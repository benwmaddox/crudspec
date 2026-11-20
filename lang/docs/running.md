# Running an app

A built app is one program: `app --data <dir> --assets <dir> --port 4301`. `app --help` lists every
flag. This page is what it protects without the spec saying so, and what to tell it about where it
runs.

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
CloudFront) keep pages and uploaded files for a minute:
- **Only for signed-out readers.** A page or file sent to a request with no cookies at all is
  what any signed-out reader gets at that address. It's sent with `Cache-Control: public,
  max-age=0, s-maxage=60, stale-while-revalidate=60`: the CDN keeps it 60 seconds, and serves it
  a further 60 while it fetches a newer one. Browsers don't keep it.
- **Never for anyone else.** A request with a cookie (signed in, a flash message, a remembered
  choice) gets its page for itself, marked `Cache-Control: private, no-cache`, and so does one whose page set a cookie or read the clock, or
  a form's post. Set the CDN to pass any request with a cookie through to the app (most do by
  default, or with a "bypass on cookie" rule), so no one is sent a page that was someone else's.
- **What it costs.** A change shows to signed-out readers up to that many seconds later (twice
  that, at worst); signed-in people see it at once. A file a row no longer holds, or that became
  private, may still be served from the CDN until then.

Without it (the default), pages carry no caching headers and files are `private`, so nothing is
kept outside the app; the app's own page cache still saves rendering the same page twice.

## Caching

The app keeps whole pages and page fragments, so the same page isn't made twice:
- **Shared:** a signed-out page is one for every reader of its address, whatever their address or
  browser. A page that reads them (`request.ip`, `request.user_agent`), or the clock, or shows a
  flash, isn't kept, and a CDN isn't told it may keep it.
- **By key:** a commit drops the pages and fragments that read what it wrote, and keeps the
  rest. `CRUDSPEC_PAGE_KEYS=0` makes any commit drop every page instead.
- **An age:** nothing is used once older than `--cache-max-age` (a day unless said; `0`: no
  limit). It's a safety net for a read no key followed, and for what's gone cold.
- **A budget each:** a quarter of the memory limit (`GOMEMLIMIT`, or 512 MB the app sets), from
  16 MB to 2 GB. Past it, what wasn't used lately goes. When the heap nears the limit, both
  caches give up what wasn't used lately, down to half their budget.

`/_metrics` says their sizes, budgets, and how often memory pressure made them shrink.

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
- **`app backup --data <dir> --out <file>`** copies the database while the app runs: SQLite's
  `VACUUM INTO` reads one consistent moment of it, beside the app's own reads and writes, into a new
  compact file. Uploaded files aren't in it: they are in `<data>/files`, or the bucket.

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
