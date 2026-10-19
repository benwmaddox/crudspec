# H10 study protocol: ten changes to Campfire, through the spec and through Rails

Pre-registered 19 Oct 2026, before any agent run. It follows the pilot
(`docs/H10-PROTOCOL.md`, `reports/h10-pilot/REPORT.md`) and keeps its arms, harness and measures
except where this says otherwise.

## Question

When a fresh agent makes a real feature change to Campfire, how often is the result right
(accepted, preserving the existing behaviour, keeping the data, and, for the spec arm, with a
sound cache), editing the crudspec spec against editing the Rails app? Secondary: how much of
each task's acceptance it meets, how much hand work and time it takes, how long the upgrade takes.

## Tasks

Ten feature requests written blind by a separate agent from a neutral brief
(`h10/study/tasks/README.md`), which saw neither app nor this protocol. Frozen in commit
`869842f` with SHA-256 sums (`h10/study/tasks/SHA256SUMS`) before any check was written: 01 Room
Topics, 02 Message Pinning, 03 Starred Messages, 04 Advanced Message Search, 05 Daily Digest
Email, 06 Automatic Room Archival, 07 Export Room Messages, 08 Admin Notifications for Inactive
Users, 09 Message Threading, 10 Scheduled Messages. The writer, like the pilot's, chose topic and
pinning; they are kept.

## Disclosure: the language changed after the tasks were frozen

Reading the frozen tasks showed that five needed what crudspec lacked. The owner then chose to
add generic features, and they were built between the freeze and this protocol:
- Go bindings (`= go "pkg".Func`, `import go`, `lang/cli.ts bind`);
- schedules (`schedule … for … at … past_due`, `every day at`), and date and time form fields;
- mail (`send mail`, a transactional outbox) and exports (`export … csv|json of view`);
- storage formats 3 and 4 (typed columns; no JSON by default), a change review that reports
  outcomes, exposure and rows at risk, the `--check-cache` self-check;
- fixes found on the way (`url_of` keeping query parameters, among others).

Each is generic (no task's wording or names), tested on patterns of its own (reminders, a
digest-style batch, exports of a view), and documented in `lang/LANGUAGE.md`. The tasks shaped
which features came first: that is a stated bias in the spec arm's favour. The language is
pinned at the commit that adds this protocol; runs use that commit's `lang/`.

## Arms

| | Spec arm | Rails arm |
| --- | --- | --- |
| The agent edits | `campfire.crud`, and `widgets.go` or `ext.go` if it must (their Go lines are counted as hand work) | the Rails app's source |
| Given | the spec, `widgets.go`, a copy of `lang/` (docs, reference, CLI, compiler) | a copy of the app (ONCE Campfire 90b3300) |
| Feedback | `tools/check.sh` (the deep checks); serving the app on a fresh database | serving the app on a fresh database; `tools/rails.sh` |
| Both | `TASK.md`; `tools/serve.sh`, `tools/mail.sh`, `tools/advance.sh` | |
| Hidden from both | these checks, the oracle and its goldens, the other arm, the crudspec repository, `docs/` | |

