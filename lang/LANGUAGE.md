# crudspec

A crudspec spec is a whole web app in one file: its data, the actions that change it, who may do what, its screens, its API and what agents may call. The compiler checks the program as a whole, proves the invariants it states, and compiles it to a Go program that keeps its data in SQLite.

This guide explains the language, in the order you'd write an app. Everything it has (every UI element and its attributes, field kinds, outcomes, builtins, the checks and their codes) is listed in [`REFERENCE.md`](REFERENCE.md), generated from the compiler (`node lang/cli.ts reference`). Read this guide to learn the language, and look things up there.

*The language is generic. Apps written in it live under `apps/`; ONCE Campfire (`apps/campfire/campfire.crud`) is the first. Nothing in the language or its runtime names an app's entities, screens or styles: an app declares them. (`docs/LANGUAGE.md` is the first version, kept as it was frozen for the H10 study; this guide replaces it.)*

**Limits, on purpose.** Programs aren't Turing-complete:
- loops run only over stored rows or literal lists;
- functions and predicates can't call themselves, directly or not;
- every effect outside the database goes through a declared `extern`.

So the checks below can look at every path through the program.

**Commands.** `node lang/cli.ts`:
- `check <spec> [--deep]`: the checks;
- `build <spec> --out <dir>`: the Go program, after the checks and the proofs;
- `verify <spec>`: everything, for CI;
- `review <old> <new>`: what a change does;
- `plan` and `migrate --data <dir>`: upgrade the data;
- `suggest-invariants`;
- `describe` and `call`: an agent's view of a running app;
- `upgrade-syntax`: rewrite an older spec;
- `scaffold`, `bind` and `reference`.

Exit codes: 0 done, 1 errors, 2 needs a person (blocked, widened, …), 64 bad usage.

## A small app

```
app tickets {
  name "Tickets"
  actor User
}

enum State { open, waiting "Waiting on customer", closed }

entity User {
  name: Text max 80
  email: Email
  password: Password
  admin: Bool = false
  unique (email)
}
entity Session { user: User on delete cascade  token: Text = token(24)  unique (token) }
identity session: Session.token from cookie "session"

entity Ticket {
  subject: Text max 120
  state: State = open
  owner: User on delete cascade
  closed_note: Text?
}

predicate mine(t: Ticket) = t.owner == actor
permission read Ticket: mine(ticket) or (actor != none and actor.admin)
gate signed_in: actor == none -> unauthenticated

action open_ticket(subject: Text) {
  create Ticket { subject: subject, owner: actor } as t
  result t
}
action close(t: Ticket, note: Text) {
  require mine(t) or (actor != none and actor.admin) else forbidden
  require t.state != closed else invalid
  set t.state = closed
  set t.closed_note = note
}

invariant closed_have_notes: all(.closed_note != none for Ticket where .state == closed)

view my_tickets() { rows Ticket where .owner == actor order by created desc }

layout page { <main><slot name=main /></main> <flash /> }
screen tickets_screen {
  route "/"
  layout page
  <main>
    <heading>Your tickets</heading>
    <list of={my_tickets()} as=t>
      <row><text>{t.subject}</text> <text>{t.state}</text></row>
    </list>
    <form action={open_ticket()}>
      <field name=subject kind=text placeholder="What's wrong?" />
      <submit label="Open" />
      <on ok stay flash="Opened." />
    </form>
  </main>
}
```

From this, the compiler:
- checks names, types and what can be none;
- proves that every action keeps `closed_have_notes`;
- checks that each query has an index;
- generates the database tables, the pages, the form handling, the session cookie, an agent API with JSON Schema, and a default screen for anything no screen offers (here `close`).

It also warns that nothing ever sets `User.admin`, and that a ticket can never be `waiting`: both true of this sketch, and the kind of thing the checks are for.

## Data

### Entities and fields

```
entity Membership {
  room: Room on delete cascade on change touch     // deleting the room deletes this row; a change touches the room
  user: User on delete cascade
  involvement: Involvement = mentions
  unread_since: Time?
  unique (room, user)
  index (room, created)
  invariant self.user.status == active or self.room.type == direct
}
singleton Account { name: Text  join_code: Text = join(chunks(token(12), 4), "-") }
data Sound { name: Text  file: Text } rows [ { name: "56k", file: "56k.mp3" }, … ]
```

- **A field** is `name: Type [= default] [options]`. `T?` makes it optional, with `none` as its empty value. A default is worked out for each new row and may read the row's other fields (`display: Text = upper(.name)`), or call `token(n)` or `now`.
- **Options:**
  - **Sizes:** `max n`, `min n` on text (characters, as SQLite's `length()` counts). The size holds everywhere: the action refuses a value that doesn't fit (`invalid`), a form's field gets a matching `maxlength`, the agent schema says `maxLength`, and the database has a CHECK. A parameter stored into a sized field takes its size. `Email`, `Url` and `Ip` have default maxima (254, 2048, 45).
  - **`on delete cascade|restrict`** on a reference: delete this row with the one it names, or refuse the delete (`invalid`, the default).
  - **`on change touch`** on a reference: a change to this row updates the parent's `updated` time (Rails' `touch: true`).
  - **`searchable`:** in full-text search, queried with `matches(.f, query)` in a `where`.
  - **`private`:** never shown to agents, exported or mailed.
  - **`write_only`:** the app writes the field and never reads it (data kept for another tool). The deep check holds the app to it (`WRITE_ONLY_READ`).
