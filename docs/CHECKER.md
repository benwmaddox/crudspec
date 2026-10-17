# The Phase 1 checker (frozen at tag `phase1-checker-v1`)

`node tools/src/cli.ts check <spec.crud> --scope spec/campfire.scope.json` runs two
passes:
- static checks;
- then, if there are no static errors, bounded exploration with the reference interpreter.

`tools/check_patch.py` applies a `spec.patch` and both pre-registered rejection rules
(`docs/HYPOTHESES.md`, H1).

The checker was frozen before the restarted corpus was written. It may not change
until H1 is scored, so the leaks in `docs/DEVIATIONS.md` can't have shaped it.

## Static checks (errors unless noted)

| Code | What it rejects |
| --- | --- |
| `UNKNOWN_NAME`, `UNKNOWN_FIELD`, `UNKNOWN_ENTITY`, `UNKNOWN_ENUM_VALUE`, `UNKNOWN_PREDICATE`, `UNKNOWN_TYPE`, `UNKNOWN_GATE` | Names that don't resolve |
| `TYPE_MISMATCH`, `NOT_BOOL`, `NOT_INT`, `IN_NEEDS_SET`, `FIELD_OF_NON_ROW`, `SET_NON_ROW`, `DELETE_NON_ROW`, `ARITY`, `NONE_FOR_REQUIRED` | Ill-typed expressions and statements, including comparisons across enums or entities |
| `MISSING_FIELD`, `DUPLICATE_FIELD`, `CREATE_SINGLETON` | Creates that can't succeed |
| `ACTOR_UNGATED` | `actor` used in an action that skips `signed_in`, where it is `none` |
| `PREDICATE_RECURSION` | A predicate that calls itself |
| `VIEW_WITHOUT_PERMISSION` | A view over an entity that has no read permission |
| `TRIGGER_CYCLE` | Triggers that can fire each other in a loop |
| `TRIGGER_ORDER` | Two triggers on the same event that write the same field, or where one deletes rows the other writes |
| `WORKFLOW_NOT_IDEMPOTENT` | A workflow step that creates without a unique `ensure`, or emits; a retried step would repeat it |
| `PERMISSION_COVERAGE` (warning) | A writing action, behind `signed_in`, with no `require` that mentions `actor` |
| `ENSURE_WITHOUT_UNIQUE`, `WORKFLOW_NEVER_RUNS` (warnings) | Constructs that can't do what they appear to |

## Bounded exploration

**Method.** Exploration starts from the scope's seed states, two in the Campfire scope. It
runs every action and view with every actor and argument combination. The combinations
cover:
- every existing row, plus one that doesn't exist;
- sets of up to two rows;
- all enum values, plus one invalid value;
- the scope's text and IP values.

It runs breadth first, with deduplicated states and per-entity row bounds, for 300,000
runs. Then it takes 300 seeded random walks of 25 steps each, under looser bounds. It is
deterministic.

| Code | What it rejects |
| --- | --- |
| `INVARIANT_VIOLATION` | An action that can end `invalid` because it would break a declared invariant |
| `INVARIANT_AFTER_WORKFLOW` | An invariant broken once workflows have run |
| `UNIQUE_VIOLATION` | A `create` that can collide with a unique key, or duplicate rows left by a workflow |
| `RESTRICT_VIOLATION` | A delete that can hit an `on delete restrict` reference |
| `CARDINALITY` | A `the(…)` that can match zero rows or several |
| `MISSING_REQUIRED`, `STALE_ROW`, `RUNTIME_ERROR`, `WORKFLOW_FAILED` | Other failures that no rule of the action explains |
| `PERMISSION_LEAK` | A view that returns a row its entity's read permission doesn't allow |
| `REQUIRE_NEVER_FAILS`, `NEVER_SUCCEEDS`, `ENUM_VALUE_UNREACHED` (warnings) | Guards that never failed, actions that never succeeded, and enum values never stored, all within the explored states |

**Why exploration replaces the SMT proof in the design sketch.** Exploration runs the
reference interpreter itself, so the checker can't disagree with the semantics. An SMT
encoding would be a second semantics, needing its own validation. The cost:
- exploration finds violations only within its bounds, where SMT would prove their absence for all states;
- it can't see bugs that need more than its bounds, such as a 41-message page.

## Results at the freeze

| Run | Result |
| --- | --- |
| Reference spec v1.1 | 0 errors; 2 warnings (`PERMISSION_COVERAGE` on `create_direct_room`, `ENUM_VALUE_UNREACHED` for `User.role = bot`); 56,712 states in about 16 s |
| Reference spec v1 | 2 errors: the Membership invariant break that Rails confirmed, which led to amendment v1.1 |
| Development set: 26 known mutations (`tools/checker_devset.py`) | Primary rule **1/26**; secondary rule **9/26** |

This is the main expectation going into H1. The spec *is* the behaviour, so the checker
can only reject a change that contradicts something else the spec says: an invariant, a
read permission, a unique key, or the language's own rules.

A wrong authorization rule contradicts none of these in a v1 spec, so it passes the
primary rule. The secondary rule catches some such changes, through guards that never
fail. Its false-alarm rate on the controls is unknown until scoring.
