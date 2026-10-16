# Design sketch: the DSL under test

This is a starting point for Phase 1, not a commitment. Anything that blocks a
decidable check, or pushes the language toward general-purpose, should be cut.

## Concepts

| Concept | Meaning |
| --- | --- |
| `entity` | A table-backed type with typed fields, relations, invariants and delete policies |
| Relation `->` / inverse `<-` | Foreign keys and their inverses; indexes are derived from them |
| Derived field | A field computed from other data (`sum`, `count`, `exists` over relations), maintained incrementally |
| `invariant` | A predicate that must hold after every action |
| `states` | A per-entity state machine; transitions are named, guarded and tied to actions |
| `action` | A named write with an actor, a precondition and effects; the only way data changes |
| `trigger` | An in-transaction reaction to an event; it must preserve invariants and may not do external I/O |
| `workflow` | A durable, asynchronous reaction with timers, retries and idempotent steps; it runs outside the transaction |
| `view` | A read model: a query over relations, compiled to joins or batched queries, optionally incremental |
| `permission` | Who may read or act on which entities and fields, written as predicates over the actor and the data |
| `extern fn` | An escape hatch: a host-language function with a declared signature and declared effects |

## Example

```
entity Room {
  id: RoomId
  kind: RoomKind                     // enum: Open | Closed | Direct
  creator: -> User
  memberships: <- Membership.room
  messages: <- Message.room
  last_message_at: Instant? = max(messages.created_at)

  invariant kind == Direct implies memberships.count == 2
  on delete creator: restrict
}

entity Message {
  id: MessageId
  room: -> Room
  creator: -> User
  body: RichText
  boosts: <- Boost.message
  created_at: Instant

  on delete room: cascade
}

action post_message(room: Room, body: RichText) by user
  when exists(room.memberships where member == user and not user.banned)
{
  create Message { room, creator: user, body, created_at: now() }
  emit MessagePosted
}

trigger on MessagePosted(m) {
  set membership(m.room, m.creator).unread_at = none
}

workflow on MessagePosted(m) {
  step push: notify members(m.room) except m.creator    // external, retried, idempotent
}

view RoomPage(room: Room, before: MessageId?) {
  messages: last 40 of room.messages where id < before order by created_at
    with creator, boosts.booster
}

permission read Message: exists(message.room.memberships where member == user)
permission act delete_message: user == message.creator or user.role == Admin
```

## Checks (Phase 1)

| Check | Method | Target corpus categories |
| --- | --- | --- |
| Actions preserve invariants | SMT (Z3): precondition ∧ invariant ∧ effect ⇒ invariant′ | invariant, missing-guard |
| State machines are sound | Reachability, dead ends, transitions not tied to guarded actions | state |
| Triggers terminate and commute | An event → action graph; cycles are rejected; triggers on the same event must commute or declare an order | trigger |
| No I/O inside a transaction | Effect checking: triggers may not call effectful externs | trigger, workflow |
| Permission coverage | Every entity, field and action has a rule; read rules are applied in every view | permission |
| Delete safety | Analysis of cascade and restrict paths over the relation graph | cascade |
| Derived-field consistency | By construction (incremental maintenance); checked against recomputation in tests | derived |
| Query shape | Each view compiles to a bounded number of queries | efficiency (N+1) |
| Migration safety | A spec diff produces typed steps; destructive steps need a mapping | migration |

## Non-goals

- **General-purpose programming.** No loops, recursion or arbitrary functions in the spec. Use `extern fn`.
- **A new runtime or VM.** The targets are Postgres and generated code in a mainstream language.
- **Command-only editing.** Specs are files with an LSP.
- **UI generation.** Possibly later; it isn't part of the value claims.

## Implementation choices (proposed)

- Write the checker and generator in Rust or TypeScript. Langium (TypeScript) gives a parser plus an LSP fastest; Rust gives the fastest checks.
- Use Z3 for invariant proofs.
- Make a reference interpreter over an in-memory relational store the semantic ground truth for Phases 1–2.
- Generate Rust (axum + sqlx) or Go (sqlc) for Phase 3, depending on the baseline language chosen in Phase 0.
