# H2 and H3 protocol: agents fixing the spec against agents fixing the Rust code

Pre-registered 17 Oct 2026, before any task is written or any agent run. This page
refines the H2 and H3 sections of `docs/HYPOTHESES.md`. Their thresholds stand.

## Question

Given the same issue report, does a fresh agent produce a correct and preserving change
more often by editing the crudspec spec than by editing the Rust port? And at what cost?

## Tasks

- **Source:** the 30 bugs of the frozen corpus `corpus-v1`. Each one gives a maintenance task: the app is in its buggy state, and an issue reports the wrong behaviour.
  - Both arms start from the same wrong behaviour: the spec with `spec.patch` applied, or the Rust port with `baseline.patch` applied.
  - The corpus confirmed that both forms are wrong in the same way.
- **Issue text** (`issue.md`) is written by a separate task-writer session from `bug.md` and `oracle.json`. It describes the symptom and the expected behaviour, as a user or product owner would, and never names files, lines, spec declarations or rule IDs. Both arms get the same `issue.md`.
- **Selection:**
  - **5 tasks** are drawn at random with seed 17 for a **pilot**; pilot runs are excluded from the results.
  - The other 25 tasks are the study set.
- **Runs:** each study task is run **twice per arm**, with fresh sessions. That's 50 runs per arm and 100 in all, above the 40 per arm in H2.

## Arms

Both arms use the same model, the same prompt template apart from the arm-specific part,
the same budget, and fresh sessions.

| | Spec arm | Rust arm |
| --- | --- | --- |
| What the agent edits | `spec/campfire.crud` | the Rust source (`crates/`), in a Windows copy without `reference/` |
| Language docs | `LANGUAGE.md` | none needed; it's Rust |
| Feedback tools | `check` (the frozen checker); `run`, which runs a scenario the agent writes and prints outcomes and state; no goldens | `test`, which syncs the copy into a WSL build tree and runs `cargo test -p campfire -p campfire_db`; the agent may add tests |
| Hidden from both | the Rails oracle and its goldens, the slice scenarios, the corpus, the rule inventory, the crudspec repository, the Rails source | |

Each run's workspace is `D:\code\crudspec-h2\runs\<run-id>\`, a fresh copy with no
git history. Agents are told to work only there. Isolation depends on that instruction,
and this is a stated caveat.

## Outcomes

These are measured by the harness, never by the agent's own tests.

- **Correct:** the task's `oracle.json` matches its Rails golden. The spec arm is checked with the interpreter, the Rust arm with the HTTP replay.
- **Preserving:** all 25 frozen slice scenarios (`slice-v1`) match their goldens, so nothing else broke. Both arms started out failing at least the task's own behaviour.
- **Complete:** the session ended normally, and the result builds and parses.
- **Primary metric:** the share of runs that are correct **and** preserving **and** complete.
- **H2 decision (`docs/HYPOTHESES.md`):**
  - **Success:** the spec arm is at least 15 points higher, with a 95% interval that excludes zero.
  - **Kill:** the difference isn't significant, or the spec arm is worse.
  - The interval is a bootstrap over tasks, 10,000 resamples with seed 17, keeping each task's runs together.
- **H3 cost:** subagent tokens, tool calls and wall time per run, as the agent platform reports them. Median spec/Rust ratios are reported for all runs and for correct runs.
  - **Success:** at most 1.2×.
  - **Kill:** more than 1.5×. Documentation fixes are allowed only during the pilot.
- **Also reported:**
  - change locality: files or declarations touched, from the run's diff;
  - checker findings on spec-arm results;
  - the share of runs where the agent's own feedback tools were green but the oracle failed.

## Procedure

1. A task-writer session writes `issue.md` for all 30 tasks, under `D:\code\crudspec-h2\tasks\`. The harness author checks that each issue names no location, then freezes the tasks and hashes them.
2. Pilot: 5 tasks × 2 arms × 1 run. Only tooling and documentation may change afterwards. The prompts and the outcome measures may not.
3. Study: 100 runs, launched in random order with seed 17, three at a time with the arms mixed.
4. A separate scoring step, `h2/score.py`, computes the outcomes from the run directories, and the report goes to `reports/h2/`.

## Caveats, stated in advance

- **Fix tasks only.** All 30 tasks are fixes. New-feature tasks need a ground truth that Rails doesn't have, so they're out of scope for this study.
- **An unfamiliar language.** The spec arm's agent sees crudspec for the first time; the Rust arm's agent knows Rust well. That is the real situation for a new DSL, and H3 measures its cost.
- **Unequal workspace size.** The Rust arm's workspace is much larger, about 17,000 lines against 260. That difference is part of what H2 tests.
