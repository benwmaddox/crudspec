# Domain-level oracle for the Campfire slice (docs/RULE-INVENTORY.md).
#
# Usage (inside the Rails app, via run.sh):
#   ORACLE_OUT=<out_dir> bin/rails runner oracle.rb <scenario.json>...
#
# For each scenario:
# 1. Reset the database (delete every row).
# 2. Build the setup state with models, plus explicit inserts where a callback
#    would add state the scenario didn't ask for.
# 3. Sign each actor in through the real sessions endpoint from its own public IP.
# 4. Run the actions as real HTTP requests through the controllers
#    (ActionDispatch::Integration::Session).
# 5. Write <out_dir>/<id>.json: the normalized initial state, each action's raw
#    response and classified outcome, and the normalized final state.
#
# Environment adjustments (oracle only; none affects a rule in the inventory):
# - jobs run inline (N1's content removal must happen before the final state);
# - Room::PushMessageJob is a no-op (push is out of scope);
# - Action Cable uses the test adapter and the cache is in memory (no Redis);
# - forgery protection is off (the slice is about authorization, not CSRF).

require "json"

ActiveJob::Base.queue_adapter = :inline
Rails.cache = ActiveSupport::Cache::MemoryStore.new
ActionCable.server.instance_variable_set(:@pubsub, ActionCable::SubscriptionAdapter::Test.new(ActionCable.server))
ActionController::Base.allow_forgery_protection = false
Room::PushMessageJob.class_eval { def perform(*) = nil }

scenario_paths = ARGV.dup
out_dir = ENV["ORACLE_OUT"] or abort "usage: ORACLE_OUT=<out_dir> oracle.rb <scenario.json>..."
FileUtils.mkdir_p(out_dir)

PASSWORD = "oracle-password-1"   # synthetic, local only
TURBO = "text/vnd.turbo-stream.html, text/html"
ROLE = { "member" => 0, "administrator" => 1, "bot" => 2 }
ROOM_TYPE = { "open" => "Rooms::Open", "closed" => "Rooms::Closed", "direct" => "Rooms::Direct" }

class Keys
  def initialize = @by_kind = Hash.new { |h, k| h[k] = {} }
  def set(kind, key, id) = (@by_kind[kind][key] = id)
  def id(kind, key) = @by_kind[kind].fetch(key) { raise "unknown #{kind} key #{key.inspect}" }
  def key(kind, id) = @by_kind[kind].key(id) || "#{kind}##{id}"
  def known?(kind, id) = @by_kind[kind].value?(id)
end

def reset_database!
  conn = ActiveRecord::Base.connection
  # FTS5 shadow tables (<index>_data, _idx, _content, _docsize, _config) are cleared through their index.
  shadow = /_(data|idx|content|docsize|config)\z/
  conn.disable_referential_integrity do
    (conn.tables - %w[schema_migrations ar_internal_metadata]).reject { |t| t.match?(shadow) && conn.tables.include?(t.sub(shadow, "")) }
      .each { |t| conn.execute("DELETE FROM #{conn.quote_table_name(t)}") }
  end
  conn.execute("DELETE FROM sqlite_sequence") if conn.table_exists?("sqlite_sequence")
  Rails.cache.clear
end

def normalized_state(keys)
  user_key = ->(id) { keys.key(:user, id) }
  {
    "account" => Account.first&.then { |a| { "restrict_room_creation" => a.settings.restrict_room_creation_to_administrators? } },
    "users" => User.order(:id).map { |u|
      { "key" => user_key.(u.id), "name" => u.name, "role" => u.role, "status" => u.status,
        "email_deactivated" => u.email_address.to_s.include?("-deactivated-") }
    },
    "rooms" => Room.order(:id).map { |r|
      { "key" => keys.key(:room, r.id), "type" => r.type.delete_prefix("Rooms::").downcase, "name" => r.name, "creator" => user_key.(r.creator_id) }
    },
    "memberships" => Membership.order(:room_id, :user_id).map { |m|
      { "room" => keys.key(:room, m.room_id), "user" => user_key.(m.user_id), "involvement" => m.involvement, "unread" => !m.unread_at.nil? }
    },
    "messages" => Message.order(:id).map { |m|
      { "key" => keys.key(:message, m.id), "room" => keys.key(:room, m.room_id), "creator" => user_key.(m.creator_id), "body" => m.body.to_plain_text }
    },
    "boosts" => Boost.order(:id).map { |b|
      { "key" => keys.key(:boost, b.id), "message" => keys.key(:message, b.message_id), "booster" => user_key.(b.booster_id), "content" => b.content }
    },
    "bans" => Ban.order(:user_id, :ip_address).map { |b| { "user" => user_key.(b.user_id), "ip" => b.ip_address } },
    "sessions" => Session.group(:user_id).count.transform_keys { |id| user_key.(id) }.sort.to_h
  }
