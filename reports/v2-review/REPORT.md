# Review: does the spec-driven Campfire behave like Rails Campfire?

*17 Oct 2026. Spec `spec/v2/campfire.crud`; runtime `tools/src/v2/runtime/server.ts`; Rails Campfire 90b3300.*

## Verdict

**Behaviour equity holds on everything measured.** A declarative spec plus a generic runtime
reproduce Rails Campfire's behaviour on all 42 oracle scenarios. They do so through the
interpreter, and through the running web app over real HTTP, with each actor's own
session cookie and IP address.

An independent review session reproduced those numbers itself. It found security issues
in the runtime, now fixed. Its behaviour-gap findings are in the next section, each with
what was done about it.

Equity is measured, not complete. What the scenarios can't reach is listed at the end.

## Equity evidence

All 42 scenarios match the Rails goldens through three implementations: the spec's
interpreter, the spec's runtime over HTTP, and the Rust port over HTTP (slice only).

| Scenario set | What it covers | Interpreter | Runtime over HTTP | Rust port over HTTP |
| --- | --- | ---: | ---: | ---: |
| `slice-v1` (25) | the 45-rule slice: auth, roles, rooms, memberships, messages, boosts, deactivation, bans | 25/25 | 25/25 | 25/25 |
| `smoke` (3) | posting and unread, edit permissions, bans | 3/3 | 3/3 | 3/3 |
| `checker-findings` (1) | a deactivated user added back to a closed room | 1/1 | 1/1 | not run |
| `v2-areas` (13) | search history and results, profiles, password changes, account settings, bots, the bot API, a bot key on a web form, session transfer, first run, push subscriptions, deactivation cleanup, sign-out, the sign-in rate limit | 13/13 | 13/13 | not run |

How the comparison works:
- The Rails goldens come from the real Rails app, driven through its controllers (`oracle/rails/oracle.rb`).
- The runtime replay (`tools/src/v2/replay-runtime.ts`) uses only the runtime's ordinary HTTP paths:
  - actions as form posts to `/_do/<action>`;
  - views as `/_view/<view>`;
  - bots through the bot API;
  - each actor with its own cookie and address.
- The runtime's `--test` endpoints only reset state from a scenario's setup, report normalized state and advance the clock.

**Browser checks** (`tools/e2e`, Chromium):
- first run;
- signing in and posting;
- a second person joining by invite link, with the first person's open page updating without a reload;
- creating a bot and posting through its curl command;
- a bot webhook round trip, where the bot's reply appears in the room;
- @mentions: only a picked mention counts, and it triggers the mentioned bot;
- all 14 screens rendering through Campfire's own stylesheet.

## What the equity work found

Each item was found by a Rails scenario, a browser run, or the review, and is now fixed.

| Found by | Where | Problem |
| --- | --- | --- |
| Rails scenario | spec | A parameter named `bot` hid the role value `bot`, so every bot-management action returned not-found. The checker now flags comparisons between an enum and a row. |
| Rails scenario | spec | A repeated first run is a no-op in Rails, not `forbidden`. |
| Browser run | spec | Rails gives new bots membership in every open room; the spec excluded them. The bot scenario had deleted the bot before the final check, so a new scenario now checks it. |
| Rails scenario | interpreter | Unique keys must hold on updates too: taking another user's email is invalid. |
| Browser run | interpreter | A key with a missing value never clashes, as in SQL. Two bots without an email are fine. |
| Rails scenario | interpreter | Rate limits count every request, including failed ones. |
| Rails scenario | **oracle** | Production keeps rate-limit counters in Redis, which the oracle lacked, so Rails' sign-in limit had silently never applied. The oracle now counts in memory, and the v1 goldens regenerate unchanged. |
| Rails scenario | spec and runtime | Rails accepts a bot key on any request, and refuses it outside the bot API. The spec now reads it from any parameter. |
| Review | runtime | The form-handler state grew without bound in memory. Handlers are now stateless, HMAC-signed references. |
| Review | runtime | Uploads were served by extension, so an uploaded SVG or HTML file could run script. Now only raster images, audio and video are inline, with `nosniff` and a sandbox CSP; anything else downloads. |
| Review | runtime | There was no CSRF protection. Cross-site writes are now refused, as the Rust port does; the bot API is exempt. |
| Review | runtime | There was no body size limit. It is now 25 MB. |
| Browser run | runtime | Bot webhooks weren't delivered: the runtime's externs were stubs. Workflows now run after the response, as Rails jobs do, and `post_json` delivers the webhook and posts the bot's reply. |

