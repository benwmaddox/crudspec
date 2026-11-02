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