end

def build_setup!(setup, keys)
  acct = setup.fetch("account", {})
  Account.create!(name: "Oracle", join_code: acct.fetch("join_code", "JOIN-CODE"),
                  settings: { restrict_room_creation_to_administrators: acct.fetch("restrict_room_creation", false) })

  setup.fetch("users").each do |u|
    user = User.create!(name: u.fetch("name"), email_address: u.fetch("email"), password: PASSWORD, role: u.fetch("role", "member"))
    keys.set(:user, u.fetch("key"), user.id)
  end

  # Rooms and memberships are inserted directly, so that Rooms::Open's grant-to-everyone
  # callback doesn't add memberships the scenario didn't list.
  setup.fetch("rooms", []).each do |r|
    now = Time.current
    id = Room.insert!({ type: ROOM_TYPE.fetch(r.fetch("type")), name: r["name"], creator_id: keys.id(:user, r.fetch("creator")),
                        created_at: now, updated_at: now }).rows.first&.first || Room.maximum(:id)
    keys.set(:room, r.fetch("key"), id)
    r.fetch("members").each do |m|
      member = m.is_a?(Hash) ? m : { "user" => m }
      Membership.insert!({ room_id: id, user_id: keys.id(:user, member.fetch("user")),
                           involvement: member.fetch("involvement", r["type"] == "direct" ? "everything" : "mentions"),
                           created_at: now, updated_at: now })
    end
  end

  setup.fetch("messages", []).each do |m|
    creator = User.find(keys.id(:user, m.fetch("creator")))
    message = Room.find(keys.id(:room, m.fetch("room"))).messages.create!(body: m.fetch("body"), creator: creator)
    keys.set(:message, m.fetch("key"), message.id)
  end

  setup.fetch("boosts", []).each do |b|
    boost = Boost.create!(message_id: keys.id(:message, b.fetch("message")), booster_id: keys.id(:user, b.fetch("booster")), content: b.fetch("content"))
    keys.set(:boost, b.fetch("key"), boost.id)
  end

  # The unread state after setup is exactly what the scenario lists (default: read).
  Membership.update_all(unread_at: nil)
  setup.fetch("unread", []).each do |u|
    Membership.where(room_id: keys.id(:room, u.fetch("room")), user_id: keys.id(:user, u.fetch("user"))).update_all(unread_at: Time.current)
  end
end

def sign_in(user_spec)
  s = ActionDispatch::Integration::Session.new(Rails.application)
  s.host! "campfire.test"
  s.post "/session", params: { email_address: user_spec.fetch("email"), password: PASSWORD },
                     env: { "REMOTE_ADDR" => user_spec.fetch("ip") }
  raise "sign-in failed for #{user_spec['key']}: #{s.response.status}" unless s.response.redirect?
  s
end

