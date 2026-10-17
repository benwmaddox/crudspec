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
