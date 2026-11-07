# Rules in crudspec v5: design

Status: design for review, 2026-11-07. No code has been written for it yet. Branch `rules`.

This is the crudspec-sized part of the Canon plan (`D:\code\canon\DESIGN.md`): what Campfire
actually needs, built on what crudspec already has.

## What already exists

Much of the plan is already in the language:

| Plan idea | crudspec today |
|---|---|
| a rule for every action, with opt-outs | `policy … else o for every action` + `skip policy` |
| a rule woven into every write | `policy … for writes to E` (`lang/writerule.ts`, with `fromPolicy` on each require) |
| row filters on every door | `policy … for rows of E` (views, screens, exports, agents) |
| lifecycles | `transitions f { … }` with `TRANSITION_UNPROVEN` etc. |
| exhaustive choice | `match` must cover its enum |
| reaction loops | `TRIGGER_CYCLE` |

So this round adds four things and changes one rule of the language.

## 1. A row you can't see doesn't exist for you (parameters)

**Today:** a row policy filters what views, screens, exports and agents *list*. A parameter
naming a row the actor can't see still loads, so each action repeats the check by hand.
Campfire has `require member(actor, …) else not_found` 18 times.

**New rule:** a parameter of an entity with a row policy is resolved through that policy. A row
the actor can't see is treated exactly like a row that doesn't exist: `not_found`, at the
parameter's first use. This keeps the lazy resolution that `actions.md` already documents, so
the existing order of refusals stays the same.

**How it's built:** in the parser's post-pass, like write policies. For each action, view,
channel and signal parameter of entity `E` with row policy `p`, insert

```
require <p with the row replaced by the parameter> else not_found   // fromPolicy: p
```

before the first statement that mentions the parameter. The rest of the compiler (types,
checks, invariants, review, Go generation) sees an ordinary require.

**Details:**
- **Optional parameter** `x: E?`: `require x == none or <p(x)> else not_found`.
- **Set parameter** `xs: set of E`: rows the actor can't see are dropped, as unknown rows
  already are. Nothing is refused.
- **Already stated:** if the statement at first use is a `require` (or a screen's `require`)
  that already contains the condition as one of its `and` parts, nothing is added. The
  author's own outcome stands. This keeps `room_screen`'s `else go home flash …` working, and
  means existing apps don't change where they already check.
- **Screens** get the same weaving, placed first among the screen's requires. A screen that
  wants a redirect instead keeps its own `require … else go …`, which then satisfies the
  "already stated" rule.
- **Not woven:** the admin section's generated actions (`admin_*`, since administrators read
  every row), schedules (no actor), triggers and workflow steps (no parameters from outside).
- **Opt out:** `skip policy <row policy name>`, as for the other policy kinds.
- **A policy that is `true`** (`user_rows`) weaves nothing.

**Behaviour changes:** before making this the default, `check` lists every site where it adds a
check with no explicit equivalent, across Campfire, Tasks, TodoMVC and Desk. Each one gets
fixed, declared as a departure, or reported to you. Known so far:

- `view autocomplete_users(room: Room?)` in Campfire: today it lists the members of any room.
  Rails uses `Current.user.rooms.find(params[:room_id])`, which is a 404 for a room you aren't
  in. So this change moves Campfire *closer* to Rails.
- `view room_messages(…, before: Message?, after: Message?, around: Message?)`: a cursor
  message from a room you can't see becomes `not_found` instead of being used as a timestamp.

## 2. One row policy for everything inside a container

```
policy room_rows: member(actor, room) for rows in Room
```

This applies to `Room` and to every entity that reaches a `Room` through required references,
with each path found by the compiler:

| Entity | Path found | Condition it gets |
|---|---|---|
| Room | itself | `member(actor, room)` |
| Membership | `.room` | `member(actor, membership.room)` |
| Message | `.room` | `member(actor, message.room)` |
| Boost | `.message.room` | `member(actor, boost.message.room)` |

**Rules:**
- **Inferred, never guessed.** Only required (not optional) references are followed. If an
  entity reaches the container by two different shortest paths, the build fails with
  `ROWS_IN_AMBIGUOUS` and both paths are shown.
- **Combined with AND.** An entity with its own `for rows of` policy too gets both conditions
  combined with `and`, in one permission (the admin section expects one per entity). This is
  how Membership keeps "only your own".
- **Expands into today's form.** The result is ordinary per-entity permissions, so the runtime,
  live updates and the who-can-see matrix in review need no change.
- **`ROWS_IN_EMPTY`** (warning): nothing but the container itself is inside it.

## 3. One row policy for several entities

```
policy own_rows: .user == actor for rows of Membership, Search, PushSubscription
```

This raises the question of how a row policy names its row. Today it's the entity's name in
lower case (`membership.user`); the docs say "not `.user`". With several entities in one
policy, that can't work.

