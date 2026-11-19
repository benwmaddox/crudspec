[← the language guide](../LANGUAGE.md)

## What the compiler checks

`node lang/cli.ts check <spec>` checks names and light types. `--deep` adds the type pass, the deep checks and the query costs. `build` runs all of these and the invariant proofs before it writes a program. A spec with an error is never compiled. Warnings name a likely mistake, or a choice worth stating. The codes, with one line each, are in `REFERENCE.md`. There are no suppressions: a declaration that states intent (`write_only`, `internal`, `private`) is itself checked.

**Names, types and none.** Every name resolves, and every expression has a type. A value that can be none must be checked before use. Every `match` covers its enum.

**Links and routes:**
- a link, redirect or `url_of` names a screen with the parameters it needs (`LINK_ARGS`);
- each `:name` in an address is a parameter (`ROUTE_PARAM`), and no address is one an earlier screen always takes (`ROUTE_SHADOWED`);
- an `href` inside the app is an error if no screen has that address, and otherwise a warning to link to the screen (`HREF_INTERNAL`);
- a link to a screen that refuses its viewer, without that screen's requirement known where the link is (`LINK_NOT_ALLOWED`);
- a screen no chain of links reaches from home, sign-in, setup or anything outside the UI (`SCREEN_UNREACHABLE`).

**Data use:**
- a field written but never read (`FIELD_NEVER_READ`);
- read but never set, so always its default or none (`FIELD_READ_NEVER_SET`);
- neither (`FIELD_NEVER_WRITTEN`);
- `write_only` read anyway (`WRITE_ONLY_READ`, an error);
- an enum value a field can never hold (`ENUM_VALUE_UNREACHABLE`);
- a `set` of a field with `transitions` that isn't a written move (`TRANSITION_UNPROVEN`, an error), one the check can't read (`TRANSITION_DYNAMIC`), and a written move nothing makes (`TRANSITION_UNUSED`);
- `the()` without a unique match (`THE_NOT_UNIQUE`).

**How entities refer to each other:**
- required references in a circle, so no row of them can be created first (`REF_CYCLE_REQUIRED`, an error);
- a row that only links two others, with no `unique` over the pair (`LINK_NOT_UNIQUE`);
- a field named after its entity that a row has twice over, its own and a row's it requires (an invoice's `customer` and its project's), with no invariant that they agree (`PATHS_DISAGREE`);
- a row whose policy admits rows whose required parent the parent's policy hides (`PARENT_HIDDEN`): what a page shows of the parent would show what its policy hides. A policy `for rows in` the parent covers it. This reads the conditions (with the spec's functions written out), not the prover, so a condition that only implies the parent's in a way the reading can't see is reported too.

**Writes and safety:**
- a write to a row the caller chooses, with no check on the actor (`WRITE_UNCHECKED`);
- a signed-out action that writes with no rate limit (`SIGNED_OUT_UNLIMITED`);
- a delete a restriction can refuse, with no check first (`DELETE_RESTRICTED`), also a restriction on a row the delete cascades to;
- a create of a uniquely keyed row from the caller's values, with no check (`UNIQUE_UNGUARDED`);
- triggers in a cycle (`TRIGGER_CYCLE`).

**Outcomes and time:**
- a form that handles some outcomes its fields can bring about, but not all (`OUTCOME_UNHANDLED`);
- a workflow step acting on a field the emitting action set, without reading it again, though another action can change it meanwhile (`WORKFLOW_STALE_CHECK`). For example, Campfire removes a banned user's messages later, though `unban_user` can run first.

**Query costs.** The compiler knows every query the app can run, so it asks SQLite how it would run each one, on a database made with the app's own schema (`EXPLAIN QUERY PLAN`). Nothing is guessed:
- `QUERY_UNINDEXED`: the plan reads the whole table for a query with a condition;
- `QUERY_SORTED`: the plan sorts every match to keep a few;
- `INDEX_UNUSED`: an index the spec declares that no query's plan uses, which costs every write and serves no read.

How costs are kept down:
- **Indexes:** each finding names the index that serves the query, and keeps it only if SQLite, planning again with it, no longer scans or sorts. The store indexes every reference and unique key by itself. With `indexes auto`, the app makes the indexes its queries want when it starts (`ax_…`) and drops ones no longer wanted. They change speed, never data, so they aren't part of the schema.
- **Order and limit in the database:** a query ordered by `created`, `id` or insertion has its order and limit run by SQLite, so it reads only the rows it keeps.
- **Membership checks:** `exists(E where .f == outer and …)` compiles to `outer IN (SELECT f FROM E WHERE f IS NOT NULL AND …)`. The inner rows are found once, instead of once per outer row, and the result is exact under `not`.
