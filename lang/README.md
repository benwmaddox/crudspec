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
| `reference.ts` | The reference (`REFERENCE.md`, `cli reference`), generated from the parser's, checker's and generator's own tables; `test/reference.test.ts` fails when they drift |
| `deep.ts` | Deep checks: unreachable enum values and states, unchecked writes, a guard its sibling actions make and one leaves out, signed-out writes without a rate limit, trigger cycles, restricted deletes, unguarded unique creates |
| `rows.ts` | Rows, values and an in-memory row store, for setups, upgrades and the importer |
| `cli.ts` | `parse`, `check`, `plan` and `migrate` (see below); `--json` for machine-readable output; never prompts |
| `describe.ts` | What each action and view does: effects through triggers, cascades and workflows; MCP annotations; JSON Schemas |
| `scaffold.ts` | Default screens, as spec source, for actions and views the spec's screens don't cover |
| `browser/qr.test.ts` | The runtime's QR codes decode back to their links |
| `browser/screens.ts` | Every screen as a text structure (and screenshots), compared with an accepted baseline; `npm install` in `lang/browser` first |
| `review.ts` | The change report: schema, agent-facing claims, and access widened or narrowed, by bounded exploration over probe states |
| `logic.ts` | How a changed condition relates to the old one (holds in fewer cases, more, the same or others), for the change report |
| `schema.ts` | A spec's schema and contract, normalized, and the classified diff between two versions |
| `gogen/` | The compiler: a spec to a Go program (`gen.ts`), and the runtime library it links (`rt/`). This is how an app runs. See [`gogen/README.md`](gogen/README.md) |
| `runtime/store-sqlite.ts` | The schema an upgrade builds: a STRICT table per entity with size checks, unique and reference indexes |
| `runtime/upgrade.ts` | Upgrades a database to a new spec: planned, rehearsed on a copy (spec code, such as defaults, migrations and invariants, runs in the compiled app), checked against every row, then swapped in with a backup |
| `test/migrate.test.ts` | 20 upgrade cases on seeded data: renames, drops, defaults, migrations, refused changes |
| `test/agent.test.ts` | The agent interface of a compiled app over HTTP: rate limits count dry runs, confirmation, private fields, read-only tokens, idempotency, the identity's where |
| `test/live.test.ts` | Live pages over HTTP: a page is told only of commits that changed what it read; keys are hashed |
| `test/deep.test.ts` | The deep checks on Campfire and Tasks, and each on the mistake it is for |
| `test/mutants.ts` | How much the checker catches: one slip at a time in a real app (a name or keyword misspelled, a field swapped for one of another type, a require or a form field removed), each checked as `check --deep` does; it counts what's caught, at the slip's line, and with the name meant suggested. `test/mutants.test.ts` holds the sample apps' rates |
| `test/compiled.test.ts` | Every clause the parser makes is one the compiler reads, or is listed with why not: a clause the app ignores fails it |
| `test/messages.test.ts` | What a person reads when a spec is wrong: positions, carets, "did you mean", one error per slip |
| `std/html.crud` | HTML's elements and attributes, for checking plain (lowercase) HTML; `std/ui.crud` the built-in elements |
| `../editors/vscode/` | VS Code support: colouring, problems, hover, definition, completion, quick fixes; see its README |
| `test/sizes.test.ts`, `test/types.test.ts` | Sizes in every layer; the type pass on Campfire and on broken copies of it |
| `gogen/rt/externs_test.go` | Web Push in Go: the RFC 8291 test vector, a decrypting round trip, VAPID verification (`go test ./rt` in `lang/gogen`) |

## Checking a spec

```
node lang/cli.ts check <app> [--deep]      names, then (--deep) the type pass, the deep checks and query costs
node lang/cli.ts check <app> --json        each finding with its file, line, column and, when its message names one, its fix
node lang/cli.ts check <app> --fix         apply those fixes ("did you mean X?"), then check again
node lang/cli.ts build <app> --out <dir>   check --deep, the invariant proofs, then the Go program
```

An app is a directory of `.crud` files. An error shows its line with a caret under the name, and
a misspelled name, keyword, attribute or type says the one meant; a delimiter left open says
which and where it opened; a habit from another language (`=` for `==`, `null`, `String`,
`className`) gets crudspec's form. How much `check` catches is measured, not assumed:
`test/mutants.ts` makes one slip at a time in a real app and counts what is caught, where, and
with what suggestion (`test/mutants.test.ts` holds the rates), and `test/fuzz.test.ts` holds that
no edit crashes the checker or the compiler. In VS Code, `../editors/vscode/` shows the same
findings as you type and offers the fixes.

## Agents and change review

```
node lang/cli.ts describe <app-url>                         what an agent may call (token in CRUDSPEC_TOKEN)
node lang/cli.ts call <app-url> <name> k=v … [--dry-run] [--confirm <v>]
node lang/cli.ts review <old> <new> [--probes f] [--data d]  schema, rows at risk, outcomes, exposure, claims; who can see, change, delete and call, widened (exit 2) or narrowed
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
file storage), so each such need doesn't become a language change.

First step, built 18 Oct 2026: **Go bindings** (`LANGUAGE.md`, "Go bindings"). An extern can call
any Go function with plain types, from the standard library, a pinned module (`import go
"module@version"`) or the app's `ext.go`. `node lang/cli.ts bind <package>` generates the extern
lines. The checker and the app's start check both types. Still to come: scheduled actions (`every
day at …`, `at row.time`), and typed modules built on bindings (mail, export, billing) with test
doubles.