Workspaces: `bash h10/study/make-workspace.sh <arm> <run> <port> <task>`, fresh, with no git
history, under `D:\code\h10-study-runs\<run>\`.

**The harness's contract, the same for both, worded the same** (`WORKSPACE.md`, "How the harness
runs and tests the app"): mail goes to the harness's SMTP server and counts only there; links in
mail point at the app's address; the harness moves the app's clock forward and expects due work
done within a few seconds; the browser is in America/Chicago, the server in America/New_York.
How each arm meets it is the harness's, not the agent's work:
- **Spec** (`h10/study/spec-serve.sh`): `CRUDSPEC_SMTP`, `--base-url`, `--test` (its clock:
  `/_test/clock` runs what comes due before answering), `--check-cache`.
- **Rails** (`h10/study/rails-serve.sh`): its own Redis and a Resque worker (production uses
  Resque; without them no job runs), and `config/initializers/h10_harness.rb`: Action Mailer over
  SMTP to the harness, `default_url_options` from the app's address, and a movable clock
  (`Time.now` plus an offset every process reads; `POST /_h10/advance` runs the blocks registered
  with `H10.on_tick`). That file is not the agent's and isn't hand work.

## Agents

The same model for both, a fresh subagent per run, the same prompt apart from the arm's part
(`h10/study/prompt.md`). The agent works only in its workspace and says when it's done; no time
or token limit beyond the platform's. Runs go in the background, a few at a time, arms
interleaved.

## Measures

Made by the harness, never by the agent; the same as the pilot's except as noted.

- **Accepted:** `h10/study/accept.mjs <arm> <base> <task>` on the arm's app built from the run's
  result, on a fresh database, through `h10/study/run-accept.mjs` (the harness's mail server and
  clock). It drives a browser through visible text, placeholders, labels, roles and the routes
  both apps share. Each task's acceptance criteria map to named checks; a criterion that allows
  several forms ("a Pin button or menu option") accepts any; criteria not checkable this way, or
  contradicting another, are listed as not scored in the file (`CRITERIA`), before any run.
  - *Accepted* = the shared steps and every check pass. *Checks passed* = the fraction.
  - **Baseline:** on both unmodified apps, the shared steps pass and each task is not accepted
    (`h10/study/baseline/`). A check that passes on an unmodified app is reported (it measures
    nothing for that arm).
- **Preserved:** the 42 oracle scenarios still match (spec: the replay against the compiled app,
  with `--check-cache`; Rails: the oracle run with the arm's app).
- **Data:** the upgrade on a copy of the same production data (spec: `bench-snap-nc4`, the
  snapshot already cleaned of the six rows the spec refuses and at storage format 4; Rails: the
  Rails snapshot, cleaned of the same rows) loses no table's rows.
- **Cache (spec only):** no `cache check:` line in the server log of the acceptance or
  preservation runs. A stale cached fragment is a wrong page users would have seen.
- **Right** = accepted, preserved, data kept, and (spec) no cache mismatch.
- **Hand work, time to live, cost:** as in the pilot (spec hand work: lines in `widgets.go` and
  `ext.go`; Rails: files changed, excluding `config/puma.rb` and the harness's initializer).

## Scale and analysis

10 tasks × 2 arms × 3 runs = 60 runs. Primary: right runs per arm out of 30, with each task's
three runs shown side by side. Secondary: checks passed per run; hand work; time to live; cost.
No significance test is planned for a primary decision: 30 runs per arm make large differences
visible and small ones not. Everything is reported, failures with their failing checks.

**Pilot first:** one task with mail and the clock (05) × 2 arms × 1 run, through scoring, before
the 60. Its runs don't count. If the pilot shows a harness or check bug, it's fixed under the
rule below and the pilot repeated.

## Changes after registration

**Rule for check and harness fixes:** a fix applies to both arms, every run is scored again, and
the fix is listed here with its date and reason. A fix may not look at which arm a run is from.

- **2026-10-19, after the task 05 spec pilot.** Campfire's house switch draws its checkbox at
  zero size (both apps share the stylesheet), so the checks missed switches and couldn't tick
  them. Now: a checkbox inside a visible label counts as a visible control and is ticked by its
  label (`fieldLike`, `checkOn`, used for every checkbox the checks tick). Two related changes in
  how task 05 saves its settings. It saves the form the delivery time is in, which may differ
  from the switch's form. It doesn't submit a switch that already saved itself again, because
  that would turn it back off. And `submit` works for a form with no submit button. The baseline
  was run again with the fixed checks (`h10/study/baseline/`). The pilot is repeated (`pilot2-*`).
- **2026-10-19, a rule for runs the host cuts off.** If the machine or container restarts while
  an agent is still working, the run is discarded and run again from a fresh workspace. Its state
  may be scored for information but doesn't count. A run whose agent had stopped editing before
  the restart (the Rails pilot: its last change was at 02:53 and the restart came hours later,
  while it waited on a server it had left running) is scored as handed over.
- **Pilot 1 results (not counted):** neither arm was accepted. Both kept 42/42 and all
  production data. The spec run asks for a time-zone name and sends nothing when it's left blank.
  The Rails run's settings page fails with a 500 (`generate_token_for(:digest_unsubscribe)` with
  no `generates_token_for`). See `h10/study/results/pilot-05-*`.

## Caveats, stated in advance

- The checks were written by the session that built crudspec and Campfire's spec. They use only
  what people see and accept every form a criterion allows; they are pre-registered and fixed
  only under the rule above. Still a bias, in the spec arm's favour.
- The language gained features after the tasks were known (see Disclosure).
- The spec arm's agent sees crudspec for the first time; Rails is widely known.
- Some criteria are loose ("e.g.", "or"); the checks' reading of each is in `accept.mjs`.
- The Rails arm's time-based work runs through `H10.on_tick`, a harness hook, where production
  would use a scheduler; an agent that uses a scheduler instead fails the clock checks. The
  workspace says so plainly.
