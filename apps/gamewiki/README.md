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
  - `/w/<address>`, always (`/w/hollow-depths`);
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
  - Every save is a revision with a summary, and so is every infobox change: a revision keeps
    the page's text and its infobox (template, picture and facts). History shows a line diff of
    each, and any revision can be restored, infobox and all.
  - Two people editing at once can't overwrite each other unseen: a save made over a newer
    revision is refused, and the editor keeps what they wrote, to compare with History and save
    again.
  - Pages have categories (comma-separated), an optional game version ("For version 1.3")
    and a spoiler notice.
  - A link to a missing page offers to write it. Search covers titles and text.
- **Moderation.**
  - A wiki admin protects a page: anyone who can edit the wiki, members who are editors, or
    wiki admins only. A protected page shows a lock.
  - *Blocked* is a role: someone blocked can't edit the wiki, even one anyone signed in may edit.
  - *Undo their edits* (on Members and Recent changes) puts back every page someone was the
    last to change, infobox included, as a new revision, and deletes pages only they wrote. The
    main page stays, and the wiki owner's edits are undone only by a site administrator.
  - Edits, infobox changes included, are limited to 30 in 10 minutes a person.
- **Infoboxes.**
  - A wiki's templates (Weapon, Boss, Location) list the facts that kind of page has.
  - A page using a template fills them in, and they show in a box beside the text, with the
    page's picture.
- **Images.**
  - Uploads are PNG, JPEG, GIF or WebP, 10 MB at most.
  - The gallery shows each image's Markdown line, ready to paste into a page.
  - An image is served only to someone who may read a page or wiki that holds it, so a private
    wiki's images stay private, even to someone given their address.
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

## AI agents

The wiki has crudspec's agent interface (`/llms.txt`, MCP at `/_mcp`, JSON at `/_agent/…`):
- **With a token:** anyone signed in opens *Agent access* in the top bar and issues a token, full or read-only. An agent with it acts as that person, on the wikis they can read and edit, and nothing more. They see its calls there and can revoke it.
- **Without a token:** agents may read public wikis, as a signed-out visitor does: pages, search, recent changes, categories. Private wikis don't exist for them, and they can't change anything. That's at most 60 calls a minute from one address, and those reads aren't logged.
- **Limits:** a token makes at most 60 calls and 10 edits a minute.
- **The site administrator** switches agents off entirely, or reading without a token, in the site settings. *Every agent token and call* (`/_agents/all`) lists every token on the site, with whom it acts for, and the latest calls; any token can be revoked there.

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

`tests.crud` holds the wiki's tests, in crudspec's own test syntax ([`lang/docs/testing.md`](../../lang/docs/testing.md)).
The unit tests check the rules as functions: slugs, subdomains, ads. The integration tests cover:
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

- **Search** uses a full-text index of titles and text; it matches the start of words, not the middle.
- **Raw HTML in a page shows as nothing.** Only Markdown is rendered.