## Independent review

A separate review session audited the claim twice. It started its own runtime, re-ran all
42 scenarios through the interpreter and over HTTP (42/42 both times), and read the Rails
source.

**First pass.** It flagged:
- the unbounded handler state;
- upload serving;
- the missing CSRF protection;
- the missing size limits.

All four are fixed (see the table above). Some of its other items were not issues:
- **"Sessions survive deactivation":** the spec's `deactivate_user` deletes them.
- **"Email uniqueness is case-sensitive"** and **"bot keys accepted in the query string":** Rails behaves the same in both cases, so these are parity.
- **"`/_view` lacks authorization":** views go through the same gates and permissions as everything else.

**Second pass.** It verified the fixes: a tampered handler is rejected, cross-site writes get
403, and all 42 scenarios still pass. It then looked for gaps controller by controller.
Checked against the Rails source, none of its six candidates is a real difference:

| Candidate | What the Rails source does |
| --- | --- |
| Sidebar ordering | Rails orders rooms by lowercased name and direct rooms by `updated_at` descending (`users/sidebars_controller.rb:6-7,16`). The spec does the same: the view orders by name, and the direct list re-sorts by `updated desc`. |
| Messages sorted by creation, not update | Rails sorts by `created_at` (`message.rb` `ordered`). |
| Direct-room matching and member order | Rails compares sets (`rooms/direct.rb:13`); so does `same_members`. |
| Autocomplete including banned users | Rails filters `.active` (`autocompletable/users_controller.rb`); so does the spec. |
| Paging at the 40-message boundary | Covered by the `g6-paging` scenario. |
| Webhook timeout and error paths | **True:** implemented as specified (`webhook.rb`'s 7 s timeout, with a text or attachment reply) but not exercised by a test. |

**Mentions, added after the review.** The composer now has an "@" picker:
- **A picked person is a mention.** Pick a bot in a shared room and its webhook fires.
- **Typed "@name" text is not a mention,** as in Rails, where mentions are attachments chosen from the prompt.
- **The bot's own mention is stripped** from the text it receives (`webhook.rb` `without_recipient_mentions`).

`tools/e2e/mention.mjs` checks all three in Chromium: typed text made no webhook call, a
picked mention made exactly one, and the reply "echo: please reply" appeared in the room.

## Size, now that the generic layer exists

The spec is the Campfire-specific part: 581 lines of logic and 557 lines of UI, 1,138 lines
in all.

The generic layer it runs on, the same for any spec:

| | Lines |
| --- | ---: |
| Parser | 460 |
| Checker | 343 |
| Interpreter | 593 |
| Runtime | 671 |
| **Total** | **about 2,070** |

The Rails app's Campfire-specific code is about 7,800 lines, and the Rust port's about
22,000. Rails also relies on Rails itself plus its gems. The Rust port relies on about
24,800 lines of generic crates.

These numbers favour the spec more than is fair. The runtime is far smaller than a real
framework because it does less, as the next section lists.

## What equity doesn't cover

These are behaviours that no scenario reaches. In each, the spec-driven app differs from
Rails or is unproven:

- **Web push.** Neither oracle nor runtime delivers it: the oracle stubs Rails' job, and the runtime logs and skips it. The spec states who gets notified; the delivery (VAPID keys, payload encryption, the service worker) isn't built.
- **Rich text.** Mentions work (see above), but the composer is otherwise a plain textarea, with no formatting and no link previews. The `opengraph` extern isn't implemented in the runtime.
- **Attachments.** Uploads are stored and shown. Rails' thumbnails, video previews and lightbox are minimal or missing.
- **Presence and typing.**
  - The presence channel runs over HTTP keep-alives; the 60-second window has no oracle scenario, because Rails drives it over Action Cable.
  - Typing indicators aren't wired.
- **UI fidelity.** The UI uses Campfire's markup and CSS where the spec says so. Day separators, scroll behaviour, the boost picker's look and several small widgets differ.
- **Concurrency.** Scenarios run one action at a time. The runtime handles requests one at a time on Node's event loop, with no database transactions across processes.
- **Persistence.** A JSON snapshot after each write, not SQLite. That's fine for a demo, not for production.
