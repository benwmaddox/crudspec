# Game Wiki: wikis for games, many on one install

A wiki site in crudspec, made for game wikis. Each wiki has its own:
- pages, written in Markdown;
- images and members;
- infobox templates;
- settings.

One install can host many wikis, or a single one when self-hosted. The spec is
`wiki.crud` (data, rules, actions) and `screens.crud` (the pages), about 1,400 lines. It
uses no app-specific code in the language.

## What it does

- **Wikis.** Anyone signed in can start a wiki, unless the site administrator keeps that to
  themselves. A wiki is at:
  - `/w/<id>`, always;
  - `<slug>.<base domain>`, when the site sets a base domain (`wikis.example.com`);
  - its own domain, when a site administrator gives it one (`wiki.mygame.com`). That's
    site administrators only, and never the base domain or a name under it, so no wiki can
    take another's address.

  At a wiki's domain, `/` is its main page.
- **Read access.** A wiki is *public* (anyone reads it) or *private* (members only).
  - A private wiki's pages, history and categories are not found for anyone else.
  - So is its infobox data, and it never appears in the directory.
  - This holds for pages, agents and exports alike: a `policy … for rows in Wiki` covers
    everything inside a wiki.
- **Roles.**
  - **Site administrators** run the install. They control:
    - the base domain;
    - sign-ups;
    - who may start wikis;
    - ads;
    - every table, at `/_admin`.

    The first account is one.
  - **Wiki administrators** run a wiki. They control:
    - its members and their roles;
    - who may edit it (editors only, or anyone signed in);
    - its infobox templates;
    - deleting pages.

    Readers can read a private wiki, and editors write.
- **Pages.**
  - Markdown with `[[Page]]` and `[[Page|text]]` links. GitHub-style tables sort when a
    heading is clicked.
  - Every save is a revision with a summary. History shows a line diff of each revision, and
    any revision can be restored.
  - Pages have categories (comma-separated), an optional game version ("For version 1.3")
    and a spoiler notice.
  - A link to a missing page offers to write it. Search covers titles and text.
- **Infoboxes.**
  - A wiki's templates (Weapon, Boss, Location) list the facts that kind of page has.
  - A page using a template fills them in, and they show in a box beside the text, with the
    page's picture.
- **Images.**
  - Uploads are PNG, JPEG, GIF or WebP, 10 MB at most.
  - The gallery shows each image's Markdown line, ready to paste into a page.
  - Thumbnails are made automatically: `/files/<key>?w=400` is the image at most 400 pixels
    wide. It's made once and kept, at 100, 200, 400, 800 or 1600 pixels.
- **Ads.** A site administrator adds ads at `/site/ads`, each for the top of the page, the
  sidebar or the end of an article:
  - **a house ad:** an image and a link;
  - **an AdSense unit:** the publisher id and slot id. `ad-network.js` loads Google's script;
  - **any network's ad code:** `ad-code.js` runs it in a sandboxed frame, with no access to
    the page or its cookies.

  Ads show only on public wikis and the site's front page, and only while they're switched
  on for the site. The site can let wiki administrators turn ads off for their wiki.

## Run it

You need Node 24, Go 1.27 and a C compiler: gcc on Linux, or MinGW-w64 gcc such as WinLibs
on Windows.

```
node lang/cli.ts verify apps/gamewiki
node lang/cli.ts build apps/gamewiki --out <build-dir>
<build-dir>/app --data <data-dir> --assets apps/gamewiki/assets --port 4310
```

Open `http://localhost:4310`. The first visit asks for the site administrator's account.
Released builds are on GitHub (`crudspec-apps-<version>-<platform>`), in `gamewiki/`.

### Where images go

By default uploads go to `<data-dir>/files/`. To keep them in S3-compatible storage
instead, set these before starting the app:

| Variable | |
| --- | --- |
| `CRUDSPEC_S3_BUCKET` | the bucket (turns S3 on) |
| `CRUDSPEC_S3_ENDPOINT` | `https://s3.us-east-1.amazonaws.com`, `https://<account>.r2.cloudflarestorage.com`, `http://localhost:9000` (MinIO)… |
| `CRUDSPEC_S3_REGION` | `us-east-1` when not set; `auto` for R2 |
| `CRUDSPEC_S3_ACCESS_KEY_ID`, `CRUDSPEC_S3_SECRET_ACCESS_KEY` | the key (or `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`) |
| `CRUDSPEC_S3_PREFIX` | a folder in the bucket, like `gamewiki/` |
| `CRUDSPEC_S3_VIRTUAL_HOST=1` | `bucket.endpoint` addresses instead of `endpoint/bucket` |

The bucket stays private: the app reads files back and serves them itself, thumbnails too.

### Domains

To serve wikis at their own addresses:
- point the domains (or a wildcard, `*.wikis.example.com`) at the server;
- set the site's base domain in the site settings, and a wiki's own domain in that wiki's
  settings (as a site administrator);
- put a reverse proxy that passes the `Host` header in front (Caddy, nginx), to terminate HTTPS.

Sign-in is per domain: someone signed in at `wikis.example.com` signs in again at
`wiki.mygame.com`.

## Tests

`tests.crud` holds the wiki's tests, in crudspec's own test syntax ([`lang/docs/testing.md`](../../lang/docs/testing.md)):
- private wikis;
- who may edit;
- domains and takeover attempts;
- the owner rule;
- page titles and revisions;
- ads;
- the site administrator;
- accounts.

`node lang/cli.ts test apps/gamewiki` runs them against the built app, and `verify` runs them
too. Uploads and thumbnails are tested in `lang/test/files.test.ts`.

## Known limits

- **Uploaded images are guarded by their address alone.** Each image's address is random
  and unguessable, as in Campfire, but anyone given the address of a private wiki's image
  can open it.
- **Search reads each page of the wiki.** There's no full-text index yet.
- **Raw HTML in a page shows as nothing.** Only Markdown is rendered.
