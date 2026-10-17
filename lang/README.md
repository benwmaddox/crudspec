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
| `cli.ts` | `parse`, `check`, `plan` and `migrate` (see below); `--json` for machine-readable output; never prompts |
| `describe.ts` | What each action and view does: effects through triggers, cascades and workflows; MCP annotations; JSON Schemas |
| `scaffold.ts` | Default screens, as spec source, for actions and views the spec's screens don't cover |
| `browser/qr.test.ts` | The runtime's QR codes decode back to their links |
| `browser/screens.ts` | Every screen as a text structure (and screenshots), compared with an accepted baseline; `npm install` in `lang/browser` first |
| `review.ts` | The change report: schema, agent-facing claims, and access widened or narrowed, by bounded exploration over probe states |
| `schema.ts` | A spec's schema and contract, normalized, and the classified diff between two versions |
| `gogen/` | The compiler: a spec to a Go program (`gen.ts`), and the runtime library it links (`rt/`). This is how an app runs. See [`gogen/README.md`](gogen/README.md) |
| `runtime/store-sqlite.ts` | SQLite storage: a table per entity, typed columns, unique and reference indexes; additive spec changes migrate on start |
| `runtime/upgrade.ts` | Upgrades a database to a new spec: planned, rehearsed on a copy, checked against every row, then swapped in with a backup |
| `test/migrate.test.ts` | 20 upgrade cases on seeded data: renames, drops, defaults, migrations, refused changes |
| `test/agent.test.ts` | The agent interface of a compiled app over HTTP: rate limits count dry runs, confirmation, private fields, read-only tokens, idempotency, the identity's where |
| `test/sizes.test.ts`, `test/types.test.ts` | Sizes in every layer; the type pass on Campfire and on broken copies of it |
| `gogen/rt/externs_test.go` | Web Push in Go: the RFC 8291 test vector, a decrypting round trip, VAPID verification (`go test ./rt` in `lang/gogen`) |

## Agents and change review

```
node lang/cli.ts describe <app-url>                         what an agent may call (token in CRUDSPEC_TOKEN)
node lang/cli.ts call <app-url> <name> k=v … [--dry-run] [--confirm <v>]
node lang/cli.ts review <old.crud> <new.crud> [--probes f]  schema, claims, and access widened or narrowed
node lang/cli.ts scaffold <spec>                            generated default screens, as spec source
node lang/browser/screens.ts <spec> --base <url> --fixture <f> --out <dir> --baseline <dir>   every screen's structure, diffed
```

See "Agents" and "Reviewing a change" in `LANGUAGE.md`.

## Upgrading an app's data

```
node lang/cli.ts plan <app.crud> --data <dir> [--json]      what an upgrade would do, rehearsed on a copy
node lang/cli.ts migrate <app.crud> --data <dir> [--json]   do it; the old database goes to <dir>/backups/
```

The runtime does the same on start, and refuses to start if the upgrade is blocked. See "Versions and data migration" in `LANGUAGE.md`.

## Compiling an app to Go

A spec is validated, then compiled; nothing is interpreted at run time. See [`../docs/VALIDATE-COMPILE.md`](../docs/VALIDATE-COMPILE.md) for the principle and how each feature measures up.


`node lang/cli.ts build <app.crud> --out <dir>` compiles the spec to a Go program, with logic, SQL-planned queries and UI all compiled. The program takes the same flags and behaves the same as the runtime below. See [`gogen/README.md`](gogen/README.md).

## Running an app

An app runs as the Go program the spec compiles to:

```
node lang/cli.ts build <app.crud> --out <dir>      # check, compile, go build
<dir>/app --data <dir> --assets <dir> [--port 3000] [--test]
```

The program:
- renders the spec's screens with the app's stylesheets, from `--assets`;
- runs actions from forms and buttons, and keeps sessions as the spec's `identity` says;
- hashes passwords and signs links;
- stores uploads and serves them safely;
- pushes live updates over server-sent events, and runs channels;
- serves the spec's `api` routes as JSON, and the agent interface (JSON, MCP, `/_agents`);
- runs workflows after the response, with real externs;
- stores data in SQLite (`<data>/app.sqlite`).

Its externs are `post_json` (webhooks), `opengraph` (link previews, through the network guard) and `web_push`.

Web push uses `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` from the environment if they are set. Otherwise it generates a key pair once and keeps it in `<data>/vapid.json`. `VAPID_SUBJECT` sets the contact address.

`--test` adds `/_test/*` endpoints for the equity driver and the screens tool: load and dump rows, fixtures, the clock, max ids, function evaluation, agent tokens. Never use it in production.

The interpreter (`interp.ts`) is not a runtime. It is the reference the scenarios are checked against, and it runs data migrations and the change report's sample calls.

Not built yet:
- rich-text formatting (bold, lists and the like); text, mentions and link previews work;
- typing indicators.

