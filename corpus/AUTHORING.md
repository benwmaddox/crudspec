# Writing the v1 seeded-bug corpus

This guide is for the **bug authors**: sessions that are not the checker's
author. The checker author writes this page and the tools, but never reads the
corpus until it is frozen and the checker is frozen too (protocol rule 3; H1 in
`docs/HYPOTHESES.md`).

## Where cases go

```
D:\code\crudspec-corpus\v1\staging\slot-N\
  bugs\<id>\        bug.md, spec.patch, baseline.patch, oracle.json
  controls\<id>\    the same four files
```

`N` is the slot number in your instructions; `<id>` is your prefix plus a number,
for example `f1`. Write and delete **only inside your own slot directory**, never
anywhere else under `D:\code\crudspec-corpus`, and never under `D:\code\crudspec`.
A separate step copies confirmed cases into the corpus (`v1\final`).

This directory is **outside** the crudspec repository on purpose. Don't put
corpus content in the repository, in commit messages, or in anything you report
back.

## What a case is

One realistic wrong change (a bug), or one realistic correct change (a control),
written twice with the same behaviour:

| File | Contents |
| --- | --- |
| `spec.patch` | A unified diff against the frozen `spec/campfire.crud` (tag `phase0-dsl-v1`), with paths `a/spec/campfire.crud` and `b/spec/campfire.crud`. The patched spec must still be valid DSL v1 (`docs/LANGUAGE.md`). |
| `baseline.patch` | A `git diff` against the Rust port at `6dae2fd` (`~/linuxbench/crudspec-baseline/src` in WSL), with paths relative to that repository's root. It must build. |
| `oracle.json` | One scenario in the oracle's format (see `oracle/scenarios/slice-v1/*.json` and the action list in `oracle/rails/oracle.rb`, `request_for`). It must expose the bug: Rails and the bug disagree on some action's outcome, a listed row, or the final state. |
| `bug.md` | Front matter, then a short description (below). |

```
---
kind: bug            # or control
category: permission-leak
rules: [R13, P2]     # docs/RULE-INVENTORY.md IDs the change touches
source: invented     # invented | campfire-issue | agentlang-failure
touches_invariants: false   # true if spec.patch edits or removes an `invariant` line
---
What is wrong (or, for a control, why it looks suspicious but is correct), the
realistic story of how someone would write it, and which action in oracle.json
exposes it.
```

## Rules for bugs

- **Realistic.** A change a developer or an AI agent could plausibly make while doing ordinary work: a forgotten guard, a wrong comparison, a mis-scoped `where`, a trigger condition that is too broad, a cleanup step lost in a refactor, an off-by-one. Not obvious sabotage, like `require false` or deleting a whole action.
- **Small.** Usually one to ten changed lines in each form.
- **The same wrong behaviour in both forms.** If the Rust form needs extra changes to compile, they must not change any other behaviour.
- **Spread across categories** (`corpus/README.md`), including ones a static checker may not catch, such as paging, ordering, and wrong outcome classes. Don't aim bugs at, or away from, any checker. None exists yet, and you shouldn't guess at its design.
- **Don't read** `docs/DESIGN-SKETCH.md`, `docs/HYPOTHESES.md`, `docs/TEST-PROCESS.md` or `docs/LESSONS-FROM-AGENTLANG.md`. They describe what the checker is meant to catch. Everything you need is in this page, `docs/LANGUAGE.md`, `docs/RULE-INVENTORY.md`, the spec, the oracle and the Rust source.
- **Also don't read** `tools/scenario_adequacy.py`, anything under `.scratch/`, or `oracle/replays/mutant-*`. They hold mutations the checker author already knows, so any overlap with them must be coincidence.
- **The crudspec repository is read-only to you:** no edits, commits or pushes. **Don't write or edit memory files** (`C:\Users\Ben\.claude\projects\D--code\memory\`); every later session, including the checker's, loads them.
- **Don't check the Rust test suite.** Whether the baseline's own tests catch a bug is measured later, at scoring. Don't choose or tune bugs with them.
- **Bugs** stay in the category or rule areas your slot is assigned in your instructions, so parallel authors don't collide. Controls may be anywhere.
- Bugs that edit or remove `invariant` lines are allowed, but mark them `touches_invariants: true`, and keep them to at most one in five of your bugs.
- Categories DSL v1 can't express (migrations, efficiency, time zones) are out of scope for v1. Don't write them.
- Don't duplicate a case that already exists in the corpus directory.

## Rules for controls

- Correct changes that **look** suspicious to a reviewer or a checker:
  - an equivalent rewrite of a predicate or `where`;
  - reordering independent statements;
  - a redundant extra guard;
  - renaming a binding;
  - a trigger split in two;
  - an extra `ensure` that is already implied;
  - a comment or format change in a tricky spot.
- Behaviour must be identical on the frozen slice **and** on the control's own scenario. The tool checks both.

## Making and confirming a case: the exact steps

Do one case at a time, and take it all the way to `CONFIRMED` before starting the
next. Run everything with the **PowerShell** tool, from `D:\code\crudspec`.

1. `python tools/case_patches.py tree N` resets your editable copies:
   - `D:\code\crudspec-authoring\author-N\campfire.crud` (the spec);
   - `D:\code\crudspec-authoring\author-N\rust\` (the Rust source).
2. Make the change in both copies with the Read and Edit tools. Read the Rust source there as well.
3. Write `oracle.json` and `bug.md` in your case directory. Start from a slice scenario that exercises the rule, then cut it down.
4. `python tools/case_patches.py spec <case-dir> N` writes `spec.patch`.
5. `python tools/case_patches.py rust <case-dir> N` writes `baseline.patch`.
6. `python tools/confirm_bug.py <case-dir> --slot N` (add `--control` for a control). It takes about a minute, and prints `CONFIRMED` or `REJECTED` with a reason.
7. If it's rejected:
   - fix the case and go back to step 4;
   - or delete the case directory and start another.

Rules:
- **Never write a patch by hand.** Patches come only from steps 4 and 5.
- **Leave nothing running.** No background commands and no loops, and wait for every command to finish.
- The confirmer accepts a case only from your own slot directory.

The confirmer confirms a bug only when:
- Rails runs the scenario;
- the unpatched spec and the unpatched Rust both match Rails;
- both patched forms differ from Rails;
- they differ **the same way**: the patched spec reproduces the patched Rust run.

If the unpatched forms disagree with Rails, the scenario is at fault.

## Reporting back

The checker author reads your final message, so it must contain **only**:
- the IDs you wrote;
- counts per category;
- counts of confirmed and rejected attempts;
- any tool problems.

No descriptions, rules, diffs or hints about what any bug does.
