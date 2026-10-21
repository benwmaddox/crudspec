# v2 coverage: Rails Campfire 90b3300 against `spec/v2/campfire.crud`

Every route, channel and job in the Rails app, mapped to the spec declaration that covers
it. "Runtime" marks what the runtime provides instead of the spec: it is generic code,
not Campfire-specific, but it has to exist (milestone M4).

## Routes (controller actions)

| Rails | Spec |
| --- | --- |
| `welcome#show` | screen `home` |
| `first_runs#show`, `#create` | screen `first_run_screen`, action `first_run` |
| `sessions#new`, `#create`, `#destroy` | screen `sign_in_screen`, actions `sign_in` (with its rate limit) and `sign_out` |
| `sessions/transfers#show`, `#update` | screen `transfer_screen`, action `transfer_session`, fn `transfer_link` |
| `accounts#edit`, `#update` | screen `account_screen`, action `update_account` |
| `accounts/users#index`, `#update`, `#destroy` | view `account_users`, actions `change_role` and `deactivate_user` |
| `accounts/bots#index`, `#new`, `#create`, `#edit`, `#update`, `#destroy` | screens `bots_screen`, `new_bot_screen`, `edit_bot_screen`; actions `create_bot`, `update_bot`, `delete_bot` |
| `accounts/bots/keys#update` | action `reset_bot_key` |
| `accounts/join_codes#create` | action `reset_join_code` |
| `accounts/logos#show`, `#destroy` | theme `logo` (runtime serves it), action `delete_logo` |
| `accounts/custom_styles#edit`, `#update` | screen `custom_styles_screen`, action `update_custom_styles` |
| `users#new`, `#create`, `#show` | screens `join_screen` and `user_screen`, action `join` |
| `users/avatars#show`, `#destroy` | runtime: avatar images, initials and the default bot avatar; action `delete_avatar` |
| `users/bans#create`, `#destroy` | actions `ban_user`, `unban_user`; workflow `UserBanned` |
| `users/sidebars#show` | component `sidebar_panel`; views `sidebar_rooms`, `direct_placeholders` |
| `users/profiles#show`, `#update` | screen `profile_screen`, action `update_profile` |
| `users/push_subscriptions#index`, `#create`, `#destroy` | screen `push_subscriptions_screen`; actions `subscribe_push` (via widget `push_permission`) and `unsubscribe_push` |
| `users/push_subscriptions/test_notifications#create` | action `send_test_notification`, workflow `TestPush` |
| `autocompletable/users#index` | view `autocomplete_users` |
| `rooms#index`, `#show`, `#destroy`, `rooms/@:message_id` | screens `home` and `room_screen` (with `at`), action `delete_room` |
| `rooms/opens#new`, `#create`, `#edit`, `#update` | screens `new_room_screen` and `edit_room_screen`; actions `create_open_room`, `update_open_room` |
| `rooms/closeds#new`, `#create`, `#edit`, `#update` | the same screens; actions `create_closed_room`, `update_closed_room` |
| `rooms/directs#new`, `#create`, `#edit`, `#destroy` | screens `new_direct_screen` and `edit_room_screen`; actions `create_direct_room`, `delete_direct_room` |
| `rooms/involvements#show`, `#update` | component `involvement_bell`, action `set_involvement` |
| `rooms/refreshes#show` | runtime: the `live` view `room_messages` catches clients up |
| `messages#index`, `#create`, `#show`, `#edit`, `#update`, `#destroy` | view `room_messages`; actions `post_message`, `edit_message`, `delete_message`; editing inline in `message_actions` |
| `messages/by_bots#index`, `#create`, `#update`, `#destroy` | `api bot_messages`; its create answers with a `Location` of the message in its room (`url_of(room_screen(room, result))`), which is crudspec's choice: the Rails source wasn't to hand to check which address Rails gives |
| `messages/boosts#index`, `#new`, `#create`, `#destroy` and `messages/boosts/by_bots` | component `message_item` (list and popup form), actions `boost` and `unboost`; `api bot_messages` |
| `searches#index`, `#create`, `#clear` | screen `search_screen`, actions `search` and `clear_searches`, views `search_results` and `recent_searches` |
| `unfurl_links#create` | view `unfurl_link`, extern `opengraph` |
| `qr_code#show` | runtime: widget `qr_link` |
| `pwa#manifest`, `#service_worker`, `up` | runtime |
| `rooms/settings#show` | the route exists, but there is no controller at 90b3300 |

## Channels and jobs

| Rails | Spec |
| --- | --- |
| `PresenceChannel` | `channel presence` with the internal actions `present`, `absent`, `refresh_connection` |
| `TypingNotificationsChannel` | `signal typing`, declared and checked; **not working**: the compiled app doesn't send signals yet (`SIGNAL_NOT_SENT`), so no typing indicator shows |
| `RoomChannel`, `RoomMessagesChannel`, `UnreadRoomsChannel`, `ReadRoomsChannel` and the Turbo broadcasts | `live` views. Their audiences come from the read permissions, so a revoked membership stops delivery |
| `HeartbeatChannel` | runtime |
| `RemoveBannedContentJob` | workflow `UserBanned` |
| `Bot::WebhookJob` | workflow `MessagePosted`, step `webhooks` |
| `Room::PushMessageJob` | workflow `MessagePosted`, step `push` |

## Provided by the runtime, not the spec

These are generic, and would be the same for any app. They're where much of Rails'
3,749 lines of JavaScript and some of its helpers go:

- **Rich text:** mention attachments, the content filters and auto-linking (`richtext … autolink`). The editor is plain text with @mentions and link previews: Rails' rich-text editor (Lexxy and Action Text: bold, lists, code blocks) isn't reproduced.
- **Attachments:** the lightbox, downloading and sharing. Not reproduced: analysis, thumbnails and video previews.
- **Composer:** reply quoting. Not reproduced: drafts, pasting and dropping files, editing your last message with the up arrow, offline handling.
- **Message area:** keeping the scroll position, jumping to the newest message, day separators, local times.
- **Sidebar:** sorted lists, unread badges and dots.
- **Widgets:** autocomplete; copy, share and QR; sounds; the push-permission flow and the web app install instructions.
- **Images:** avatars (initials as SVG, the default bot avatar) and logos, without variants.
- **Infrastructure:**
  - browser version checks;
  - version headers;
  - CSRF;
  - the session cookie;
  - the WebSocket transport;
  - the web app manifest and service worker.

## Approximations, to be confirmed by M3 oracle scenarios

- **Edit and boost forms.** Message editing and new boosts are inline popups. Rails uses Turbo frames that load separate pages; the behaviour is the same, the markup isn't.
- **Account settings.** `update_account` takes one optional parameter per setting. Rails sends the settings hash as a single form.
- **Deactivated emails.** The rewritten email uses `token(36)` where Rails uses a UUID. Both are unique, so the behaviour is the same.
