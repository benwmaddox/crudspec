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
