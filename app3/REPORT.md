# A third app from scratch: Desk

18 Oct 2026. Protocol: `app3/PROTOCOL.md`. The agent's spec: `app3/desk.crud`.

One fresh agent, given the language (docs and compiler), the small Tasks app as an example (not
Campfire) and a product brief, built Desk, a support helpdesk.

## Result

| Measure | Result |
| --- | --- |
| Builds | yes: `check --deep` 0 errors, 0 warnings; compiles |
| Accepted | **13 of 18** browser checks |
| Hand work | none: only `desk.crud` (445 lines) and `assets/desk.css` |
| Cost | 75k tokens, 45 tool calls, 5.6 minutes |

All five failures are one miss: the app shows statuses as `open`, `pending`, `solved`, where
the brief says "Open", "Pending", "Solved". Everything else passed: setting up, signing up,
private tickets (another customer can neither list nor open one), the staff queue, replies,
staff-only notes, assignment, solved tickets leaving the queue, a customer's reply putting a
ticket back in the queue.

## What it found

- **A runtime bug.** The staff queue (`status != solved`) compiles to `NOT (status IS ?)`; the live-key reader took the equality inside the `NOT` as a constraint, so the cached queue was never told of new tickets. Campfire's checks never hit it (its negations are on other shapes). Fixed in `lang/gogen/rt/live.go`, with tests; Campfire's equity and live checks are unchanged. The app is scored built with the fixed compiler.
- **A documentation gap.** The agent reported that the language can't limit a field's length. It can (`subject: Text max 120`), but `LANGUAGE.md` didn't say so. Now it does.
- **A language rough edge.** An enum value displays as its declared name, and a label needs a hand-written function. `LANGUAGE.md` now shows the pattern; built-in labels would make the brief's wording the default.

## Reading it

One run: it shows a fresh agent can build an app of a different shape from the docs and a
small example, in about six minutes, with no work outside the spec, and that the remaining
miss was wording the language makes easy to get wrong. It also found a soundness bug in the
cache that two apps' worth of checks had missed, which argues for more apps, and for a test
that compares cached and uncached renders on every app, not just Campfire.
