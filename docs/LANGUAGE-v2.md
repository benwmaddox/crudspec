# crudspec language, v2 (draft)

v2 is v1 (`docs/LANGUAGE.md`) plus what a complete app needs: time, files, rich text,
search, secrets, external effects, real time, an API and a UI. Everything v1 says still
holds. Programs stay non-Turing-complete:
- loops run only over stored rows or literal lists;
- functions are non-recursive;
- every effect outside the database goes through a declared `extern`.

## Types and values (additions)

| Type | Values and operations |
| --- | --- |
| `Time` | `now`, `t + d`, `t - d`, comparisons. Every row has `created` and `updated` times. Ties in `created` are broken by insertion order, so ordering is total. |
| `Duration` | literals `500 ms`, `60 s`, `30 min`, `4 h`, `7 day` |
| `File` | an uploaded file: `.filename`, `.content_type`, `.size`, `.kind` (`image`, `video`, `audio` or `other`). Storage and variants belong to the runtime. |
| `RichText` | formatted text. `plain(x)` is its text; `mentions(x)` is the set of users it mentions; `blank(x)` is true when it's empty. |
| `Password` | stored hashed and never readable. `authenticates(u.password, given)` checks a password. |
| `Url`, `Email` | text with validation |
| `Json` | a value built with `json { k: e, … }` and `[e, …]`; only for externs and the API |
| `List of T` | an expression value, never stored: `list(E where p order by f : e)`, `[a, b]`; with `count`, `first(n, l)`, `last(n, l)`, `join(l, sep)`, `sentence(l)`, `any`, `in` |

**Text functions:** `+`, `lower`, `upper`, `trim`, `length`, `contains`, `starts_with`, `after(text, prefix)`, `words(text)`, `initials(text)`, `blank`, `present`.

**Tokens and links:**
- `token(n)` gives a random alphanumeric text of length `n`.
- `signed(row, purpose, expires)` gives a tamper-proof reference to a row.
- `verify(E, text, purpose)` gives the row, or `none` if the reference is invalid or expired.

## Declarations (additions)

```
fn display_name(r: Room, viewer: User?): Text =
  if r.type == direct then sentence(list(Membership where .room == r and .user != viewer : .user.name)) else r.name
```

- **`fn`** is a pure function that returns any type. Functions may not call themselves.
- **Field options:**
  - `searchable` adds a field to full-text search, queried with `matches(.f, query)` inside a `where`;
  - `touches` on a reference field updates the parent's `updated` time when the row changes, as Rails `touch: true` does;
  - `= token(12)` is a generated default.
- **`data Name { fields } rows [ { … }, … ]`** is read-only reference data, such as the list of sounds.
- **`limit`** in `where … order by f [desc] limit n` caps the number of rows.

## Statements (additions)

- **`let x = e`** binds a value.
- **`result e`** names what an action produced, for screens and the API.
- **`rate_limit n per d by request.ip else outcome`** applies to the action it appears in.
- **`set x.f = e`** may also set times, files and passwords. A password is hashed.
- **`touch x`** sets `x.updated = now`.

## Identity

```
identity session: Session.token from cookie "session_token"
identity bot_key: User from path bot_key as "{id}-{bot_token}" where .role == bot and .status == active
```

`actor` is the user identified by the first identity that matches. `request.identity` is
the identity's name, so a gate can say `gate deny_bots: request.identity == bot_key -> forbidden`.

## Effects: externs and workflows

```
extern fn web_push(endpoint: Url, p256dh: Text, auth: Text, title: Text, body: Text, path: Text, badge: Int) effect push
extern fn post_json(url: Url, body: Json, timeout: Duration): HttpReply effect http
```

- An `extern` declares a host function's signature and its effect.
- Externs with an effect other than `fetch` may be called **only inside workflow steps**, never in actions, triggers or views. The checker enforces this.
- A `fetch` extern reads from outside without changing anything, so a value view may call it: `view unfurl_link(link: Url) value call opengraph(link)`.
- A workflow step may `let` the result of an extern call and act on it. The step must still be safe to repeat.

## Real time

- **`view … live`** keeps the view's rows current for every client showing it. The runtime re-sends the rows that change and removes the rows that disappear. Read permissions still apply to every update.
- **`signal name(params) to <set of users> carries { fields }`** declares an ephemeral broadcast that is never stored, such as typing indicators.
- **`channel name(params) requires e on open action(args) on close action(args) every d action(args)`** declares a client connection the runtime keeps open. Presence is one.

## API

```
api bot_messages "/rooms/:room/:bot_key/messages" identity bot_key {
  get    -> list_messages(room, before: query.before, after: query.after) as json
  post   -> post_message(room, body: request.text) status 201
}
```

An `api` maps HTTP routes to actions and views, with explicit parameter binding. Outcomes
map to statuses as follows:

| Outcome | Status |
| --- | --- |
| ok | 200, or the status given |
| forbidden | 403 |
| not_found | 404 |
| invalid | 422 |
| blocked | 429 |
| unauthenticated | 401 |

## UI

```
layout app {
  nav    { slot nav }
  main   { slot main  footer { slot footer } }
  aside  { slot sidebar }
  flash
}

screen room "/rooms/:room" (room: Room) layout app {
  require member(actor, room) else go home flash "Room not found or inaccessible"
  title display_name(room, actor)
  nav    { heading display_name(room, actor)  link edit_room(room) icon "menu-dots-horizontal" label "Settings" }
  main   { list room_messages(room) as m { use message_item(m) } }
  footer { form post_message(room) { field body richtext  submit icon "arrow-up" label "Send" } }
}
```

- **`screen name "route" (params) layout L { … }`** declares a page.
  - Its `require … else go <screen> [flash "…"]` checks run before it renders.
  - It fills the layout's slots.
- **`component name(params) { … }`** is a reusable piece of UI.
- **Elements** (presentation only; no logic beyond `if`, `each` and expressions):

  | Group | Elements |
  | --- | --- |
  | Text | `heading`, `text`, `strong`, `time e [as date\|time\|relative]` |
  | Media | `image`, `avatar u`, `icon "name"` |
  | Navigation | `link screen(args)`, `link url e`, `button action(args) [confirm "…"]` |
  | Forms | `form action(args) { field p kind [label "…" placeholder "…"] … submit }`, `switch` |
  | Lists | `list view(args) as x { … }`, `each x in list { … }` |
  | Structure | `section`, `row`, `column`, `separator`, `menu`, `popup`, `dialog`, `frame` |
  | Runtime widgets | `widget name(args)`: `copy_button`, `share_button`, `qr_link`, `lightbox`, `autocomplete`, `sound`, `push_permission` |

- **Form fields** are typed from the action's parameters: `text`, `email`, `password`, `richtext`, `file`, `textarea`, `users`, `hidden`. The field names must match the action's parameters.
- **After a form or button** runs its action, `on ok go screen(args)` or `on ok stay` decides what happens; `flash "…"` adds a message. Other outcomes show the layout's flash, unless they're handled with `on not_found go …`.
- **`class "…"`** on any element is a styling hint for the theme. The base theme uses Campfire's stylesheet.

**Checks on the UI:**
- every `link`, `button` and `form` names a real screen or action, with arguments of the right type;
- every `form` field is a parameter of its action;
- a screen shows only rows that their entity's read permission allows for the viewer;
- every action is reachable from some screen, or from an `api`, or a `channel`, or is marked `internal`;
- a `button` or `form` is shown only where its action's `require`s can pass for the viewer: the runtime evaluates them before rendering.
