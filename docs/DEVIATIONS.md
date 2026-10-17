# Protocol deviations

Everything that went differently from `docs/TEST-PROCESS.md` and `corpus/AUTHORING.md`,
recorded when it was found. The scoring session reads this page.

## 16 Oct 2026: the first authoring round

Five author sessions (slots 1–5, prefixes a–e) ran in parallel, each asked for 14 bugs and 5
controls. The round mostly failed:

| Slot | Reported | Problem |
| --- | --- | --- |
| 1 (a) | 3 bugs and 5 controls confirmed | Its bugs disappeared from the corpus directory afterwards; two empty control folders remained |
| 2 (b) | 0 confirmed | Wrote its cases inside the repository (`D:\code\crudspec\corpus\v1\`), not the corpus directory |
| 3 (c) | 0 confirmed | Wrote patches by hand, and none applied |
| 4 (d) | 0 confirmed, stubs only | A background batch script it started kept rewriting and deleting case folders after the session ended |
| 5 (e) | 4 bugs confirmed (e02–e05) | Confirmed against spec v1, before amendment v1.1 |

Causes:
- Each session ran out of budget after a few cases.
- Writing patches by hand across the Windows/WSL boundary failed.
- All authors could write and delete in one shared directory.

### Breaches of the checker author's blindness

- **Repository commit.** Slot 2's early files (b01–b03) were swept into commit `bb6ab76` by `git add -A` and pushed. The checker author removed them in `8ef553f` without opening them. Their contents remain in the history of the private repository. Rewriting that history needs the owner's approval, and none of those cases are in the corpus.
- **Category maps.** Slots 1, 3, 4 and 5 put which ID is in which category or rule into their final reports, against the content-free reporting rule.
- **A content hint.** Slot 5 said that comparison-operator changes (`<` against `<=`) were its most efficient bugs. Its confirmed bugs are e02–e05, three of them in the paging category. This is the only report that hinted at what bugs do.
- **Process output.** While stopping the runaway script, the checker author saw the generic preamble of its command line: a helper that creates a case from sed commands. No bug-specific content was visible.

### What was done

- The leftover writer process was killed. Other leftover shells that mention the corpus could not be inspected or stopped from this session; they are left for the owner. One still rewrote `v1/bugs/d01`.
- `v1/bugs` and `v1/controls` are abandoned. Authors now write only in `v1/staging/slot-N/`. `tools/confirm_bug.py` refuses any case outside the slot's own staging directory. It records SHA-256 hashes of the spec and of the case files. `tools/corpus_assemble.py` copies only confirmed, current cases into `v1/final/`.
- e02–e05 were moved to `v1/staging/slot-5/` to be re-confirmed against v1.1. They keep their IDs. New authors get new prefixes, f onwards.
- **The checker is frozen before any new case is written** (tag `phase1-checker-v1`). The leaks above can't shape it. No check specific to paging or comparison operators was added after the hint.

### Flagged at scoring

The scoring session flags these cases, and reports H1 both with and without them, the same way as the overlap screen:
- e02–e05: their categories leaked, and so did the hint;
- any case that slots 1, 3 or 4 named in their reports.

As it stands, only e02–e05 survive from the first round.

## H7 and H2-F writing (17 Oct 2026)

- **H7 writer E reported its cases' contents**, against the content-free reporting rule. Its reply gave a one-line summary of each case: a name split, quantities clamped to satisfy a new invariant, a migration whose output collides with a unique key, and a Text to Int change that can't convert, with each one's expected status. The harness author read these. **No change was made to the migration code (`lang/schema.ts`, `lang/runtime/upgrade.ts`) between that report and the first scoring run.** E's cases are scored like the others and flagged in the report.
- **H7 writer D reported its expected statuses** (3 blocked, 1 applied) without describing the cases.
- **H2-F directory names carry topic slugs**, such as `G-3-message-admin-delete`. The writers named directories as the protocol's `<writer>-<n>-<slug>` pattern asks. The slugs reveal each task's subject, but not its checks or labels.
- **An acceptance-runner rule, added before any task was read.** Inside a message (`"in": "<message key>"`), a control that belongs to one of the message's boosts doesn't count, unless the step says `"boost": true`. Without the rule, "click Delete in m1" can hit the control for removing one's own boost instead of the message's Delete. Found with a sample check the harness author wrote himself (`h2f/accept.ts`).
- **H2-F tasks frozen** (17 Oct 2026): 15 tasks, 45 files. `D:\code\crudspec-h2f\FREEZE.txt` has SHA-256 `9ac4d15f7591ada55390cf557b792cced6dd2763aee8e5aba5992d633dd0fec2`. Only file names were listed; no task file was opened.
- **Overlapping H2-F topics, seen from directory names only.**
  - The writers were independent, and several chose the same idea:
    - a room topic or description (F-1, G-1, J-2);
    - admins deleting messages (G-3, H-2);
    - bookmarks or favourites (F-2, H-1).
  - So the 15 tasks cover about 10 distinct changes. Whether to replace the duplicates with new tasks from fresh writers, before any run, is the owner's decision.
- **H7 writer C also reported its cases' contents.** It summarised each case's intent and expected status: removal without drop; a dropped reference with cascade; a dropped entity others referenced; a remove-and-add expected to be refused. Read by the harness author after the freeze hashes were taken, and before scoring. No migration code changed. C's cases are flagged in the report, like E's.
- **H7 cases frozen** (17 Oct 2026): 20 cases, 100 files. `D:\code\crudspec-h7\FREEZE.txt` has SHA-256 `9034b23e78d2cbc9f5822de1c739a026333c40b85dac56365e619742789ec125`. The migration code (`lang/schema.ts`, `lang/runtime/upgrade.ts`, `lang/runtime/store-sqlite.ts`) was last changed in `cd5232c`, before any writer started.
- **H2-F duplicates replaced** (17 Oct 2026, by the owner's decision): G-1, H-1, H-2 and J-2 moved unread to `D:\code\crudspec-h2f\retired\`. They were replaced by fresh writers K (2 features) and L (a rule change and a schema change), who were told the taken subjects. Re-frozen: 15 tasks, 45 files, SHA-256 `f7b3e9135e3109a3e055f50ab60aeabc6f80b8fba5293e32b8a7d20d6569ce9f`.
