# Design: database work stays in the database

**Status:** decided (2026-11-19); landing in phases.

**Goal:** a crudspec app never quietly reads rows into memory to filter, sort, count, sum or check what SQL could do, and never runs one query per row (N+1). When work does happen in the app, the spec says so where it happens.

## Where we are

The compiler already does a lot of this:

- **Conditions:** a `where` becomes SQL.
- **Counts and existence:** `count` and `exists` become `count(*)` and `EXISTS`.
- **Semi-joins:** `exists(F where .x == it)` inside a `where` becomes a join in SQL.
- **N+1 in pages:** a list's rows prefetch what the list body reads through them (references, child rows: `PrefetchRefs`, `PrefetchKids`), one query each.
- **N+1 in loops:** a nested loop over rows is batched (`PrefetchBy`), and a loop of `ensure` is one batch.
- **Bulk writes:** a loop that only sets fields is one write, `SetWhere` (on change touch included, as of the `sql-pushdown` branch).
- **Sums:** `sum` and `avg` over columns are SQL's own (the `sql-in-db` branch, Decimals included).

But when part of a query can't be SQL, the compiler **quietly** reads the rows the rest of the SQL leaves and finishes in Go. Here is the full list across the five apps (`lang/gogen/gen.ts inApp()`):

| App | Sites | What |
| --- | --- | --- |
| TodoMVC, app3 | 0 | |
| Freestore | 1 | `where .month == m` (a Date) |
| Tasks | 3 | `order by lower(.name)` ×2; `where … contains(lower(.name), lower(typed))` |
| Campfire | 20 | `order by lower(…)` ×9, `.room.name` ×2, `.user.created`, `updated` ×2; `where` with `text(.id) == cookie(…)`, `present(.ip)`, an `if` inside the where, `matches(.body, …)`, `contains(lower(.name), …)`, `same_members(it, …)`, `it in mentionees(m)` |

Most of these are **gaps in the compiler, not limits of SQL**:

- **Dates and Decimals are integers in the table**, but the planner treats them as unknown kinds. That's Freestore's one site.
- **These have direct SQL forms:** `present`, `text(.id)`, `if c { a } else { b }` (`CASE`), and `in` a set (`json_each`, already used elsewhere).
- **Text functions** (`lower`, `contains`, `matches`) differ between Go and SQLite on non-ASCII text. That is the only real semantic problem.
- **Ordering by a field** other than insertion order, `created` or `id` is done in Go, because live pages keep their row windows in order as rows change.

## The rules

1. **Naming an entity means the database.** `count(E where …)`, `exists`, `all`, `sum`, `avg`, `the`, `list(… order by … limit …)`, `for each x in E where …`: the condition, the order, the aggregate's value and the existence check all compile to SQL. If any part can't, it's a compile error, `QUERY_IN_APP`, naming that part.
2. **Opting in to memory is visible.** `in_app(…)` around the part that runs in the app: `Todo where .board == b and in_app(f(.title))`. SQL narrows the rows by the rest; only the marked part runs per row in the app. The editor and the cost report show it. (Alternative: load explicitly, `let rows = list(Todo where .board == b)`, then filter the list value.)
3. **No query per row.** A query, or a reference followed (`m.creator.name`), inside a loop over rows or a list body is batched by the compiler (prefetch, join or aggregate). One it can't batch is a compile error, `QUERY_PER_ROW`, with the same opt-in (`in_app(…)`) for the rare case where per-row is meant.
4. **Values are memory.** A list or row held in a variable is already loaded. Operating on it (`for each x in rows`, comprehensions) is plain in-app work, with no marker needed.
5. **The compiler states what it did.** Every query's plan (SQL, batch, or in-app) is in `check --deep` and in the editor: a hint above a query, the SQL on hover, and an underline on any `in_app` part. A dev flag (`--trace-sql`) logs each request's statements and rows read, and tests can set a budget per action ("at most 3 statements, no rows read").

