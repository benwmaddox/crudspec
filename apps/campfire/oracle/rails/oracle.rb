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
# - forgery protection is off (the slice is about authorization, not CSRF);
# - rate-limit counters live in memory instead of Redis (same limits).

require "json"
require "net/http"

ActiveJob::Base.queue_adapter = :inline
Rails.cache = ActiveSupport::Cache::MemoryStore.new
ActionCable.server.instance_variable_set(:@pubsub, ActionCable::SubscriptionAdapter::Test.new(ActionCable.server))
ActionController::Base.allow_forgery_protection = false
Room::PushMessageJob.class_eval { def perform(*) = nil }
Bot::WebhookJob.class_eval { def perform(*) = nil }   # v2 scenarios: no outbound webhook calls
# Production keeps rate-limit counters in Redis; without Redis the limiter silently allows
# everything. Count in memory instead, so rate limits behave as in production.
ORACLE_RATE_STORE = ActiveSupport::Cache::MemoryStore.new
ActiveSupport::Cache::RedisCacheStore.class_eval do
  def increment(name, amount = 1, **options) = ORACLE_RATE_STORE.increment(name, amount, **options)
end
require "active_support/testing/time_helpers"
include ActiveSupport::Testing::TimeHelpers

scenario_paths = ARGV.dup
out_dir = ENV["ORACLE_OUT"] or abort "usage: ORACLE_OUT=<out_dir> oracle.rb <scenario.json>..."
FileUtils.mkdir_p(out_dir)

PASSWORD = "oracle-password-1"   # synthetic, local only
TURBO = "text/vnd.turbo-stream.html, text/html"
ROLE = { "member" => 0, "administrator" => 1, "bot" => 2 }
ROOM_TYPE = { "open" => "Rooms::Open", "closed" => "Rooms::Closed", "direct" => "Rooms::Direct" }

class Keys
  attr_reader :message_rooms   # message id -> room id, kept after the message is deleted
  attr_reader :boost_messages  # boost id -> message id, kept after the boost is deleted
  def initialize
    @by_kind = Hash.new { |h, k| h[k] = {} }
    @message_rooms = {}
    @boost_messages = {}
  end
  def set(kind, key, id) = (@by_kind[kind][key] = id)
  def id(kind, key) = @by_kind[kind].fetch(key) { raise "unknown #{kind} key #{key.inspect}" }
  def key(kind, id) = @by_kind[kind].key(id) || "#{kind}##{id}"
  def known?(kind, id) = @by_kind[kind].value?(id)
  attr_accessor :join_code
  def bot_tokens = (@bot_tokens ||= {})
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
  ORACLE_RATE_STORE.clear
end

