# H1 result: spec checks against the baseline's tests

**Decision: H1 is killed** under its pre-registered rule (`docs/HYPOTHESES.md`).

The frozen checker caught **2 of 22** unflagged seeded bugs (9%). The Rust port's own
tests caught **3 of 22** (14%). The checker would have needed 20 points *more* than the
baseline, and it trails.

Scored on 16 Oct 2026 by a separate session. The checker author checked the numbers
against `results.json`.

## Verification before scoring

All three checks passed:
- `git diff phase1-checker-v1 -- tools/src spec/campfire.scope.json` is empty;
- `git diff phase0-dsl-v1.1 -- spec/campfire.crud` is empty;
- `tools/corpus_manifest.py --verify` reports the manifest OK.

## Results

The corpus is `corpus-v1`: 30 bugs and 20 controls. Each was confirmed against Rails in
both forms, wrong in the same way.

| Arm | Bugs (all 30) | Bugs (22 unflagged) | False alarms (20 controls) |
| --- | --- | --- | --- |
| **Checker, primary rule (decides H1)** | 2 (7%) | 2 (9%) | 0 |
| Checker, secondary rule (reported, doesn't decide) | 10 (33%) | 10 (45%) | 1 (5%) |
| Spec + its 25 example scenarios (pre-registered) | 27 (90%) | 19 (86%) | 0 |
| Baseline: the Rust port's 351 tests | 8 (27%) | 3 (14%) | 0 |
| *Exploratory:* Rust + the same 25 scenarios, replayed over HTTP | 27 (90%) | 19 (86%) | not run |

**Flagged** (`flags.json`):
- e02–e05: their categories leaked to the checker author (`docs/DEVIATIONS.md`);
- h3, l1, n1, n2: they make the same change as a mutation the checker author already knew;
- e03 overlaps a known mutation as well.

Without the flagged bugs, the decision is the same.

## What it shows

1. **A checker over a single-source spec catches little.** The spec *is* the behaviour, so the checker can only reject a change that contradicts something else the spec says. Only two bugs did:
   - g2 broke a unique key;
   - p1 dropped a view's read permission.

   The other 28, mostly wrong permission and guard rules, contradict nothing the spec states.
2. **Soft signals do better, unproven.** The secondary rule rejects any finding the reference doesn't have, such as a guard that never fails, an action that never succeeds, or an actor never checked. It caught 45% of unflagged bugs, at one false alarm in 20. That would clear the success thresholds, but:
   - it isn't the pre-registered deciding rule;
   - 20 controls can't separate a 5% false-alarm rate from 15%;
   - its signals depend on how the exploration budget is spent.

   A separately labelled study with more controls could test it.
3. **The example scenarios do the work, in any language.** The spec plus scenarios caught 86–90%. The exploratory run catches exactly the same bugs in Rust when the same scenarios are replayed against it. So that catch rate isn't a DSL effect. It comes from oracle-derived scenarios, which any implementation can use. What the DSL adds is speed: a scenario runs in milliseconds on the interpreter, against about a minute to build and replay the Rust port.
4. **The baseline's tests are weak on these bugs.** They caught 3 of 22 unflagged bugs, mostly paging and deactivation, and missed nearly all the permission and guard bugs. Even so, the checker under its primary rule trailed them.

## Per-bug results

P is the checker's primary rule, S its secondary rule, E the spec with examples, B the baseline tests, and R the Rust with examples (exploratory). The categories are in each case's `bug.md`.

| Bug | P | S | E | B | R | Checker's new findings |
| --- | --- | --- | --- | --- | --- | --- |
| e02 ⚑ | | | ✓ | | ✓ | |
| e03 ⚑ | | | ✓ | | ✓ | |
| e04 ⚑ | | | ✓ | ✓ | ✓ | |
| e05 ⚑ | | | ✓ | ✓ | ✓ | |
| f1 | | ✓ | ✓ | | ✓ | PERMISSION_COVERAGE, REQUIRE_NEVER_FAILS |
| f2 | | | ✓ | | ✓ | |
| f3 | | ✓ | ✓ | | ✓ | NEVER_SUCCEEDS, REQUIRE_NEVER_FAILS |
| g1 | | | ✓ | | ✓ | |
| g2 | ✓ | ✓ | ✓ | ✓ | ✓ | UNIQUE_VIOLATION |
| g3 | | ✓ | ✓ | | ✓ | ENUM_VALUE_UNREACHED |
| h1 | | | ✓ | | ✓ | |
| h2 | | | ✓ | | ✓ | |
| h3 ⚑ | | | ✓ | | ✓ | |
| i1 | | ✓ | | | | REQUIRE_NEVER_FAILS |
| i2 | | | ✓ | | ✓ | |
| i3 | | | | | | |
| j1 | | ✓ | ✓ | | ✓ | NEVER_SUCCEEDS, PERMISSION_COVERAGE |
| j2 | | ✓ | ✓ | | ✓ | NEVER_SUCCEEDS |
| j3 | | ✓ | | | | NEVER_SUCCEEDS, PERMISSION_COVERAGE, REQUIRE_NEVER_FAILS |
| k1 | | | ✓ | | ✓ | |
| k2 | | ✓ | ✓ | ✓ | ✓ | NEVER_SUCCEEDS |
| k3 | | | ✓ | | ✓ | |
| l1 ⚑ | | | ✓ | ✓ | ✓ | |
| l2 | | | ✓ | ✓ | ✓ | |
| m1 | | | ✓ | | ✓ | |
| m2 | | | ✓ | | ✓ | |
| n1 ⚑ | | | ✓ | ✓ | ✓ | |
| n2 ⚑ | | | ✓ | ✓ | ✓ | |
| p1 | ✓ | ✓ | ✓ | | ✓ | VIEW_WITHOUT_PERMISSION |
| p2 | | | ✓ | | ✓ | |

The one control false alarm, under the secondary rule only, was jc2: `REQUIRE_NEVER_FAILS`.

There were no checker crashes, and every case was scored.

## Caveats

- **Sample size:** n = 30 bugs and 20 controls, so the false-alarm rates are rough.
- **Agent-written corpus:** the bugs were written by agent sessions in assigned rule areas. Authors were told to start their scenarios from the slice scenarios, which favours both example arms equally. It doesn't favour the checker.
- **Exploration bounds:** the checker explores within bounds. Bugs that need larger states, such as a 41-message page, are out of its reach by design.
- **Deviations:** the first authoring round had blindness breaches (`docs/DEVIATIONS.md`). Results without the flagged cases are given, and the decision doesn't change.
- **Exploratory arm:** the Rust-plus-examples arm wasn't pre-registered, and wasn't run on the controls.

## What this means for the experiment

The H1 claim, that spec checks catch logic bugs tests miss, fails. The remaining case for
the DSL rests on other properties:
- **compactness and locality,** with rules in one place and 212 lines for the slice;
- **fast example runs;**
- **the living-app design** (H10).

These are measured by H2–H4 and H10, which test whether agents and people change the spec
more correctly or cheaply. H1 doesn't support them, and doesn't rule them out.
