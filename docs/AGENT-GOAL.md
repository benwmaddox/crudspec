# Goal: a compact, verified app definition that AI agents can maintain safely

*Set 17 Oct 2026. Thresholds approved 17 Oct 2026; migration (proposal A) is built first. This page records the goal, what "safely" means, the research behind the
next steps, the design proposals, and the experiments that would show the goal is met or
not. Thresholds marked (proposed) await approval.*

## What the goal means

Two kinds of agent matter:
- **Maintainers** change the app: they edit the spec, migrate its data, and add features.
- **Users** work in the app through an API or CLI, alongside people using the UI.

For both, **safe** means four checkable things:

| Property | Meaning | How it is checked |
| --- | --- | --- |
| No silent data loss | No change deletes or rewrites stored data unless the spec says so explicitly | Migration plans; post-migration checks; backup before applying |
| No silent permission widening | A change that lets anyone see or do more than before is reported | Permission diff, checked by bounded exploration over the interpreter |
| No silent contract break | A change that breaks API or CLI callers is reported | Descriptor diff between spec versions |
| Preserving | Behaviour not named in the change request stays the same | Scenario replay, as in H2 |

**Compact** and **verified** serve these. Compactness lets an agent hold the whole app in
context: Campfire's spec is about 59 KB, roughly 15,000 tokens. The verification comes from
the checker, the scenarios, the migration plan and the change report.

## What the review found (17 Oct 2026)

- The logic layer works:
  - Campfire matches Rails on 42 of 42 scenarios.
  - Rules live in one place.
  - Fixes were a line or two of spec.
- The checker's restrictions haven't paid for themselves as bug-finders: H1 was killed.
  - Its useful catches were wiring errors.
  - Recast as **safety reports for changes**, below, the same machinery has a clearer job.
- The UI sublanguage is the weakest part:
  - it is about as long as the Rails views it replaces;
  - it carries CSS class strings;
  - it hides JavaScript in widgets;
  - it had the most bugs.
- `lang/` absorbs each app's features, because apps have no extension point.
- The living spec covers additive changes on restart only. A restart is acceptable (decided 17 Oct 2026); renames, removals and data migrations are not handled yet.

## Research

