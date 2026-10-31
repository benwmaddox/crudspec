# crudspec

A crudspec spec is a whole web app: its data, the actions that change it, who may do what, its screens, its API and what agents may call. The compiler checks the program as a whole, proves the invariants it states, and compiles it to a Go program that keeps its data in SQLite.

This guide explains the language, in the order you'd write an app. Everything it has (every UI element and its attributes, field kinds, outcomes, builtins, the checks and their codes) is listed in [`REFERENCE.md`](REFERENCE.md), generated from the compiler (`node lang/cli.ts reference`). Read this guide to learn the language, and look things up there.

*The language is generic. Apps written in it live under `apps/`; ONCE Campfire (`apps/campfire/campfire.crud`) is the first. Nothing in the language or its runtime names an app's entities, screens or styles: an app declares them. (`docs/LANGUAGE.md` is the first version, kept as it was frozen for the H10 study; this guide replaces it.)*

**Files.** An app is every `.crud` file in its directory, read in name order as one spec. There are no imports: a declaration in any file is seen in all of them, so split an app however reads best (data, rules, screens). Commands take the directory or any one of its files, and messages name `file.crud:line`. The built-in UI elements are declared the same way, in [`std/ui.crud`](std/ui.crud), which every app sees, and the standard library's components are written in crudspec in [`std/components.crud`](std/components.crud): an app has them without declaring them, and only the ones its UI uses are compiled.

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

