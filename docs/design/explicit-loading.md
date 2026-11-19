# Design: the database only where the spec says so

**Status:** decided (2026-11-19); landing in phases.

**Goal:** you can always tell from the text whether something reads the database. Rails blurs this: a Relation is a lazy value, `.count` and `.length` and `.size` run in different places, and `m.creator.name` quietly runs a query (in a loop, one per row). crudspec does none of that.

## The rule

The database is read in exactly these places:

1. **A query form:** an expression that names an entity: `count(Todo where …)`, `list(… for Item where …)`, `exists`, `all`, `the`, `sum`, a singleton's field (`Settings.limit`), a view.
2. **A `query` function:** a function whose body reads the database is declared `query`, not `fn`. A `fn` is pure: it works only on the values it's given.
   ```
   query member(u: User?, r: Room): Bool = exists(Membership where .room == r and .user == u)
   fn initials_of(u: User): Text = initials(u.name)
   ```
   Calling `actor.member(room)` reads the database, and its declaration's keyword says so.
3. **What an action is given:** a parameter row (`action toggle(t: Todo)`) is loaded by its id when the action starts, inside the action's transaction. It's the one load with no query written; it's in the signature.
4. **`with`, on a query or a parameter:** what else to load with the rows.
   ```
   list(Message where .room == r order by created with .creator, .room)
   action rename(t: Todo with .board) { … t.board.name … }
   ```
   Each `with` is one batched query (`IN (…)`), never one per row.

There is no lazy loading. Reading a field of a row that wasn't loaded is a compile error, `NOT_LOADED`, with a fix that adds the `with`.

## What counts as a load

- **A reference's id is not a load.** A row holds its references' ids, so `t.board == actor`, passing `t.board` on, and `.board == b` in a where need nothing loaded. Only reading the referenced row's fields does: `t.board.name` needs `.board` loaded.
- **Inside a `where` or an `order`,** `.room.name` is SQL (a subquery or join): it's within the query.
- **Types say what's loaded.** A row from `… with .creator` is a `Message with .creator`; a function that reads through one says so: `fn author(m: Message with .creator): Text = m.creator.name`.
- **Child rows:** a named list in the `with`: `Room where … with messages: list(Message where .room == it order by created limit 20)`. Then `r.messages` is a plain list, in memory, loaded by one query for all the rooms.

## Phases

1. **The `query` keyword.** A `fn` that reads the database is an error, `FN_QUERIES`, fixed by `check --fix`. This alone doesn't remove lazy loading.
2. **Inventory.** Count every reference read through a row outside a where, statically and with a test-mode counter at run time.
3. **`with` for references,** `NOT_LOADED`, and the fix that writes the `with`.
4. **Child lists,** and `QUERY_PER_ROW` (docs/design/sql-first.md) with them.
5. **Remove the old paths:** the inferred prefetch, and a field read of an unloaded row at run time becomes a refusal. This happens only once the suite runs with no lazy read.

## Open, with the default proposed

- **`actor`:** loaded by its identity when a request starts. Its own fields are fine; reading through it needs `app t { actor User with .org }`.
- **Screen and view parameters** (`screen r(room: Room)`): inbound like an action's, so they get the same exception.
- **The rows a trigger or workflow is given:** inbound too, the same exception.
- **Component props:** not inbound. A prop says what it needs (`m: Message with .creator`), and the caller's rows must have it.