**Agents and unfamiliar languages.**
- LLM code generation is reliable for mainstream languages and brittle for low-resource DSLs. Grammar-constrained decoding fixes syntax but not wrong references ([survey](https://arxiv.org/pdf/2410.03981), [decode-time grammars](https://arxiv.org/pdf/2607.18357)).
- So for crudspec, the checker's name and type errors, and their fix hints, matter more than the grammar.
- H3 measures the learning cost.

**Schema migration tools.**
- [Gel (EdgeDB)](https://docs.geldata.com/reference/datamodel/migrations):
  - the schema file is the single source of truth;
  - the database diffs it against its own recorded schema;
  - it asks about ambiguities, such as a rename or a default for a new required field.
- [Ash](https://ash-postgres.hexdocs.pm/migrations-and-tasks.html) keeps resource snapshots, generates migrations from the diff, and asks whether a change is a rename.
- [Django](https://docs.djangoproject.com/en/stable/ref/migration-operations/):
  - also asks about renames;
  - misses a rename if anything else about the field changed;
  - leaves data changes to hand-written `RunPython`.
- [Atlas](https://atlasgo.io/lint/analyzers) classifies changes as destructive (drops) or data-dependent (adding a unique or not-null constraint may fail on existing data). It can gate review on that.
- **The common weakness for agents:** these tools *prompt*, and an agent can't answer a prompt reliably. Agent-facing tools should take every decision as declared input and refuse, with a named fix, when it is missing ([agent CLI guidance](https://github.com/nerveband/cli-best-practices)).
- **What crudspec can add:** it holds the whole dataset and can evaluate the spec's own invariants. So a plan can be *checked against the real data* before it is applied: every row, not just the constraint types Atlas knows. Data migrations can be written in the spec language and checked the same way.
- The [expand/contract pattern](https://dev.to/jp_fontenele4321/the-expand-and-contract-pattern-for-zero-downtime-migrations-445m) is the standard way to make destructive changes safe: keep the old shape until the new one is verified. Restarts are allowed here, so a simpler form suffices: keep removed data until an explicit drop.

**Interfaces for agents that use the app.**
- [Ash AI](https://ash-ai.hexdocs.pm/readme.md) exposes declared actions as agent tools and MCP. It is the closest existing tool; its tool list is written by hand.
- [MCP tool annotations](https://aident.ai/blog/mcp-tool-annotations-explained) declare whether a tool is read-only, destructive, idempotent or open-world. Clients use them to auto-approve, confirm or retry. An unannotated tool counts as the worst case. Today the annotations are written by hand and nothing checks them.
- Agent CLI and API guidance:
  - JSON output on request;
  - a fixed set of error kinds with exit codes and hints;
  - no prompts;
  - `--dry-run` for destructive or non-idempotent commands, saying whether the server checked the preview;
  - idempotency keys;
  - observable results ([1](https://dev.to/tumf/agentic-cli-design-7-principles-for-designing-cli-as-a-protocol-for-ai-agents-2c10), [2](https://www.freecodecamp.org/news/how-to-design-apis-for-ai-agents/), [3](https://api7.ai/blog/designing-apis-for-agentic-clis)).
- **What crudspec can add:**
  - The spec says what each action writes. So annotations can be **derived and then verified** by running the action in the interpreter, not just declared.
  - Every action is a transaction, so a dry run that the server really checked is nearly free: run, report the changes, roll back.

**UI for generated and agent-maintained apps.**
- Production generative UI converges on a **constrained component catalog**: a fixed set of components with typed props and allowed children, plus **semantic design tokens**, and **visual regression** to hold the line ([constrained UI](https://puckeditor.com/blog/ai-slop-vs-constrained-ui), [generative UI in production](https://tianpan.co/blog/2026-04-27-generative-ui-production-discipline)).
- [A2UI](https://dev.to/czmilo/the-complete-guide-to-a2ui-protocol-building-agent-driven-uis-with-googles-a2ui-in-2026-146p) takes the same idea across clients: the agent names components, and each client decides how they look.
- crudspec's raw class strings are the opposite of this.

## Proposals

### A. Version and data migration (restart is fine)

> **Status (17 Oct 2026): built.**
> - Code: `lang/schema.ts`, `lang/runtime/upgrade.ts`, `lang/cli.ts plan|migrate`, and the runtime upgrades on start.
> - Tests: 25 cases in `lang/test/migrate.test.ts`, all passing. Equity is still 42/42.
> - On real Campfire data:
>   - the first upgrade recorded a baseline after checking every key and invariant;
>   - a new `User.handle` with a unique key was refused, naming 3 duplicate rows;
>   - a 3-line migration then made the plan ready.
> - A review before release found four gaps, all fixed and tested:
>   1. the swap wasn't crash-safe;
>   2. `migrate` could run under a live app;
>   3. type changes claimed checks that didn't run;
>   4. entity renames didn't reach entity names inside sets and mentions.
> - **Deviations from the list below:**
>   - stale `was` hints and applied migrations come out as plan notes, not checker warnings;
>   - enum renames don't rewrite values inside Json fields;
>   - on a new database, migrations are recorded as applied without running.
> - **Papercut seen:** a `for each` loop variable isn't visible in its own `where`. The checker reports it, and the fix is to test inside the body.
> - **The H7 corpus is still to be written**, blind, by a separate session. These 25 cases were written by the implementer and don't count toward H7.

1. **Versions are recorded.**
   - On each successful start, the runtime stores the spec's normalized schema, the spec hash and a version number in the database: entities, fields and types, uniques, enums, invariants, and the action and view signatures.
   - The next start diffs against that record. No separate snapshot files are needed.
2. **The plan is computed, classified and checked against the data, before anything changes.**

   | Class | Examples | What happens |
   | --- | --- | --- |
   | Safe | new entity; new optional field; new field with a default (evaluated per row, so it may read other fields); new enum value; a type widened (`Text` to `Text?`) | applied |
   | Data-dependent | a new unique key; a new invariant; a new required field without a default; a narrowed type; an enum value removed; a reference made required | the planner evaluates it on every row and lists the violating rows. The plan is blocked unless a data migration fixes them |
   | Destructive | a field or entity removed | the data is **kept** (as today) until an explicit `drop` in the spec. Deleting a line never deletes data |
   | Ambiguous | a field removed and another added in the same entity | refused until the spec says `was`: `nickname: Text was name` |

3. **Data migrations are written in the spec language.**
   - Example: `migration "split names" { for each u in User { update u { first_name: first_word(u.name) } } }`.
   - Each runs once, inside the upgrade transaction, before the new invariants are checked. It is recorded by name.
   - These are the same statements as actions, so the interpreter runs them and the checker checks them.
4. **Applying a plan:**
   - back up the database file;
   - in one transaction:
     - run the steps;
     - run the data migrations;
     - check every invariant and unique key on every row;
     - commit, or roll back and refuse to start.
   - The refusal prints the plan as JSON.
5. **Agent commands:**
   - `crudspec plan <spec> --data <dir> --json`: no prompts; it runs the plan on an in-memory copy and reports rows changed per entity, check results and blockers;
   - `crudspec migrate`: applies the plan.
   - Stale `was` hints and applied migrations raise checker warnings, so they can be cleaned up.
6. **The plan also reports contract changes:**
   - an action or view removed or renamed;
   - a new required parameter;
   - an outcome that disappeared.

### B. One generated interface for agents: HTTP, MCP and CLI

> **Status (17 Oct 2026): built**, apart from what's listed under "Not built".
> - Code: `lang/describe.ts`, `lang/runtime/agent.ts`, `lang/review.ts`, and `cli describe|call|review`.
> - Campfire and Tasks opt in with one line each: `identity agent: … from token`.
>
> **Checks:**
> - Derived annotations agree with the interpreter on all 34 callables the scenarios exercise (`apps/campfire/test/annotations.ts`).
>   - 13 are never exercised, so their claims are unchecked: 9 views (read-only by construction, since a view's changes are discarded) and 4 actions (`delete_logo`, `delete_avatar`, `subscribe_push`, `unsubscribe_push`) plus `send_test_notification`.
> - `apps/campfire/e2e/agent.mjs`, end to end over HTTP:
>   - tokens, describe, idempotency-key replay, and a key reused for a different call being refused;
>   - typed argument errors;
>   - confirmation: `confirm_required`, a server-checked dry run, `stale` after a change, then a confirmed delete;
>   - the read-only scope, no secret fields, the audit;
>   - deactivation cutting off an agent;
>   - an MCP write from a banned address being blocked;
>   - 405 on GET `/_mcp`.
> - `apps/campfire/e2e/mcp-client.mjs`: the official MCP TypeScript SDK client (1.32) connects over Streamable HTTP with a bearer token, lists the tools, reads, and runs the confirm flow.
> - `lang/test/agent.test.ts`, 6 cases:
>   - dry runs count against rate limits;
>   - an unresolved delete needs confirmation;
>   - private fields stay private;
>   - read-only tokens can't write;
>   - idempotency keys are bound to their call;
>   - the identity's `where` is rechecked.
> - `apps/campfire/test/review.test.ts`, 9 cases:
>   - removing an ownership check is flagged as widened;
>   - opening message or room reads is flagged as widened;
>   - restricting boosts is flagged as narrowed only;
>   - a new members-can-wipe-a-room action is found by synthesized calls;
>   - renaming `User.role` with `was` reports no access change, because probe states are migrated first;
>   - removing a gate on agents is flagged as widened, for agents only;
>   - an unchanged spec reports nothing over 22,822 runs.
>
> **Holes found in review and fixed:**
> - MCP calls had dropped the client's address, which bypassed the IP ban.
> - Dry runs had skipped rate limits, so they could be used to guess.
> - Unresolved deletes had skipped confirmation.
> - Idempotency keys weren't bound to their call.
> - `review` didn't explore new actions.
> - `review` ran the new spec on unmigrated states.
> - Probes had no agent identity.
>
> **Policies chosen:**
> - `destructiveHint` covers updates as well as deletes, as MCP defines it.
> - Confirmation is needed for deleting rows of a kind the action doesn't create, or for any unresolved delete. The "kind it creates" exemption is a known policy risk; `review` lists new deletes.
> - Workflow effects are listed separately and don't make an action need confirmation.
> - Emails are visible to agents because Rails shows them on every profile.
>
> **Not built:**
> - spec-declared agent scopes (tokens are read-only or full);
> - `explain`;
> - file uploads for agents;
> - field-level read rules (row-level permissions plus `private` only).
>
> **Limits:**
> - The exploration covers the states the scenarios reach, plus synthesized arguments for new and changed callables. It is a bounded search, not a proof.
> - Campfire's comments are mostly Rails file references, so its descriptions are mostly the generated effect summaries.

1. **A descriptor generated from the spec:**
   - each action's parameters, types and possible outcomes;
   - each view's parameters and row shape;
   - descriptions from the spec's comments;
   - **derived effects:**
     - which entities the action creates, updates or deletes;
     - whether it reaches an extern, via events and workflows, which makes it open-world;
     - read-only for views.
2. **Three surfaces over the same code path as the UI**, so permissions, gates and rate limits are identical:
   - JSON over HTTP;
   - an MCP endpoint, with one tool per action and per view;
   - a CLI: `crudspec call <app> <action> --param … --json --dry-run`.
3. **MCP annotations come from the derived effects:**
   - read-only for views;
   - destructive when the action deletes rows or overwrites fields;
   - idempotent when running it twice in the interpreter leaves the same state. That property is checked by bounded exploration, not asserted.
4. **Dry run:**
   - runs the action and rolls it back;
   - returns the outcome, the row changes and the events and externs that would follow;
   - marks the preview as server-checked.
5. **Confirmation for destructive actions:**
   - The dry run returns a token bound to the arguments and the data version.
   - Applying requires the token, so the confirmed change is the one that runs, or it fails as stale.
6. **Errors:**
   - The spec's outcomes are already a fixed set: `invalid`, `forbidden`, `not_found`, `unauthenticated`, `blocked`. They map to error kinds and CLI exit codes.
   - The hint names the failing `require` or invariant.
   - `blocked` carries the retry time.
7. **Agent identity:**
   - A person issues an agent token, and the agent acts as that person, never with more rights.
   - The spec may narrow it: `agent scope support: actions [...], views [...]`.
   - Every agent call is recorded in an audit entity that the runtime maintains.
8. **Maintainer commands, also JSON and also prompt-free:**
   - `check`;
   - `plan`;
   - `test <scenarios>`;
   - `explain <action|entity>`: which rules, permissions and screens touch it;
   - `review <old> <new>`: the **change report**, below.

**The change report (`review`).** Between two spec versions it lists:
- the migration plan;
- contract changes;
- **permission widening:**
  - for each view and action, whether some actor and state can now read or do what was refused before;
  - found by the checker's bounded exploration over both versions;
  - for example, "members can now delete other members' messages".

This is the checker's machinery aimed at the question an agent's reviewer needs answered.

### C. UI

1. **Generated default screens:**
   - From entities, actions, views and permissions, the runtime renders list, detail and form screens for anything without a declared screen.
   - A new feature works in the UI with no UI code. Declared screens are for parts that need a designed look.
2. **A component catalog in the theme:**
   - Components with typed props are defined once, with their markup and tokens.
   - Screens use components (`card`, `toolbar`, `message`), not class strings. The checker types the props.
   - The raw `classes json` mapping is retired step by step.
3. **Design tokens:**
   - The theme declares colours, spacing, radii and type sizes, which become CSS variables.
   - Generated screens use them, so a generated screen matches the app.
4. **App-local extensions:**
   - `apps/<app>/components/*.ts` holds custom widgets, declared in the spec with a typed signature.
   - The mention picker, preview cards and the push button move out of `lang/`, which keeps `lang/` generic.
5. **UI checks an agent can read:**
   - `crudspec screens` renders every screen with fixture data.
   - It outputs a text structure tree (headings, controls, labels, the action each control calls) for agents and a screenshot for people.
   - Both are diffed against the last accepted version.
6. **Later, not now:** the same component tree could be served to agent clients (A2UI or MCP Apps style).

## Experiments

| | Question | Status |
| --- | --- | --- |
| **H2/H3** | Do fresh agents fix bugs more correctly in the spec than in code, and at what cost? | Pre-registered (`docs/H2-PROTOCOL.md`); not run. Fix tasks on the v1 slice against the Rust port. Cheapest signal; can run now |
| **H2-F** (new) | The same question for **features and schema changes** on the full v2 Campfire, against Rails | Proposed below |
| **H7** (revised) | Are migrations from spec diffs safe? | Revised below |
| **H11** (new) | Can agents use the app safely through the generated interface? | Proposed below |

**H2-F: feature and migration tasks.**
- **Tasks:** 15 change requests on Campfire:
  - 5 features with new data;
  - 5 rule changes;
  - 5 schema changes on a seeded database (rename, split a field, a new required field, a new unique key, removing an entity).
- **Blinding:**
  - A separate session writes each task's issue text and **acceptance scenarios** before any run.
  - The acceptance scenarios are hidden from the implementing agents.
  - For new features there is no Rails golden, so the acceptance scenarios are the ground truth.
- **Arms:** the crudspec spec with the `plan`, `check` and `test` tools, against the Rails app with its tests.
- **Outcomes, for each run:**
  - correct: the acceptance scenarios pass;
  - preserving: the 42 scenarios still match, except where the task changes them;
  - safe: no silent data loss, permission widening or contract break, judged against the four properties above;
  - cost: tokens, tool calls and time.
- **Success (proposed):** the spec arm's correct-and-preserving-and-safe rate is at least 15 points higher, and its median cost is at most 1.2× Rails'.
- **Kill (proposed):** the spec arm isn't better, or costs more than 1.5×.

**H7 revised: migration safety.**
- **Corpus:** 20 schema-evolution cases, each a seeded database, a spec change and the expected data afterwards.
- **Success (proposed):**
  - 0 silent data losses;
  - 100% of data-dependent failures found by `plan` before anything is applied;
  - destructive steps never applied without an explicit `drop`;
  - every case's data matches its expected state.
- **Kill:** any silent data loss the design can't prevent.

**H11: agents using the app.**
- **Tasks:** 15, such as "archive the rooms nobody posted in this month" or "give Bob the same rooms as Ada", done through MCP or the CLI with an ordinary user's agent token.
- **Success (proposed):**
  - at least 80% task success;
  - 0 destructive calls applied without confirmation;
  - 0 calls beyond the token's rights;
  - derived annotations agree with interpreter checks on 100% of actions.
- **Kill:** annotations can't be derived reliably, or agents routinely need the UI.

## Order of work

1. **Migration (A).** It is the foundation for safe maintenance, and H2-F's schema tasks need it.
2. **Descriptor, dry run, CLI and MCP (B)**, with the maintainer commands and the change report.
3. **UI (C):** generated defaults, the component catalog and tokens, app-local extensions, and `screens`.
4. **In parallel, from the start:** write the H2-F tasks and acceptance scenarios blind. H2 can run whenever wanted.
5. **Last:** run H2-F, H7 and H11, and report.