layout page { <Main><Slot name=main /></Main> <Flash /> }
screen tickets_screen {
  route "/"
  layout page
  <Main>
    <Heading>Your tickets</Heading>
    <List of={my_tickets()} as=t>
      <Row><Text>{t.subject}</Text> <Text>{t.state}</Text></Row>
    </List>
    <Form action={open_ticket()}>
      <Field name=subject kind=text placeholder="What's wrong?" />
      <Submit label="Open" />
      <On ok stay flash="Opened." />
    </Form>
  </Main>
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
  - **`searchable`:** a field `matches(.f, query)` searches in a `where`, by its words: each word of the query starts a word of the field, in any case. The spec marks the fields it searches (`MATCHES_UNSEARCHABLE` warns of one it doesn't); the runtime reads each row the rest of the `where` leaves, as there is no full-text index yet.
  - **`private`:** never shown to agents, exported or mailed.
  - **`write_only`:** the app writes the field and never reads it (data kept for another tool). The deep check holds the app to it (`WRITE_ONLY_READ`).
- **Unique keys** (`unique (email)`, `unique (room, user)`) hold on create and on update. As in SQL, a key with an empty value never clashes: two users with no email are fine.
- **`index (a, b)`** declares an index. With `indexes auto` in the app, the compiler gives the app the indexes its queries want instead (see Query costs).
- **Entity invariants** (`invariant <condition over self>`) must hold for every row after every action; the runtime refuses a write that breaks one (`invalid`). App invariants, which the compiler proves, are below.
- **`transitions f { … }`** says which values an enum field may move to from which (a state machine):
  ```
  enum TaskStatus { open, claimed, done, cancelled }
  entity Task {
    status: TaskStatus = open
    transitions status {
      open    -> claimed, cancelled
      claimed -> open, done, cancelled
    }
  }
  ```
  A row may start in any state (a create or the default). After that a `set` may only make a move that is written; a state with no row of its own (`done`, `cancelled`) is final, and setting a field to the value it has is always allowed. The runtime refuses any other move with `invalid` (whatever sets it: an action, a trigger, a loop over rows, an agent), and an upgrade's data migrations are exempt. The compiler holds the spec to it before it runs:
  - a `set f = v` to a named state must be a written move from every state the `require`s, `if`s and `for each … where` before it leave open (`TRANSITION_UNPROVEN`, an error: add the `require x.f == claimed` it asks for, or declare the move). It reads `==`, `!=`, `in [ … ]`, `and`, `or` and `not` on the field; a condition it can't read proves nothing. A `set` right after another to the same row knows the state it made;
  - a `set f = none` is refused too (`TRANSITION_NONE`, an error, and `invalid` at run time for a value that turns out to be none): none is no state, so a final state is one with no moves out of it, never a move to none. A row with no value yet (an optional field never set) may start in any state;
  - a `set` to a value that isn't a name (`set t.status = status`) is left to the runtime (`TRANSITION_DYNAMIC`, a warning);
  - a written move that nothing makes is reported (`TRANSITION_UNUSED`), and a state nothing reaches (`ENUM_VALUE_UNREACHABLE`);
  - the block's own slips: an unknown or non-enum field (`TRANSITIONS_FIELD`), a value the enum lacks (`TRANSITIONS_VALUE`), a field or state given twice (`TRANSITIONS_DUPLICATE`), a state moving to itself (`TRANSITIONS_SELF`).
  `review` lists the moves a change adds (WIDER) and removes (narrowed).
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
| `Email`, `Url`, `Ip` | text, with a size (254, 2048, 45 at most); a form's field checks the format in the browser (`type="email"`, `"url"`) and the agent schema names it (`format`), but the server checks only the size: an action that needs a well-formed address checks it (`scheme(u)`, `host(u)`, `public_ip(e)`). Text is given where any of them is declared, but one of them where another is declared, or compared with another, is an error. A plain text field compared with one, or given for one, gets a warning when its entity has a field of that type (`.bio == email`: did you mean email?). `host(u)`, `path(u)`, `with_host(u, h)` |
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
| `sum(e for E where p)`, `avg(e for E where p)` | the Ints `e` gives for the matching rows, added; their mean |
| `actor` | who is acting (the app's `actor` entity), or none |
| `request.ip`, `request.method` (`get`, `write`), `request.identity`, `cookie(name)` | the request |
| `p(args)` | a predicate or function |

```
predicate member(u: User?, r: Room) = exists(Membership where .room == r and .user == u)
fn display_name(r: Room, viewer: User?): Text =
  if r.type == direct { sentence(list(.user.name for Membership where .room == r and .user != viewer)) } else { r.name }
```

**Sums and means.** `sum(.amount for Expense where .owner == u)` adds an Int for each matching row, and `avg(…)` is their mean, both over whole numbers (there is no fractional type):
- a row where `e` is none (an optional Int) adds nothing and isn't counted;
- a sum of no rows is `0`; a mean of no rows is `none`, so it is an `Int?` to check before use;
- a mean is truncated toward zero (`sum / count` in whole numbers: 65 over 3 rows is 21, -15 over 2 is -7), so it never rounds up;
- a sum past what a whole number holds (64 bits) is refused with `invalid`;
- `e` must be an Int (`TYPE_MISMATCH` otherwise). The `for` is what makes it a sum: a `fn` of your own called `sum` is still a call.

When the field is an Int column the database adds it (a subquery in a larger query's `where` or the generated statement); otherwise the matching rows are read and added in the app. Either way a page that shows a sum is told when one of those rows' fields it read changes, and not of other rows.

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
- **Settings** come first, a line each:
  - `skip gate <name>` lets the action run where a gate would refuse it.
  - `agents no`: people only. Agents aren't told of it and can't call it (a view takes it too).
  - `people no`: agents only. No screen, API route or channel may offer it (`PEOPLE_NO_OFFERED`), none is generated for it, and a person's request for it is a 404. It needs an agent identity; with `agents no` too, make it `internal` instead.
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

### The admin section

```
app freestore {
  actor Staff
  admin actor.role == admin       // who may use it: a condition about the actor
}
```

An app that says who its administrators are gets an admin section at `/_admin`, written as ordinary crudspec (like the default screens under `/_auto`; `cli scaffold` prints the rest):
- **An index** of the entities with how many rows each has (`data` tables are left out), a **table** for each (`/_admin/<entity>`, its newest 200 rows, each linking to its form), a **form** to create a row (`/_admin/<entity>/new`) and one to edit or delete it (`/_admin/<entity>/<id>`). A `singleton` has just its form. Link to it from your own screens with `<Link href="/_admin" label="Admin" />`.
- **Who:** only when the `admin` condition holds for the actor (a signed-out visitor is not an administrator; anyone else is sent to the sign-in screen, or the first screen without parameters, with "Administrators only."). **Allowing users to be administrators** is editing the field the condition reads: an administrator opens the user's form and sets it, and that user is one from then on. `admin` is yours to write: `actor.is_admin`, `actor.role == admin`, `exists(Grant where .user == actor and .name == "admin")`. With no `admin` line there is no section.
- **What it does is what the app's own rules say.** Each form runs a generated action (`admin_create_<entity>`, `admin_update_<entity>`, `admin_delete_<entity>`, `agents no`), so a size, a `unique` key, an entity `invariant` and a restricting delete hold as everywhere (`invalid`), and so do an enum field's `transitions`: an administrator can't take a completed visit back to waiting. A row may be *created* in any state of such a field, since the form says where it starts.
- **Fields:** one form field for each of type `Text`, `Int`, `Bool`, `Time`, `Email`, `Url`, `Ip`, `Password`, `RichText`, an enum, or a reference. A `Password` is never shown, and left empty on an edit it is kept. A field with a default may be left empty on a create and takes its default. A field of another type (`File`, `Json`, `Duration`, a set) is left out of the forms and kept as it is on an edit. An entity that needs one to be created can be edited and deleted but not created.
- **Only administrators make administrators.** The compiler holds the whole app to it, not just the section: an action that sets a field the `admin` condition reads (through the predicates it calls), or creates a row giving one a value from the caller or the administrator's own value, must require the `admin` condition first (`ADMIN_ESCALATION`, an error). A create that makes the first administrator is allowed while `not exists(<the actor's entity>)` is required.
- **Reading:** the lists show every entity, so an administrator may read each (an entity's own `permission read` still decides for everyone else, and one with none is readable by administrators and no one else). This reaches agents and the API too: an administrator's token sees what an administrator sees.
- **What it does not do:** it doesn't bypass anything, so there is no "force". To correct a row the entity's rules won't let you, change the rules (a migration, or a `transitions` move) or write an action for it. The deep checks that ask whether a field is ever written or read (`FIELD_NEVER_WRITTEN`, …) look at the app's own actions and screens, not at the admin section.

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
  <Nav><Slot name=nav /></Nav>
  <Main><Slot name=main /></Main>
  <Flash />
}
screen room_screen(room: Room) {
  route "/rooms/:room"
  layout app
  require member(actor, room) else go home flash "Room not found or inaccessible"
  <Title>{display_name(room, actor)}</Title>
  <Nav><Heading>{display_name(room, actor)}</Heading> <Link to={edit_room(room)} icon="menu" label="Settings" /></Nav>
  <Main>
    <List of={room_messages(room)} as=m><MessageItem m={m} /></List>
    <Form action={post_message(room)}>
      <Field name=body kind=richtext />
      <Submit icon="arrow-up" label="Send" />
      <On ok stay />
    </Form>
  </Main>
}
component MessageItem(m: Message) { <Row><Avatar>{m.creator}</Avatar> <Text>{plain(m.body)}</Text></Row> }
```

- **A screen's settings** come first, a line each: `route "/rooms/:room"`, `layout L`, `access public` (signed-out visitors may open it; the default is `access signed_in`) and `remember name` (a cookie keeping its last parameters). Its `require … else go <screen> [flash "…"]` (or `else <outcome>`) checks run before it renders. It fills the layout's slots by name.
- **Elements** are `<Name attrs>content</Name>` or `<Name attrs />`. A built-in element or a component takes a fixed set of attributes, and an unknown one is an error. Attributes are:
  - `name="text"` or `name={expression}`;
  - a bare name, for the attributes that name something (`name=body`, `kind=richtext`, `as=m`);
  - a flag on its own (`required`, `desc`).
- **Plain HTML:** a lowercase tag is HTML, as written: `<p class="note">Hello {u.name}!</p>`, `<input type="checkbox" name="pinned">`, `<br>`. A tag with a dash is a web component, passed through the same way (`<my-chart data-points={…}>`; the app's assets define it). Built-in elements and components start with a capital. The elements and attributes HTML has are in `lang/std/html.crud`; a tag or attribute that isn't one is a warning with the one meant (`UI_HTML_UNKNOWN`, `UI_HTML_ATTR_UNKNOWN`), and `data-…` and `aria-…` attributes are always fine. An attribute is `"text"`, `{value}` or bare: a Bool value shows a bare attribute when true, none leaves the attribute out, and an address in `href`, `src` and the like keeps to relative, http(s), mailto and tel (anything else becomes `#`). What could run script is refused: `<script>`, `on…` attributes, `srcdoc`, `javascript:` addresses (`UI_HTML_SCRIPT`, `UI_HTML_HANDLER`, `UI_HTML_URL`); so are `<style>` and a `style` that varies (use the theme's stylesheets and `class`). Inside a `<Form>`, a control's `name` is one of the action's parameters and fills it; a plain `<form>` can't run an action (`UI_HTML_FORM`).
- **Content** is text as it shows, `{expression}` (its value, as text) and elements: `<Section>Signed in as {actor.name}</Section>`. A run of only spaces and line breaks is nothing, so the layout of the source doesn't show; a space between two elements is written `{" "}`. In other text, line breaks and the spaces around them show as one space, and `//` at the start of a line or after a space starts a comment. Write `{"{"}`, `{"}"}` and `{"<"}` for those characters. Text elements hold only text: `<Heading>{room.name}</Heading>`, `<Text>{left} items left</Text>`. Elements whose value isn't text take it in braces: `<Avatar>{m.creator}</Avatar>`, `<Time as={date}>{m.created}</Time>`.
- **Code goes in braces** among the content, and its blocks are content again: `{if c { … } else if d { … } else { … }}`, `{let x = e}` (for the rest of the content), `{for each x in list { … }}`, and `{match e { a { … } b, c { … } none { … } }}`. In a block, text is written as it shows: `{if done { Done } else { <Strong>Open</Strong> }}`; a quoted string would show its quotes (`UI_TEXT_QUOTED`), and code without its braces shows as text (`UI_TEXT_CODE`). A `match` has an arm for every value of the enum (and `none` when it's optional) and no else, so a value added later is an error until every match handles it (`MATCH_MISSING`). An element's `if={…}` attribute shows or hides that element alone.
- **Links and actions:**
  - `<Link to={screen(args)}>` and `<Link href={url}>`;
  - `<Button action={act(args)} confirm="…">` and `<Form action={act(args)}>` with `<Field>`s and `<Submit>`;
  - `url_of(screen(args))` for an absolute address.

  The arguments a call gives come first. A form's fields fill the action's other parameters by name, and are typed from them: `text`, `email`, `password`, `richtext`, `file`, `textarea`, `number`, `url`, `code`, `hidden`, `checkbox` (a Bool), `choice` (an enum or Bool), `select` (one row, from `from={list}`), `users` (a set), `datetime`, `date` (in the person's time zone) and `time` (a time of day, as text). `select` and `users` offer only rows the person may read.

  **Fields follow HTML's defaults.** A field is a `<label>` holding its label text, then its control: `<label><span>Title</span><input type="text" name="title"></label>` (a checkbox comes before its text). `label_hidden` keeps the label for screen readers only, for a field an icon or a placeholder names. A class or a placeholder is there only when the field or the theme gives one, and a textarea's height is HTML's unless it says `rows={n}`. A `checkbox` sends `false` when it isn't checked. To write a control yourself, put plain HTML in the `<Form>`: `<input type="range" name="volume" min="0" max="10">` fills the `volume` parameter.

  | Kind | HTML | The default screens use it for |
  | --- | --- | --- |
  | `text` | `<input type="text">` | Text, and other text types |
  | `email`, `url`, `password` | `<input type="email">` and so on (a password: `autocomplete="current-password"`) | Email, Url, Password |
  | `number` | `<input type="number" step="1">` | Int |
  | `checkbox` | `<input type="checkbox" value="true">`, after a hidden `false` | Bool |
  | `choice` | `<select>` of the values, by their labels (`—` first when optional) | an enum |
  | `select` | `<select>` of rows | a reference |
  | `users` | a list of checkboxes, or a people picker with `autocomplete={view}` | a set |
  | `datetime`, `date`, `time` | `<input type="datetime-local">`, `date`, `time` (in the person's time zone) | Time |
  | `textarea` | `<textarea>` | RichText |
  | `richtext` | an editor with @mentions and link previews | — |
  | `file` | `<input type="file">` (with its image, with `preview={…}`) | File |
  | `hidden`, `code` | `<input type="hidden">`, `<textarea>` | — |
- **Outcomes after a form or button:**
  - `<On ok go={screen(result)} />`, or `<On ok stay flash="Done." />`;
  - `<On invalid shake />`, `<On not_found go={…} />`, and `sign_in={result}` and `clear_form` on an `<On>`.

  An outcome with no `<On>` returns to the page with the outcome's text. A form's `<On>`s are inside it; a button's come right after it.
- **Components** are used by name, their parameters given as props in order: `<MessageItem m={m} />`. Built-in elements and components start with a capital (`<Heading>`, `component MessageItem`); a component can't take a built-in's name. `upgrade-syntax` rewrites the lowercase tags of earlier specs.
- **Widgets:** `<Widget call={copy_button(text)} />` and the runtime's others:
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
- **`signal typing(room: Room) { to set(User where member(it, room)) carries { action: Text } requires member(actor, room) }`** broadcasts something ephemeral and never stored, such as typing.
  - A page that shows `<Signal call={typing(room)} />` hears it, if its viewer is in `to` and `requires` holds for them. A page sends it (`POST /_signal/typing:<room>`, or `crudspec.signal(key, fields)` in a page's script) if `requires` holds for the sender; it reaches the pages of those in `to` at that moment, not the sender's own. Each one heard is a `crudspec:signal` event on the element.
  - `carries` lists what a page sends, by type (Text, Int, Bool), checked when it arrives; anything else is dropped. Who sent it the runtime adds (`from`: their id and display), so a page can't say it's someone else, and `check` warns of a carried `user_id` or the like (`SIGNAL_CARRIES`).
  - **`indicator`** shows who else is typing in the form beside it: the page sends `action: "start"` while someone types (at most once a second) and `"stop"` when they send or empty it, and shows the names of those who started in the last 5 seconds and haven't stopped. Its classes are the theme's `signal`, `signal_author` (the names) and `signal_active` (while anyone is). A signal shown as an indicator must carry `{ action: Text }`.
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

  An extern without `= go` is one of these, declared as above; `check` refuses any other name (`EXTERN_UNKNOWN`: it would do nothing and give none), and a different number of parameters or a different result (`EXTERN_SIGNATURE`).
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

## Extending with Go

The language is small on purpose. When an app needs something it doesn't have (a check against a standard, a call to a provider, a custom piece of a page), the app brings Go. There are three ways, from the lightest; the examples below are one app, built and run as written by `test/go-examples.test.ts`.

| You need | Use | Where the Go lives |
| --- | --- | --- |
| A function from Go's standard library or a published module | an `extern fn … = go "pkg".Func` | the library, pinned with `import go "module@version"` |
| Your own logic: a parser, a checksum, a call to a provider | an `extern fn … = go Func` | `ext.go`, beside the spec |
| Your own piece of a page | a `widget` | `widgets.go`, beside the spec |

### A function from a library

```
extern fn shout(t: Text): Text effect pure = go "strings".ToUpper
```

`call shout(note)` now runs Go's `strings.ToUpper`. For a module outside the standard library, pin it once and name its packages:

```
import go "github.com/google/uuid@v1.6.0"
extern fn valid_id(t: Text): Text? effect pure = go "github.com/google/uuid".Validate
```

`node lang/cli.ts bind "github.com/google/uuid"` prints the `extern` lines for a package's functions, and why it can't bind the others. It writes `effect TODO`, which the checker refuses until you choose the effect.

### Your own functions: `ext.go`

A file called `ext.go` beside the spec (`package main`) is compiled into the app. A binding without a package names a function in it:

```
extern fn vat_problem(id: Text): Text? effect pure = go VatProblem
extern fn to_cents(price: Text): Int? effect pure = go ToCents
extern fn slug(t: Text): Text effect pure = go Slug
```
```go
// ext.go
package main

import ("errors"; "regexp"; "strconv"; "strings")

var vat = regexp.MustCompile(`^[A-Z]{2}[0-9]{8,12}$`)

// an error: the spec sees Text?, none when it is nil
func VatProblem(id string) error {
	if !vat.MatchString(id) { return errors.New("not a VAT number") }
	return nil
}

// (value, error): the spec sees Int?, none when the error is not nil
func ToCents(price string) (int, error) {
	f, err := strconv.ParseFloat(strings.TrimSpace(price), 64)
	if err != nil || f < 0 { return 0, errors.New("not a price") }
	return int(f*100 + 0.5), nil
}

func Slug(s string) string { return strings.ReplaceAll(strings.ToLower(s), " ", "-") }
```

The spec then checks what Go answered, like any value:

```
action place(vat_id: Text, price: Text, note: Text) {
  require actor != none else unauthenticated
  require call vat_problem(vat_id) == none else invalid       // Go said the number is fine
  require call to_cents(price) != none else invalid           // and the price parses
  create Order { customer: actor, vat_id: vat_id, note: call shout(note), cents: call to_cents(price) } as o
  emit OrderPlaced(o)
}
```

### Choosing the effect

Every `extern` says what it does to the world. The effect decides where it may be called, so the checks and the change review can see it:

- **`pure`:** the same arguments always give the same result, and it reads and changes nothing outside the app (not the clock, not randomness, not a file). It may be called anywhere: an action, a view, a screen, a `where`.
- **`fetch`:** it only reads from outside. A value view may call it.
- **Any other name** (`mail`, `http`, `push`, … your word for it): it changes something outside. Only a workflow step may call it. A workflow runs after the action that emitted its event commits, and a step is retried until it succeeds, so **the function must be safe to run twice** (send with an idempotency key, or check first).

```
extern fn send_sms(to: Text, body: Text): Text? effect http = go SendSMS

workflow on OrderPlaced(o) {
  step text_customer: let r = call send_sms(o.customer.name, "order in: " + call slug(o.note))
}
```
```go
func SendSMS(to string, body string) error { /* call the provider */ return nil }
```

An effect function an action calls is an error (`EXTERN_OUTSIDE_WORKFLOW`). With `--offline`, a binding whose effect isn't `pure` or `fetch` isn't called and gives none, so tests and previews never reach the outside.

### Your own piece of a page: widgets

For markup the UI elements can't make, declare a widget in the spec and write it in Go:

```
widget badge(label: Text)
screen orders() { route "/orders"  layout l  access public
  <Main><List of={Order where true} as=o><Widget call={badge(o.note)} /></List></Main>
}
```
```go
// widgets.go
package main

import "crudspec/gogen/rt"

var widgets = map[string]func([]rt.Val, rt.WidgetHelpers) string{
	"badge": func(a []rt.Val, h rt.WidgetHelpers) string {
		return `<span class="badge">` + rt.Esc(rt.Plain(rt.Arg(a, 0))) + `</span>`
	},
}
```

The function gets the call's arguments (`rt.Arg(a, 0)`) and helpers (`h.DC("button")` for the theme's class, `h.Display(ref)` for a row's name, `h.FileURL`, `h.Asset`). **Escape what you write into the markup** with `rt.Esc`: a widget is not checked, and a value from a user is untrusted. Give a widget the values it shows as arguments. `--widgets <file.go>` builds with a file from elsewhere.

### Types across the line

| In the spec | In Go |
| --- | --- |
| `Text`, `Email`, `Url` | `string` (or `[]byte`) |
| `Int` | any int type (a value that doesn't fit is refused) |
| `Bool` | `bool` |
| `Time`, `Duration` | `time.Time`, `time.Duration` |
| `list of Text` | `[]string` |

A result is nothing, or one value, or an `error` (seen as `Text?`: the message, none when nil), or `(value, error)` (seen as the value made optional). Anything else (a row, a map, several values) needs a small wrapper in `ext.go` that takes and returns these. A parameter can't be optional, so a function that takes "maybe a value" takes the value and a `Bool`.

### What is checked

- **At `check`:** the types above (`GO_TYPE`), a chosen effect (`GO_EFFECT`), a module outside the standard library having a pinned `import go` (`GO_IMPORT`), and where an extern is called (`EXTERN_OUTSIDE_WORKFLOW`).
- **When the app starts:** every binding's Go signature against the spec's, naming the spec's line (`app.crud:12: extern shout: parameter 1 is Int in the spec but string in Go`). A mismatch stops the app; it never runs with a wrong binding.
- **At `build`:** each `import go` module is fetched at its pinned version, and `go.sum` is kept beside the spec.

What is not checked is what the Go does. It runs with the app's privileges, outside the language's rules: it can read the clock, touch files, or open a socket whatever the effect says. The effect is a promise the spec relies on; keep it. And keep to the language where you can: a rule that can be a `require` should be one, because only a `require` is seen by `review`, the deep checks and the provers.

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

**Agents** (an identity `from token`). A person issues and revokes tokens at `/_agents`, full or read-only, and an agent acts as that person, with no more permissions. Link `/_agents` from an account or profile screen (`<Link href="/_agents" label="…" />`; `check` warns when nothing does). Every action and view is callable, with the same rules as the UI:
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
- **Withheld from agents:** actions and views that say `agents no`, and actions that manage browser sessions (create the cookie identity's rows, or read `session_token`); `check` asks those to say `agents no` (`AGENTS_NO_UNSTATED`). Withheld callables aren't in `describe` or MCP; calling one is `unknown`. `review` reports a callable agents gain or lose.

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
- a `set` of a field with `transitions` that isn't a written move (`TRANSITION_UNPROVEN`, an error), one the check can't read (`TRANSITION_DYNAMIC`), and a written move nothing makes (`TRANSITION_UNUSED`);
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
- **Outcomes:** what each action can now answer, and each form or button that has no `<On>` for it.
- **What screens show and views return:** the fields each now reads, against before.
- **Who can see and change each field, delete each entity's rows, and call each extern:**
  - the screens, components (counted as the screens that show them) and views that read it, through functions too, with who may open them and their requires;
  - the read permission;
  - the actions that set it, with their requires and the gates they skip;
  - the actions that delete an entity's rows, and that call an extern;
  - what the workflows an action's events start do, as that action's doing.

  Each is compared with its conditions apart (a require's and-parts, a permission's, signed in): one dropped, or a gate skipped, **widens** (`… can now be changed by action x (…), without is_admin(actor)`); one added narrows (`… now also needs …`), which isn't flagged.

  A new reader or writer is a reason to exit 2. `--matrix` prints the whole matrix. An `if` inside a page isn't counted, so the matrix may list more people as seeing a field than really can, never fewer.
- **Conditions:** each condition that changed: a predicate, a permission, a gate, the requires of an action, screen or view (taken together), a trigger's `when`, an `if`, a `where`. Each is said to hold in **fewer** cases, **more**, or **others**. This is worked out by trying every true/false value of the comparisons and calls inside it, so `a or b` → `a` is fewer and `x` → `true` is more, whatever `a`, `b` and `x` are; `x > 3` → `x > 5` is "others", since what's inside a comparison isn't looked into. A predicate's line names what it guards. A guard that admits more or others, or a gate that blocks fewer or others, is **WIDER**, a reason to exit 2. A declaration that changed with none of its conditions changed is listed by name. The access diff above uses the same test: a guard replaced by one that holds in fewer cases narrows (`… now needs x instead of y`).
- **Lifecycles:** the moves each enum field's `transitions` allow, against before: a move added, or a field no longer restricted, is **WIDER**; a move removed, or a field newly restricted, is narrowed.
- **Query costs:** what the change makes slower (a new scan, sort or per-row query) and faster, as SQLite plans each version. Reported, not a reason to exit 2.
- **What agents are told:** actions, annotations, confirmation, effects.
- **Behaviour, by bounded exploration:**
  - recorded calls (`--probes`) are replayed against both versions, by every actor;
  - every row's read permission is checked for every actor;
  - what was refused and is now allowed is **widened**.

It exits 2 when something widened (a guard or gate among them), a screen or view shows more, a new reader or writer appears, a change breaks callers, or data would be dropped.

### Verifying before release

`node lang/cli.ts verify <spec> [--against <old.crud>] [--data <dir>] [--probes <file>] [--strict] [--report <file>] [--json]` runs everything, for CI or packaging:
1. `check --deep`;
2. the invariant proofs, with 20 s per proof (`--timeout`), from the same cache as `build`;
3. with `--against`, the review.

It exits 1 for an error or a broken invariant, and 2 when the review needs a person (or, with `--strict`, an invariant is unproven). `--report` writes the result as JSON.

### Serving

- **Pages are gzipped** for a client that asks (`Accept-Encoding`). A page is mostly fragments from the cache, and each cached fragment keeps its compressed form, made once. A page is sent as those pieces joined, with only what's around them compressed afresh, so compression costs about the same CPU as sending the page plain. Campfire's room page goes from 351 KB to 23 KB. `--no-gzip` turns it off, for a proxy that compresses.
- **Assets are addressed by content.** A page names each asset with a hash of its bytes (`/assets/app.css?v=1a2b3c4d5e6f`), and that address is kept by browsers for good (`immutable`, a year). An address without the current hash is kept 5 minutes and revalidated by `ETag`, so a 304 sends nothing. Text assets (CSS, JS, SVG, JSON) are gzipped once, at the best level. Campfire's room page loads 40 assets: 82 KB plain, 28 KB gzipped, and nothing on a return visit.

- **Live streams are bounded.** An open page holds a stream (`/_events`) for its live updates and signals. The server keeps at most `--max-streams` (10,000) of them, and at most `--max-streams-each` (16) for one person (a session, or an address when signed out). Past either it refuses one (503, `Retry-After: 30`); the page stays as it is, and tries again 30 seconds later.

### Testing

- **`--test`** starts an app with endpoints for tests:
  - `/_test/load`, `/_test/fixture`, `/_test/clock`, `/_test/outbox` and `/_test/dump`;
  - an `X-Test-Actor: Entity:id` header, to act as someone.
- **`--check-cache`** renders every cached fragment afresh too, and logs any difference as a cache bug. Campfire's 42 scenarios make 18,726 comparisons with no difference.
- **Checking screens:** `node lang/browser/screens.ts <spec> --base <url> --fixture <file> --out <dir> [--baseline <dir>] [--accept] [--shots]`.
  - It renders every screen as text an agent can read (and as screenshots with `--shots`), and diffs it against a baseline.
  - It exits 2 on a change until it's accepted. Accepting is a reviewer's step.
