# Writing the v1 seeded-bug corpus

This guide is for the **bug authors**: sessions that are not the checker's
author. The checker author writes this page and the tools, but never reads the
corpus until it is frozen and the checker is frozen too (protocol rule 3; H1 in
`docs/HYPOTHESES.md`).

## Where cases go

```
D:\code\crudspec-corpus\v1\
  bugs\<id>\        bug.md, spec.patch, baseline.patch, oracle.json
  controls\<id>\    the same four files
```

This directory is **outside** the crudspec repository on purpose. Don't put
corpus content in the repository, in commit messages, or in anything you report
back. `<id>` is your author prefix plus a number, for example `a07`.

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
- **Don't check the Rust test suite.** Whether the baseline's own tests catch a bug is measured later, at scoring. Don't choose or tune bugs with them.
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

## Confirming a case

Each author gets a slot number N (a private Rust tree and port). Run:

```
python tools/confirm_bug.py D:\code\crudspec-corpus\v1\bugs\<id> --slot N
python tools/confirm_bug.py D:\code\crudspec-corpus\v1\controls\<id> --slot N --control
```

It prints `CONFIRMED` or `REJECTED`, with a reason, and writes `.work\confirm.json`
inside the case. A bug is confirmed only when:
- Rails runs the scenario;
- the unpatched spec and the unpatched Rust both match Rails;
- both patched forms differ from Rails.

If the unpatched forms disagree with Rails, the scenario is at fault: fix it,
or pick another scenario. Keep only confirmed cases. Delete rejected ones
rather than leaving them behind. Each run takes about a minute.

Practical notes:
- To run WSL commands, use the PowerShell tool (`wsl -d Ubuntu -u ben -- …`).
- For anything with quotes, write a script file and run `bash /mnt/d/...`.
- Generate `spec.patch` with `git diff --no-index` on two copies of the spec, then fix the path prefixes.
- Generate `baseline.patch` with `git -c safe.directory='*' diff` in a scratch copy of the Rust tree. Don't edit `~/linuxbench/crudspec-baseline/src` itself; the tool uses your slot's tree, `~/linuxbench/crudspec-mutant-N`.

## Reporting back

The checker author reads your final message, so it must contain **only**:
- the IDs you wrote;
- counts per category;
- counts of confirmed and rejected attempts;
- any tool problems.

No descriptions, rules, diffs or hints about what any bug does.
