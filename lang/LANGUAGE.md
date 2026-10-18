# crudspec language, v2

Everything the language has (every UI element and its attributes, field kinds, outcomes, builtins) is listed in [`REFERENCE.md`](REFERENCE.md), generated from the compiler: `node lang/cli.ts reference`.

*The language is generic. Apps written in it live under `apps/`; ONCE Campfire
(`apps/campfire/campfire.crud`) is the first. Nothing in the language or its runtime
names an app's entities, screens or styles: an app declares them.*

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
| `Url`, `Email` | text with validation. `host(u)` and `path(u)` read a URL's parts; `with_host(u, h)` swaps its host. |
| `Json` | a value built with `json { k: e, … }` and `[e, …]`; only for externs and the API |
| `List of T` | an expression value, never stored: `list(E where p order by f : e)`, `[a, b]`; with `count`, `first(l)`, `first(l, n)` (the first n), `last(l)`, `last(l, n)`, `join(l, sep)`, `sentence(l)`, `any`, `in` |

**Sizes:** a text field or parameter may say how long it can be: `subject: Text max 120`, `code: Text max 8 min 4`, `action rename(n: Text max 40)`. Lengths count characters (as SQLite's `length()` does). The size holds everywhere: the action refuses a value that doesn't fit (`invalid`), a form's field gets a matching `maxlength`, the agent schema says `maxLength`, and the database has a CHECK. A parameter stored into a sized field takes the field's size. `Email`, `Url` and `Ip` have default maxima (254, 2048, 45). Changing a size later is an upgrade step: tightening is checked against existing rows.

**Enum labels:** a value can declare how people see it: `enum Status { open, pending "Waiting on customer", solved }`. One without a label shows its name made readable (`not_found` is "Not found", `open` is "Open"). An enum value shown in the UI (`<text>{t.status}</text>`, `heading`, `strong`) shows its label, and so do a choice field's options; `label(e)` gives it in an expression (`"Status: " + label(t.status)`). `text(e)` is still the declared name, for comparisons, links and the API. Labels are display only: changing one is not an upgrade step.

**Request values:** `cookie(name)` reads a cookie, for example one a screen's `remember "name"` set.

**Text functions:** `+`, `lower`, `upper`, `trim`, `length`, `contains`, `starts_with`, `after(text, prefix)`, `words(text)` (the **number** of words), `split(text)` (the list of words), `split(text, sep)`, `initials(text)`, `blank`, `present`.

**Tokens and links:**
- `token(n)` gives a random alphanumeric text of length `n`.
- `signed(row, purpose, expires)` gives a tamper-proof reference to a row.
- `verify(E, text, purpose)` gives the row, or `none` if the reference is invalid or expired.

## Declarations (additions)

**Unique keys** (`unique (email)`, `unique (room, user)`) hold on create and on update. As in SQL, **a key with an empty value never clashes**: two users with no email are fine, and a new key added to existing data refuses the upgrade only if two rows share a full value.

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

## The app

```
app campfire {
  name "Campfire"
  actor User                   // the entity that signs in and acts: the type of `actor`
  sign_in sign_in_screen       // where a signed-out visitor is sent
  setup first_run_screen       // … or here, while setup_when holds
  setup_when not exists(User)
}

display User: .name            // how pickers and lists label a row
avatar User: if .avatar != none then .avatar else if .role == bot then "default-bot-avatar.svg" else initials(.name)
```

- **`app`** tells the runtime what it would otherwise have to guess.
- **`display E: <expr>`** labels a row, for example in a mention picker or a user list.
- **`avatar E: <expr>`** evaluates per row to an image. It may give:
  - a stored `File`;
  - the name of an image in the assets;
  - text, which the runtime draws as initials.

  The runtime serves the result at `/avatars/E/<id>`.
- **`theme`** properties:
  - `stylesheets [ … ]` lists the CSS files, served from the assets directory;
  - `custom` is extra CSS;
  - `logo` is an image;
  - `classes json { button: "…", submit: "…", … }` gives the app's class names for the runtime's own markup. The runtime has no styling of its own.

  The class kinds are: `heading`, `icon`, `avatar`, `avatar_large`, `button`, `submit`, `plain_button`, `row`, `column`, `menu`, `dropdown`, `dropdown_panel`, `form`, `fieldset`, `button_form`, `field`, `input`, `choices`, `choice`, `picker_item`, `signal` and `screen_reader`.

## Identity

```
identity session: Session.token from cookie "session_token"
identity bot_key: User from path bot_key as "{id}-{bot_token}" where .role == bot and .status == active
```

`actor` is the user identified by the first identity that matches. `request.identity` is
the identity's name, so a gate can say `gate deny_bots: request.identity == bot_key -> forbidden`.

## Effects: externs and workflows

```
extern fn web_push(endpoint: Url, p256dh: Text?, auth: Text?, title: Text, body: Text, path: Url, badge: Int): Text effect push
extern fn post_json(url: Url, body: Json, timeout: Duration): HttpReply effect http
```

- An `extern` declares a host function's signature and its effect.
- Externs with an effect other than `fetch` may be called **only inside workflow steps**, never in actions, triggers or views. The checker enforces this.
- A `fetch` extern reads from outside without changing anything, so a value view may call it: `view unfurl_link(link: Url) value call opengraph(link)`. The runtime awaits such views when a client asks for them. Its built-in `opengraph(url)` reads a page's OpenGraph card through a network guard that refuses private and loopback addresses, on every redirect.
- A workflow step may `let` the result of an extern call and act on it. The step must still be safe to repeat.
- Named arguments to an extern are matched to its parameters by name.
- The runtime provides these externs:
  - `post_json(url, body, timeout)`;
  - `opengraph(url)`;
  - `web_push(…)`, which encrypts and signs a notification. It returns `"sent"`, `"expired"` (the subscription is gone, so delete it) or `"failed"`.

## Agents

An app opts in with an identity whose source is `token`:

```
identity agent: User from token where .status == active and .role != bot
```

- **Tokens.**
  - A signed-in person issues and revokes tokens at `/_agents`, with full or read-only access.
  - An agent with a token acts as that person, with that person's permissions and no more.
  - The `where` is checked on every call, so someone who loses access, deactivated for example, takes their agents with them.
  - `request.identity` is the identity's name, so gates can treat agents differently.
- **What agents can call:** every action and view, over JSON or MCP, with the same rules as the UI (permissions, gates, rate limits).
  - `GET /_agent/describe` lists them with parameters as JSON Schema, possible outcomes, effects and annotations.
  - `POST /_agent/call/<name>` takes `{"args": {…}, "dry_run"?, "confirm"?, "idempotency_key"?}`.
  - `POST /_mcp` is an MCP server (JSON-RPC over HTTP) with one tool per action and view.
  - All take `Authorization: Bearer <token>`.
- **Unavailable to agents:**
  - actions that manage browser sessions: they create the cookie identity's rows, or read `request.session_token`;
  - actions that require a file upload. An optional file parameter is simply left out.
- **Effects and annotations are derived, not written.** From each action's statements, its triggers, its cascades and the workflows its events start, the runtime derives:
  - what the action creates, updates and deletes (workflow effects are listed separately, as `later`);
  - the events and externs it reaches;
  - the MCP annotations:
    - `readOnlyHint`: changes nothing;
    - `destructiveHint`: updates or deletes rows;
    - `idempotentHint`: a repeat has no more effect. It is false when the action creates rows, uses the time or random values, reads the field it sets, is rate-limited, or calls externs;
    - `openWorldHint`: reaches an extern.
  - The description is the comment block above the declaration, followed by a summary of the effects.
  - An app's tests can check these claims against the compiled app. Campfire's do (`apps/campfire/test/annotations.ts`).
- **Dry runs** run the call, report the rows it would create, update and delete, and roll the changes back. The server checks them. A dry run still counts against rate limits, so previews can't be used to guess a password or code.
- **Confirmation.**
  - An action that deletes rows of a kind it doesn't itself create needs a `confirm` value from a dry run. So does a delete whose target can't be resolved statically.
  - Known policy risk: a delete of a kind the action also creates is treated as housekeeping. A spec can meet that test without being harmless, so `review` reports new deletes.
  - The value is bound to the token, the arguments and the data version.
  - Without it the call returns `confirm_required`. If the data changed since the dry run, it returns `stale`.
- **Errors** are `{"outcome", "error": {"kind", "message", "hint"}}`. The kinds are the spec's outcomes plus `confirm_required`, `stale`, `unknown` and `unavailable`.
- **Idempotency keys:** the same key from the same token within 24 hours returns the first result, marked `replayed`. Reusing a key for a different call or different arguments is `invalid`.
- **Never sent to agents:** password fields, fields an identity matches on (`Session.token`, a `{bot_token}` in a format), and fields marked `private`: `endpoint: Url private`.
- **Audit:** every call, dry runs and refusals included, is recorded and shown to the person at `/_agents`. Password arguments are redacted.

From a shell: `node lang/cli.ts describe <app-url>` and `node lang/cli.ts call <app-url> <name> param=value … [--dry-run] [--confirm <v>] [--key <k>]`. The token comes from `CRUDSPEC_TOKEN`. Exit codes: 0 ok, 3 invalid, 4 forbidden, 5 not found, 6 unauthenticated, 7 blocked, 8 confirm required, 9 stale.

## Reviewing a change

`node lang/cli.ts review <old.crud> <new.crud> [--probes <file>] [--json]` is the report a reviewer of a spec change needs. It lists:
- **schema and data steps**, as in a migration plan, plus contract changes;
- **what agents are told that changed:** new or removed actions, annotations, confirmation, new entities written, new externs;
- **behaviour, by bounded exploration over probe states:**
  - every recorded call is replayed against both versions, by its own actor and by every other actor in that state;
  - every row's read permission is evaluated for every actor, including an anonymous one;
  - a call, view row or read refused before and allowed after is **widened**; the reverse is **narrowed**;
  - each comes with examples.

It exits 2 when something widened, broke callers, or would drop data. Apps record probe states from their scenarios; Campfire's are made by `node apps/campfire/test/probes.ts <spec> <out.json>`.

## Versions and data migration

The runtime records each version of the spec in the database. On start, or with `node lang/cli.ts plan|migrate <spec> --data <dir>`, it compares the spec with the recorded version and upgrades the data. The plan is rehearsed in full on a copy of the database:
1. renames and drops;
2. new tables and columns;
3. defaults for new fields;
4. pending migrations;
5. then every required field, enum value, reference, unique key and invariant, checked on every row.

The upgrade happens only if the rehearsal passes. The original database is kept under `<data>/backups/`. Nothing prompts: every decision is written in the spec.

| Change | What happens |
| --- | --- |
| New entity; new optional field; new field with a default; new enum value; a removed unique key | Applied. A default is evaluated per row and may read the row's fields: `display: Text = upper(.name)`. A new `Int` field without a default starts at 0. |
| New required field without a default; new unique key; new or changed invariant; a field made required; an enum value removed; a text type changed (for example `Text` to `Email`); a kept field declared again | Checked against the data: required values, types, enum values, references, keys and invariants. The language has no format rules, so `Email` and `Url` formats aren't validated. The upgrade is refused while any row breaks a check; the plan names the rows. |
| A field or entity no longer declared | Its data is **kept**. `drop Entity.field` or `drop entity Entity` deletes it on the next upgrade, and the plan says how much. |
| Renames | `name: Text was old_name`, `entity Member was Person`, `enum Status { open, done was closed }`. Values, rows and references are kept. An entity rename also rewrites the entity name stored inside sets, mentions and Json values. An enum rename rewrites fields of that enum type, not enum values inside Json. |
| A field removed and another added with the same type, or an entity replaced by one with mostly the same fields | Refused as ambiguous until the spec says `was` (a rename) or `drop` (really removed). |
| A type change that can't convert (for example `Text` to `Int`) | Refused. Add a new field, copy the values in a migration, then drop the old one. |

**Data migrations** are statements, as in an action. They run once, in declaration order, before the checks:

```
migration "unique handles" {
  for each u in User {
    if count(User where .handle == u.handle and .id < u.id) > 0 { set u.handle = u.handle + "-" + text(u.id) }
  }
}
```

- They run as written: triggers don't fire, and they can't `emit` or call externs.
- A failing `require` refuses the upgrade.
- Applied migrations, drops and `was` hints are reported in the plan's notes, and can then be removed from the spec.
- A new database has no data to migrate, so its migrations are recorded as applied without running. Don't use a migration to seed data.

**Safety rules.**
- The running app holds `<data>/app.lock`. `migrate` refuses while the app runs; `plan` doesn't.
- The backup is copied from the original, which stays in place until one rename swaps in the upgraded copy. A crash at any point leaves a whole database.
- If the database is missing but backups or an unfinished upgrade exist, the runtime refuses to start empty and points to the backups.

The plan also lists **contract changes**, which break API and agent callers: a removed action or view, a new required parameter, a parameter whose type changed.

`plan --json` prints the whole plan. Its status is `ready`, `current`, `blocked`, `applied` or `created`. Exit codes: 0 done; 1 spec errors; 2 blocked, with the steps, failing checks and fixes listed.

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

The UI is written as TSX-style markup:

```tsx
layout app {
  <nav><slot name="nav" /></nav>
  <main>
    <slot name="main" />
    <footer><slot name="footer" /></footer>
  </main>
  <aside><slot name="sidebar" /></aside>
  <flash />
}

screen room "/rooms/:room" (room: Room) layout app {
  require member(actor, room) else go home flash "Room not found or inaccessible"
  <title>{display_name(room, actor)}</title>
  <nav>
    <heading>{display_name(room, actor)}</heading>
    <link to={edit_room(room)} icon="menu-dots-horizontal" label="Settings" />
  </nav>
  <main>
    <list of={room_messages(room)} as="m">
      <message_item m={m} />
    </list>
  </main>
  <footer>
    <form action={post_message(room)}>
      <field name="body" kind="richtext" />
      <submit icon="arrow-up" label="Send" />
    </form>
  </footer>
}
```

- **Elements** are `<name …>children</name>`, or `<name … />` with no children. Newlines and indentation don't matter.
- **Attributes** are `name="text"`, `name={expression}`, or a flag on its own (`required`, `desc`). Each element takes a fixed set of them, and an unknown one is an error naming it.
- **An element's main value is its content**, in braces: `<heading>{room.name}</heading>`, `<text>{"None"}</text>`, `<avatar>{m.creator}</avatar>`, `<time as={date}>{m.created}</time>`. Text in the markup always goes in braces, as a string.
- **Where an element goes, or what it does, is an attribute:** `<link to={room_screen(room)}>`, `<link href={url}>`, `<button action={boost(m, "👍")}>`, `<form action={post_message(room)}>`.
- **The others with a head:** `<field name="body" kind="richtext" />`; `<list of={view(args)} as="m" where={…} order={…} desc>` (`of` also takes a query, `of={Boost where .message == m}`); `<each as="u" in={list}>`; `<let name="x" value={…} />`; `<slot name="main" />`; `<widget call={sound(file)} />`, and `call` likewise on `channel` and `signal`.
- **Conditions:** `<if test={…}>…</if>`, then optionally `<else test={…}>…</else>` (as many as needed) and `<else>…</else>`. An `if` attribute on an element (`<submit label="Save" if={can_edit} />`) shows or hides that element alone.
- **Outcomes** after a form or button: `<on ok go={room_screen(result)} />`, `<on ok stay flash="Done." />`, `<on invalid shake />`.
- **Components** are used by their name, with their parameters as props: `<message_item m={m} />`. Props are given in the order of the parameters, from the first.

- **`screen name "route" (params) layout L { … }`** declares a page.
  - Its `require … else go <screen> [flash "…"]` checks run before it renders.
  - It fills the layout's slots.
- **`component name(params) { … }`** is a reusable piece of UI.
- **Elements** (presentation only; no logic beyond `if`, `each` and expressions):

  | Group | Elements |
  | --- | --- |
  | Text | `heading`, `text`, `strong`, `time` (`as={date}`, `as={time}`, `as={relative}`) |
  | Media | `image`, `avatar`, `icon` |
  | Navigation | `link to={screen(args)}`, `link href={url}`, `button action={action(args)} confirm="…"` |
  | Forms | `form action={action(args)}` with `field name="p" kind="…" label="…" placeholder="…"` and `submit`; `switch` |
  | Lists | `list of={view(args)} as="x"`, `each as="x" in={list}` |
  | Structure | `section`, `row`, `column`, `separator`, `menu`, `popup`, `dialog`, `frame` |
  | Runtime widgets | `<widget call={name(args)} />`: `copy_button`, `share_button`, `qr_link`, `lightbox`, `autocomplete`, `push_permission(action)`. `qr_link` makes its QR code on the server (`/_qr/…`), so the link it encodes never leaves the app. An app adds its own with a declaration, `widget sound(file: Text)`, implemented in a module the runtime loads with `--widgets <file>`. That module's default export maps each name to `(args, helpers) => html`. Calls are checked against the declaration. The last asks for notification permission, subscribes the browser, and calls the action with the endpoint, p256dh key and auth key. `client.push_endpoint` is then this browser's endpoint. |

- **Link previews.** A rich-text field's `unfurl={<view>}` attribute names a value view that turns a pasted link into a card. The card is shown before sending and can be removed. Sent cards are kept with the text and drawn with the theme's `embed`, `embed_body`, `embed_content`, `embed_title`, `embed_description` and `embed_image` classes.
- **Pickers.** A field's `mentions={<view>(…)}` or `autocomplete={<view>(…)}` attribute names a view that offers the choices. Inside it, `typed` is the text typed so far. Rows are labelled by their entity's `display`. Only a picked mention is recorded as a mention; text typed as "@name" is not.
- **Other element attributes:**
  - `<popup panel="…">` sets the class of the popup's menu;
  - `<field … accept="image/*" />` limits a file field.
- **Labels.** A `label` next to an icon is read out by screen readers. On a button, link or submit with no icon and no `text`, the label is the visible text.
- **Choosing rows.** `<field name="p" kind="select" from={list} />` chooses one row; `kind="users"` (or `autocomplete={view}`) chooses a set. The checker requires the field's kind to fit the parameter's type.
- **Form fields** are typed from the action's parameters: `text`, `email`, `password`, `richtext`, `file`, `textarea`, `users`, `select`, `hidden`, `url`, `code`, `number` (an `Int`), `choice` (an enum or a `Bool`: `kind="choice" from={[open, done]}`). The field names must match the action's parameters.
  - `select` and `users` only offer rows the person may read.
  - A choice-type field with a `label` and no placeholder or icon shows the label.
- **A row shown as text** (`<text>{r}</text>`) shows its entity's `display`, or else its `name`, `title`, `label` or `subject` field.
- **Design tokens:** `theme { tokens json { accent: "#2f6feb", … } }` become CSS variables (`--accent`), set after the app's stylesheets.
- **Generated screens.** The runtime adds a default screen for:
  - every action no screen, API route or channel offers: a form at `/_auto/actions/<name>`, one labelled field per parameter;
  - every row view no screen lists: a list at `/_auto/views/<name>`;
  - and an index at `/_auto`.

  They take the home screen's navigation, and `classes json { generated_section: "…" }` styles their sections.
  - `node lang/cli.ts scaffold <spec>` prints them as ordinary spec source to copy in and change.
  - The checker's `ACTION_UNREACHABLE` warning names the generated screen.
- **Checking screens:** `node lang/browser/screens.ts <spec> --base <url> --fixture <file> --out <dir> [--baseline <dir>] [--accept] [--shots]`.
  - It renders every screen, generated ones included, against a runtime in `--test` mode, with a fixture loaded through `/_test/fixture`.
  - The fixture is rows created as `create` would create them, then actions run as named people, with a fixed clock and fixed tokens.
  - For each screen it writes a text structure an agent can read: headings, links and their targets, forms and their actions, fields, and lists. With `--shots` it writes screenshots for people too.
  - Against a baseline it prints what changed. It exits 2 on any difference until the change is accepted. Accepting (`--accept`) is a reviewer's step: an agent that changes the UI shouldn't accept its own diff.
  - Closed menus show as `details (closed …)`, with their contents listed under them.
  - Test mode also takes `X-Test-Actor: Entity:id`, to render as a given person.
- **After a form or button** runs its action, `<on ok go={screen(args)} />` or `<on ok stay />` decides what happens; `flash="…"` adds a message. Other outcomes show the layout's flash, unless they're handled with `<on not_found go={…} />`.
- **`class="…"`** on any element is a styling hint for the theme. The base theme uses Campfire's stylesheet.

**Checks on the UI:**
- every `link`, `button` and `form` names a real screen or action, with arguments of the right type;
- every `form` field is a parameter of its action;
- a screen shows only rows that their entity's read permission allows for the viewer;
- every action is reachable from some screen, or from an `api`, or a `channel`, or is marked `internal`;
- a `button` or `form` is shown only where its action's `require`s can pass for the viewer: the runtime evaluates them before rendering.
