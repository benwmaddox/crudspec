# crudspec: the language

A small declarative language for CRUD apps: data, rules, actions, triggers, workflows,
views, permissions, real time, an API and a UI. It comes with tools to check a spec and to
run it as a web app. This directory is generic: nothing in it names an app's entities,
screens or styles. Apps live under `../apps/`.

| File | What it is |
| --- | --- |
| `LANGUAGE.md` | The language reference |
| `parser.ts` | Parser: logic is newline-insensitive; UI attributes run to the end of the element's line |
| `check.ts` | Static checker: names and fields, arities, extern placement, enum and row type mismatches, and the UI rules (links and forms name real screens and actions, form fields are action parameters, required inputs are present, listed rows have read permissions, every action is reachable) |
| `interp.ts` | Reference interpreter: the semantics. Every action is a transaction; virtual clock; workflows can be deferred and run asynchronously with real externs |
| `cli.ts` | `node lang/cli.ts parse <spec>` and `node lang/cli.ts check <spec>` |
| `runtime/server.ts` | Serves a spec as a web app |
| `runtime/store-sqlite.ts` | SQLite storage: a table per entity, typed columns, unique and reference indexes; additive spec changes migrate on start |
| `runtime/net.ts` | Guarded outbound HTTP: every hop pinned to a public address |
| `runtime/webpush.ts` | Web Push: RFC 8291 payload encryption, VAPID signing, the service worker |
| `test/webpush.test.ts` | The push crypto against the RFC 8291 test vector, a decrypting round trip and VAPID verification |

## Running an app

```
node lang/runtime/server.ts <app.crud> --data <dir> --assets <dir> [--port 3000]
```

The runtime:
- renders the spec's screens with the app's stylesheets, from `--assets`;
- runs actions from forms and buttons;
- keeps sessions as the spec's `identity` says;
- hashes passwords and signs links;
- stores uploads and serves them safely;
- pushes live updates over server-sent events;
- runs channels;
- serves the spec's `api` routes as JSON;
- runs workflows after the response, with real externs;
- stores data in SQLite (`<data>/app.sqlite`);
- provides the externs `post_json` (webhooks), `opengraph` (link previews) and `web_push`.

Web push uses `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` from the environment if they are set.
Otherwise it generates a key pair once and keeps it in `<data>/vapid.json`. `VAPID_SUBJECT` sets the contact address.

`--test --harness <file>` adds `/_test/*` endpoints for replaying scenarios:
- the runtime provides reset, clock, max ids and function evaluation;
- the app's harness module provides setup and normalized state.

Not built yet:
- rich-text formatting (bold, lists and the like); text, mentions and link previews work;
- typing indicators.
