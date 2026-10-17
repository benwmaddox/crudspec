# The complete Campfire spec, compared with Rails and the Rust port (static)

> **Paths moved (17 Oct 2026).** The language is now `lang/` (`tools/src/v2/*`, and `docs/LANGUAGE-v2.md` is `lang/LANGUAGE.md`). Campfire is now `apps/campfire/` (`spec/v2/campfire.crud`, `oracle/`, `tools/e2e/`, `docs/V2-*.md`). This report keeps the paths as they were when it was written.

*17 Oct 2026. Spec `spec/v2/campfire.crud` at commit b2da036; Rails at 90b3300; the Rust port at 6dae2fd.*

**What this is.** The spec now defines all of Campfire, UI included. It parses, and the
v2 checker passes it with no errors and no warnings. Every Rails route, channel and job is
mapped to it (`docs/V2-COVERAGE.md`).

**What this isn't.** The v2 spec has not been *run*. There is no v2 interpreter or runtime
yet (milestones M3 and M4). So this report compares size, structure and where rules live,
not behaviour. Behaviour has been checked only for the v1 slice, which matched Rails on 25
of 25 scenarios.

## Size

All counts are non-blank, non-comment lines.

| | Rails (app code) | Rust port | crudspec v2 spec |
| --- | ---: | ---: | ---: |
| Logic (data, rules, actions, background, real time) | 2,376 | about 16,800 | **580** |
| UI (views, templates, helpers) | 2,655 | about 5,150 | **545** |
| Client behaviour (JavaScript) | 2,796 | n/a | 0: in runtime widgets |
| Styles | 2,812 CSS | reused | reused, Campfire's own CSS |
| **App-specific total** | **7,827** | **about 22,000** | **1,125** |

**Rails breakdown.**
- Logic: models 1,093, controllers 1,059, channels 125, jobs 17 and routes 82.
- UI: views 2,032 and helpers 623.
- Not counted: `lib/`, 244 lines, mostly network guards. They belong to the runtime side.

**Rust breakdown.**
- App-specific crates:
  - `campfire`: 12,515 (controllers, channels, jobs);
  - `db`: 4,297 (the logic row above counts both together);
  - `views`: 3,466;
  - HTML templates: 1,686.
- Not counted: its generic crates (`kit`, `richtext`, `storage`, `cable`, `rails_compat`, `assets`), about 24,800 lines. These are its "runtime", the counterpart of the Rails framework and its gems.

**Spec breakdown.** 77 of the 580 logic lines are the sound and quick-reaction tables. Rails
holds the same data in about 60 lines.

The spec is about **7× smaller** than the Rails app code and about **20× smaller** than the
Rust port's app-specific code. **That isn't a like-for-like saving.** The spec relies on
a runtime that doesn't exist yet. The runtime must supply the generic behaviour that Rails
gets from its framework, its gems and its 2,796 lines of JavaScript:
- the rich-text editor;
- attachment processing;
- live updates;
- the widgets.

What the comparison does show: once that generic layer exists, **the Campfire-specific
part** is about 1,100 lines in one file, against about 7,800 lines in roughly 200 Rails
files.

## Where a rule lives: three examples

| Rule | Rails | Spec |
| --- | --- | --- |
| **Who may edit a room** | `User::Role#can_administer?`; `RoomsController#ensure_can_administer`; a `before_action` in each of `Rooms::OpensController` and `Rooms::ClosedsController`; `room_scope` in each (direct rooms excluded); the view helper `link_to_edit_room`; the conditional in `rooms/layouts/_form` that shows a heading instead of a name field. **6 places in 5 files** | Two `require`s in `update_open_room` and `update_closed_room`, plus `readonly_unless` on their forms. **3 places in 1 file**, and the checker connects the form to the action's parameters |
| **Who gets a push notification** | `Room#push_later`; `Room::PushMessageJob`; `Room::MessagePusher`, which builds the payload and combines four scopes; the `Membership` scopes `visible` and `disconnected` and the `CONNECTION_TTL` in `Membership::Connectable`; `Push::Subscription#notification`; `Message::Mentionee`. **6 files** | The `push` step of the `MessagePosted` workflow, with the predicates `visible`, `connected` and the fn `mentionees`. **One step, about 12 lines** |
| **Who may see a room's messages, including live updates** | `RoomScoped`; `MessagesController`; the long `RoomMessagesChannel`, guarding the stream name; `RoomStreamsAreAuthorized`, which is prepended onto Turbo's channel so it can't be used to get around the guard; an initializer. Rails' own comments say the stock Turbo channel *leaked* until this was added | `permission read Message: member(actor, message.room)`. Every view and live update is filtered by it. The checker rejects a screen that lists rows without one |

The third example is the clearest. In Rails, live-update authorization is a separate,
hand-built security layer, and the code's own comments describe a past leak. In the spec,
live views reuse the read permission, so there is no second path to protect.

## What writing it showed

- **The checker caught real spec errors while the spec was being written.**
  - A nested query in `direct_placeholders` where `it` meant the inner row, not the outer one. That would have offered the wrong people in the sidebar.
  - Three references to screens or APIs that didn't exist.
  - A form value that wasn't in scope in a handler.

  None of these would have failed in Rails until someone opened the page.
- **The UI is where the language is weakest.** Screens are about half the spec, and need the most vocabulary: about 40 element and attribute words. Fidelity to Campfire's look is unproven until a runtime renders them with Campfire's CSS. The JavaScript-heavy behaviours are delegated to named runtime widgets, so the spec states *that* they exist, not *how* they work.
- **Time was the main gap in v1,** and v2 now expresses it: the 60-second presence window, transfer links that expire, and the rate limit.

## What it doesn't show yet

- **Behaviour.** That needs:
  - **M3:** a v2 interpreter, with the slice scenarios ported and new oracle scenarios for bots, search, push, transfer and presence;
  - **M4:** a runtime that serves the spec as a working app.
- **Effort and correctness of change.** Whether people and agents change this spec more correctly than the Rails or Rust code is H2–H4, paused until the spec runs.
