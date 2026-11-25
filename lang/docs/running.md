# Running an app

A built app is one program: `app --data <dir> --assets <dir> --port 4301`. `app --help` lists every
flag. This page is what it protects without the spec saying so, and what to tell it about where it
runs.

## While changing it: watch

`node lang/cli.ts watch <app> [--port 3000] [--data <dir>] [--out <dir>] [--json]` builds the app,
runs it on the port, and on every change to the app's folder builds and restarts it:

- **a spec change** is built (about 8 s: nearly all of it Go's compile), while the last good build
  keeps serving; then the new one replaces it;
- **an asset change** (under `assets/`) only restarts the app, which reads them at start (well
  under a second);
- **a change that doesn't build** is reported at its file and line, and the last good build serves
  on, with the errors in a banner at the foot of every page;
- **a change to the stored schema** migrates the watch's data (`migrate`, which keeps a backup)
  before the new build starts.

For an agent, `GET /_watch/wait` returns once every change written before the call is serving or
has failed: `{"version", "state": "live" | "failed", "errors", "changed", "took_ms"}`. It looks at
the files itself, so it can be called the moment an edit is saved: edit, wait, then look at the page.
`GET /_watch/status` says the same at once. Each step is a line on standard output (one JSON object
a line with `--json`). For a person, an open page reloads itself when a new version is live.

The builds and, unless `--data` says otherwise, the data go in crudspec's `target/watch/<app>`. It's
for development only: the app runs behind a small proxy that adds the reload script to pages and
sends everything uncompressed.

## Behind a proxy

Put a TLS-terminating proxy (Caddy, nginx) on the same machine in front of it.

- **The visitor's address.** A request from this machine (127.0.0.1 or ::1) is a proxy's: the
  visitor is the address the proxy added to `X-Forwarded-For`, the **last** entry. Earlier ones
  are whatever the visitor sent, so they never count: a rate limit `by request.ip` can't be
  dodged by sending a different one each time. Behind two proxies on this machine, say
  `--proxies 2`. A request from anywhere else is its own address, whatever it says.
- **https.** When the proxy says `X-Forwarded-Proto: https` (or the app serves TLS itself, or
  `--base-url` is `https://…`), the session cookie is `Secure`, so the browser never sends it over
  plain http, and pages say `Strict-Transport-Security`.

## Behind a CDN

For a site read far more than it's written, `--cdn-cache 60` lets a CDN (Cloudflare, Fastly,
CloudFront) keep pages for a minute, and uploaded files (`/files/…`) for a day
(`--file-cdn-cache`, in seconds; 0 keeps them as long as a page). An upload's address is a
random key that never shows anything else, so a longer time costs nothing but this: a file
taken down may still be served from the CDN for up to that long, unless the CDN's copy is purged.
- **Only for signed-out readers.** A page or file sent to a request with no cookies at all is
  what any signed-out reader gets at that address. It's sent with `Cache-Control: public,
  max-age=0, s-maxage=60, stale-while-revalidate=60`: the CDN keeps it 60 seconds, and serves it
  a further 60 while it fetches a newer one. Browsers don't keep it.
- **Never for anyone else.** A request with a cookie (signed in, a flash message, a remembered
  choice) gets its page for itself, marked `Cache-Control: private, no-cache`, and so does one whose page set a cookie, read the clock or
  read the visitor (`request.ip`, `request.user_agent`), or a form's post. A page that reads
  `request.host` is the same for everyone at that host, so it's kept, one per host. Set the CDN to pass any request with a cookie through to the app (most do by
  default, or with a "bypass on cookie" rule), so no one is sent a page that was someone else's.
- **What it costs.** A change shows to signed-out readers up to that many seconds later (twice
  that, at worst); signed-in people see it at once. A file a row no longer holds, or that became
  private, may still be served from the CDN until then.

Without it (the default), pages carry no caching headers and files are `private`, so nothing is
kept outside the app; the app's own page cache still saves rendering the same page twice.

## Caching

The app keeps whole pages and page fragments, so the same page isn't made twice:
- **Signed out:** whole pages are kept for signed-out readers only. A signed-in person's page is
  theirs alone and seldom asked for again before it changes, so it's put together from cached
  fragments instead. `CRUDSPEC_PAGE_CACHE=all` keeps signed-in pages too, each session's its own.
- **Shared:** a signed-out page is one for every reader of its address, whatever their address or
  browser. A page that reads them (`request.ip`, `request.user_agent`), or the clock, or shows a
  flash, isn't kept, and a CDN isn't told it may keep it.
- **By key:** a commit drops the pages and fragments that read what it wrote, and keeps the
  rest. `CRUDSPEC_PAGE_KEYS=0` makes any commit drop every page instead.
- **An age:** nothing is used once older than `--cache-max-age` (a day unless said; `0`: no
  limit). It's a safety net for a read no key followed.
- **Cold entries go:** once a minute, a sweep drops what's past that age and what nobody has read
  for an hour. A quiet server so keeps the pages read this hour, not everything read that day,
  and the memory goes back at the next quiet spell.
- **A budget each:** a quarter of the memory limit (`GOMEMLIMIT`, or 512 MB the app sets), from
  16 MB to 2 GB. Past it, what wasn't used lately goes. When the heap nears the limit, both
  caches give up what wasn't used lately, down to half their budget.
- **Quiet spells:** after 30 seconds under one request a second, following a burst, the server
  hands back what it no longer needs: the database connections waiting in its pools drop
  SQLite's cached pages, the Go heap is collected and its free pages returned, and on Linux glibc
  returns the C memory SQLite freed. Left alone, an idle process keeps it for minutes. The caches
  stay as they are.

`/_metrics` says their sizes, budgets, how often memory pressure made them shrink, and how often
a quiet spell gave memory back (`returned_when_quiet`).

## Health, metrics and backups

- **`/up`** answers `ok` when the database answers a read, and 503 when it doesn't, never cached:
  for a load balancer's or uptime check's probe.
- **`/_metrics`** is what the server did since it started, as JSON, for administrators (the app's
  `admin` condition; anyone else gets 404), never cached:
  - requests by kind (page, file, asset, action, agent, runtime) and by status;
  - the 50th and 95th percentile and the longest of the latest 2,000 pages' times, in ms;
  - how often the page cache answered.

  Requests are counted by kind, never by address, so nothing a request carried (a search, an
  email in a query) is kept.
- **`app backup --data <dir>`** backs the app up while it runs ([Backups](#backups)).

### Backups

```
app backup --data <dir> [--to <folder>] [--keep <days>]
```

1. **A copy of the database,** made while the app runs: SQLite's `VACUUM INTO` reads one
   consistent moment of it, beside the app's own reads and writes, into a new compact file,
   `app-<UTC time>.sqlite` in the folder (`<data>/backups` when not said).
2. **Checked:** SQLite's integrity check, every reference, and that it's at this build's version.
   A copy that fails isn't kept.
3. **Sent to the backup bucket,** when `CRUDSPEC_BACKUP_BUCKET` names one, on the service the
   `CRUDSPEC_S3_*` settings name (their endpoint, region and keys, [data.md](data.md);
   `CRUDSPEC_S3_BUCKET` needn't be set): the copy under `db/`, and the uploaded files the app
   keeps on this machine (`<data>/files`) under `files/`, only those not sent before.
   `CRUDSPEC_BACKUP_PREFIX` puts them in a folder of the bucket.
4. **`--keep 14`** removes copies older than 14 days, in the folder and the bucket. The newest
   is always kept.

It prints what it did as a line of JSON, and exits 1 if any part failed, so a scheduler reports
it. Run it nightly from cron or a systemd timer. `--out <file>` makes one copy to that file and
nothing else.

Every upgrade is a backup checkpoint too ([changing an app](changing-an-app.md)): the database as
it was is copied, checked and sent to the bucket before it's replaced, or it isn't upgraded.

## What every app does

- **Cross-site writes are refused.** A write is a POST from the app's own pages. One a browser
  says comes from another site (`Origin`, `Sec-Fetch-Site`) is refused with 403, and so is one
  that says nothing while carrying the session cookie (`Origin: null` included). A program that
  sends no cookie is not a browser's forged form, so it is let through. The agent API takes a
  bearer token, never the cookie.
- **Session cookies** are `HttpOnly` and `SameSite=Lax`.
- **Headers on every response:**
  - `X-Frame-Options: SAMEORIGIN` and `frame-ancestors 'self'`: no other site frames the app;
  - `X-Content-Type-Options: nosniff`;
  - `Referrer-Policy: strict-origin-when-cross-origin`.
- **Uploads** are known by their bytes, not their name or what the browser said. A PNG named
  `cat.gif` is stored as a `.png`; something named or sent as an image that isn't one is stored as
  a `.bin` to download, and `file.kind` isn't `"image"`. Images, audio and video are shown inline,
  anything else downloads, and every upload is served with a policy that runs no script.
- **Files follow their row.** `/files/<key>` is served only to someone who may read a row holding
  the file (`data.md`).
- **Passwords** are scrypt hashes. A sign-in written `require user != none and
  authenticates(user.password, password)` hashes a password even when there's no such user, so how
  long it takes doesn't say whether an email has an account.
- **Slow requests end.** A request's headers must arrive within 10 seconds and its body within 5
  minutes; an idle connection closes after 2.
- `--test` adds the `/_test/` endpoints a test run drives. Never pass it to a public app.
