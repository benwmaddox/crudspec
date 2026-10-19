# The H10 study harness's part of the app (docs/H10-STUDY-PROTOCOL.md), the same for every run.
# Not the agent's work, and not counted as hand work.
#
# - Mail: delivered over SMTP to the harness's mail server (SMTP_ADDRESS, SMTP_PORT), from
#   MAIL_FROM; links in mail use APP_URL.
# - Time: the harness moves the app's clock forward (POST /_h10/advance {"ms": n}). Every process
#   (the web server, the job worker) sees the moved clock: the offset is kept in H10_CLOCK_FILE.
#   After moving it, the harness calls every block registered with H10.on_tick, in the request,
#   so time-based work registered there runs then (recurring jobs have no scheduler here).

module H10
  @ticks = []
  @offset = 0.0
  @read_at = 0.0
  class << self
    def file = ENV["H10_CLOCK_FILE"]

    # seconds the clock is moved forward (re-read at most every 0.2 s of real time)
    def offset
      real = Process.clock_gettime(Process::CLOCK_MONOTONIC)
      if file && real - @read_at > 0.2
        @offset = File.exist?(file) ? File.read(file).to_f : 0.0
        @read_at = real
      end
      @offset
    end

    def advance(ms)
      raise "no H10_CLOCK_FILE" unless file
      @offset = offset + ms.to_f / 1000
      File.write(file, @offset.to_s)
      @read_at = Process.clock_gettime(Process::CLOCK_MONOTONIC)
      @ticks.each { |blk| blk.call(Time.current) }
    end

    # registers time-based work: the block runs, with the current time, whenever the clock moves
    def on_tick(&blk) = @ticks << blk
  end
end

# Time.now (and so Time.current, Date.today, Active Record's timestamps) follows the moved clock
class << Time
  alias_method :h10_real_now, :now
  def now(...) = h10_real_now(...) + H10.offset
end

Rails.application.configure do
  if ENV["SMTP_ADDRESS"].present?
    config.action_mailer.delivery_method = :smtp
    config.action_mailer.smtp_settings = { address: ENV["SMTP_ADDRESS"], port: ENV.fetch("SMTP_PORT", 25).to_i, enable_starttls_auto: false }
    config.action_mailer.perform_deliveries = true
    config.action_mailer.raise_delivery_errors = true
  end
  config.action_mailer.default_options = { from: ENV.fetch("MAIL_FROM", "campfire@h10.test") }
  if ENV["APP_URL"].present?
    u = URI(ENV["APP_URL"])
    config.action_mailer.default_url_options = { host: u.host, port: u.port, protocol: u.scheme }
  end
end

# a plain Rack endpoint (no controller, so nothing loads early), before config/routes.rb is
# drawn, so the app's own routes come after it
H10_ADVANCE = lambda do |env|
  body = JSON.parse(env["rack.input"].read.presence || "{}")
  Rails.application.executor.wrap { H10.advance(body.fetch("ms")) }
  [200, { "content-type" => "application/json" }, [{ offset_s: H10.offset, now: Time.current.iso8601(3) }.to_json]]
end
Rails.application.routes.prepend { post "/_h10/advance", to: H10_ADVANCE }