**Proposal: one rule for every row policy.** The row is `.field` and `it`, exactly as in
`where`. The container in `for rows in Room` is the one exception: it is named by its lower-case
name (`room`). `upgrade-syntax` rewrites existing `message.room` forms to `.room`, so there is
one spelling, not two. This touches every app's row policies and the docs.

## 4. Subsets: a named `where` used as a type

```
subset ActiveUser = User where .status == active
subset ActiveBot  = ActiveUser where .role == bot
```

- **In queries** a subset is its entity plus its condition: `ActiveUser where .name == n`,
  `exists(ActiveBot)`, `for each u in ActiveUser where u in users`, `rows ActiveUser`. This is
  rewritten in the post-pass to `User where .status == active and …`.
- **As a parameter type** (actions, views, screens): `user: ActiveUser` loads a User and
  requires the condition at first use, `else not_found`. It's the same mechanism and placement
  as section 1, so a parameter outside the subset is a row that doesn't exist.
- **Not allowed as a stored field's type** (`SUBSET_STORED`: the condition can change after the
  row is written, so use an invariant), nor in a `fn` parameter (`SUBSET_FN_PARAM`: a function
  can't refuse).
- **Other errors:** `SUBSET_CYCLE`, an unknown base entity, and a condition that isn't about the
  row.

## 5. Seeing what was woven

```
node lang/cli.ts expand apps/campfire/campfire.crud edit_message
```

This prints an action, view or screen after weaving, in crudspec syntax. Each added line ends
with where it came from:

```
action edit_message(message: Message, body: RichText) {
  require member(actor, message.room) else not_found          // from policy room_rows (campfire.crud:228)
  require can_administer(actor, message.creator) else forbidden
  set message.body = body
  result message
}
```

Every-action policies are listed first, as a comment, because they run before the body. This
needs a printer for statements and expressions. `describe.ts` already prints conditions, and
it would grow to cover statements.

## 6. Checks

| Code | Severity | When |
|---|---|---|
| `ROWS_IN_AMBIGUOUS` | error | an entity reaches the container by two shortest paths |
| `ROWS_IN_EMPTY` | warning | a container policy covers only the container |
| `SKIP_UNNEEDED` | error | `skip policy p` where p would add nothing to that site |
| `SUBSET_STORED`, `SUBSET_FN_PARAM`, `SUBSET_CYCLE` | error | section 4 |
| `PARAM_POLICY_ADDED` | report | a check woven with no explicit equivalent, listed by `review` as a narrowing |

Each code goes into the reference tables, so `reference.test.ts` stays in step.

## 7. Campfire after the port (estimate)

| Today | After | Lines |
|---|---|---|
| 18 `require member(actor, …) else not_found` (some also check `room.type`) | woven from `room_rows` | about −14 (4 keep their `room.type` part) |
| `room_rows`, `message_rows`, `boost_rows` | one `for rows in Room` | −2 |
| `membership_rows`, `search_rows`, `push_subscription_rows` | one `own_rows` | −2 |
| 2 `require subscription.user == actor else not_found` | woven from `own_rows` | −2 |
| `require user.status == active else not_found` ×2, `b.role == bot and b.status == active` ×4 | `ActiveUser` / `ActiveBot` parameters | −6 |
| about 12 `User where .status == active` | `ActiveUser where …` | shorter lines, same count |

That's about 26 fewer lines in 1,785. The bigger change is that a new action taking a Room,
Message or Boost can't forget the membership check, and `autocomplete_users` stops showing
rooms you aren't in.

**Admin checks stay explicit.** The 17 `require can_administer(actor, none) else forbidden`
remain. Write policies would move them after the `not_found` checks, changing refusals. A
`by`-style header saves a line each but adds a second way to say a require. Neither is worth
it for this round.

## 8. How it's verified

1. Unit tests for each form and each error code (new `lang/test/rules.test.ts`).
2. The behaviour-change inventory (section 1) for all four apps, reviewed before the guard
   becomes the default.
3. The Campfire equity run (41 scenarios matching plus 1 declared departure today) stays the
   same or improves.
4. `review --against main` on the ported Campfire shows narrowing only at the inventoried
   sites, and no widening.
5. The full test suite. Mutant rates that move because explicit requires are gone get
   explained in the commit, not loosened.
6. The invariant proof cache: change `room_rows`' condition and confirm the proofs rerun.

The compiler features land in separate commits from the Campfire port. Nothing is pushed
without your OK.

## 9. Out of scope this round

Decision tables, guards derived from invariants, std-library keywords, and stamp/also/soft
delete. Campfire doesn't need them. They're in the Canon plan for when an app does.

## Decisions for you

1. **Row naming (section 3):** move every row policy to `.field`, with `upgrade-syntax`
   rewriting the old form? *Recommended: yes.*
2. **Parameter guard (section 1) as the default** for actions, views, channels, signals and
   screens, subject to the inventory? *Recommended: yes.*
3. **Set parameters:** drop rows the actor can't see, rather than refusing? *Recommended:
   drop.*
4. **Admin checks stay explicit** this round? *Recommended: yes.*
