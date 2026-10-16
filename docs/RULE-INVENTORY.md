# Rule inventory: the Campfire slice

This is the **fixed denominator for H5**. It lists every behavioural rule in the
slice, taken from the Rails source of ONCE Campfire at commit **`90b3300`**
(2026-09-26, `basecamp/once-campfire`). Citations are `path:line` in that tree.
It was written before any spec, and is frozen when Phase 1 starts. A rule
missing here can be added only with a new inventory version.

**Slice:** users and roles, rooms (open, closed, direct), memberships and
involvement, messages (create, edit, delete), boosts, deactivation, bans, unread
state.
**Out of scope:** rich-text rendering, attachments and media, websockets and
presence (except where a rule's effect is visible over HTTP), search, push,
bots and webhooks, sessions and sign-in mechanics, account settings other than
room-creation restriction.

How each rule is observed:
- **H:** the HTTP oracle, a controller request whose outcome and resulting state are recorded.
- **M:** a model-level oracle call only; not reachable over HTTP in the slice.

## Authentication and request gates

| ID | Rule | Source | Obs |
| --- | --- | --- | --- |
| A1 | Every request in the slice requires a signed-in session; otherwise it redirects to sign-in | `app/controllers/concerns/authentication.rb:6,33-35,50-53` | H |
| A2 | A non-GET/HEAD request from an IP address that has a ban is answered with 429 | `app/controllers/concerns/block_banned_requests.rb:5,9-15`; `app/models/ban.rb:6-8` | H |
| A3 | Sign-in only succeeds for `active` users, so deactivated and banned users can't start sessions | `app/controllers/sessions_controller.rb:11` | H |

## Roles and administration

| ID | Rule | Source | Obs |
| --- | --- | --- | --- |
| P1 | Users have role `member`, `administrator` or `bot`; the default is member | `app/models/user/role.rb:5`; `db/schema.rb` (`users.role` default 0) | M |
| P2 | `can_administer?(record)` is true for an administrator, for the record's creator, or for a new record | `app/models/user/role.rb:8-10` | H |
| P3 | Account-level admin actions (change role, deactivate a user) need an administrator; the record-less `can_administer?` reduces to `administrator?` | `app/controllers/concerns/authorization.rb:3-5`; `app/controllers/accounts/users_controller.rb:2` | H |
| P4 | Changing a role accepts only `member` or `administrator`; anything else becomes `member` | `app/controllers/accounts/users_controller.rb:23-25` | H |
| P5 | Role changes and deactivation apply only to `active` users; others give 404 | `app/controllers/accounts/users_controller.rb:19-21` | H |

## Rooms

| ID | Rule | Source | Obs |
| --- | --- | --- | --- |
| R1 | A room has a type (`Open`, `Closed` or `Direct`), an optional name and a creator; the creator defaults to the current user | `app/models/room.rb:23`; `db/schema.rb` (rooms) | H |
| R2 | When the account restricts room creation to administrators, a non-administrator creating an open or closed room gets 403 | `app/controllers/rooms_controller.rb:40-44`; `rooms/opens_controller.rb:6`; `rooms/closeds_controller.rb:6` | H |
| R3 | Creating an open room makes **every active user** a member, bots included. The creator is granted first, then the after-commit hook grants all active users | `app/controllers/rooms/opens_controller.rb:20`; `app/models/rooms/open.rb:3,6-8`; `app/models/room.rb:35-41` | H |
| R4 | Creating a closed room grants membership **only to the selected users**. The creator isn't added unless selected | `app/controllers/rooms/closeds_controller.rb:20,51-61` | H |
| R5 | Creating a direct room with selected users always includes the current user. If a direct room with exactly that set of users exists, it is reused; otherwise a new one is created | `app/controllers/rooms/directs_controller.rb:8,18-24`; `app/models/rooms/direct.rb:5-16` | H |
| R6 | New memberships get the room's default involvement: `everything` for direct rooms, `mentions` otherwise | `app/models/room.rb:5,65-67`; `app/models/rooms/direct.rb:19-21` | H |
| R7 | Granting a membership that already exists is a no-op; at most one membership per user per room | `app/models/room.rb:5` (`insert_all`); `db/schema.rb` unique index on memberships(room_id, user_id) | H |
| R8 | Updating an open or closed room (rename, change type, revise members) needs `can_administer?(room)`: an administrator or the room's creator | `rooms/opens_controller.rb:3`; `rooms/closeds_controller.rb:3`; `rooms_controller.rb:36-38` | H |
| R9 | Open and closed rooms convert into each other through their update endpoints. Converting to open grants membership to all active users | `rooms/opens_controller.rb:5,39-41`; `rooms/closeds_controller.rb:5,41-43`; `app/models/rooms/open.rb:7` | H |
| R10 | Updating a closed room sets its membership to exactly the selected users: selected users are granted, other current members revoked | `rooms/closeds_controller.rb:31-34,51-61`; `app/models/room.rb:8-17` | H |
| R11 | A direct room can never change type; the open and closed endpoints can't reach direct rooms | `app/models/room.rb:25,73-77`; `rooms/opens_controller.rb:45-47`; `rooms/closeds_controller.rb:47-49` | H |
| R12 | Room-scoped endpoints only reach rooms the current user is a member of; otherwise they redirect with "Room not found or inaccessible" | `app/controllers/rooms_controller.rb:22-34` | H |
| R13 | Deleting a room needs `can_administer?(room)`, except a direct room, which any of its members may delete | `rooms_controller.rb:3,36-38`; `rooms/directs_controller.rb:34-36` | H |
| R14 | Deleting a room deletes its memberships, its messages, and those messages' boosts | `app/models/room.rb:2,21`; `app/models/message.rb:7` | H |

## Memberships and involvement

| ID | Rule | Source | Obs |
| --- | --- | --- | --- |
| M1 | Involvement is one of `invisible`, `nothing`, `mentions` or `everything` | `app/models/membership.rb:9` | H |
| M2 | Any member may set their own involvement in a room they belong to; a non-member gets 404 | `app/controllers/rooms/involvements_controller.rb:2,8-9`; `app/controllers/concerns/room_scoped.rb:9-12` | H |
| M3 | Setting an involvement value that isn't one of those four is rejected | `app/models/membership.rb:9` (enum assignment raises) | H |

## Messages

| ID | Rule | Source | Obs |
| --- | --- | --- | --- |
| G1 | Only a member of a room can post to it. A non-member's post creates nothing and renders "room not found", with **status 200** | `app/controllers/messages_controller.rb:20-28`; `concerns/room_scoped.rb:10` | H |
| G2 | A posted message records its room and creator, and gets a client message id when none is given | `app/models/message.rb:4-5,11` | H |
| G3 | Editing or deleting a message needs `can_administer?(message)`: an administrator or the message's creator. Others get 403 | `messages_controller.rb:6,57-59`; `app/models/user/role.rb:8-10` | H |
| G4 | Messages are addressed within a room the user belongs to; a message in another room, or a room the user isn't in, gives 404 | `messages_controller.rb:4-5,53-55`; `concerns/room_scoped.rb:10` | H |
| G5 | Deleting a message deletes its boosts | `app/models/message.rb:7` | H |
| G6 | Message pages hold 40 messages, newest last; `before` and `after` page from a given message; an empty page is 204 | `messages_controller.rb:10-18,62-71`; `app/models/message/pagination.rb` | H |

## Unread state

| ID | Rule | Source | Obs |
| --- | --- | --- | --- |
| U1 | Posting a message marks the room unread (`unread_at` = the message's time) for every membership that is **visible** (not `invisible`) and **disconnected**, and **not the creator's** | `app/models/message.rb:12`; `app/models/room.rb:48-51,79-81` | H |
| U2 | A membership is connected when `connected_at` is within the last 60 s; otherwise disconnected | `app/models/membership/connectable.rb:4-8` | M |
| U3 | Becoming present in a room clears `unread_at` (over the presence channel, so websockets) | `app/models/membership/connectable.rb:16-18,25-27` | M |

## Boosts

| ID | Rule | Source | Obs |
| --- | --- | --- | --- |
| B1 | A user can boost any message in any room they are a member of; otherwise 404 | `app/controllers/messages/boosts_controller.rb:2,25-27`; `app/models/user.rb:7` | H |
| B2 | A boost records its message, booster and content. There is no uniqueness, so a user may boost the same message repeatedly. Content is declared as at most 16 characters, but isn't validated; SQLite doesn't enforce the limit | `boosts_controller.rb:12,33-35`; `app/models/boost.rb:2-3`; `db/schema.rb` (`boosts.content` limit 16) | H |
| B3 | Only the booster can delete their own boost; others get 404 | `boosts_controller.rb:3,29-31` | H |

## Users: joining, deactivation, bans

| ID | Rule | Source | Obs |
| --- | --- | --- | --- |
| D1 | Joining with the account's join code creates an active member and grants membership in every **open** room | `app/controllers/users_controller.rb:5,11-14,27-29`; `app/models/user.rb:22,53-55` | H |
| D2 | A wrong join code gives 404 | `users_controller.rb:27-29` | H |
| D3 | Deactivating a user (admin only) deletes their memberships in **non-direct** rooms (they stay in direct rooms), deletes their sessions and searches, sets status `deactivated`, and rewrites their email so it can be reused | `accounts/users_controller.rb:13-16`; `app/models/user.rb:35-46,57-59` | H |
| D4 | A deactivated user's messages and boosts remain | `app/models/user.rb:35-46` (absence of message deletion) | H |
| N1 | Banning a user (admin only) creates a ban for each distinct non-blank IP in their sessions, deletes their sessions, removes all their messages (via a background job), and sets status `banned` | `app/controllers/users/bans_controller.rb:2,5-8`; `app/models/user/bannable.rb:4-10,23-28,31-41` | H |
| N2 | A ban IP must be a valid public address. Loopback, private or link-local addresses are rejected, so banning a user with such a session IP fails | `app/models/ban.rb:4,11-19` | H |
| N3 | Unbanning (admin only) deletes the user's bans and sets status `active`. Memberships are unchanged by ban and unban; removed messages don't return | `bans_controller.rb:10-13`; `app/models/user/bannable.rb:12-17` | H |
| N4 | Banning doesn't delete memberships | `app/models/user/bannable.rb` (absence) | H |

## Counts

| Group | Rules |
| --- | ---: |
| Authentication and request gates (A) | 3 |
| Roles and administration (P) | 5 |
| Rooms (R) | 14 |
| Memberships and involvement (M) | 3 |
| Messages (G) | 6 |
| Unread state (U) | 3 |
| Boosts (B) | 3 |
| Users, deactivation and bans (D, N) | 8 |
| **Total** | **45** |

H5 is measured as the share of these 45 rules expressed in the spec rather
than in `extern fn` escape hatches. U2 and U3 are model-level only (M); they
count for H5 but are checked against model-oracle cases, not HTTP ones.

## Notes for the oracle

- Each actor needs a session created through sign-in, with a **public** `REMOTE_ADDR` (for example `203.0.113.x`), or N1 fails on N2's rule. A loopback-IP case is kept on purpose as a test of N2.
- Background jobs (N1's message removal, push) run **inline** in the oracle so the final state is deterministic. Push delivery is out of scope and stubbed.
- Forgery protection must be disabled in the oracle's environment. The rules here are about authorization, not CSRF.
- Timestamps are excluded from normalized state, except `unread_at` presence (U1) and ordering where a rule depends on it (G6, R5's "exists").
