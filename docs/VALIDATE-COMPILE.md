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

The deep checks (`lang/deep.ts`) run with `cli check --deep` and on every `cli build`; their findings are warnings. On Campfire they report the three signed-out actions without a rate limit (`first_run`, `transfer_session`, `join`) and `ban_user`, whose repeat for the same address is refused as a duplicate.

What the checker proves about each feature today, and how the feature compiles.

| Feature | Validated | Compiled | Gap |
| --- | --- | --- | --- |
| Entities, fields, types | Names resolve; light type checks | Columns, codecs, SQL, create, setters, delete, all generated | No full typing; nothing tracks whether a value can be none |
| `unique`, `ensure` | Fields exist | Generated key checks | A create keyed by its arguments, with no `ensure` or check first, is reported (`UNIQUE_UNGUARDED`, deep) |
| References, `on delete`, `touches` | Target entities exist | Generated cascades, restricts and touches | A delete a restricting reference can refuse, with no check or clearing first, is reported (`DELETE_RESTRICTED`, deep) |
| `invariant` | Names resolve | A generated check of the touched rows | Not proven preserved by actions |
| Enums | Values resolve; values and states no default, create, set or migration can reach, following the guards of each set, are reported (`ENUM_VALUE_UNREACHABLE`, deep) | Constants | None |
| Identities, gates | Names resolve | Generated lookups and formats; gates as Go functions | None |
| `permission read` | Every view has one (`VIEW_WITHOUT_PERMISSION`); screens show no unpermitted rows | Folded into each query's SQL | Writes to a row the caller chooses with no check of the actor first are reported (`WRITE_UNCHECKED`, deep); that the check is the right one is not proven |
| Predicates, functions | Arity, unknown names, builtin arguments | Go functions; inlined into SQL where possible | Return types are not checked |
| Actions | Names, arguments, reachability (`ACTION_UNREACHABLE`), internal actions never offered | Go functions; guards generated separately. Scalar parameters, top-level lets and `create … as` names bound once are typed Go variables. Still in the variable map: entity parameters (resolved lazily, so a missing row is not_found only where it is used), names bound inside `if` and loops, loop variables, trigger subjects, and workflow lets that run externs | Signed-out actions that write without a rate limit are reported (`SIGNED_OUT_UNLIMITED`, deep); outcomes the UI leaves unhandled are not |
| `rate_limit` | Expressions resolve | Generated counter call | See actions |
| Views (`window`, `around`, `page`) | Permission present | SQL plus generated windowing | None |
| Triggers | Names resolve | Called directly by the writes that set them off | Triggers that can set each other off in a loop are reported (`TRIGGER_CYCLE`, deep) |
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