def normalized_state(keys, v2 = false)
  user_key = ->(id) { keys.key(:user, id) }
  state = {
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
  return state unless v2
  # v2 scenarios also cover account settings, profiles, bots, search history and push.
  state.merge(
    "account_settings" => Account.first&.then { |a| { "name" => a.name, "custom_styles" => a.custom_styles, "join_code_reset" => a.join_code != keys.join_code } },
    "profiles" => User.order(:id).map { |u|
      { "key" => user_key.(u.id), "bio" => u.bio, "email" => (u.email_address.to_s.include?("-deactivated-") ? "deactivated" : u.email_address),
        "bot_token_reset" => u.bot? ? u.bot_token != keys.bot_tokens[u.id] : nil }
    },
    "webhooks" => Webhook.order(:user_id).map { |w| { "user" => user_key.(w.user_id), "url" => w.url } },
    "searches" => Search.order(:user_id, updated_at: :desc, id: :desc).group_by(&:user_id).to_h { |uid, ss| [ user_key.(uid), ss.map(&:query) ] }.sort.to_h,
    "push_subscriptions" => Push::Subscription.order(:user_id, :id).map { |p| { "user" => user_key.(p.user_id), "endpoint" => p.endpoint } }
  )
end

def build_setup!(setup, keys)
  return if setup["empty"]   # first-run scenarios start with no account at all
  acct = setup.fetch("account", {})
  account = Account.create!(name: "Oracle", settings: { restrict_room_creation_to_administrators: acct.fetch("restrict_room_creation", false) })
  account.update_column(:join_code, acct.fetch("join_code", "JOIN-CODE"))   # Account::Joinable generates a random one
  keys.join_code = acct.fetch("join_code", "JOIN-CODE")

  setup.fetch("users").each do |u|
    user = User.create!(name: u.fetch("name"), email_address: u["email"], password: PASSWORD, role: u.fetch("role", "member"), bio: u["bio"], bot_token: u["bot_token"])
    keys.set(:user, u.fetch("key"), user.id)
    keys.bot_tokens[user.id] = u["bot_token"]
    user.create_webhook!(url: u["webhook_url"]) if u["webhook_url"]
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
    keys.message_rooms[message.id] = message.room_id
  end

  setup.fetch("boosts", []).each do |b|
    boost = Boost.create!(message_id: keys.id(:message, b.fetch("message")), booster_id: keys.id(:user, b.fetch("booster")), content: b.fetch("content"))
    keys.set(:boost, b.fetch("key"), boost.id)
    keys.boost_messages[boost.id] = boost.message_id
  end

  # Setup searches are dated in the past, oldest first, so later searches sort after them.
  searches = setup.fetch("searches", [])
  searches.each_with_index do |q, i|
    travel_to(Time.current - (searches.size - i).minutes) { Search.create!(user_id: keys.id(:user, q.fetch("user")), query: q.fetch("query")) }
  end

  # The unread state after setup is exactly what the scenario lists (default: read).
  Membership.update_all(unread_at: nil)
  setup.fetch("unread", []).each do |u|
    Membership.where(room_id: keys.id(:room, u.fetch("room")), user_id: keys.id(:user, u.fetch("user"))).update_all(unread_at: Time.current)
  end
end

# ORACLE_TARGET=http://127.0.0.1:<port> replays the same requests over real HTTP against
# another implementation (the Rust baseline) sharing this database; the Rails models
# here still build the setup and normalize the final state, so both are identical.
TARGET = ENV["ORACLE_TARGET"]

class HttpBrowser
  Response = Struct.new(:status, :location, :body) do
    def redirect? = (300..399).cover?(status)
  end
  attr_reader :response
  def initialize(base) = (@base = URI(base); @cookies = {})
  def host!(_) = nil
  def flash = nil
  %i[get post patch delete].each do |verb|
    define_method(verb) { |path, params: {}, headers: {}, env: {}| request(verb, path, params, headers, env) }
  end

  private
    def request(verb, path, params, headers, env)
      uri = @base.dup
      uri.path = path
      body = Rack::Utils.build_nested_query(params)
      uri.query = body if verb == :get && !body.empty?
      klass = { get: Net::HTTP::Get, post: Net::HTTP::Post, patch: Net::HTTP::Patch, delete: Net::HTTP::Delete }.fetch(verb)
      req = klass.new(uri)
      req["Host"] = "campfire.test"
      req["X-Forwarded-For"] = env["REMOTE_ADDR"] if env["REMOTE_ADDR"]
      req["X-Forwarded-Proto"] = "http"
      headers.each { |k, v| req[k] = v }
      req["Cookie"] = @cookies.map { |k, v| "#{k}=#{v}" }.join("; ") unless @cookies.empty?
      if verb != :get
        req["Content-Type"] = "application/x-www-form-urlencoded"
        req.body = body
      end
      res = Net::HTTP.start(uri.host, uri.port) { |http| http.request(req) }
      Array(res.get_fields("set-cookie")).each do |c|
        name, value = c.split(";", 2).first.split("=", 2)
        if c =~ /max-age=0|expires=Thu, 01 Jan 1970/i then @cookies.delete(name) else @cookies[name] = value end
      end
      @response = Response.new(res.code.to_i, res["location"], res.body.to_s.dup.force_encoding("UTF-8"))
    end
end

def new_browser
  if TARGET
    HttpBrowser.new(TARGET)
  else
    ActionDispatch::Integration::Session.new(Rails.application).tap { |s| s.host! "campfire.test" }
  end
end

def sign_in(user_spec)
  s = new_browser
  s.post "/session", params: { email_address: user_spec.fetch("email"), password: PASSWORD },
                     env: { "REMOTE_ADDR" => user_spec.fetch("ip") }
  raise "sign-in failed for #{user_spec['key']}: #{s.response.status}" unless s.response.redirect?
  s
end

def request_for(action, keys)
  rid = ->(k) { keys.id(:room, k) }
  uid = ->(k) { keys.id(:user, k) }
  mid = ->(k) { keys.id(:message, k) }
  room_of = ->(message_key) { keys.message_rooms.fetch(mid.(message_key)) }
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
  when "unboost"            then [ :delete, "/messages/#{keys.boost_messages.fetch(keys.id(:boost, action['boost']))}/boosts/#{keys.id(:boost, action['boost'])}", {} ]
  when "change_role"        then [ :patch, "/account/users/#{uid.(action['user'])}", { user: { role: action["role"] } } ]
  when "deactivate_user"    then [ :delete, "/account/users/#{uid.(action['user'])}", {} ]
  when "ban_user"           then [ :post, "/users/#{uid.(action['user'])}/ban", {} ]
  when "unban_user"         then [ :delete, "/users/#{uid.(action['user'])}/ban", {} ]
  when "sign_out"           then [ :delete, "/session", {} ]
  when "search"             then [ :post, "/searches", { q: action["query"] } ]
  when "clear_searches"     then [ :delete, "/searches/clear", {} ]
  when "search_results"     then [ :get, "/searches", { q: action["query"] } ]
  when "update_profile"     then [ :patch, "/users/me/profile", { user: action.slice("name", "bio", "password").merge(action.key?("email") ? { "email_address" => action["email"] } : {}) } ]
  when "update_account"
    params = {}
    params[:name] = action["name"] if action.key?("name")
    params[:settings] = { restrict_room_creation_to_administrators: action["restrict_room_creation"] } if action.key?("restrict_room_creation")
    [ :patch, "/account", { account: params } ]
  when "update_custom_styles" then [ :patch, "/account/custom_styles", { account: { custom_styles: action["custom_styles"] } } ]
  when "reset_join_code"    then [ :post, "/account/join_code", {} ]
  when "create_bot"         then [ :post, "/account/bots", { user: action.slice("name", "webhook_url") } ]
  when "update_bot"         then [ :patch, "/account/bots/#{uid.(action['b'])}", { user: action.slice("name", "webhook_url") } ]
  when "delete_bot"         then [ :delete, "/account/bots/#{uid.(action['b'])}", {} ]
  when "reset_bot_key"      then [ :patch, "/account/bots/#{uid.(action['b'])}/key", {} ]
  when "subscribe_push"     then [ :post, "/users/me/push_subscriptions", { push_subscription: action.slice("endpoint", "p256dh_key", "auth_key") } ]
  when "list_messages"
    query = {}
    query[:before] = mid.(action["before"]) if action["before"]
    query[:after] = mid.(action["after"]) if action["after"]
    [ :get, "/rooms/#{rid.(action['room'])}/messages", query ]
  else raise "unknown action #{action['do']}"
  end
end

# Outcome classes: ok, forbidden, not_found, blocked (429), invalid (500/422), unauthenticated.
def classify(response, flash_alert, action = nil, keys = nil)
  status = response.status
  body = response.body.to_s
  if TARGET && response.redirect? && %w[update_open_room update_closed_room delete_room delete_direct_room].include?(action&.fetch("do")) &&
     URI(response.location.to_s).path == "/"
    gone = !Room.exists?(keys.id(:room, action["room"]))
    return action["do"].start_with?("delete") && gone ? "ok" : "not_found"
  end
  case
  when status == 429 then "blocked"
  when status == 401 then "unauthenticated"
  when status == 403 then "forbidden"
  when status == 404 then "not_found"
  when status >= 500 || status == 422 || status == 400 then "invalid"
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
                  "post_message" => [ :message, Message ], "boost" => [ :boost, Boost ], "join" => [ :user, User ],
                  "create_bot" => [ :user, User ], "first_run" => [ :user, User ] }.fetch(action["do"]) { return }
  newest = model.where("id > ?", before[kind]).order(:id).last
  keys.set(kind, as, newest.id) if newest
  keys.message_rooms[newest.id] = newest.room_id if newest && kind == :message
  keys.boost_messages[newest.id] = newest.message_id if newest && kind == :boost
