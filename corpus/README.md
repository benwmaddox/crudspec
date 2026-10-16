# Corpora

Every comparison uses these, and nothing else. They are frozen and hashed before
the phase that uses them. Changes go into a new version (`v2`, …), never into a
frozen one.

## Layout (planned)

```
corpus/
  v1/
    bugs/<id>/          seeded logic bugs
      bug.md            what is wrong, category, the oracle case that exposes it
      spec.patch        the bug as a change to the reference spec
      baseline.patch    the same wrong behaviour as a change to the baseline app
      oracle.json       requests, starting state, expected responses and final state
    controls/<id>/      correct but suspicious-looking changes (same files)
    tasks/<id>/         change tasks for agent studies
      issue.md          the request, as an issue would phrase it
      oracle.json       cases the result must pass
      preserve.json     behaviours that must not change
    planted/<id>/       wrong changes for the human review study
  MANIFEST.json         hashes of every file, written at freeze
```

## Bug categories (target 60–100 bugs in total)

| Category | Example in the Campfire domain |
| --- | --- |
| Permission leak | A member reads messages of a room they left; a view skips the read rule |
| Missing guard | A banned user can still post; an action skips its precondition |
| Invariant violation | A direct room ends up with three members |
| State machine | An account deactivation path skips required cleanup; an unreachable state |
| Trigger | A trigger cycle (boost → notify → boost); order-dependent triggers; I/O inside a transaction |
| Workflow | A notification sent twice on retry; a timer lost on restart |
| Cascade | Deleting a user deletes rooms they created, which other members still use |
| Derived data | Unread state is not reset on post; `last_message_at` is stale |
| Paging and boundaries | Off-by-one at the 40-message page edge; `before` the first message |
| Time and ordering | Ties in `created_at` ordering; time zones in day grouping |
| Migration | A column split loses data; a NOT NULL is added without a backfill |
| Efficiency | An N+1 in a room page (counts as a bug for H6, not H1) |

Include categories the checker is **not** designed to catch, such as paging,
time and ordering. That shows where the approach stops helping, instead of
only scoring its strengths.

## Rules

- Each bug is **confirmed wrong by the oracle**, and the oracle case is part of the bug.
- Each bug exists in **both forms** (`spec.patch` and `baseline.patch`) with the same wrong behaviour.
- Bugs are written by someone, or some agent, **other than** whoever builds the checker, and kept from the checker author until the freeze.
- Record the source of each bug: invented, taken from a real Campfire issue, or taken from AgentLang's observed failures.
