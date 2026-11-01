# crudspec language, v1

A spec describes the data, the actions that change it, the reactions to those
changes, and who may do what. It has no loops except over finite stored
relations, no recursion, and no user-defined functions other than
non-recursive predicates. Every check in `docs/DESIGN-SKETCH.md` therefore stays
decidable.

This page is the whole language. It's meant to fit in an agent's context.

## Lexical

- `//` starts a comment to the end of the line.
- Identifiers are `[a-z_][a-z0-9_]*`. Type names start with an upper-case letter.
- Strings are `"…"`, with `\"` and `\\` escapes. Integers are decimal. Booleans are `true` and `false`.
- Statements end at the end of a line. Blocks use `{ }`.

## Types

| Type | Values |
| --- | --- |
| `Text` | strings |
| `Int` | integers |
| `Bool` | `true`, `false` |
| `Ip` | text that is an IP address (see `public_ip`) |
| `enum Name { a, b, c }` | one of the listed names, written `a`, or `Name.a` when ambiguous |
| `Entity` | a reference to a stored record |
| `set of Entity` | a parameter only: a set of references; unknown references are dropped |
| `T?` | an optional field; `none` is its absent value |

## Declarations

```
enum Role { member, administrator, bot }

singleton Account {
  restrict_room_creation: Bool = false
}

entity User {
  name: Text
  email: Text
  role: Role = member
  status: UserStatus = active
}

entity Membership {
  room: Room on delete cascade       // deleting the room deletes this row
  user: User on delete cascade
  involvement: Involvement = mentions
  unread: Bool = false
  unique (room, user)
}
```

- A **field** is `name: Type [= default]`. A reference field may say `on delete cascade` (delete this row with the referenced one) or `on delete restrict` (the delete fails with `invalid`). The default is `restrict`.
- `unique (f, g)` declares that at most one row may have a given combination of values.
- `invariant <expr>` inside an entity is a predicate over `self` that must hold for every row after every action.
- A `singleton` has exactly one row, named by its type name in expressions (`Account.restrict_room_creation`).

## Expressions

**Row fields are written with a leading dot.** Inside a `where` (and in `all`'s
condition, field defaults, `for each … where` and `delete … where`), `.f` is
the current row's field `f`, and `it` is the row itself. A bare name is always a
variable: a parameter, an `as` binding, a loop or trigger variable, `actor`,
an enum value, or a singleton's type name. So `Membership where .room == room`
compares the row's `room` field with the parameter `room`, and is unambiguous.

| Form | Meaning |
| --- | --- |
| `x.f` | a field; reference fields can be chained |
| `==`, `!=`, `<`, `<=`, `>`, `>=` | comparison; references compare by identity |
| `and`, `or`, `not`, `implies` | boolean logic |
| `x in {a, b}` | membership in a literal set of enum values or references |
| `x in param` | membership in a `set of` parameter |
| `exists(E where p)` | whether any row of `E` satisfies `p`; inside `p`, `.f` is the row's field `f`, and `it` is the row |
| `count(E where p)` | the number of such rows |
| `all(E where p : q)` | whether every row of `E` satisfying `p` also satisfies `q` |
| `the(E where p)` | the unique row satisfying `p`; if there isn't exactly one, the action ends with `invalid` |
| `actor` | the user performing the action |
| `request.ip`, `request.method` | the request's address and method; the method is one of the built-in names `get` and `write` |
| `public_ip(e)` | true when `e` is a valid public IP address (not loopback, private or link-local) |
| `if c then a else b` | a conditional value |
| `x in set_param` | membership in a `set of` parameter, also inside predicates |
| `p(args)` | a call to a declared predicate |

```
predicate member(u: User, r: Room) = exists(Membership where .room == r and .user == u)
```

Predicates can't call themselves, directly or indirectly.

## Actions

An action is the only way stored data changes.

```
action edit_message(message: Message, body: Text) {
  require member(actor, message.room) else not_found
  require can_administer(actor, message.creator) else forbidden
  set message.body = body
}
```

