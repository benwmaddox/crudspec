# Plan: the complete Campfire spec, UI included (DSL v2)

*Started 17 Oct 2026 at the owner's request: "complete the spec including the UI parts, then compare". H2 is paused until this is done.*

## Goal

One crudspec v2 spec that defines **all of ONCE Campfire** at Rails 90b3300: its data,
rules, background behaviour, real-time updates, bot API, and UI. Then compare it with
the Rails app and the Rust port on size, locality and behaviour.

The v1 slice (`spec/campfire.crud`) and everything scored against it stay frozen. v2 is a
new language version and a new spec, `spec/v2/campfire.crud`.

## What Campfire has (Rails 90b3300)

About 9,700 lines of app code:

| Part | Lines |
| --- | --- |
| Models | 1,375 |
| Controllers | 1,325 |
| Views | 2,316 |
| JavaScript (37 Stimulus controllers) | 3,749 |
| Helpers | 753 |
| Channels (7) and jobs | 188 |

| Area | Features | In v1? |
| --- | --- | --- |
| Setup | first run (creates the account and its first administrator) | no |
| Sessions | sign in and out; session transfer by link or QR code | sign in only |
| Account | name, logo, custom CSS, join code and regenerating it, restricting room creation, user admin with paging | partly |
| Users | join, profile (name, bio, avatar, password), roles, deactivation, ban and unban | mostly |
| Bots | create, edit and delete; API keys and reset; webhooks; a JSON API for posting, editing, deleting and boosting | no |
| Rooms | open, closed and direct; create, edit and delete; involvement (the bell); settings; refresh; jumping to a message | logic only |
| Messages | rich text, mentions, attachments with previews, link unfurling (OpenGraph), sounds (`/play`), paging, edit and delete, replies | logic only (plain text) |
| Boosts | create and delete | yes |
| Unread and presence | unread rooms, connected or present, typing notifications, read state across tabs | partly |
| Search | full-text search over messages, with a per-user search history and clearing it | no |
| Notifications | web push (subscriptions, test notification), with mentions and involvement deciding who is notified | no |
| UI | layout, sidebar, room page, composer, message and boost rendering, autocomplete, lightbox, settings pages, flash messages, the installable web app | no |

## What the language needs (v2 additions)

Each addition should stay declarative and checkable. Anything effectful sits behind a
declared `extern`, with its effects stated.

1. **Time.** A `Time` type, `now`, durations (`60 s`, `1 day`) and their comparisons. This closes the H5 gaps (U1, U2).
2. **Files.** A `File` type for attachments, avatars and logos. Storage, variants and previews belong to the runtime.
3. **Rich text.** A `RichText` type, with built-in `mentions(body)` returning a set of users, `plain(body)` and `links(body)`.
4. **Search.** A `searchable` field option, and `matches(.body, query)` in a `where`.
5. **Secrets and tokens.** A `Password` type with `authenticates`, and `token()` for join codes, bot keys and transfer tokens.
6. **External effects:**
   - `extern fn` declarations with their effects: `push`, `http`, `fetch`;
   - allowed only in workflow steps, which the checker enforces;
   - examples: web push, webhooks, OpenGraph fetching.
7. **Real time:**
   - a `live` view, whose clients get its rows' changes as they happen;
   - an `ephemeral` signal, which is never stored: typing, presence.
8. **API.** An `api` block exposes chosen actions and views as JSON, with its own authentication (bot keys).
9. **UI.** These reference only views and actions, so the checker can verify them:
   - `layout` and `screen`;
   - components: `list`, `form`, `button`, `link`, `menu`, `avatar`, `image`, `text`, `field`, `section`, `if`;
   - routes and screen parameters;
   - flash messages from outcomes;
   - styling through a `theme`, which uses Campfire's own stylesheet.

## Milestones

| | Work | Done when |
| --- | --- | --- |
| **M1** | The v2 language reference (`docs/LANGUAGE-v2.md`) and the full spec `spec/v2/campfire.crud`, every part written against the Rails source, with a v2 rule inventory | Every route, model rule and view in the inventory maps to a declaration |
| **M2** | Parser and type checker for v2, including the UI rules: controls call real actions, screens only show readable data, every action is reachable or API-only | The spec parses and checks clean; the checker rejects broken screens |
| **M3** | Interpreter for v2 logic, with the v1 scenarios ported and new oracle scenarios for the new areas | v2 matches Rails on the slice plus the new scenarios |
| **M4** | Runtime: an HTTP server that runs the spec over SQLite, renders its screens with Campfire's CSS, and serves live views over WebSockets | Campfire is usable in a browser from the spec alone |
| **M5** | Comparison: size, rule locality, behaviour on the oracle, UI side by side with Rails; then H2 resumes on the full app | A report in `reports/v2-compare/` |

The full spec comes first (M1), because it's the thing being judged. If the language gets
in the way, that is a finding in itself. M4 is the largest part; it can start with a
generated default UI before the declared screens.

## Progress

- **M1 and M2, done (17 Oct 2026).**
  - The full spec parses and checks clean.
  - Every Rails route, channel and job is mapped (`docs/V2-COVERAGE.md`).
  - Static comparison: `reports/v2-compare/REPORT.md`.
- **M3, done (17 Oct 2026).** The v2 interpreter runs the spec.
  - It matches Rails on the 25 frozen slice scenarios, the 3 smoke scenarios and the checker finding.
  - It matches Rails on 9 new scenarios (`oracle/scenarios/v2-areas`, goldens `oracle/golden/v2-areas-d`) covering search, profiles, account settings, bots, the bot API, session transfer, first run, push subscriptions and deactivation cleanup.
  - Running the oracle found:
    - **Spec bug:** a parameter named `bot` hid the enum value `bot`, so `bot.role == bot` compared a role with a user. Every bot-management action returned not_found. The checker now flags enum-to-row comparisons; it finds all four uses in the previous version.
    - **Spec bug:** a repeated first run is a no-op in Rails, not `forbidden`.
    - **Interpreter gap:** unique keys must hold on updates too. Rails rejects taking another user's email.
- **M4, next:** the runtime.
