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
  if r.type == direct { sentence(list(.user.name for Membership where .room == r and .user != viewer)) } else { r.name }
```

- **`fn`** is a pure function that returns any type. Functions may not call themselves.
- **Field options:**
  - `searchable` adds a field to full-text search, queried with `matches(.f, query)` inside a `where`;
  - `on change touch` on a reference field updates the parent's `updated` time when the row changes, as Rails `touch: true` does;
  - `write_only` says the app writes the field and never reads it (data kept for another tool, or for a later feature); the deep check holds the app to it (`WRITE_ONLY_READ`);
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
avatar User: if .avatar != none { .avatar } else if .role == bot { "default-bot-avatar.svg" } else { initials(.name) }
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
  - `classes { button: "…", submit: "…", … }` gives the app's class names for the runtime's own markup. A class nothing reads (not the runtime, nor the app's own widgets) is a warning (`THEME_CLASS_UNKNOWN`): a typo does nothing otherwise. The runtime has no styling of its own.

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
- A `fetch` extern reads from outside without changing anything, so a value view may call it: `view unfurl_link(link: Url) { value call opengraph(link) }`. The runtime awaits such views when a client asks for them. Its built-in `opengraph(url)` reads a page's OpenGraph card through a network guard that refuses private and loopback addresses, on every redirect.
- A workflow step may `let` the result of an extern call and act on it. The step must still be safe to repeat.
- Named arguments to an extern are matched to its parameters by name.
- The runtime provides these externs:
  - `post_json(url, body, timeout)`;
  - `opengraph(url)`;
  - `web_push(…)`, which encrypts and signs a notification. It returns `"sent"`, `"expired"` (the subscription is gone, so delete it) or `"failed"`.
- An extern with `effect pure` gives the same result for the same arguments, and reads and changes nothing outside the app, so it may be called anywhere: actions, views, screens, triggers (views and screens are cached, so a function that reads the clock, randomness or the network is not pure). Migrations still can't call externs.

### Go bindings

An extern can call a Go function: one from a Go package, or one of the app's own in `ext.go` beside the spec.

```
import go "github.com/google/uuid@v1.6.0"                                 // a module outside the standard library, pinned
extern fn shout(t: Text): Text effect pure = go "strings".ToUpper
extern fn parse_int(t: Text): Int? effect pure = go "strconv".Atoi
extern fn valid_id(t: Text): Text? effect pure = go "github.com/google/uuid".Validate   // the problem, or none
extern fn send_mail(server: Text, from: Email, to: list of Text, subject: Text, body: Text): Text? effect mail = go SendMail   // ext.go
```

- **Generated:** `node lang/cli.ts bind <package>` prints these lines for every function in a package that a spec can call, and why each other one can't. It takes `strings`, `github.com/google/uuid@v1.6.0` (with its `import go` line) or an app directory (its `ext.go`), and optionally function names. It writes `effect TODO` except for packages known to be pure; the checker refuses `TODO` until a person chooses the effect.
- **Types a binding carries:**

  | Spec | Go |
  | --- | --- |
  | `Text`, `Email`, `Url` | `string` or `[]byte` |
  | `Int` | any `int` or `uint` type (a value that doesn't fit is refused) |
  | `Bool` | `bool` |
  | `Time` | `time.Time` |
  | `Duration` | `time.Duration` |
  | `list of Text` | `[]string` |

- **Results:** none; one value; `error`, which the spec sees as `Text?` (the message, or none when it worked); or `(value, error)`, which the spec sees as the value made optional (none when it failed; the error is logged).
- **Anything else** (structs, pointers, interfaces, variadic or generic functions) needs a small Go function with plain types in `ext.go`, bound with `= go Func`. For example, `net/smtp.SendMail` takes an `Auth`, so `ext.go` wraps it as `SendMail(server, from string, to []string, subject, body string) error`.
- **Checked twice:** the checker refuses types a binding can't carry and a module without an `import go`. The compiled app checks every binding's Go signature against the spec when it starts, whatever it runs (the server, an upgrade, a probe), and stops naming the spec line: `app.crud:6: extern shout: parameter 1 is Int in the spec but string in Go`.
- **Modules:** `build` fetches each `import go` module at its version and keeps the checksums in `go.sum` beside the spec; commit it.
- **Offline:** started with `--offline`, the app doesn't call a binding whose effect isn't `pure` or `fetch`; it gives none. `--test` alone still calls them, so a test server's mail can reach a test mail server.

## Schedules

Work that runs when its time comes, not when someone asks:

```
schedule send_due for m in ScheduledMessage where not m.cancelled {
  at m.send_at
  if missed run
  create Message { room: m.room, author: m.author, body: m.body }  delete m
}
schedule archive_idle for r in Room where not r.archived {
  at r.last_message + 30 day
  if missed skip
  set r.archived = true  set r.archived_at = now
}
schedule morning {
  every day at "08:00" in "America/New_York"
  emit morning()
}
schedule sweep {
  every 15 min
  delete Session where .expires < now
}
```

- **For rows:** `schedule n for x in Entity [where …] { at x.field [± duration]  if missed run|skip  … }`. The field is a `Time` (or `created`, `updated`).
  - A row runs **once for each value of its time.** When the time moves (a new message, an edited send time), the row is due again at the new time. A row with no time, or a deleted one, never runs.
  - The `where` is read **when the time comes.** If it doesn't hold then, that time passes without a run.
  - **`if missed` is required:** `run` runs, on the first deploy, the rows already due; `skip` runs only times after the deploy. `review --data` says how many rows a new `if missed run` schedule would run at once.
- **Every period:** `schedule n { every day at "HH:MM" [in "Zone"]  … }` (an IANA zone; else the server's), or `every <duration>` (1 min at least). When periods were missed (the server was down), only the latest runs.
- **One transaction per run:** the body's writes and the run's record commit together, through the normal commit, so live pages and the cache see them. Its `emit`s start workflows after it, which is where mail and other effects go.
  - A run that a `require` refuses is logged and recorded, and isn't tried again for that time.
  - At most 100 rows run per schedule per pass, each in its own transaction, so a large batch doesn't hold up requests.
- **No request comes with a run:** a body can't use `actor`, `request`, `cookie()` or `rate_limit`, and gates don't apply. The checker refuses these.
- **Runs:** the server checks every second. In `--test`, `/_test/clock {"advance_ms": n}` runs everything the new time makes due, with the workflows it starts, before it answers. `/_test/load` starts the schedules afresh.
- **Storage:** the runtime keeps its runs in `crudspec_schedule_runs`, beside the app's tables, so adding a schedule is not a schema change.

## Mail

```
action invite(email: Email) {
  send mail { to: email, subject: "You're invited to " + account.name, text: "Join here:\n" + url_of(join_screen(account.join_code)) }
}
schedule digest {
  every day at "08:00" in "America/New_York"
  for each u in User where .digest_on {
    send mail { to: u.email, subject: "Your digest", text: digest_text(u), unsubscribe: url_of(unsubscribe_screen(signed(u, "unsubscribe", 30 day))) }
  }
}
```

- **`send mail { to, subject, text, unsubscribe? }`** puts a message in the outbox, in the statement's transaction. A refused action, or an agent's dry run, sends nothing; a schedule's mail commits with its run, so it goes once. It may be written wherever writes are: actions, schedules, triggers, workflow steps; not in views or migrations.
- **Checks:** `to` is an address; `to`, `subject` and `text` are required and nothing else is taken; no `private` field may appear in what the message says; **mail a schedule sends needs `unsubscribe`**, which becomes a one-click `List-Unsubscribe` header. At run time a bad address, a subject with a line break, or too long a message is refused (`invalid`).
- **Delivery:** the server delivers the outbox over SMTP every second (`CRUDSPEC_SMTP` host:port, `CRUDSPEC_MAIL_FROM`; optionally `CRUDSPEC_SMTP_USER` and `CRUDSPEC_SMTP_PASSWORD`, used only over TLS or to localhost), with the subject encoded and the text as UTF-8; a failure is retried (1, 2, 4… minutes, six tries), then marked failed.
- **Links:** absolute links (`url_of`) use `--base-url` (or `CRUDSPEC_BASE_URL`) when it's set, never a request's Host header. An app that sends mail won't start without a mail server and a base URL, unless `--offline` or `--test`.
- **Tests:** `--offline` delivers nothing; `/_test/outbox` lists the outbox (`{"deliver": true}` sends what's due first), a clock advance sends what it made due, and `/_test/load` empties it.
- Agents are told an action that sends mail reaches outside the app (`openWorldHint`) and isn't idempotent.
- Strings take `\n` for a line break.

## Exports

```
export room_csv(room: Room) {
  route "/rooms/:room/export.csv"
  format csv
  of room_messages(room) as m
  named room.name + " messages"
  "Timestamp": .created, "Author": .author, "Message": plain(.body), "Reactions": list(.content for Boost where .message == m), "Attachment": .attachment
}
export room_json(room: Room) {
  route "/rooms/:room/export.json"
  format json
  of room_messages(room) as m
  named room.name
  timestamp: .created, author: .author.name, message_text: plain(.body), attachments: [.attachment]
}
```

- **A download of a view's rows**, a column per entry. It runs the view as the person asking (signed in, like a screen): the view's `require`s and each row's read permission hold, so an export never shows more than the view does. `.field` is the row's; `as m` names the row for expressions like `list(Boost where .message == m : …)`. Link to it with `url_of(room_csv(room))`.
- **Checks:** the source is a view of rows; columns are typed expressions, each named once; no `private` field may be exported.
- **CSV:** a header row, then a row per row, quoted as RFC 4180 wants. Times are ISO 8601 (UTC), rows their display, rich text its text, files their name, lists joined with `; `. A cell that a spreadsheet would run as a formula (starting with `=`, `+`, `-`, `@`, a tab or a return) gets a leading `'`.
- **JSON:** an array of objects; times ISO 8601, rows `{id, label}`, rich text its text, files their metadata only (`filename`, `type`, `size`), lists and `json { }` objects element by element.
- **The file's name** (`named …`, else the export's) loses path separators, quotes and control characters, and gets the format's extension; it's sent as an attachment, not cached.
- `review` reports an export's new or changed columns.