- **Unique keys** (`unique (email)`, `unique (room, user)`) hold on create and on update. As in SQL, a key with an empty value never clashes: two users with no email are fine.
- **`index (a, b)`** declares an index. With `indexes auto` in the app, the compiler gives the app the indexes its queries want instead (see Query costs).
- **Entity invariants** (`invariant <condition over self>`) must hold for every row after every action; the runtime refuses a write that breaks one (`invalid`). App invariants, which the compiler proves, are below.
- **A `singleton`** has exactly one row, named by its type in expressions (`Account.join_code`).
- **`data`** is read-only reference data, kept in memory.
- **Every row** has `id`, `created` and `updated`. Ties in `created` are broken by insertion order, so ordering by it is total.

### Types

| Type | Values and operations |
| --- | --- |
| `Text`, `Int`, `Bool` | as usual. Text: `+`, `lower`, `upper`, `trim`, `length`, `contains`, `starts_with`, `after(text, prefix)`, `words(text)` (the number of words), `split(text[, sep])`, `initials(text)`, `blank`, `present`, `replace`, `join(list, sep)` |
| `enum Name { a, b "Label", c }` | one of the listed names, written bare (`open`), or `Name.a` when ambiguous. A label is how people see the value (one without a label is its name made readable: `not_found` is "Not found"); `label(e)` gives it, `text(e)` the declared name. Labels are display only |
| `Entity` | a reference to a row; compares by identity |
| `Time` | `now`, `t + d`, `t - d`, comparisons |
| `Duration` | literals `500 ms`, `60 s`, `30 min`, `4 h`, `7 day` |
| `File` | an upload: `.filename`, `.content_type`, `.size`, `.kind` (`image`, `video`, `audio`, `other`) |
| `RichText` | formatted text: `plain(x)` its text, `mentions(x)` the users it mentions, `blank(x)`, `html(x)`, `rich(text)` |
| `Password` | stored hashed (scrypt), never readable: `authenticates(u.password, given)` |
| `Email`, `Url`, `Ip` | text with validation; `host(u)`, `path(u)`, `with_host(u, h)`; `public_ip(e)` |
| `Json` | `json { k: e, … }` and `[e, …]`, for externs and the API only |
| `set of Entity` | a parameter: a set of rows (unknown ones dropped) |
| `list of T` | an expression value, never stored: `list(e for E where p order by f)`, `[a, b]`, with `count`, `first(l[, n])`, `last(l[, n])`, `join`, `sentence`, `any`, `in` |

**Tokens and links:** `token(n)` is random text of length `n`; `signed(row, purpose, expires)` is a tamper-proof reference to a row, and `verify(E, text, purpose)` gives the row back, or none if it was changed or has expired.

### Storage

One SQLite table per entity, one typed column per field, `STRICT`:
- **text** is `TEXT`; `Int`, `Bool` and references are `INTEGER`;
- **a `Password`** is `TEXT` (`scrypt:<salt>:<key>`); a `Duration` is `INTEGER` milliseconds;
- **a `Time`** is two `INTEGER` columns, `field` (milliseconds, UTC) and `field__seq` (its order within the millisecond);
- **a `File`** is four columns: its stored key, `__name`, `__type` and `__size`;
- **a `RichText`** is its text in `field`, with its mentions in `<Entity>__<field>__mentions` and its link previews in `<Entity>__<field>__embeds`;
- **`Json`** is the one JSON column.

So SQL filters, orders and indexes on all of them, and other tools can read the tables. A stored field holds one value; a `set of` or `list of` field is refused (`STORED_COLLECTION`): keep a collection as rows.

## Expressions and queries

