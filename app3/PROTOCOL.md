# A third app, from scratch

Registered 18 Oct 2026, before the run.

**Question.** Can a fresh agent, given only the language (its docs and compiler) and one small
example app (Tasks, not Campfire), build a new app of a different shape from a product brief?
And where does the language fall short?

**The app.** Desk, a support helpdesk (`app3/BRIEF.md`): two kinds of people with different
views of the same data, private rows, staff-only notes, assignment, a status workflow with a
rule that moves it back, and a queue. Written in user-visible terms only, by the session that
built crudspec (a stated bias).

**The run.** One fresh agent, in a workspace made by `app3/make-workspace.sh`, told to work only
there. It may not change the language; it reports anything the language couldn't express.

**Measures** (by the harness):
- **Builds:** `check --deep` has no errors and the app compiles.
- **Accepted:** `app3/accept.mjs` on a fresh installation: 18 checks through the browser, by the
  placeholders, labels, links, buttons and text the brief names. Each counted.
- **Hand work:** files changed outside `desk.crud` and `assets/` (the language is copied in; a change to it doesn't reach the build).
- **Shortfalls:** what the agent reports the language couldn't express, and what the checks show.
- **Size and cost:** the spec's lines; the agent's tokens, tool calls and time.

One run: an existence test, not a rate.

## After the run

- **A runtime bug the app found.** The staff queue (`status != solved`, compiled as `NOT (… IS ?)`) was cached as reading only solved tickets, so a new ticket didn't reach the cached queue. The live-key reader now treats an equality under `NOT` as not constraining its query (`lang/gogen/rt/live.go`, with tests). The app is scored built with the fixed compiler.
- **Acceptance:** a link counts if its text is, or contains, the subject (the queue's links also show the status and the customer), as the brief allows.
