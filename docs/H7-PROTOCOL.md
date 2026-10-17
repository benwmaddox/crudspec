# H7 protocol: are migrations from spec diffs safe?

Pre-registered 17 Oct 2026, before any case is written. This page refines H7 as revised in
`docs/AGENT-GOAL.md`. Its thresholds were approved on 17 Oct 2026 and stand.

## Question

When a spec changes and the app restarts, does the upgrade keep every stored value? Does it
refuse changes the data can't take before touching anything? Does it destroy data only where
the spec explicitly says `drop`? And does the data end up as the change intended?

## Cases

- **20 cases**, written by **5 writer sessions** of 4 cases each, one category per session:

  | Writer | Category | Cases |
  | --- | --- | ---: |
  | A | additive changes (new entities, fields, defaults, enum values) | 4 |
  | B | renames (fields, entities, enum values), including references to renamed things | 4 |
  | C | removals and drops, including cascades and fields that come back | 4 |
  | D | data-dependent changes (new unique keys, invariants, required fields, narrowed types, removed enum values), some of which the data breaks | 4 |
  | E | data migrations (`migration` blocks), type changes, ambiguous changes | 4 |

- **Each case is a directory** `D:\code\crudspec-h7\cases\<writer>-<n>-<slug>\` containing:
  - `README.md`: what the developer wants, and what a safe upgrade does. Plain language.
  - `base.crud`: the spec before. It must pass `node lang/cli.ts check`.
  - `next.crud`: the spec after. It must pass the same check.
  - `seed.json`: data for the base spec, in the runtime's fixture format (`/_test/fixture`: `rows` created as `create` would create them, then `steps` run as named people).
  - `expect.json`:
    ```
    { "status": "applied" | "blocked",
      "key": { "<Entity>": "<field that identifies a row>" },
      "data": { "<Entity>": [ { "<field>": <value>, … }, … ] },
      "note": "why" }
    ```
    - `applied`: after the upgrade, each listed row (found by its key field) has the listed values. Unlisted fields are not compared.
    - Values are written as JSON: text and enum values as strings, `Int` as numbers, `Bool` as `true`/`false`, an empty value as `null`. A **reference** is written as the referenced row's key-field value. A `set of` is a list of key-field values. `Time`, `File` and `Password` fields aren't compared.
    - A row the upgrade must remove is written `{ "<key field>": …, "_absent": true }`.
    - `blocked`: the upgrade must be refused, and the database left exactly as seeded.
- **Writers may read** `lang/LANGUAGE.md`, the example specs `apps/tasks/tasks.crud` and `apps/campfire/campfire.crud`, and this page.
- **Writers may run:**
  - `node lang/cli.ts check`;
  - the runtime on a **base** spec in `--test` mode on their own port, to check their `seed.json` loads through `/_test/fixture`.
- **Writers must not:**
  - read `lang/schema.ts`, `lang/runtime/upgrade.ts`, `lang/runtime/store-sqlite.ts` or anything under `lang/test/`;
  - read the other writers' cases;
  - run `plan`, `migrate`, or a runtime on a `next.crud`.

  The expected outcome comes from the documented rules and the developer's intent, not from trying the implementation.
- **Freezing:** the harness author counts the cases and checks the file list, without reading the contents. He then hashes every file into `D:\code\crudspec-h7\FREEZE.txt`, and the hash of that file is committed in `docs/DEVIATIONS.md`.

## Scoring

The harness author writes `h7/score.ts` before reading any case, against the format above. For each case it:
1. starts the runtime on `base.crud` in `--test` mode with a fresh data directory, and loads `seed.json`;
2. stops it, records every stored value, and runs `node lang/cli.ts migrate next.crud --data <dir> --json`;
3. reads the database and compares it with `expect.json` and the seeded values.

**Outcomes per case:**
- **Silent data loss:** a seeded value of a field or row is gone or changed, while the next spec neither drops it (`drop`) nor renames it, `expect.json` doesn't list the change, and no `migration` block wrote it.
- **Caught before apply:** for an expected `blocked`, the upgrade was refused and the database is unchanged.
- **Destructive without `drop`:** a column or table was removed that no `drop` named.
- **Data correct:** for an expected `applied`, every listed value matches.

**Decision**, as revised in `docs/AGENT-GOAL.md`:
- **Success:**
  - 0 silent data losses;
  - 100% of the expected-`blocked` cases caught before apply;
  - no destructive step without a `drop`;
  - every case's data correct.
- **Kill:** any silent data loss that the design can't prevent.
- **Neither:** wrong outcomes that are bugs in the implementation. They're reported, fixed, and the corpus rerun. Both the first-run and the after-fix results go in the report.

## Caveats, stated in advance

- **Blinding rests on the writers following their instructions.** The writers share the machine.
- **The writers know the documented rules.** The test is whether the implementation keeps the documented promises on cases its author didn't write. It doesn't test whether the rules are wise.
- **The baseline in H7 ("hand-written migrations with Atlas lint plus review") isn't run.** This corpus measures the absolute safety criteria only.
