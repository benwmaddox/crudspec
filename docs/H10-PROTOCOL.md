# H10 pilot protocol: changing Campfire through the spec, and through Rails

Pre-registered 17 Oct 2026, before any agent run. It refines H10 in `docs/HYPOTHESES.md`
for a pilot. A pilot makes no H10 decision: it measures, and finds what a study would need.

## Question

When a fresh agent makes a real feature change to Campfire (schema, behaviour and UI), how
often is the result right, and how much else does it need, editing the crudspec spec against
editing the Rails app? And once the change is made, how long until the app serves it again on
real data, with the data intact?

## Deviation from H10 as registered

H10 names the Rust port as its baseline. This pilot uses **Rails** (ONCE Campfire 90b3300),
at the owner's request (17 Oct 2026), worded from the review that recommended comparing with
Rails. The Rails app runs natively in WSL from `~ben/linuxbench`, as the oracle does.

## Tasks

Three changes, written only in what users see (labels, visible text, who may do what), never in
spec or Rails terms. None changes behaviour the 42 oracle scenarios test. Each covers a kind of
change: an additive field shown in the UI; a new action with a permission and buttons; a change
that maps existing data.

- **topic.** Rooms can have a topic: one short line of text, up to 200 characters, that whoever may change a room's name can set on the page where the room is edited (a field labelled "Topic"). The topic shows on the room's page under its name, for everyone in the room. Existing rooms start with no topic.
- **pin.** Members can pin messages. Whoever may delete a message (its author, or an administrator) can pin it with a "Pin" button among the message's actions, and unpin it with an "Unpin" button. A pinned message shows the word "Pinned" on it, for everyone in the room. Existing messages start unpinned.
- **display.** Messages show their author's display name instead of their full name. Everyone's display name starts as the first word of their name: for existing users too, and for people who join later. People can change their display name on their profile page (a field labelled "Display name"), up to 40 characters.

Stated bias: the tasks were written by the session that built crudspec's Campfire, which knows
it intimately. Writing them in user-visible terms only is the mitigation.

## Arms

| | Spec arm | Rails arm |
| --- | --- | --- |
| What the agent edits | `campfire.crud` (and `widgets.go` only if it must: counted as hand work) | the Rails app's source |
| Given | the spec, `widgets.go`, a copy of `lang/` (the language docs, CLI and compiler) | a copy of the app from `~ben/linuxbench/rails/app` |
| Feedback | `check --deep`; building and running the app on a fresh database | running the app on a fresh database; migrations and the schema dump |
| Hidden from both | these acceptance checks, the oracle and its goldens, the other arm, the crudspec repository, `docs/` | |

Both arms: the same model, the same prompt apart from the arm's part, a fresh session, a fresh
workspace under `D:\code\h10-runs\<run>\` with no git history, and the instruction to work only
there (isolation depends on it: a stated caveat). Runs go in the background, a few at a time.

## Measures

Made by the harness (`h10/`), never by the agent.

- **Accepted:** `h10/accept.mjs <base> <task>` passes on the arm's app built from the run's result, on a fresh database. It drives a browser through placeholders, labels, button names, visible text and the routes both apps share (`/first_run`, `/join/…`, `/account/edit`, `/rooms/:id`, `/rooms/:id/edit`, `/users/me/profile`). Before any run, on both unmodified apps, its shared steps passed and every task check failed (`h10/baseline/`).
- **Preserved:** the 42 oracle scenarios still match their goldens: on the spec arm through the replay against the compiled app (`bench/go-check.sh`); on the Rails arm through the oracle itself run with the arm's app (`h10/rails-preserve.sh`; on the unmodified app it gives 42/42).
- **Data:** on a copy of the same production data (the Rails snapshot for Rails, its import for the spec), no table loses rows in the upgrade (`h10/upgrade.sh`, `h10/data.mjs`); for **display**, some column of the users' table holds each name's first word.
- **Time to live:** from the result being saved to the app serving again on that data: for the spec arm, build, `cli migrate` and start; for Rails, `db:migrate` and boot. Against H10's 10 s target. Warm builds; a cold Go build is about 29 s, reported separately.
- **Hand work:** files changed other than the spec (spec arm), or the number of files changed (Rails arm, for scale: all of it is hand work there by H10's terms).
- **Errors:** a run is **right** when it is accepted, preserved and its data survives. Reported per run, with each failing check.
- **Cost:** the agent's tokens, tool calls and wall time, as the platform reports them.

## Scale

3 tasks x 2 arms x 1 run: 6 runs. A pilot: the result is reported as such, with no H10 decision.

## Changes after registration

- **Cleaned production data (17 Oct 2026, after the first run).** The snapshot holds rows the spec's rules refuse: 5 push subscriptions to endpoints the spec doesn't permit, and a message whose user is gone. They block every spec upgrade before the change is looked at. Both arms' copies are cleaned the same way before the upgrade (`h10/upgrade.sh`).
- **Acceptance waits for the app** behind WSL's port forwarding (its first request had raced it).
- **The room's edit page is reached by the room page's link.** The two apps' routes for it differ (Rails: `/rooms/opens/:id/edit`); the protocol was wrong to list `/rooms/:id/edit` as shared. A read-only topic field counts as not settable (the check had hung trying to type in one). The topic baseline was run again on both apps.
- Hand work excludes `config/puma.rb` on the Rails arm (the serve script binds it to loopback), and `lang/README.md`, which the harness author changed after the workspaces were made.

## Caveats, stated in advance

- One run per task and arm: chance dominates. Read the result as what happened, not a rate.
- The spec arm's agent sees crudspec for the first time; Rails is widely known. That is the real situation for a new language.
- Acceptance through the browser depends on both arms keeping the shared markup it relies on (`.message`, `#composer`, the account page's join link); an arm that changes those can fail a check without being wrong. Such failures are reported as they are, and examined.
- Rails' own test suite isn't in the app copy (no `test/` directory), so neither arm has a test suite; both have the running app.
