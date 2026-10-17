# H2-F protocol: feature, rule and schema changes, crudspec against Rails

Pre-registered 17 Oct 2026, before any task is written. This page refines H2-F in
`docs/AGENT-GOAL.md`. Its thresholds were approved on 17 Oct 2026 and stand.

This page covers **writing the tasks**. Running them needs a harness for each arm. That harness
is built after the tasks are frozen, against the format here, and before any implementing run.

## Question

Given the same change request for Campfire, does a fresh agent produce a correct, preserving
and safe change more often by editing the crudspec spec than by editing the Rails app? And at
what cost?

## Tasks

- **15 tasks**, written by **5 writer sessions** of 3 tasks each:

  | Writer | Kind |
  | --- | --- |
  | F | features with new data (2) and a rule change (1) |
  | G | features with new data (2) and a rule change (1) |
  | H | a feature with new data (1) and rule changes (2) |
  | I | schema changes on existing data (3): rename, split or merge a field, new required data |
  | J | schema changes on existing data (2) and a rule change (1) |

  That makes 5 features, 5 rule changes and 5 schema changes.
- **Each task is a directory** `D:\code\crudspec-h2f\tasks\<writer>-<n>-<slug>\` containing:
  - `issue.md`: the change request, written as a product owner would. It says what people should be able to do, and the **visible labels** of any new buttons, links, fields or pages. It never names files, classes, declarations, tables or code.
  - `acceptance.json`: the hidden checks, in the vocabulary below. It covers the requested behaviour, and at least one check that someone who shouldn't be able to do it can't.
  - `notes.md`: the writer's reasoning, for the scorer. Hidden from implementers.
- **Arm-neutral acceptance vocabulary.** Every check runs in a browser against either arm:
  ```
  { "id": "…",
    "seed": { "users": [ { "key", "name", "email", "role": "administrator"|"member" } ],
              "rooms": [ { "key", "name", "type": "open"|"closed"|"direct", "creator", "members": [keys] } ],
              "messages": [ { "key", "room", "author", "body" } ],
              "boosts": [ { "message", "author", "content" } ] },
    "checks": [ { "as": "<user key>",
                  "steps": [ step, … ] } ] }
  ```
  - **Steps:**
    - `{ "visit": "room" | "home" | "profile" | "account" | "user", "of": "<key>" }`;
    - `{ "click": "<visible label>", "in"?: "<message key>" }`;
    - `{ "fill": "<field label or placeholder>", "with": "<text>" }`;
    - `{ "select": "<field label>", "option": "<visible text>" }`;
    - `{ "submit": "<button label>" }`;
    - `{ "see": "<text>", "in"?: "<message key>" }`;
    - `{ "not_see": "<text>", "in"?: "<message key>" }`;
    - `{ "denied": true }`: the last action was refused, or the page isn't available.
  - A message is found by its seeded body, so bodies must be unique.
  - Labels come from the issue, or from Campfire's existing UI.
- **Schema tasks (writers I and J)** seed data in the same `seed`. The checks then show that the existing data survived the change as intended. For example, after a rename the old values still show under the new label.
- **Writers may read:**
  - the Rails Campfire source in WSL (`~/linuxbench/rails/app`), to learn the app and its labels;
  - this page.
- **Writers must not read** the crudspec repository, apart from this page, or the other writers' tasks.
- **Freezing:** the harness author counts and lists the task files without reading `acceptance.json` or `notes.md`. He hashes everything into `D:\code\crudspec-h2f\FREEZE.txt` and commits that file's hash in `docs/DEVIATIONS.md`.

## Arms, outcomes and procedure (to be completed before any implementing run)

- **Arms:**
  - the crudspec spec arm: `apps/campfire/campfire.crud` with `check`, `plan`, `review`, `screens` and scenario runs;
  - the Rails arm: the Rails app with its tests.

  Both get the same model, budget and prompt template, and fresh sessions.
- **Outcomes per run:**
  - **correct:** every acceptance check passes;
  - **preserving:** the 42 equity scenarios still match, except where the task changes them, as `notes.md` says;
  - **safe:** no silent data loss on the seeded data, and no access wider than the issue asks (the denied checks);
  - **cost:** tokens, tool calls and time.
- **Decision** (`docs/AGENT-GOAL.md`):
  - **Success:** the spec arm's correct-and-preserving-and-safe rate is at least 15 points higher, with median cost at most 1.2× the Rails arm's.
  - **Kill:** the spec arm isn't better, or costs more than 1.5×.
- A pilot of 3 tasks comes before the study. Only tooling and documentation may change after it.

## Caveats, stated in advance

- **Blinding rests on the writers following their instructions.**
- **UI checks couple tasks to labels.** Issues must name the labels they need, which is fair to both arms.
- **The writers learn Campfire from Rails.** Tasks may lean towards how Rails structures things. Both arms share that.