## Making the rules livable: close the gaps first

The strict rule should land after the compiler can do in SQL what these apps need. Otherwise every app fills with `in_app`.

| Gap | Fix | Sites it removes |
| --- | --- | --- |
| Date, Decimal, Time columns | the planner knows their stored integer forms | Freestore's 1 |
| `present`, `text(.id)`, `if` in a where, `in` a set | direct SQL (`IS NOT NULL AND <> ''`, `CAST`, `CASE`, `json_each`) | about 5 in Campfire |
| Text functions (`lower`, `upper`, `trim`, `contains`, `starts_with`, `words_only`, `matches`) | **register the runtime's own Go functions in SQLite** (`sqlite3_create_function`, deterministic), so SQL calls exactly what the app would: same results by construction, no rows leave the database | 3 in Tasks, about 4 in Campfire |
| `order by` an expression or a reference's field | `ORDER BY` in SQL (with the same registered functions, and a join for `.room.name`); live pages re-run a window's query when a row's order key changes, rather than reordering in Go | 2 in Tasks, 12 in Campfire |
| User functions in a where (`same_members`, `can_administer`) | already inlined when their body is SQL; the rest become `QUERY_IN_APP` until written so | the remainder |
| Searching text (`matches`) | the registered function first; FTS5 (an index for words) when a spec marks a field `searchable` | Campfire's search |

**Indexes for the new SQL:** a registered deterministic function can be indexed (`index (lower(name))`), so `order by lower(.name)` and `where lower(.name) == …` use an index, and the cost report can suggest one.

## Decided (2026-11-19)

1. **The strict rule:** yes. `QUERY_IN_APP` and `QUERY_PER_ROW` are errors; `in_app(…)` around the part that runs in the app is the opt-in.
2. **Text semantics:** the runtime's Go functions are registered in SQLite, so SQL computes exactly what the app would.
3. **Order of work:** the gaps first, then the rule.
4. **Live pages ordered by a field that can change:** a window re-runs its query when a row's order key changes.

## Landed (2026-11-19)

- **Gaps closed:**
  - Date and Decimal columns, `present`/`blank`, `text(.id)`, `if … else` (`CASE`) and `all(…)` (`NOT EXISTS`) in a condition.
  - The runtime's text functions, registered in SQLite as `cs_lower` and so on (`rt/sqlfuncs.go`). A RichText column counts as its text.
  - Orders by any expression the planner writes, a referenced row's field included. A live page reads the order's columns (`OrderReads`).
  - A builtin over a query's list: `any`, `count`, `first`, `last`, `distinct`, `count(distinct …)`.
  - `all(p for E where q)` outside a where becomes a count of the rows that break it.
- **Result:** all five apps have 0 sites left in the app.
- **The rule:** `QUERY_IN_APP` is an error from `build` and `check --deep`. `in_app(…)` is the opt-in, known to the checker, the generator, the prover and the Lean evaluator.
- **Exempt:** invariant checks over a whole table read every row on purpose, to name the rows that break the invariant.

## Next: QUERY_PER_ROW

Queries inside a per-row loop, from the cost report's loop data (`cost.queries()` with `loops`):

| App | Count | Where |
| --- | --- | --- |
| Tasks | 1 | `count(Task where .project == pr and …)` in a list of projects |
| Campfire | 6 | workflow `MessagePosted` (push subscriptions and webhooks per member or bot); `SidebarPanel` and `bots_screen` counts per row |

These need batching before the rule can be an error:

- a count or exists per list row becomes one `GROUP BY` query, prefetched before the list;
- a workflow loop's per-row query becomes one `IN (…)` query.

## Not in scope here

- Choosing indexes automatically (the cost report suggests; `indexes auto` exists).
- Query planning across actions (caching between requests).
- Other databases: the registered functions are SQLite's; another backend would need its own (docs/STORAGE-BACKENDS.md).
