# crudspec: the language

A small declarative language for CRUD apps: data, rules, actions, triggers, workflows,
views, permissions, real time, an API and a UI. It comes with tools to check a spec and to
run it as a web app. This directory is generic: nothing in it names an app's entities,
screens or styles. Apps live under `../apps/`.

| File | What it is |
| --- | --- |
| `LANGUAGE.md` | The language reference |
| `parser.ts` | Parser: declarations and expressions, and the UI as TSX-style markup; newlines don't matter |
| `check.ts` | Static checker: names and fields, arities, extern placement, enum and row type mismatches, and the UI rules (links and forms name real screens and actions, form fields are action parameters, required inputs are present, listed rows have read permissions, every action is reachable) |
| `deep.ts` | Deep checks: unreachable enum values and states, unchecked writes, signed-out writes without a rate limit, trigger cycles, restricted deletes, unguarded unique creates |
| `rows.ts` | Rows, values and an in-memory row store, for setups, upgrades and the importer |
| `cli.ts` | `parse`, `check`, `plan` and `migrate` (see below); `--json` for machine-readable output; never prompts |
| `describe.ts` | What each action and view does: effects through triggers, cascades and workflows; MCP annotations; JSON Schemas |
| `scaffold.ts` | Default screens, as spec source, for actions and views the spec's screens don't cover |
| `browser/qr.test.ts` | The runtime's QR codes decode back to their links |
| `browser/screens.ts` | Every screen as a text structure (and screenshots), compared with an accepted baseline; `npm install` in `lang/browser` first |
| `review.ts` | The change report: schema, agent-facing claims, and access widened or narrowed, by bounded exploration over probe states |
| `schema.ts` | A spec's schema and contract, normalized, and the classified diff between two versions |
| `gogen/` | The compiler: a spec to a Go program (`gen.ts`), and the runtime library it links (`rt/`). This is how an app runs. See [`gogen/README.md`](gogen/README.md) |
| `runtime/store-sqlite.ts` | The schema an upgrade builds: a STRICT table per entity with size checks, unique and reference indexes |
| `runtime/upgrade.ts` | Upgrades a database to a new spec: planned, rehearsed on a copy (spec code, such as defaults, migrations and invariants, runs in the compiled app), checked against every row, then swapped in with a backup |
| `test/migrate.test.ts` | 20 upgrade cases on seeded data: renames, drops, defaults, migrations, refused changes |
| `test/agent.test.ts` | The agent interface of a compiled app over HTTP: rate limits count dry runs, confirmation, private fields, read-only tokens, idempotency, the identity's where |
| `test/live.test.ts` | Live pages over HTTP: a page is told only of commits that changed what it read; keys are hashed |
| `test/deep.test.ts` | The deep checks on Campfire and Tasks, and each on the mistake it is for |
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

Upgrades (`cli plan`, `cli migrate`) plan and rehearse in the CLI, and run whatever evaluates spec code in the compiled app: defaults for new fields, data migrations and every invariant (`app migrate-data`, `gogen/rt/migrate.go`, built on demand by `gogen/program.ts`).

The change report (`cli review --probes`) runs both versions' compiled apps (`app probe`): each probe state loaded, each call rolled back, each read permission evaluated per actor.

There is no interpreter. Until 17 Oct 2026 `interp.ts` was the reference semantics; the compiled app is now the only implementation, checked against the Rails oracle over HTTP.

Not built yet:
- rich-text formatting (bold, lists and the like); text, mentions and link previews work;
- typing indicators.

Future feature (the owner, 17 Oct 2026): **an extension model.** Typed, checked modules for
what a SaaS app needs beyond the language (billing, email, sign-in providers, scheduled jobs,
file storage), so each such need doesn't become a language change. Today the escape hatches
are externs and an app's `widgets.go`.