**A field of the current row is written with a leading dot.** Inside a `where` (and an `all`'s condition, a field default, `for each … where` and `delete … where`), `.f` is the row's field `f`, and `it` is the row itself. A bare name is always a variable: a parameter, a `let`, a loop variable, `actor`, an enum value, or a singleton. So `Membership where .room == room` compares the row's `room` with the parameter `room`.

| Form | Meaning |
| --- | --- |
| `x.f`, `x.f.g` | a field; references chain |
| `==`, `!=`, `<`, `<=`, `>`, `>=` | comparison |
| `and`, `or`, `not`, `implies` | logic |
| `x in {a, b}`, `x in set_param`, `x in list` | membership |
| `if c { a } else if d { b } else { e }` | a value chosen by conditions |
| `exists(E where p)`, `count(E where p)` | whether any row matches, how many |
| `all(q for E where p)` | whether every matching row satisfies `q` |
| `the(E where p)` | the one matching row; if there isn't exactly one, the action ends `invalid` |
| `the_or_none(E where p)`, `first_or_none(E where p order by f)` | one row or none |
| `list(e for E where p order by f [desc] limit n)`, `set(E where p)`, `set(x, y)` | lists and sets |
| `actor` | who is acting (the app's `actor` entity), or none |
| `request.ip`, `request.method` (`get`, `write`), `request.identity`, `cookie(name)` | the request |
| `p(args)` | a predicate or function |

```
predicate member(u: User?, r: Room) = exists(Membership where .room == r and .user == u)
fn display_name(r: Room, viewer: User?): Text =
  if r.type == direct { sentence(list(.user.name for Membership where .room == r and .user != viewer)) } else { r.name }
```

**`predicate`** is a named condition; **`fn`** a pure function of any type. Neither may call itself. `match` (in the UI, below) chooses by an enum's value, and must cover every value.

Queries compile to SQL: conditions, orders and limits run in the database (see Query costs). An app's data is never held in memory, apart from `data` tables.

## Actions

An action is the only way stored data changes, and runs in one transaction with the triggers it sets off: it keeps all of its writes or none.

```
action edit_message(message: Message, body: RichText) {
  require member(actor, message.room) else not_found
  require can_administer(actor, message.creator) else forbidden
  set message.body = body
}
action sign_in(email: Email, password: Text) {
  skip gate signed_in
  rate_limit 10 per 3 min by request.ip else blocked
  let user = the_or_none(User where .email == email and .status == active)
  require user != none and authenticates(user.password, password) else unauthenticated
  create Session { user: user, ip: request.ip } as s
  result s
}
```

- **Parameters** are typed and resolve lazily. A reference to a row that doesn't exist ends the action with `not_found` when first used; an enum value outside its enum, `invalid`. `name: E?` may be none. Because of lazy resolution, the order of the requires decides which refusal someone gets.
- **Settings** come first, a line each: `skip gate <name>` lets the action run where a gate would refuse it.
- **Statements:**
  - `require <condition> else <outcome> ["reason"]` ends the action with that outcome when the condition is false. Nothing written is kept. Agents are told why: the reason when given, else the condition, with the predicates it calls spelled out for the call (`this needs can_edit(actor, doc)`; hint `can_edit(actor, doc) means doc.owner == actor`). A `not_found` says only what a missing row would (`Doc 4 does not exist`), so it never reveals that a hidden row exists.
  - `reject <outcome> ["reason"]` does the same, unconditionally (in an `if`, or a trigger guarding a transition).
  - `let x = e` names a value for the rest of the block.
  - `create E { f: e, … } [as x]` inserts a row (omitted fields take their defaults); `ensure E { … }` does nothing if a row with the same unique key exists.
  - `set x.f = e` updates a field; a password is hashed. `touch x` sets `x.updated = now`.
  - `delete x` deletes a row, and `delete E where p` every matching row, each applying the `on delete` of rows that refer to it.
  - `for each x in E where p { … }` repeats over the rows matching when the loop starts; `for each x in list { … }` over a list.
  - `if c { … } else { … }`.
  - `emit Event(args)` starts the event's workflows after the action commits.
  - `send mail { … }` (below); `rate_limit n per d by e else outcome` (a fixed window: the first attempt starts it, every attempt in it counts, refused ones too, and it ends `d` after it started); `result e`, what the action produced, for screens and the API.
- **Outcomes** are `ok`, `forbidden`, `not_found`, `blocked`, `invalid` and `unauthenticated`. An action that reaches its end is `ok`. A unique key, an entity invariant, a size or a restricting delete that fails ends it `invalid`.
- **`internal action`** can't be called from outside: screens, the API and agents don't see it (a channel or a schedule can call it).

### Gates

```
gate blocked_ip: request.method == write and exists(Ban where .ip == request.ip) -> blocked
gate signed_in: actor == none -> unauthenticated
gate deny_bots: request.identity == bot_key -> forbidden
```

Gates apply to every action, in order, before its body; the first that holds ends it with its outcome. An action opts out with `skip gate <name>`.

### Triggers

```
trigger on create Message as m {
  for each ms in Membership where .room == m.room and .user != m.creator { set ms.unread_since = m.created }
}
trigger on update Room.type as r when old.type == direct and r.type != direct { reject invalid }
trigger on delete Membership as m { emit Disconnect(m.user) }
```

A trigger runs inside the action's transaction, right after the write that sets it off: `on create E as x`, `on update E.f as x [when …]` (with `old`), `on delete E as x`. It can't reach outside the app. Triggers that could set each other off round and round are reported (`TRIGGER_CYCLE`).

### Who may read

```
permission read Message: member(actor, message.room)
```

A read permission limits which rows any view, screen, export or agent call may show, for every viewer, every time. Every entity a view returns needs one.

### Identity and the app

```
app campfire {
  name "Campfire"
  about "Group chat for one team"   // what agents are told the app is (/llms.txt, MCP)
  actor User                     // who signs in and acts: the type of `actor`
  sign_in sign_in_screen         // where a signed-out visitor is sent
  setup first_run_screen         // … or here, while setup_when holds
  setup_when not exists(User)
  indexes auto
}
identity session: Session.token from cookie "session_token"
identity bot_key: User from path bot_key as "{id}-{bot_token}" where .role == bot and .status == active
identity agent: User from token where .status == active and .role != bot
display User: .name              // how pickers and lists label a row
avatar User: if .avatar != none { .avatar } else { initials(.name) }
```

- `actor` is the row the first matching identity names. `request.identity` is that identity's name.
- **Identity sources:** a `cookie` (sessions), a `path` segment in a format, or a `token` (agents).
- `display` labels rows in pickers and lists.
- `avatar` gives an image per row: a `File`, an asset name, or text drawn as initials. It's served at `/avatars/E/<id>`.

## Views, screens and the UI

### Views

```
view room_messages(room: Room, before: Message?, after: Message?) {
  updates live
  require member(actor, room) else not_found
  rows Message where .room == room and (before == none or .created < before.created) and (after == none or .created > after.created)
  order by created
  window 40 last unless after != none
}
view unfurl_link(link: Url) { value call opengraph(link) }
```

- **A view returns rows in an order** (`rows … order by … [desc] [limit n]`), or a single value (`value e`).
- **Windows:** `window n last` keeps the newest `n`, and `window n first` the oldest. `unless c` switches between them, and `around x n` gives the rows on both sides of one.
- **`updates live`** keeps the rows current on every page showing them. The runtime sends what changed, and read permissions apply to every update.
- Views are what screens list, the API returns and agents read.

### Screens, layouts, components

```
layout app {
  <nav><slot name=nav /></nav>
  <main><slot name=main /></main>
  <flash />
}
screen room_screen(room: Room) {
  route "/rooms/:room"
  layout app
  require member(actor, room) else go home flash "Room not found or inaccessible"
  <title>{display_name(room, actor)}</title>
  <nav><heading>{display_name(room, actor)}</heading> <link to={edit_room(room)} icon="menu" label="Settings" /></nav>
  <main>
    <list of={room_messages(room)} as=m><message_item m={m} /></list>
    <form action={post_message(room)}>
      <field name=body kind=richtext />
      <submit icon="arrow-up" label="Send" />
      <on ok stay />
    </form>
  </main>
}
component message_item(m: Message) { <row><avatar>{m.creator}</avatar> <text>{plain(m.body)}</text></row> }
```

- **A screen's settings** come first, a line each: `route "/rooms/:room"`, `layout L`, `access public` (signed-out visitors may open it; the default is `access signed_in`) and `remember name` (a cookie keeping its last parameters). Its `require … else go <screen> [flash "…"]` (or `else <outcome>`) checks run before it renders. It fills the layout's slots by name.
- **Elements** are `<name attrs>children</name>` or `<name attrs />`. Each takes a fixed set of attributes, and an unknown one is an error. Attributes are:
  - `name="text"` or `name={expression}`;
  - a bare name, for the attributes that name something (`name=body`, `kind=richtext`, `as=m`);
  - a flag on its own (`required`, `desc`).
- **Text is written as it shows.** `<heading>{room.name}</heading>`, `<text>{left} items left</text>`. Runs of spaces show as one space, and the ends are trimmed. Write `{"{"}`, `{"}"}` and `{"<"}` for those characters. Elements whose value isn't text take it in braces: `<avatar>{m.creator}</avatar>`, `<time as={relative}>{m.created}</time>`.
- **Logic among elements:** `if c { … } else if d { … } else { … }`, `let x = e`, `for each x in list { … }`, and `match e { a { … } b, c { … } none { … } }`. A `match` has an arm for every value of the enum (and `none` when it's optional) and no else, so a value added later is an error until every match handles it (`MATCH_MISSING`). An element's `if={…}` attribute shows or hides that element alone.
- **Links and actions:**
  - `<link to={screen(args)}>` and `<link href={url}>`;
  - `<button action={act(args)} confirm="…">` and `<form action={act(args)}>` with `<field>`s and `<submit>`;
  - `url_of(screen(args))` for an absolute address.

  The arguments a call gives come first. A form's fields fill the action's other parameters by name, and are typed from them: `text`, `email`, `password`, `richtext`, `file`, `textarea`, `number`, `url`, `code`, `hidden`, `choice` (an enum or Bool), `select` (one row, from `from={list}`), `users` (a set), `datetime`, `date` (in the person's time zone) and `time` (a time of day, as text). `select` and `users` offer only rows the person may read.
- **Outcomes after a form or button:**
  - `<on ok go={screen(result)} />`, or `<on ok stay flash="Done." />`;
  - `<on invalid shake />`, `<on not_found go={…} />`, and `sign_in={result}` and `clear_form` on an `<on>`.

  An outcome with no `<on>` returns to the page with the outcome's text. A form's `<on>`s are inside it; a button's come right after it.
- **Components** are used by name, their parameters given as props in order: `<message_item m={m} />`.
- **Widgets:** `<widget call={copy_button(text)} />` and the runtime's others:
  - `share_button`, `qr_link` (drawn on the server);
  - `lightbox`, `autocomplete`;
  - `push_permission(action)`, which subscribes the browser and calls the action with its endpoint and keys.

  An app adds its own with `widget name(params)`, implemented in Go (`--widgets <file.go>`).
- **Rich text fields:** `mentions={view(…)}` and `autocomplete={view(…)}` name a view of choices, in which `typed` is what has been typed; `unfurl={view}` turns a pasted link into a preview card.
- **A row shown as text** shows its `display`, or else its `name`, `title`, `label` or `subject`.
- **Styling:** `class="…"` on any element (its own classes, instead of the theme's for its kind), and the app's `theme`:
  - `stylesheets [ … ]` (linked in this order: the later win), `custom` CSS and a `logo`;
  - `brand json { href, label, image, alt }`, a link to whoever made the app at the foot of every page;
  - `avatar_colors [ "#…", … ]`, the backgrounds of generated avatars (one picked by the person's id);
  - `tokens json { accent: "#2f6feb" }`, which become CSS variables;
  - `classes { button: "…", … }`, the class names for the runtime's own markup. One nothing reads is a warning (`THEME_CLASS_UNKNOWN`).

  The runtime has no styling of its own.
- **Generated screens:** an action no screen, API route or channel offers gets a form at `/_auto/actions/<name>`; a row view no screen lists gets a list at `/_auto/views/<name>`; `/_auto` indexes them. `node lang/cli.ts scaffold <spec>` prints them as source to copy in.

### Real time

- **`updates live`** on a view (above).
- **`signal typing(room: Room) { to set(User where member(it, room)) carries { … } requires member(actor, room) }`** broadcasts something ephemeral and never stored, such as typing.
- **`channel presence(room: Room) { requires member(actor, room)  on open present(room)  on close absent(room)  every 50 s refresh(room) }`** keeps a connection open and calls internal actions on its events.

## Effects outside the app

### Externs and workflows

```
extern fn web_push(endpoint: Url, p256dh: Text?, auth: Text?, title: Text, body: Text, path: Url, badge: Int): Text effect push
extern fn post_json(url: Url, body: Json, timeout: Duration): HttpReply effect http

workflow on MessagePosted(m) {
  step push:
    for each sub in PushSubscription where member(.user, m.room) and .user != m.creator {
      let sent = call web_push(sub.endpoint, sub.p256dh_key, sub.auth_key, title: m.room.name, body: plain(m.body), path: url_of(room_screen(m.room)), badge: 1)
      if sent == "expired" { delete sub }
    }
}
```

- **An `extern`** declares a host function and its effect.
  - One whose effect isn't `pure` or `fetch` may be called only in a workflow step.
  - A `fetch` extern reads from outside without changing anything, so a value view may call it.
  - A `pure` one gives the same result for the same arguments and touches nothing outside, so it may be called anywhere.
  - Migrations call none.
- **The runtime's externs:**
  - `post_json(url, body, timeout)`;
  - `opengraph(url)`, which reads a page's card through a guard that refuses private and loopback addresses on every redirect;
  - `web_push(…)`, which encrypts and signs a notification and returns `"sent"`, `"expired"` or `"failed"`.
- **A workflow** runs after the action that emitted its event commits, a step at a time. Each step's writes apply directly, outside a transaction. A step is retried until it succeeds, so it must be safe to run twice.

**Go bindings.** An extern can call a Go function:

```
import go "github.com/google/uuid@v1.6.0"
extern fn shout(t: Text): Text effect pure = go "strings".ToUpper
extern fn valid_id(t: Text): Text? effect pure = go "github.com/google/uuid".Validate
extern fn send_mail(server: Text, from: Email, to: list of Text, subject: Text, body: Text): Text? effect mail = go SendMail   // ext.go beside the spec
```

- **Generating the lines:** `node lang/cli.ts bind <package | app dir>` prints the extern lines for a package's functions, and why the others can't be bound. It writes `effect TODO`, which the checker refuses until a person chooses the effect.
- **Types:**
  - `Text`, `Email` and `Url` are Go `string` or `[]byte`;
  - `Int` is any int type (a value that doesn't fit is refused);
  - `Bool`, `Time` and `Duration` are `bool`, `time.Time` and `time.Duration`;
  - `list of Text` is `[]string`.
- **Results:**
  - none, or one value;
  - an `error`, seen as `Text?`;
  - a `(value, error)`, seen as the value made optional.

  Anything else needs a small wrapper in `ext.go`.
- **Checked twice:** the compiled app checks every binding's Go signature against the spec when it starts, naming the spec's line.
- **Modules:** `build` fetches each `import go` module at its pinned version and keeps `go.sum` beside the spec.
- **Offline:** with `--offline`, a binding whose effect isn't `pure` or `fetch` isn't called, and gives none.

### Schedules

```
schedule send_due for m in ScheduledMessage where not m.cancelled {
  at m.send_at
  if missed run
  create Message { room: m.room, author: m.author, body: m.body }  delete m
}
schedule morning { every day at "08:00" in "America/New_York"  emit morning() }
schedule sweep { every 15 min  delete Session where .expires < now }
```

- **For rows:** `at x.field [± duration]`.
  - A row runs once for each value of its time; moving the time makes it due again.
  - The `where` is read when the time comes.
  - `if missed run|skip` is required. It says whether the first deploy runs the rows already due; `review --data` says how many that is.
- **Every period:** `every day at "HH:MM" [in "Zone"]`, or `every <duration>` (1 min at least). After a gap, only the latest period runs.
- **Each run is a transaction.** A refused run is logged and not tried again for that time. At most 100 rows run per schedule per pass.
- **No request comes with a run**, so `actor`, `request`, `cookie()`, `rate_limit` and gates don't apply. The checker refuses them.
- In `--test`, `/_test/clock {"advance_ms": n}` runs whatever the new time makes due.

### Mail

```
schedule digest {
  every day at "08:00" in "America/New_York"
  for each u in User where .digest_on {
    send mail { to: u.email, subject: "Your digest", text: digest_text(u), unsubscribe: url_of(unsubscribe_screen(signed(u, "unsubscribe", 30 day))) }
  }
}
```

- **Where:** it may be written wherever writes are. The message goes into the outbox in the same transaction, so a refused action sends nothing.
- **Checks:**
  - `to` is an address, and `to`, `subject` and `text` are required;
  - no `private` field may appear in it;
  - mail a schedule sends needs `unsubscribe`, which becomes a one-click `List-Unsubscribe` header.
- **Delivery:** over SMTP (`CRUDSPEC_SMTP`, `CRUDSPEC_MAIL_FROM`; credentials only over TLS or to localhost), retried six times.
- **Links:** absolute links use `--base-url`, never a request's Host header.
- **Tests:** `/_test/outbox` lists the outbox.

### Exports

```
export room_csv(room: Room) {
  route "/rooms/:room/export.csv"
  format csv
  of room_messages(room) as m
  named room.name + " messages"
  "Timestamp": .created, "Author": .author, "Message": plain(.body), "Reactions": list(.content for Boost where .message == m)
}
```

- **What it is:** a download of a view's rows, run as the person asking, so it never shows more than the view does.
- **CSV** follows RFC 4180, and a cell a spreadsheet would run as a formula gets a leading `'`.
- **JSON** is an array of objects.
- **Checks:** no `private` field may be exported.

## The API and agents

```
api bot_messages {
  route "/rooms/:room/:bot_key/messages"
  identity bot_key
  get "" -> room_messages(room, before: query.before) as json message_json
  post "" -> post_message(room, body: rich(request.text)) status 201
}
```

**An `api`** maps HTTP routes to actions and views: each line is a method, a path under the API's `route` (`""` for the route itself), and a call with its arguments bound from the path, `query.x`, `request.text` and `request_file(name)`. A view's rows are given `as json`, through a function that makes each row's JSON; `headers { … }` and `status n` set the reply's. Outcomes map to statuses:

| Outcome | Status |
| --- | --- |
| `ok` | 200, or the status given |
| `unauthenticated` | 401 |
| `forbidden` | 403 |
| `not_found` | 404 |
| `invalid` | 422 |
| `blocked` | 429 |

**Agents** (an identity `from token`). A person issues and revokes tokens at `/_agents`, full or read-only, and an agent acts as that person, with no more permissions. Link `/_agents` from an account or profile screen (`<link href="/_agents" label="…" />`; `check` warns when nothing does). Every action and view is callable, with the same rules as the UI:
- `GET /llms.txt`, public, says what the app is (`about`) and how an agent gets a token; every page links it in its head;
- `GET /_agent/describe` lists them, with their parameters as JSON Schema, their outcomes, rules, effects and annotations, and an overview;
- `POST /_agent/call/<name>` takes `{"args", "dry_run"?, "confirm"?, "idempotency_key"?}`;
- `POST /_mcp` is an MCP server; `initialize` returns the overview as its instructions: the records, the rules the refusals name, how calls work, and who the token acts as.

How calls work:
- **Derived, not written:** effects and MCP annotations come from the statements, triggers, cascades and workflows: `readOnlyHint`, `destructiveHint`, `idempotentHint` and `openWorldHint`. The description is the comment above the declaration (`check` warns about callables without one), then what it changes, returns and refuses.
- **Dry runs** report the rows a call would change, then roll back.
- **Confirmation:** an action that deletes rows of a kind it doesn't create needs a `confirm`. Called without one it runs as a dry run: a refusal comes back as usual, and otherwise `confirm_required` with the changes and the confirm value that applies them. The confirm is bound to the token, the arguments and the data version.
- **Files** are sent inline: `{"filename", "content_type"?, "data": "<base64>"}`, stored as a form's upload is (a dry run's isn't written). Rows show them as `{filename, content_type, size, url}`.
- **Idempotency keys** replay the first result for 24 hours.
- **Never sent to agents:** passwords, identity-matched fields, and `private` fields.
- **Audit:** every call is recorded.
- **Unavailable to agents:** session-managing actions.

From a shell: `node lang/cli.ts describe <url>` and `call <url> <name> p=v … [--file p=path] [--dry-run] [--confirm v] [--key k]` (`describe --overview` prints the overview too), with the token in `CRUDSPEC_TOKEN`. Exit codes 3–9 are the outcomes.

## What the compiler checks

`node lang/cli.ts check <spec>` checks names and light types. `--deep` adds the type pass, the deep checks and the query costs. `build` runs all of these and the invariant proofs before it writes a program. A spec with an error is never compiled. Warnings name a likely mistake, or a choice worth stating. The codes, with one line each, are in `REFERENCE.md`. There are no suppressions: a declaration that states intent (`write_only`, `internal`, `private`) is itself checked.

**Names, types and none.** Every name resolves, and every expression has a type. A value that can be none must be checked before use. Every `match` covers its enum.

**Links and routes:**
- a link, redirect or `url_of` names a screen with the parameters it needs (`LINK_ARGS`);
- each `:name` in an address is a parameter (`ROUTE_PARAM`), and no address is one an earlier screen always takes (`ROUTE_SHADOWED`);
- an `href` inside the app is an error if no screen has that address, and otherwise a warning to link to the screen (`HREF_INTERNAL`);
- a link to a screen that refuses its viewer, without that screen's requirement known where the link is (`LINK_NOT_ALLOWED`);
- a screen no chain of links reaches from home, sign-in, setup or anything outside the UI (`SCREEN_UNREACHABLE`).

**Data use:**
- a field written but never read (`FIELD_NEVER_READ`);
- read but never set, so always its default or none (`FIELD_READ_NEVER_SET`);
- neither (`FIELD_NEVER_WRITTEN`);
- `write_only` read anyway (`WRITE_ONLY_READ`, an error);
- an enum value a field can never hold (`ENUM_VALUE_UNREACHABLE`);
- `the()` without a unique match (`THE_NOT_UNIQUE`).

**Writes and safety:**
- a write to a row the caller chooses, with no check on the actor (`WRITE_UNCHECKED`);
- a signed-out action that writes with no rate limit (`SIGNED_OUT_UNLIMITED`);
- a delete a restriction can refuse, with no check first (`DELETE_RESTRICTED`);
- a create of a uniquely keyed row from the caller's values, with no check (`UNIQUE_UNGUARDED`);
- triggers in a cycle (`TRIGGER_CYCLE`).

**Outcomes and time:**
- a form that handles some outcomes its fields can bring about, but not all (`OUTCOME_UNHANDLED`);
- a workflow step acting on a field the emitting action set, without reading it again, though another action can change it meanwhile (`WORKFLOW_STALE_CHECK`). For example, Campfire removes a banned user's messages later, though `unban_user` can run first.

**Query costs.** The compiler knows every query the app can run, so it asks SQLite how it would run each one, on a database made with the app's own schema (`EXPLAIN QUERY PLAN`). Nothing is guessed:
- `QUERY_UNINDEXED`: the plan reads the whole table for a query with a condition;
- `QUERY_SORTED`: the plan sorts every match to keep a few;
- `INDEX_UNUSED`: an index the spec declares that no query's plan uses, which costs every write and serves no read.

How costs are kept down:
- **Indexes:** each finding names the index that serves the query, and keeps it only if SQLite, planning again with it, no longer scans or sorts. The store indexes every reference and unique key by itself. With `indexes auto`, the app makes the indexes its queries want when it starts (`ax_…`) and drops ones no longer wanted. They change speed, never data, so they aren't part of the schema.
- **Order and limit in the database:** a query ordered by `created`, `id` or insertion has its order and limit run by SQLite, so it reads only the rows it keeps.
- **Membership checks:** `exists(E where .f == outer and …)` compiles to `outer IN (SELECT f FROM E WHERE f IS NOT NULL AND …)`. The inner rows are found once, instead of once per outer row, and the result is exact under `not`.

## Invariants

```
invariant admin_exists: not exists(Account where true) or exists(User where .role == administrator and .status == active)
invariant sessions_of_active: all(.user.status == active for Session where true)
```

`invariant name: condition` is a fact about the stored data that every action and workflow step must keep. It can't read the actor, the request or the time (`INVARIANT_AMBIENT`).

**Proven, not tested.** For each invariant and each writer, the compiler asks Z3 whether any database, arguments and actor could make the invariant false after the writer runs. The database is assumed to start with every invariant, reference, unique key and entity invariant holding. The proof follows:
- requires, gates and rejects;
- `if`s, creates, sets and deletes, with their cascades;
- loops over rows, and the triggers each write sets off.

Each proof ends one of three ways:
- **proven:** no run breaks it;
- **broken:** a run that does, as a counterexample. For example `(user: User#1) by User#1: User#1 status active → deactivated (role administrator)` is the last administrator deactivating themselves. A search over three rows of each kind runs first, so a counterexample is small and concrete;
- **unproven:** the proof can't follow something (a text function such as `upper`, a Go call, a loop that writes another row), with the reason. A run that would break it only through such a value is unproven, never called broken.

Campfire states five invariants and all 220 proofs (5 invariants × 44 writers) are proven.

**In the build:**
- **When:** `build` proves every invariant with a 6 s limit per proof, and `verify` with 20 s.
- **Broken:** the build stops on a broken one (`INVARIANT_BROKEN`, with the counterexample), as on a type error.
- **Unproven:** for each writer an invariant is unproven for, the build compiles a check into it. An action refuses (`invalid`) a run that would break the invariant, before it commits. A workflow step, which runs outside a transaction, reports it (`invariant broken: …`). Writers it's proven for carry no check.
- **The cache:** proofs are cached per writer in `.crudspec-cache/` beside the spec. The key is a hash of only what that writer's proofs can read: the prover, the limit, the writer, the triggers it can set off, what every proof assumes, and the functions, fields and enums those name. So changing one action, or adding a field nothing reads, proves again only what it reaches. On Campfire, a cold run is 11 s, nothing changed is 0.1 s, and one trigger changed is 1.5 s.
- **Upgrades:** invariants are part of the schema, with the functions and predicates they call. Adding or changing one checks the data first, and rows that already break it block the upgrade, named.
- **Inductive:** an invariant true of every database the app can reach can still fail to prove, because a counterexample may start from a database no action could make. Strengthen it (`not exists(Account where true) or …` covers the empty database), or state the missing fact as another invariant.

**Suggested invariants.** `node lang/cli.ts suggest-invariants <spec> --data <dir> [--min <rows>]` puts forward facts the data holds that the spec doesn't state. The compiled app mines them from a copy of the data, in Go (`app suggest-invariants`):
- an optional field never none;
- a field set, or none, whenever an enum or Bool has a value;
- one enum value fixing another;
- the row a reference names always holding a value;
- every row having a row that refers to it.

Each must hold on at least `--min` rows. The candidates are proven together, the ones not proven are dropped, and the rest are proven again until none is dropped. What's left holds given the others, and is printed as invariants to add. A candidate an action can break comes with its counterexample: a case the data hasn't met yet, or a rule to enforce. On Campfire's data, this showed that `change_role` can make a bot an administrator.

## Changing an app

### Versions and data migration

The runtime records each version of the spec in the database. On start, or with `node lang/cli.ts plan|migrate <spec> --data <dir>`, it compares the spec with the recorded version, and rehearses the whole upgrade on a copy:
1. renames and drops;
2. new tables and columns;
3. defaults for new fields;
4. pending migrations;
5. then every required field, enum value, reference, unique key and invariant, checked on every row.

The upgrade happens only if the rehearsal passes. The original is kept under `<data>/backups/`. Nothing prompts: every decision is written in the spec.

| Change | What happens |
| --- | --- |
| New entity; new optional field or one with a default; new enum value; a removed unique key | Applied. A default is worked out per row. A new `Int` without a default starts at 0 |
| New required field without a default; new unique key; new or changed invariant; a field made required; an enum value removed; a text type changed; a size tightened | Checked against the data. Refused while any row breaks it; the plan names the rows |
| A field or entity no longer declared | Its data is kept. `drop Entity.field` or `drop entity Entity` deletes it next time, and the plan says how much |
| Renames | `name: Text was old_name`, `entity Member was Person`, `enum Status { open, done was closed }`. Values, rows and references are kept |
| A field removed and another of the same type added | Refused as ambiguous until the spec says `was` or `drop` |
| A type change that can't convert | Refused: add a field, copy the values in a migration, drop the old one |

```
migration "unique handles" {
  for each u in User {
    if count(User where .handle == u.handle and .id < u.id) > 0 { set u.handle = u.handle + "-" + text(u.id) }
  }
}
```

**Data migrations** are statements, run once and in order, before the checks:
- triggers don't fire, and they can't emit or call externs;
- a failing `require` refuses the upgrade;
- a new database records them as applied without running them, so don't seed data with them.

**Safety:**
- `migrate` refuses while the app runs (`<data>/app.lock`);
- the upgraded copy is swapped in with one rename, so a crash at any point leaves a whole database;
- the runtime won't start empty while backups exist.

The plan also lists **contract changes** that break API and agent callers: a removed action or view, a new required parameter, a changed type. `plan --json` prints the whole plan. Its status is `ready`, `current`, `blocked`, `applied` or `created`.

**Older syntax:** `node lang/cli.ts upgrade-syntax <spec> [--check]` rewrites a spec written before v3 in the current syntax, and checks the result is the same program.

### Reviewing a change

`node lang/cli.ts review <old.crud> <new.crud> [--probes <file>] [--data <dir>] [--matrix] [--json]` is the report a reviewer of a spec change needs:
- **Schema and data steps**, as in a plan. With `--data`, how many rows each checked or destructive step touches, and how many rows a new `if missed run` schedule would run at once.
- **Outcomes:** what each action can now answer, and each form or button that has no `<on>` for it.
- **What screens show and views return:** the fields each now reads, against before.
- **Who can see and change each field:**
  - the screens, components (counted as the screens that show them) and views that read it, through functions too, with who may open them and their requires;
  - the read permission;
  - the actions that set it, with their requires and the gates they skip.

  A new reader or writer is a reason to exit 2. `--matrix` prints the whole matrix. An `if` inside a page isn't counted, so the matrix may list more people as seeing a field than really can, never fewer.
- **Query costs:** what the change makes slower (a new scan, sort or per-row query) and faster, as SQLite plans each version. Reported, not a reason to exit 2.
- **What agents are told:** actions, annotations, confirmation, effects.
- **Behaviour, by bounded exploration:**
  - recorded calls (`--probes`) are replayed against both versions, by every actor;
  - every row's read permission is checked for every actor;
  - what was refused and is now allowed is **widened**.

It exits 2 when something widened, a screen or view shows more, a new reader or writer appears, a change breaks callers, or data would be dropped.

### Verifying before release

`node lang/cli.ts verify <spec> [--against <old.crud>] [--data <dir>] [--probes <file>] [--strict] [--report <file>] [--json]` runs everything, for CI or packaging:
1. `check --deep`;
2. the invariant proofs, with 20 s per proof (`--timeout`), from the same cache as `build`;
3. with `--against`, the review.

It exits 1 for an error or a broken invariant, and 2 when the review needs a person (or, with `--strict`, an invariant is unproven). `--report` writes the result as JSON.

### Serving

- **Pages are gzipped** for a client that asks (`Accept-Encoding`). A page is mostly fragments from the cache, and each cached fragment keeps its compressed form, made once. A page is sent as those pieces joined, with only what's around them compressed afresh, so compression costs about the same CPU as sending the page plain. Campfire's room page goes from 351 KB to 23 KB. `--no-gzip` turns it off, for a proxy that compresses.
- **Assets are addressed by content.** A page names each asset with a hash of its bytes (`/assets/app.css?v=1a2b3c4d5e6f`), and that address is kept by browsers for good (`immutable`, a year). An address without the current hash is kept 5 minutes and revalidated by `ETag`, so a 304 sends nothing. Text assets (CSS, JS, SVG, JSON) are gzipped once, at the best level. Campfire's room page loads 40 assets: 82 KB plain, 28 KB gzipped, and nothing on a return visit.

### Testing

- **`--test`** starts an app with endpoints for tests:
  - `/_test/load`, `/_test/fixture`, `/_test/clock`, `/_test/outbox` and `/_test/dump`;
  - an `X-Test-Actor: Entity:id` header, to act as someone.
- **`--check-cache`** renders every cached fragment afresh too, and logs any difference as a cache bug. Campfire's 42 scenarios make 18,726 comparisons with no difference.
- **Checking screens:** `node lang/browser/screens.ts <spec> --base <url> --fixture <file> --out <dir> [--baseline <dir>] [--accept] [--shots]`.
  - It renders every screen as text an agent can read (and as screenshots with `--shots`), and diffs it against a baseline.
  - It exits 2 on a change until it's accepted. Accepting is a reviewer's step.
