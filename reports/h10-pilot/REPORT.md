# H10 pilot: feature changes to Campfire through the spec, and through Rails

17 Oct 2026. Protocol: `docs/H10-PROTOCOL.md` (registered before any run; changes after
registration are listed there). Harness and raw results: `h10/`, `h10/results/<run>/`.

A pilot: 3 tasks, 2 arms, 1 run each. It makes no H10 decision. Read it as what happened.

## Results

| Run | Accepted | Preserved (42 scenarios) | Upgrade on production data | Back up after | Files changed | Agent: tokens / tool calls / minutes |
| --- | --- | --- | --- | --- | --- | --- |
| spec, topic | yes (5/5) | 42/42 | rows intact | 2.6 s | spec only (10 lines) | 79k / 35 / 4.6 |
| Rails, topic | yes (5/5) | 42/42 | rows intact | 2.9 s | 6 | 93k / 62 / 7.2 |
| spec, pin | yes (8/8) | 42/42 | rows intact | 3.3-5.5 s | spec only (17 lines) | 86k / 67 / 6.1 |
| Rails, pin | **no**: messages don't render | **39/42** | rows intact | 3.0 s | 9 | 100k / 100 / 10.2 |
| spec, display | yes (4/4) | 42/42 | rows intact; all 10 users' display name is their name's first word | 5.8 s | spec only | 99k / 67 / 7.7 |
| Rails, display | yes (4/4) | 42/42 | **fails**: the migration has a syntax error; the app doesn't come back | - | 9 | 98k / 89 / 10.1 |

**Right** (accepted, preserved, data intact): spec 3 of 3; Rails 1 of 3.

## What went wrong in Rails

- **pin:** a `dom_id` call in the new message markup raises (`undefined method 'model_name' for an instance of Symbol`), so no message renders. The agent's own checks ran the migration and started the server, but never showed a message.
- **display:** the migration doesn't parse. A fresh install was fine, because the agent also edited `db/schema.rb` by hand, so the migration only runs on an existing database: the case the task said mattered.

Both are the kind of error the spec arm can't make: there is no separate migration to write (the upgrade is planned from the spec, here a default `first_word(.name)` on a new field), and the spec is checked and compiled as a whole before it runs, so a broken template doesn't reach the page.

## Time to live

Both arms were back within H10's 10 s target on the production data: 2.6-5.8 s for the spec
(build about 2 s, upgrade 0.3-3.4 s, start under 0.1 s), about 3 s for Rails (migrate and boot).
A cold Go build is about 29 s. Neither arm is clearly faster here.

## Cost

The spec runs used fewer tokens (79-99k against 93-100k), fewer tool calls (35-67 against
62-100) and less time (4.6-7.7 against 7.2-10.2 minutes), on every task. With one run each, that
is a direction, not a measurement.

## Caveats

- One run per task and arm: chance dominates.
- The tasks were written by the session that built crudspec's Campfire (in user-visible terms only).
- The harness had to be fixed during the pilot, each fix recorded in the protocol and re-checked against both unmodified apps: a route the protocol wrongly listed as shared, races with Turbo and WSL, a read-only field, stale scoring data, and production rows the spec refuses (cleaned from both arms' copies alike).
- Isolation was by instruction: agents could have read outside their workspace.

## For a study

More runs per task, tasks written by someone else, and a task set that includes changes the
spec language can't yet express (the spec arm's limits are H10's kill criterion, and this pilot
didn't test them).