**Times from forms:** `kind=datetime` picks a date and time in the person's own time zone (the browser sends its zone along), and binds to a `Time`. `kind=date` gives that day's midnight in their zone. `kind="time"` gives a time of day as text (`"08:30"`). The agent API takes an RFC 3339 time or milliseconds.

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

## Query costs and indexes

The compiler knows every query the app can run, so it asks SQLite how it would run each one, on a database made with the app's own schema (`EXPLAIN QUERY PLAN`). `node lang/cli.ts check <spec> --deep` reports what the plans say; nothing is guessed:

- **`QUERY_UNINDEXED`**: the plan reads every row of the table for a query with a condition on the row (or a limit). A query with no condition on the row, and no limit, asks for every row, and isn't reported.
- **`QUERY_SORTED`**: the plan sorts every matching row to keep a few (a `limit` or a view's `window`), such as all of a room's messages to show its last 40.

Each finding names the index that serves the query, when one does. The compiler finds it from the query (the columns it looks rows up by, then its order) and keeps it only if SQLite, planning the query again with that index, no longer scans or sorts. A finding says when no single index can help, and shows the condition.

**Indexes:**
- The store indexes every reference field and every unique key by itself.
- `index (room, created)` in an entity declares another. It's part of the schema, made and dropped by the upgrade like a unique key. A `Time` field, `created` included, indexes as its two columns, its time and its order within that time.
- `indexes auto` in the app gives it the indexes its queries want. The build carries them, and the app makes the missing ones when it starts and drops ones no longer wanted (named `ax_…`, logged as `indexes auto: made …`). They change only speed, never data, so they aren't part of the schema's version: a build whose queries change can start on the same database. Without it (or with `indexes declared`), the findings say which indexes to declare.

**Order and limit in the database:** a query whose condition is all SQL, ordered by insertion, `created` or `id`, has its order and its `limit` (or its view's `window`) done by SQLite, so it reads only the rows it keeps. Any other order is sorted in Go, after the rows are read.

**Membership checks:** `exists(E where .f == r and …)`, where `r` is the outer row (or a column of it that is never none) and the rest of the condition doesn't read the outer query, compiles to `r IN (SELECT f FROM E WHERE f IS NOT NULL AND …)`. The rows the rest picks (a person's memberships, say) are found once, and the outer rows by their own index, instead of one lookup for each outer row. The `IS NOT NULL` keeps it exact under `not`. A predicate such as `member(actor, room)` gets this wherever a query uses it.

## Invariants

`invariant name: condition` is a fact about the data that every action and workflow step must keep:

```
invariant admin_exists: not exists(Account where true) or exists(User where .role == administrator and .status == active)
invariant bots_have_tokens: all(.bot_token != none for User where .role == bot)
```

The condition reads only stored data (rows, fields, predicates and functions over them). It can't read the actor, the request or the time, itself or through a function it calls (`INVARIANT_AMBIENT`). The compiler proves each invariant for each thing that writes, using Z3 (the `z3-solver` package, loaded only for a spec that declares one). It assumes the invariant holds before the action runs, then asks whether any input, actor and database can make it false afterwards. Every outcome is followed: `require`, gates, `reject`, `if`, creates, sets, deletes with their cascades, loops over rows, and the triggers a write runs. Each proof ends one of three ways:

- **proven:** no run of the action breaks it.
- **broken:** a run that does, as a counterexample. For example `(user: User#1) by User#1: User#1 status active → deactivated (role administrator)` means the last active administrator deactivated themselves. A small search (three rows of each kind) runs first, so a counterexample is found fast and is concrete.
- **unproven:** the proof can't follow something, with the reason. Examples are a loop over a list that writes, or a text function (`upper`, `trim`) or a Go call whose result the invariant depends on. Unproven is never a guess at broken; a run that would break the invariant only through such a value is unproven, not broken.

**Upgrades:** an app's invariants are part of its schema, with the functions and predicates they call. An upgrade that adds or changes one first checks the data: rows that already break it block the upgrade, and the plan names them (for `all(… for E where …)`, the rows; for another form, the fact). Fix the data with a migration, or change the invariant.

An invariant that isn't true of every reachable database can still be broken by a counterexample that starts from a database no action could make. Strengthen it (`not exists(Account where true) or …` above covers the empty database) or add the fact that makes it inductive as another invariant.

The proofs run in `build` and in `verify` (below), not in `check`. Proofs are cached, so a build proves again only what a change can affect. In `build` the limit is 6 s per proof (`--timeout <ms>`). A broken invariant is an error: the build stops with the counterexample (`INVARIANT_BROKEN`), as for a type error. Unproven ones are only counted in the summary line; `verify` lists each, with the reason.

**The cache:** each action or workflow step's proofs are cached in `.crudspec-cache/invariants.json` beside the spec (`--cache <dir>` elsewhere, `--no-cache` for none). An entry neither `build` nor `verify` has used for 30 days is dropped. The key is a hash of what that writer's proofs can read:

- the prover's source and the time limit;
- the writer itself (for a workflow step, its workflow and the type its event carries);
- the triggers it can set off: a create of the trigger's entity, a set of its field, or any delete, since a delete cascades;
- what every proof assumes: the invariants, gates, identities, the app, the events, and each entity's singleton, unique keys, entity invariants and reference fields;
- the functions, predicates and externs any of that names;
- an entity's other fields only if one of those names them, plus the fields with a default on an entity it creates rows of;
- the enums it names by type or by a value.

So adding a field nothing reads, or changing one action, predicate or trigger, proves again only the writers it reaches. A change to an invariant, a unique key or a reference proves everything again. A limit reached, or Z3 out of memory, is cached too: the same inputs give the same result, and the limit is part of the key.

On Campfire's trial (5 invariants, 44 writers, 220 proofs) the timings were:

| Run | Time |
|---|---|
| Cold | 11 s (15 s in WSL) |
| Nothing changed | 0.08 s |
| One trigger changed | 1.5 s |
| A new action | 0.8 s |

## Reviewing a change

`node lang/cli.ts review <old.crud> <new.crud> [--probes <file>] [--data <dir>] [--json]` is the report a reviewer of a spec change needs. It lists:
- **schema and data steps**, as in a migration plan, plus contract changes;
- **rows at risk** (`--data`, a copy of the live data): for each checked or destructive step, how many rows it touches (`drop Ticket.legacy: 214 row(s) have Ticket.legacy set`);
- **outcomes:** what each action can now answer that it couldn't, with each form or button that calls it and has no `<on>` for that outcome (`add_reply can now answer blocked; not handled by component staff_ticket_controls (line 421)`), and what it no longer answers;
- **what screens show and views return:** the entity fields each screen and component reads, now against before (`screen ticket_screen now reads User.email`), and the fields each view newly returns to agents and the API;
- **query costs:** each declaration's queries as SQLite plans them on each version's schema (lang/cost.ts), compared. **Slower** is a scan, a sort or a query run once per row of a loop that the old version didn't have (`view open_tickets (new) reads every Ticket row`); **faster** is one it no longer has. With `indexes auto`, a scan an index the app makes takes away isn't counted. It is reported, not a reason to exit 2;
- **what agents are told that changed:** new or removed actions, annotations, confirmation, new entities written, new externs;
- **behaviour, by bounded exploration over probe states:**
  - every recorded call is replayed against both versions, by its own actor and by every other actor in that state;
  - every row's read permission is evaluated for every actor, including an anonymous one;
  - a call, view row or read refused before and allowed after is **widened**; the reverse is **narrowed**;
  - each comes with examples.

It exits 2 when something widened, a screen or view shows more, a change broke callers, or data would be dropped.

**Cache self-check:** an app started with `--check-cache` renders every fragment the cache holds afresh too, serves the fresh one, and compares the two. Each difference is a cache bug, logged to stderr (`cache check: fragment … on /rooms/1: …`) and counted at `/_test/cache-check` (with `--test`). Any traffic checks the cache this way: scenarios, acceptance checks, an agent's own testing. Campfire's 42 scenarios make 18,726 comparisons with no difference; with keyed invalidation broken on purpose, 479 differ. The H10 and app3 harnesses run the spec apps this way. Apps record probe states from their scenarios; Campfire's are made by `node apps/campfire/test/probes.ts <spec> <out.json>`.

## Verifying before release

`node lang/cli.ts verify <spec> [--against <old.crud>] [--data <dir>] [--probes <file>] [--report <file>] [--json]` runs everything the compiler can check, for CI or packaging:

1. `check --deep`: the checks, the type pass, the deep checks and the query costs;
2. the invariant proofs, with longer limits than a test (`--timeout <ms>`, 20 s by default, per proof);
3. with `--against`, the change review from the old spec to this one (`--data` and `--probes` as for `review`).

Proofs come from the same cache as `build` (see Invariants), keyed by their own limit.

It exits 1 for an error or a broken invariant and 2 when the review needs a person (as `review` does). It also exits 2 for an unproven invariant with `--strict`. Otherwise it exits 0. `--report <file>` writes the whole result as JSON (`result`, `findings`, `invariants`, `review`) for the CI job to keep.

## Versions and data migration

**Storage:** one SQLite table per entity, one typed column per field: text as `TEXT`, `Int`, `Bool` and references as `INTEGER`, a `Password` as `TEXT` (`scrypt:<salt>:<key>`), a `Duration` as `INTEGER` milliseconds, and a `Time` as two `INTEGER` columns, `field` (milliseconds, UTC) and `field__seq` (its order among times in the same millisecond, as `created` has `seq`). A `File` is four columns: `field` (the stored file's key), `field__name`, `field__type` and `field__size`. A `RichText` is its text in `field`; its mentions are rows of `<Entity>__<field>__mentions` (row, position, entity, the mentioned row's id; indexed by the mentioned row) and its link previews rows of `<Entity>__<field>__embeds` (row, position, url, title, description, image). So SQL filters, orders and indexes on them, and other tools can read the tables. Only a field declared `Json` is JSON text. A stored field holds one value: a `set of` or `list of` field is refused (`STORED_COLLECTION`); keep the collection as rows of an entity. Tables are `STRICT`. A database from before storage format 4 (times, durations, passwords, files and rich text as JSON text) is converted in place by the upgrade, values kept.

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
- **`signal name(params) { to <set of users>  carries { fields }  requires e }`** declares an ephemeral broadcast that is never stored, such as typing indicators.
- **`channel name(params) { requires e  on open action(args)  on close action(args)  every d action(args) }`** declares a client connection the runtime keeps open. Presence is one.

## API

```
api bot_messages {
  route "/rooms/:room/:bot_key/messages"
  identity bot_key
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
  <nav><slot name=nav /></nav>
  <main>
    <slot name=main />
    <footer><slot name=footer /></footer>
  </main>
  <aside><slot name=sidebar /></aside>
  <flash />
}

screen room(room: Room) {
  route "/rooms/:room"
  layout app
  require member(actor, room) else go home flash "Room not found or inaccessible"
  <title>{display_name(room, actor)}</title>
  <nav>
    <heading>{display_name(room, actor)}</heading>
    <link to={edit_room(room)} icon="menu-dots-horizontal" label="Settings" />
  </nav>
  <main>
    <list of={room_messages(room)} as=m>
      <message_item m={m} />
    </list>
  </main>
  <footer>
    <form action={post_message(room)}>
      <field name=body kind=richtext />
      <submit icon="arrow-up" label="Send" />
    </form>
  </footer>
}
```

- **Elements** are `<name …>children</name>`, or `<name … />` with no children. Newlines and indentation don't matter.
- **Attributes** are `name="text"`, `name={expression}`, a name for the ones that name something (`<field name=body kind=richtext />`, `as=m`, `<slot name=main />`), or a flag on its own (`required`, `desc`). Each element takes a fixed set of them, and an unknown one is an error naming it.
- **An element's main value is its content.** In `text`, `heading`, `strong` and `title` it is text, written as it shows, with `{expression}`s in it: `<heading>{room.name}</heading>`, `<text>None</text>`, `<text>{left} items left</text>`. Runs of spaces and line breaks show as one space, and the ends are trimmed; a `//` starting a line is a comment, elsewhere it's text (`https://…`); write `{"{"}`, `{"}"}` and `{"<"}` for those characters. Elements whose value isn't text take it in braces: `<avatar>{m.creator}</avatar>`, `<time as={date}>{m.created}</time>`.
- **Links are checked against the screens.** `to={room_screen(room)}` names a screen with its arguments: an unknown screen, a parameter it lacks, or a missing one its address or type needs (`LINK_ARGS`) is an error, as in redirects and `url_of`. Each `:name` in a screen's address is one of its parameters (`ROUTE_PARAM`), and no address may be one an earlier screen always takes, since the runtime tries screens in the spec's order (`ROUTE_SHADOWED`: put `/rooms/new` before `/rooms/:room`). An `href` to a path inside the app can't be checked: to no screen's address it's an error, otherwise a warning to link to the screen instead (`HREF_INTERNAL`).
- **Where an element goes, or what it does, is an attribute:** `<link to={room_screen(room)}>`, `<link href={url}>`, `<button action={boost(m, "👍")}>`, `<form action={post_message(room)}>`.
- **The others with a head:** `<field name=body kind=richtext />`; `<list of={view(args)} as=m where={…} order={…} desc>` (`of` also takes a query, `of={Boost where .message == m}`); `<slot name=main />`; `<widget call={sound(file)} />`, and `call` likewise on `channel` and `signal`.
- **Among the elements**, as among statements: `if c { … } else if d { … } else { … }`; `let name = value` (for the rest of the block); `for each u in list { … }`; and `match e { a { … } b, c { … } none { … } }`, the block for e's value, where e is an enum value and every value of the enum (and `none`, when e is optional) has exactly one arm: there's no else, so a value added to the enum later is an error until each match handles it (`MATCH_MISSING`). An `if` attribute on an element (`<submit label="Save" if={can_edit} />`) shows or hides that element alone.
- **Outcomes** after a form or button: `<on ok go={room_screen(result)} />`, `<on ok stay flash="Done." />`, `<on invalid shake />`.
- **Components** are used by their name, with their parameters as props: `<message_item m={m} />`. Props are given in the order of the parameters, from the first.

- **`screen name(params) { route "…"  layout L  … }`** declares a page. Its settings come first in the body, a line each, in any order: `route "/rooms/:room"` (its address), `layout L`, `access public` (signed-out people may open it; the default is `access signed_in`) and `remember name` (a cookie keeping its last parameters). A setting given twice, or a value it doesn't take, is an error that says which it takes.
  - Its `require … else go <screen> [flash "…"]` checks run before it renders.
  - It fills the layout's slots.
- **`component name(params) { … }`** is a reusable piece of UI.
- **Elements** (presentation only; no logic beyond `if`, `for each`, `match`, `let` and expressions):

  | Group | Elements |
  | --- | --- |
  | Text | `heading`, `text`, `strong`, `time` (`as={date}`, `as={time}`, `as={relative}`) |
  | Media | `image`, `avatar`, `icon` |
  | Navigation | `link to={screen(args)}`, `link href={url}`, `button action={action(args)} confirm="…"` |
  | Forms | `form action={action(args)}` with `field name=p kind=… label="…" placeholder="…"` and `submit`; `switch` |
  | Lists | `list of={view(args)} as=x`, and `for each x in list { … }` |
  | Structure | `section`, `row`, `column`, `separator`, `menu`, `popup`, `dialog`, `frame` |
  | Runtime widgets | `<widget call={name(args)} />`: `copy_button`, `share_button`, `qr_link`, `lightbox`, `autocomplete`, `push_permission(action)`. `qr_link` makes its QR code on the server (`/_qr/…`), so the link it encodes never leaves the app. An app adds its own with a declaration, `widget sound(file: Text)`, implemented in a module the runtime loads with `--widgets <file>`. That module's default export maps each name to `(args, helpers) => html`. Calls are checked against the declaration. The last asks for notification permission, subscribes the browser, and calls the action with the endpoint, p256dh key and auth key. `client.push_endpoint` is then this browser's endpoint. |

- **Link previews.** A rich-text field's `unfurl={<view>}` attribute names a value view that turns a pasted link into a card. The card is shown before sending and can be removed. Sent cards are kept with the text and drawn with the theme's `embed`, `embed_body`, `embed_content`, `embed_title`, `embed_description` and `embed_image` classes.
- **Pickers.** A field's `mentions={<view>(…)}` or `autocomplete={<view>(…)}` attribute names a view that offers the choices. Inside it, `typed` is the text typed so far. Rows are labelled by their entity's `display`. Only a picked mention is recorded as a mention; text typed as "@name" is not.
- **Other element attributes:**
  - `<popup panel="…">` sets the class of the popup's menu;
  - `<field … accept="image/*" />` limits a file field.
- **Labels.** A `label` next to an icon is read out by screen readers. On a button, link or submit with no icon and no `text`, the label is the visible text.
- **Choosing rows.** `<field name=p kind=select from={list} />` chooses one row; `kind=users` (or `autocomplete={view}`) chooses a set. The checker requires the field's kind to fit the parameter's type.
- **Form fields** are typed from the action's parameters: `text`, `email`, `password`, `richtext`, `file`, `textarea`, `users`, `select`, `hidden`, `url`, `code`, `number` (an `Int`), `choice` (an enum or a `Bool`: `kind=choice from={[open, done]}`). The field names must match the action's parameters.
  - `select` and `users` only offer rows the person may read.
  - A choice-type field with a `label` and no placeholder or icon shows the label.
- **A row shown as text** (`<text>{r}</text>`) shows its entity's `display`, or else its `name`, `title`, `label` or `subject` field.
- **Design tokens:** `theme { tokens json { accent: "#2f6feb", … } }` become CSS variables (`--accent`), set after the app's stylesheets.
- **Generated screens.** The runtime adds a default screen for:
  - every action no screen, API route or channel offers: a form at `/_auto/actions/<name>`, one labelled field per parameter;
  - every row view no screen lists: a list at `/_auto/views/<name>`;
  - and an index at `/_auto`.

  They take the home screen's navigation, and `classes { generated_section: "…" }` styles their sections.
  - `node lang/cli.ts scaffold <spec>` prints them as ordinary spec source to copy in and change.
  - The checker's `ACTION_UNREACHABLE` warning names the generated screen.
  - Deep checks: `node lang/cli.ts check <spec> --deep` reports:
    - `THE_NOT_UNIQUE`: a `the()` or `the_or_none()` query whose condition doesn't guarantee a unique match (no unique key or id pinned), risking a runtime error when multiple rows match. Fix: declare a unique key on the field combination, or use `first_or_none` if multiple matches are expected.
    - `FIELD_NEVER_READ`: a field is written (a default, a create or ensure, a set) but nothing reads it: no screen, component, view, query condition or order, action, function, predicate, permission, gate, identity, mail, export, API, schedule, trigger or workflow, nor the runtime (a cookie identity reads its token field and the session's reference to the actor). Dead data, or a feature not finished. If the app means to only write it (data kept for another tool, say), declare it `write_only` (`user_agent: Text? write_only`): that's checked, not a silencer (below).
    - `FIELD_READ_NEVER_SET`: a field something reads, but nothing sets (no create gives it, no set or migration writes it). It always holds its default, or none, so the reads can never see anything else: a missing write, or a field not needed. A default worked out for each row (`token(24)`, `now`) counts as setting it.
    - `FIELD_NEVER_WRITTEN`: a field nothing reads and nothing sets beyond a constant default (or, optional with no default, nothing sets at all).
    - `OUTCOME_UNHANDLED`: a form or button handles some of its action's outcomes with `<on>`, but not one that what the person enters can bring about. That one gets the default (back, with the outcome's text) while the others get what was written. It counts:
      - a `require` whose condition reads a field the form sends;
      - a `reject` under an `if` on one;
      - `invalid` from a create or set that puts a sent value in a unique key, with no check for an existing row first.

      Outcomes about the row or who acts aren't counted (the screen shows the form where it applies), nor sizes (the form keeps them), nor a gate's. A form with no `<on>` at all leaves every outcome to the default, and isn't reported.
    - `WORKFLOW_STALE_CHECK`: an action sets a row's field, then emits an event with the row (the event says the change happened). The event's workflow runs later, in its own transaction, so another body can change the field in between. A step that acts (writes, mails, calls a non-pure extern) without reading the field again acts on what was true then. For example, Campfire removes a banned user's messages after `ban_user`, though `unban_user` may have run first. Fix: read it in the step (`if u.status == banned { … }`).
    - `LINK_NOT_ALLOWED`: a link (`<link to=…>`, `to=`, `go=`) to a screen that refuses whoever follows it. A screen's `require` on the viewer (it reads `actor` and none of the screen's parameters) with an outcome must be known where the link is: in the linking screen's own requires, an `if` around the link, or, in a component or layout, the requires of every screen that shows it. Predicates are read through, so `if administrator(actor)` covers `can_administer(actor, none)`, whose body is `u.role == administrator or u == creator`. Requires about the screen's own row (`member(actor, room)`) are the screen's to check, and a `require … else go` sends the viewer elsewhere on purpose; neither is asked of the link. `access signed_in` isn't either: the runtime asks a signed-out person to sign in.
    - `SCREEN_UNREACHABLE`: a screen that no chain of links reaches, so only its address typed in opens it. Reaching starts from the screen at `/` (`home`), the app's `sign_in` and `setup` screens, and every screen named outside the UI: a mail, a push's `url_of`, an action, a view, a function. A screen reaches what it, its layout and the components it shows link to. An address built by hand (`url("/join/" + code)`) isn't a link to anything; `url_of(join_screen(code))` is the same address, checked.
    - `WRITE_ONLY_READ` (an error): a field declared `write_only` is read somewhere; the message names where. Remove `write_only` or the read: the declaration says what the app does, and the compiler holds it to that.
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