end

def start_server
  pid = Process.spawn(ENV.fetch("ORACLE_SERVER_CMD"), out: File::NULL, err: ENV.fetch("ORACLE_SERVER_LOG", File::NULL), pgroup: true)
  uri = URI(TARGET)
  200.times do
    begin
      return pid if Net::HTTP.get_response(URI("#{TARGET}/up")).code.to_i < 500
    rescue SystemCallError, IOError
    end
    sleep 0.1
  end
  stop_server(pid)
  raise "server at #{TARGET} did not start"
end

def stop_server(pid)
  Process.kill("TERM", -Process.getpgid(pid)) rescue nil
  Process.wait(pid) rescue nil
end

failures = 0
scenario_paths.each do |path|
  scenario = JSON.parse(File.read(path))
  begin
  travel_back
  reset_database!
  keys = Keys.new
  build_setup!(scenario.fetch("setup"), keys)
  server = TARGET && start_server
  users = scenario.fetch("setup").fetch("users", []).index_by { |u| u.fetch("key") }
  v2 = scenario["v2"] == true
  sessions = users.values.select { |u| u["ip"] }.to_h { |u| [ u.fetch("key"), sign_in(u) ] }
  initial = normalized_state(keys, v2)

  results = scenario.fetch("actions").map do |action|
    before = { room: Room.maximum(:id).to_i, message: Message.maximum(:id).to_i, boost: Boost.maximum(:id).to_i, user: User.maximum(:id).to_i }
    ip = action["ip"] || users.dig(action["actor"], "ip") || "203.0.113.250"
    case action.fetch("do")
    when "wait"
      travel action.fetch("seconds").seconds
      next { "action" => action, "status" => 0, "outcome" => "ok" }
    when "first_run"
      s = new_browser
      s.post "/first_run", params: { user: { name: action["name"], email_address: action["email"], password: PASSWORD } }, env: { "REMOTE_ADDR" => ip }
      if action["as"] && s.response.redirect?
        sessions[action["as"]] = s
        users[action["as"]] = { "key" => action["as"], "email" => action["email"], "ip" => ip }
      end
      keys.set(:room, "all_talk", Room.order(:id).first.id) if Room.any? && !keys.known?(:room, Room.order(:id).first.id)
    when "transfer_session"
      # An anonymous browser follows the user's transfer link ("link" overrides it, to test bad links).
      s = new_browser
      link = action["link"] || User.find(keys.id(:user, action.fetch("user"))).transfer_id
      s.put "/session/transfers/#{link}", env: { "REMOTE_ADDR" => ip }
      sessions[action["user"]] = s if action["user"] && s.response.redirect?
    when /\Abot_(post|edit|delete|boost)\z/
      # A bot acts through the bot API, authenticated by its key in the path.
      bot = User.find(keys.id(:user, action.fetch("actor")))
      key = action["bot_key"] || "#{bot.id}-#{bot.bot_token}"
      rid = keys.id(:room, action.fetch("room"))
      s = new_browser
      verb, url, body = case action["do"]
        when "bot_post"   then [ :post, "/rooms/#{rid}/#{key}/messages", action.fetch("body", "") ]
        when "bot_edit"   then [ :put, "/rooms/#{rid}/#{key}/messages/#{keys.id(:message, action['message'])}", action.fetch("body", "") ]
        when "bot_delete" then [ :delete, "/rooms/#{rid}/#{key}/messages/#{keys.id(:message, action['message'])}", "" ]
        when "bot_boost"  then [ :post, "/rooms/#{rid}/#{key}/messages/#{keys.id(:message, action['message'])}/boosts", action.fetch("content", "") ]
      end
      s.public_send(verb, url, params: body, headers: { "Content-Type" => "text/plain" }, env: { "REMOTE_ADDR" => ip })
      if action["as"] && action["do"] == "bot_post" && s.response.status == 201
        newest = Message.order(:id).last
        keys.set(:message, action["as"], newest.id)
        keys.message_rooms[newest.id] = newest.room_id
      end
    when "bot_ui_post"
      # A bot key presented to an ordinary (non-API) endpoint.
      bot = User.find(keys.id(:user, action.fetch("actor")))
      s = new_browser
      s.post "/rooms/#{keys.id(:room, action.fetch('room'))}/messages?bot_key=#{bot.id}-#{bot.bot_token}", params: { message: { body: action["body"] } }, headers: { "Accept" => TURBO }, env: { "REMOTE_ADDR" => ip }
    when "sign_in"
      # A fresh browser signs the actor in again; on success it becomes the actor's session.
      s = new_browser
      s.post "/session", params: { email_address: users.fetch(action["actor"]).fetch("email"), password: action["password"] || PASSWORD }, env: { "REMOTE_ADDR" => ip }
      sessions[action["actor"]] = s if s.response.redirect? && !s.response.location.to_s.include?("/session")
    when "join"
      # An anonymous browser joins; "as" names the new user, who then has this session.
      s = new_browser
      s.post "/join/#{action['join_code']}", params: { user: { name: action["name"], email_address: action["email"], password: PASSWORD } }, env: { "REMOTE_ADDR" => ip }
      if action["as"] && s.response.redirect? && !s.response.location.to_s.include?("/session")
        sessions[action["as"]] = s
        users[action["as"]] = { "key" => action["as"], "email" => action["email"], "ip" => ip }
      end
    else
      s = sessions[action.fetch("actor")] || new_browser
      verb, url, params = request_for(action, keys)
      s.public_send(verb, url, params: params, headers: { "Accept" => TURBO }, env: { "REMOTE_ADDR" => ip })
    end
    alert = s.flash[:alert] rescue nil
    # Another process wrote the database: drop query-cached reads from before the request.
    ActiveRecord::Base.connection.clear_query_cache if TARGET
    name_created!(action, keys, before)
    result = { "action" => action, "status" => s.response.status, "outcome" => classify(s.response, alert, action, keys) }
    if %w[list_messages search_results].include?(action["do"]) && result["outcome"] == "ok"
      result["rows"] = s.response.body.to_s.scan(/data-message-id="(\d+)"/).flatten.map { |id| keys.key(:message, id.to_i) }
    end
    result
  end

  stop_server(server) if server
  server = nil
  ActiveRecord::Base.connection.clear_query_cache
  out = { "scenario" => scenario.fetch("id"), "rules" => scenario.fetch("rules", []), "oracle" => TARGET ? "replay:#{ENV.fetch('ORACLE_TARGET_NAME', TARGET)}" : "rails@90b3300",
          "initial" => initial, "results" => results, "final" => normalized_state(keys, v2) }
  File.write(File.join(out_dir, "#{scenario.fetch('id')}.json"), JSON.pretty_generate(out) + "\n")
  puts "#{scenario.fetch('id')}: #{results.map { |r| r['outcome'] }.join(' ')}"
  rescue => e
    stop_server(server) if server
    failures += 1
    puts "#{scenario['id']}: ORACLE ERROR #{e.class}: #{e.message}"
    puts e.backtrace.select { |l| l.include?("oracle.rb") }.first(5).map { |l| "  at #{l}" }
  end
end
abort("#{failures} scenario(s) failed") if failures > 0