def request_for(action, keys)
  rid = ->(k) { keys.id(:room, k) }
  uid = ->(k) { keys.id(:user, k) }
  mid = ->(k) { keys.id(:message, k) }
  room_of = ->(message_key) { Message.find(mid.(message_key)).room_id }
  case action.fetch("do")
  when "create_open_room"   then [ :post, "/rooms/opens", { room: { name: action["name"] } } ]
  when "create_closed_room" then [ :post, "/rooms/closeds", { room: { name: action["name"] }, user_ids: action.fetch("users", []).map(&uid) } ]
  when "create_direct_room" then [ :post, "/rooms/directs", { user_ids: action.fetch("users", []).map(&uid) } ]
  when "update_open_room"   then [ :patch, "/rooms/opens/#{rid.(action['room'])}", { room: { name: action["name"] } } ]
  when "update_closed_room" then [ :patch, "/rooms/closeds/#{rid.(action['room'])}", { room: { name: action["name"] }, user_ids: action.fetch("users", []).map(&uid) } ]
  when "delete_room"        then [ :delete, "/rooms/#{rid.(action['room'])}", {} ]
  when "delete_direct_room" then [ :delete, "/rooms/directs/#{rid.(action['room'])}", {} ]
  when "set_involvement"    then [ :patch, "/rooms/#{rid.(action['room'])}/involvement", { involvement: action["involvement"] } ]
  when "post_message"       then [ :post, "/rooms/#{rid.(action['room'])}/messages", { message: { body: action["body"] } } ]
  when "edit_message"       then [ :patch, "/rooms/#{room_of.(action['message'])}/messages/#{mid.(action['message'])}", { message: { body: action["body"] } } ]
  when "delete_message"     then [ :delete, "/rooms/#{room_of.(action['message'])}/messages/#{mid.(action['message'])}", {} ]
  when "boost"              then [ :post, "/messages/#{mid.(action['message'])}/boosts", { boost: { content: action["content"] } } ]
  when "unboost"            then [ :delete, "/messages/#{Boost.find(keys.id(:boost, action['boost'])).message_id}/boosts/#{keys.id(:boost, action['boost'])}", {} ]
  when "change_role"        then [ :patch, "/account/users/#{uid.(action['user'])}", { user: { role: action["role"] } } ]
  when "deactivate_user"    then [ :delete, "/account/users/#{uid.(action['user'])}", {} ]
  when "ban_user"           then [ :post, "/users/#{uid.(action['user'])}/ban", {} ]
  when "unban_user"         then [ :delete, "/users/#{uid.(action['user'])}/ban", {} ]
  else raise "unknown action #{action['do']}"
  end
end

# Outcome classes: ok, forbidden, not_found, blocked (429), invalid (500/422), unauthenticated.
def classify(response, flash_alert)
  status = response.status
  body = response.body.to_s
  case
  when status == 429 then "blocked"
  when status == 403 then "forbidden"
  when status == 404 then "not_found"
  when status >= 500 || status == 422 then "invalid"
  when response.redirect? && response.location.to_s.include?("/session/new") then "unauthenticated"
  when response.redirect? && flash_alert.to_s.include?("not found") then "not_found"
  when status == 200 && body.include?("This room was deleted.") then "not_found"
  else "ok"
  end
end

# Records an action creates are named by the action's "as" key: the newest row of that kind.
def name_created!(action, keys, before)
  return unless (as = action["as"])
  kind, model = { "create_open_room" => [ :room, Room ], "create_closed_room" => [ :room, Room ], "create_direct_room" => [ :room, Room ],
                  "post_message" => [ :message, Message ], "boost" => [ :boost, Boost ] }.fetch(action["do"]) { return }
  newest = model.where("id > ?", before[kind]).order(:id).last
  keys.set(kind, as, newest.id) if newest
end

failures = 0
scenario_paths.each do |path|
  scenario = JSON.parse(File.read(path))
  begin
  reset_database!
  keys = Keys.new
  build_setup!(scenario.fetch("setup"), keys)
  users = scenario.fetch("setup").fetch("users").index_by { |u| u.fetch("key") }
  sessions = users.values.select { |u| u["ip"] }.to_h { |u| [ u.fetch("key"), sign_in(u) ] }
  initial = normalized_state(keys)

  results = scenario.fetch("actions").map do |action|
    s = sessions.fetch(action.fetch("actor")) { raise "actor #{action['actor']} has no session (needs an ip)" }
    before = { room: Room.maximum(:id).to_i, message: Message.maximum(:id).to_i, boost: Boost.maximum(:id).to_i }
    verb, url, params = request_for(action, keys)
    s.public_send(verb, url, params: params, headers: { "Accept" => TURBO }, env: { "REMOTE_ADDR" => users.fetch(action["actor"]).fetch("ip") })
    alert = s.flash[:alert] rescue nil
    name_created!(action, keys, before)
    { "action" => action, "status" => s.response.status, "outcome" => classify(s.response, alert) }
  end

  out = { "scenario" => scenario.fetch("id"), "rules" => scenario.fetch("rules", []), "oracle" => "rails@90b3300",
          "initial" => initial, "results" => results, "final" => normalized_state(keys) }
  File.write(File.join(out_dir, "#{scenario.fetch('id')}.json"), JSON.pretty_generate(out) + "\n")
  puts "#{scenario.fetch('id')}: #{results.map { |r| r['outcome'] }.join(' ')}"
  rescue => e
    failures += 1
    puts "#{scenario['id']}: ORACLE ERROR #{e.class}: #{e.message}"
    puts e.backtrace.select { |l| l.include?("oracle.rb") }.first(5).map { |l| "  at #{l}" }
  end
end
abort("#{failures} scenario(s) failed") if failures > 0
