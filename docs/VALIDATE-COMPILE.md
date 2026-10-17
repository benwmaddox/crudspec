# Validate, then compile

*The owner, 17 Oct 2026.*

**The principle.** A spec is validated, then compiled into efficient Go. Nothing in it is interpreted at run time.

- **Validation:** it helps developers, and agents, be accurate and consistent. The point of declaring everything is that the checker can follow the connections a normal app leaves implicit: who can read a row, what an action may delete, which screen offers which action. Then it can say what is wrong before anything runs.
- **Compilation:** it keeps the promise the validation makes. Every feature becomes generated Go code, with SQL planned at build time. The runtime library only stores, serves and formats.

**Every feature is held to both halves.** A new feature is done when:

1. the checker validates its syntax and its connections to the rest of the spec;
2. the generator compiles it to Go, with no run-time walk of spec structures;
3. it is covered by equity, screens or end-to-end checks.

**The pipeline:**
- **Checker (`lang/check.ts`):** `node lang/cli.ts build` runs it first, and a spec with errors is never compiled.
- **Generator (`lang/gogen/gen.ts`):** it refuses, with the spec line, any construct it can't compile. It never emits a placeholder.
- **Compiled binary:** checked against the Rails oracle (42 scenarios), the screens baseline (18) and the agent end-to-end check.

## Feature audit (17 Oct 2026)

What the checker proves about each feature today, and how the feature compiles.

| Feature | Validated | Compiled | Gap |
| --- | --- | --- | --- |
| Entities, fields, types | Names resolve; light type checks | Columns, codecs, SQL, create, setters, delete, all generated | No full typing; nothing tracks whether a value can be none |
| `unique`, `ensure` | Fields exist | Generated key checks | A create that can clash is not reported |
| References, `on delete`, `touches` | Target entities exist | Generated cascades, restricts and touches | A delete that can hit `restrict` is not reported |
| `invariant` | Names resolve | A generated check of the touched rows | Not proven preserved by actions |
| Enums | Values resolve | Constants | Unreachable values and states are not reported |
| Identities, gates | Names resolve | Generated lookups and formats; gates as Go functions | None |
| `permission read` | Every view has one (`VIEW_WITHOUT_PERMISSION`); screens show no unpermitted rows | Folded into each query's SQL | Writes are not checked against an authorization rule |
| Predicates, functions | Arity, unknown names, builtin arguments | Go functions; inlined into SQL where possible | Return types are not checked |
| Actions | Names, arguments, reachability (`ACTION_UNREACHABLE`), internal actions never offered | Go functions; guards generated separately | Outcomes the UI leaves unhandled are not reported; signed-out actions without a rate limit are not reported |
| `rate_limit` | Expressions resolve | Generated counter call | See actions |
| Views (`window`, `around`, `page`) | Permission present | SQL plus generated windowing | None |
| Triggers | Names resolve | Called directly by the writes that set them off | Trigger cycles are not reported |
| Workflows, externs | `EXTERN_OUTSIDE_WORKFLOW`, `WORKFLOW_NEVER_RUNS`, unknown externs | Go steps; externs run with the writer released | None |
| Channels, signals | Unknown channels and signals | Generated argument decoding | Signals are not built in the runtime |
| Bot API (`api`) | Targets resolve | Generated path typing and arguments | None |
| Agent API | Derived from the spec (`lang/describe.ts`), and its annotations checked against runs | Generated argument checks and row views | None |
| Screens, components, layouts | Unknown screens, components and layouts; `it` and `.field` outside a where | Each one a Go function writing HTML | Requires that can never hold are not reported |
| Forms, fields, buttons | Fields match parameters (`FIELD_NOT_A_PARAMETER`); kinds match types; required inputs present; choices exist | Generated; buttons check the compiled guards | Dead buttons are not reported |
| Widgets, theme, display, avatar | Unknown widgets | Generated; app widgets in the app's `widgets.go` | None |
| Migrations, `drop`, `was` | `MIGRATION_EFFECT`, `DROP_DECLARED`, `WAS_CONFLICT`; upgrades planned and rehearsed | Run by `cli migrate`; the binary checks the database version | None |

The compile half is complete: no feature is interpreted. The validation half has the gaps in the table.

**The order to close them:**
1. **Full typing with none-tracking.** It also unlocks typed Go, the main remaining speed gain.
2. **Write authorization**, plus rate limits on actions open to signed-out visitors.
3. **Unique clashes, reachable restricts, trigger cycles.**
4. **Unhandled outcomes, dead buttons, enum and state reachability.**
5. **Invariant preservation, and a query-cost bound per page.**

The checker is frozen for the experiment's runs. These checks are added as a separate deep pass, `cli check --deep`, unless the owner decides otherwise.
