# Campfire, written in crudspec

[ONCE Campfire](https://github.com/basecamp/once-campfire), the chat app, at Rails 90b3300,
written as one crudspec spec: `campfire.crud`. It uses the generic language and runtime in
`../../lang/`.

| Path | What it is |
| --- | --- |
| `campfire.crud` | The whole app, about 1,140 lines: data, rules, actions, triggers, workflows, views, live updates, the bot API and every screen |
| `oracle/` | The Rails oracle: drives the real Rails app through its controllers and records golden files (`rails/oracle.rb`, `rails/run.sh`), plus the scenarios and goldens. `rails/replay-rust.sh` replays scenarios against the Rust port |
| `test/` | Campfire's scenario runner (`run-scenarios.ts`, interpreter); the HTTP replay driver for the runtime (`replay-runtime.ts`); and the runtime test harness (`harness.ts`) |
| `e2e/` | Browser checks in Chromium: first run, two users with live updates, bots, a webhook round trip, @mentions, presence, every screen |
| `docs/` | The plan for the full spec (`PLAN.md`) and the map of every Rails route, channel and job to the spec (`COVERAGE.md`) |

## Run it

The app's stylesheets and images come from the Rails app's `app/assets`, copied outside this
repository. Campfire is MIT-licensed.

```
node lang/cli.ts check apps/campfire/campfire.crud
node lang/runtime/server.ts apps/campfire/campfire.crud --data <data-dir> --assets <campfire-assets-dir> --port 13800
```

## Behaviour equity with Rails

These commands show it (results in `../../reports/v2-review/REPORT.md`):

```
node apps/campfire/test/run-scenarios.ts apps/campfire/campfire.crud apps/campfire/oracle/scenarios/<set> apps/campfire/oracle/golden/<goldens>
node lang/runtime/server.ts apps/campfire/campfire.crud --data <dir> --assets <dir> --port 13801 --test --harness apps/campfire/test/harness.ts
node apps/campfire/test/replay-runtime.ts apps/campfire/campfire.crud http://127.0.0.1:13801 apps/campfire/oracle/scenarios/<set> apps/campfire/oracle/golden/<goldens>
```

All 42 scenarios match through both the interpreter and the runtime over HTTP:

| Set | Goldens | Scenarios |
| --- | --- | ---: |
| `slice-v1` | `slice-v1-e` | 25 |
| `smoke` | `smoke-10` | 3 |
| `checker-findings` | `findings-1` | 1 |
| `v2-areas` | `v2-areas-h` | 13 |
