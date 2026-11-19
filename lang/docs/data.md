[← the language guide](../LANGUAGE.md)

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
| `Int` arithmetic | `+ - * / %`; `/` and `%` toward zero, as SQL's, and `/ 0` and `% 0` are 0 |
| `Decimal` | exact numbers, for money: `price: Decimal places 2` (0 to 6 places; 2 when not said). Literals `12.50`, `0.125`. `0.1 + 0.2` is `0.3`: a value is kept × 10^6, never as a binary float. A write keeps the field's places, rounding half to even (`0.125` to 2 places is `0.12`, `0.135` is `0.14`). An Int widens to a Decimal; a Decimal becomes an Int only through `round`, `floor` or `ceil`. Dividing a Decimal by zero refuses the action (`invalid`). Agents send and get one as text (`"12.50"`) |
| `enum Name { a, b "Label", c }` | one of the listed names, written bare (`open`), or `Name.a` when ambiguous. A label is how people see the value (one without a label is its name made readable: `not_found` is "Not found"); `label(e)` gives it, `text(e)` the declared name. Labels are display only |
| `Entity` | a reference to a row; compares by identity |
| `Time` | an instant: `now`, `t + d`, `t - d`, `t2 - t1` (a Duration), comparisons |
| `Duration` | `Duration.milliseconds(500)`, `Duration.seconds(60)`, `Duration.minutes(30)`, `Duration.hours(4)`, `Duration.days(7)` (of an Int: `Duration.days(n)`); `d1 + d2`, `d1 - d2`, `d * n`, `d / n`; `hours(d)` and `minutes(d)` as Decimals (`hours(2 h 30 min)` is `2.50`) |
| `Date` | a calendar day, with no time of day: a birthday, a due date. `today()` is today in the app's zone (`time_zone "America/New_York"` in `app`; UTC when not said), and `date_of(t)` the day an instant falls on there. Built with `date(2026, 11, 18)` (an impossible day refuses `invalid`) or `to_date("2026-11-18")` (none for text that isn't one). Compared with `< <= == >= >`, but not added to: `add_days`, `add_months`, `add_years` (Jan 31 + 1 month is Feb 28 or 29), and `days_between`, `months_between`, `years_between` (whole months, as people count age). `year`, `month`, `day`, `weekday` (1 Monday to 7 Sunday), `start_of_month`, `end_of_month`, `start_of_day(d)` and `end_of_day(d)` (Times, in the app's zone), `format_date(d, "MM/DD/YYYY")`. Years 1 to 9999: a step past them refuses `invalid`. Shown, sent and posted as `2026-11-18`; a `<Field kind=date>` fills one |
| `File` | an upload: `.filename`, `.content_type`, `.size`, `.kind` (`image`, `video`, `audio`, `other`) |
| `RichText` | formatted text: `plain(x)` its text, `mentions(x)` the users it mentions, `blank(x)`, `html(x)`, `rich(text)` |
| `Password` | stored hashed (scrypt), never readable: `authenticates(u.password, given)` |
| `Email`, `Url`, `Ip` | text, with a size (254, 2048, 45 at most); checked where it comes in: a form's or the API's argument that isn't one is refused (`invalid`), and text in the spec becomes one only through `to_email(t)`, `to_url(t)` or `to_ip(t)` (none when it isn't one) or as a literal the compiler checks. A Url is http or https, with a host. Read as text, any of them is text; one of them where another is declared, or compared with another, is an error. A plain text field compared with one, or given for one, gets a warning when its entity has a field of that type (`.bio == email`: did you mean email?). `host(u)`, `path(u)`, `with_host(u, h)` |
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

So SQL filters, orders and indexes on all of them, and other tools can read the tables.

**References are foreign keys.** A reference to a stored entity is `INTEGER REFERENCES "<Entity>" (id) DEFERRABLE INITIALLY DEFERRED`, with an index, and the app runs with SQLite's foreign keys on. They're checked as each write commits, so a write may delete a row and those that refer to it in any order. The app's own `on delete restrict` and `cascade` still run first, in the app (so triggers, invariants and live pages see each delete); the foreign key catches what they miss, such as a row written by another tool, and the write is rolled back. A reference to `data` declared in the spec, and a rich text's mentions (rows of any entity), have none. An upgrade from an older database rebuilds its tables with them, after checking every reference (one to a row that isn't there blocks it, and names the row). A stored field holds one value; a `set of` or `list of` field is refused (`STORED_COLLECTION`): keep a collection as rows.
