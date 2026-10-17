# H7 result: migrations from spec diffs, on a blind corpus

*17 Oct 2026. Protocol: `docs/H7-PROTOCOL.md`. Corpus: 20 cases by 5 writer sessions in
`D:\code\crudspec-h7\cases`, frozen at SHA-256 `9034b23e…` (`docs/DEVIATIONS.md`). Scorer:
`h7/score.ts`, committed before any case was read. Migration code unchanged since `cd5232c`,
from before the corpus was written.*

## Decision

**Not killed, and not yet a success.**
- **No silent data loss in any case.** That is H7's kill criterion, and the one that matters most.
- **No destructive change without a `drop`.**
- **Success isn't met**, because it needs every expected refusal caught and every case's data correct. On the first run, 6 of 7 refusals were caught and 9 of 13 cases had correct data.
- **None of the 5 misses lost or damaged data.** All are explained below:
  - 3 are case errors;
  - 1 is a rule the documentation didn't state;
  - 1 is documentation that contradicted the implementation, which the checker didn't catch.

## Results

| | First run | After fixes |
| --- | ---: | ---: |
| Silent data losses | **0** | **0** |
| Destructive steps without `drop` | **0** | **0** |
| Expected refusals caught before apply | 6 / 7 | 6 / 7 |
| Expected-applied cases with correct data | 9 / 13 | 9 / 13 |

The fixes changed documentation and the checker, not migration behaviour. So the counts don't move. E-1 now fails at the spec check, before any migration runs.

## The five misses

| Case | What happened | Whose error | Data harmed? |
| --- | --- | --- | --- |
| B-2 entity rename with references | Applied. The case identifies `Order` rows by `id`, which isn't a field, and its expected rows carry no id, so nothing could match. Keyed on `amount` in a copy, every value is correct | the case: the key format | no |
| B-3 enum rename with a new field | The same: `Task` keyed by `id`. Keyed on `title` in a copy, every value is correct | the case: the key format | no |
| C-1 removal without drop | Applied, with the removed entity's rows kept. The case's note says removed data is kept until `drop`, which is the documented rule, but its expected data marks the row as must-be-gone | the case contradicts itself | no |
| D-1 new unique key | **Applied**; the case expected a refusal. Two users have no email. The runtime follows SQL: a key with an empty value never clashes. Rails' unique index does the same, and the equity scenarios checked that. `LANGUAGE.md` never said so | **the documentation:** the rule was unstated, and the writer's reading was reasonable | no |
| E-1 split a name with a migration | Refused; the case expected applied. The migration used `words(p.name)` as a list of words and `first(1, parts)`. In fact `words` is a word count, and `first` takes the list first. **`LANGUAGE.md` documented `first(n, l)`, the wrong order.** The checker didn't type builtin arguments, so the mistake surfaced as a JavaScript error inside the rehearsal. The upgrade was refused and nothing changed | **the documentation, and a checker gap** | no |

## Fixed after the first run

- `LANGUAGE.md`:
  - how unique keys treat empty values;
  - `words(text)` is a count;
  - `first(l)`, `first(l, n)`, `last(l)`, `last(l, n)`.
- A new `split(text)` / `split(text, sep)` builtin, for what E-1 wanted.
- The checker:
  - list functions (`first`, `last`, `join`, `chunks`, `distinct`, `any`, `sentence`) given a scalar first are `BUILTIN_ARGUMENT` errors;
  - `words`, `length`, `count` and `split` have result types.
- The interpreter: `join` on a non-list is a clean error, not a crash.
- The scorer prints "spec errors" when `next.crud` fails the check. This changes reporting only; no judgement changed.
- With the functions used as documented, a copy of E-1 applies with every value correct.

Equity (42 of 42 through the interpreter) and the 25 implementer-written migration cases still pass.

## What this shows, and what it doesn't

- **The safety properties held on cases their implementer didn't write.** No case lost data. Every case that should have been refused either was, or harmed nothing when it wasn't (D-1). Nothing was destroyed without a `drop`.
- **The documentation is part of the safety surface.** Two of the five misses came from the reference being silent or wrong. For agents maintaining a spec from its documentation, that is a finding in itself.
- **The corpus is small:** 20 cases, 4 per category.
- **Blinding was imperfect.** Writers C and E described their cases in their replies, and D gave its expected statuses (`docs/DEVIATIONS.md`). Their cases' results here are 3 of 4 correct (C) and 3 of 4 correct (E). The misses, C-1 and E-1, aren't ones prior knowledge could have helped.
- **The baseline (hand-written migrations with Atlas lint plus review) wasn't run**, as stated in advance.