- **Parameters** are typed, and resolve **lazily**. A reference parameter that names a row which doesn't exist ends the action with `not_found` when it is first used, in a `require`, an expression or an effect. An enum parameter given a name outside its enum ends the action with `invalid` at first use. A parameter written `name: E?` is optional, and may be `none`. Lazy resolution keeps the order of checks explicit: `require administrator(actor) else forbidden` before any use of `user` means a non-administrator gets `forbidden` even for a missing user.
- **Gates** (below) run before the action's body.
- **`require <expr> else <outcome>`** ends the action with that outcome when `expr` is false. Nothing it has written is kept. Requires run in order.
- **Effects:**
  - `create E { f: expr, … } [as name]` inserts a row. Omitted fields take their defaults. `as name` binds the new row for later statements, and also names it in the scenario's results.
  - `ensure E { f: expr, … }` is a create that does nothing if a row with the same `unique` key exists.
  - `set x.f = expr` updates a field.
  - `delete x` deletes a row, applying the `on delete` policies of rows that reference it.
  - `delete E where p` deletes every matching row the same way.
  - `for each x in E where p { effects }` repeats effects over a finite set of rows, fixed before the loop starts.
  - `if <expr> { effects } [else { effects }]` is a conditional.
  - `emit Event(args)` raises an event for triggers and workflows.
  - `reject <outcome>` ends the action with that outcome and discards its writes. It's used in triggers that guard transitions.
- **Outcomes** are `ok`, `forbidden`, `not_found`, `blocked`, `invalid` and `unauthenticated`. An action that reaches its end ends with `ok`.
- **Atomicity:** an action, with its triggers, applies all of its writes or none. Any violated invariant, unique constraint or `restrict` delete ends it with `invalid`.

## Gates

```
gate blocked_ip: request.method == write and exists(Ban where .ip == request.ip) -> blocked
gate signed_in:  not exists(Session where .user == actor) -> unauthenticated
```

Gates apply to every action, in declaration order. The first gate whose
condition is true ends the action with its outcome. An action may opt out with
`skip gate signed_in` on the line after its header, for example to let someone join. With the gate skipped, `actor` is `none`.

## Triggers and workflows

```
trigger on create Message as m {
  for each ms in Membership where .room == m.room and .user != m.creator and .involvement != invisible and not .connected {
    set ms.unread = true
  }
}

workflow on UserBanned(u) {
  step remove_messages: delete Message where .creator == u
}
```

- **Triggers** run inside the action's transaction, immediately after the effect that fires them. Their events are:
  - `on create E as x`;
  - `on update E.f as x [when <expr>]`, where `old.f` is the previous value;
  - `on delete E as x`;
  - `on Event(args)` for an emitted event.
- Triggers may not perform external effects. The trigger graph (which triggers can cause which) must have no cycles.
- **Workflows** run after the action commits, step by step. Each step is retried until it succeeds, and must be safe to run twice. For oracle comparisons, workflows run to completion before the final state is read.

## Permissions and views

```
policy message_rows: member(actor, message.room) for rows of Message

view room_page(room: Room, before: Message?, after: Message?) {
  require member(actor, room) else not_found
  rows Message where .room == room and (before == none or .created < before.created) and (after == none or .created > after.created)
  order by created
  window 40 last unless after != none
}
```

- `policy e_rows: <expr> for rows of E` restricts which rows any view may return. Every entity used by a view needs a read permission.
- A **view** returns rows in a declared order. `window n last` keeps the newest `n`, and `window n first` the oldest `n`. `unless` switches between the two.

## Ordering

Every row has an implicit `created` sequence number, which increases with each
insert. `order by created` uses it. It stands in for timestamps; no
wall-clock time exists in v1.

## What v1 does not have

- No user-defined functions besides predicates.
- No arithmetic on references.
- No external calls, apart from a workflow step's declared external effect (`notify …`), which is recorded but does nothing in v1.
- No rich text. `Text` bodies compare as plain text.
