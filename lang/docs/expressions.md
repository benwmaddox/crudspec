[← the language guide](../LANGUAGE.md)

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
| `the_or_none(E where p)` | the one matching row, or none: when no row matches, and when two or more do. Match a unique key with `==` (check warns otherwise, `LOOKUP_NOT_UNIQUE`) |
| `first_or_none(E where p order by f)` | the first matching row in that order, or none when none match |
| `list(e for E where p order by f [desc] limit n)`, `set(E where p)`, `set(x, y)` | lists and sets |
| `sum(e for E where p)`, `avg(e for E where p)` | the Ints `e` gives for the matching rows, added; their mean |
| `actor` | who is acting (the app's `actor` entity), or none |
| `request.ip`, `request.method` (`get`, `write`), `request.identity`, `cookie(name)` | the request |
| `p(args)` | a function (one that returns `Bool` is a predicate) |

```
fn member(u: User?, r: Room): Bool = exists(Membership where .room == r and .user == u)
fn display_name(r: Room, viewer: User?): Text =
  if r.type == direct { sentence(list(.user.name for Membership where .room == r and .user != viewer)) } else { r.name }
```

**No value changes kind by itself.** A conversion to a stricter kind is written, and checked:
- **An Int with a Decimal** is an error: `to_decimal(qty) * price`. A whole-number literal stands for a Decimal where one is wanted (`price: Decimal = 0`, `price > 0`): a constant, nothing converted as the app runs.
- **Text to an Email, Url or Ip** is `to_email(t)`, `to_url(t)` or `to_ip(t)`, each none when the text isn't one. A literal is checked as it compiles (`"help@example.com"`), and a form or API argument for an `Email`, `Url` or `Ip` parameter is checked as it arrives (`invalid` when it isn't one). The other way, an Email read as text, is fine.
- **Text to an enum** is an error unless it's a literal value (`"open"`): declare the parameter as the enum, and a form or the API checks it.
- **`+` joins text with text.** A number, a yes/no, an enum or a row isn't turned into text: write it in the text, `"{n} left"`, or `text(n)` (an enum's name; `"{s}"` shows its label).
- **None is never a number or text.** `n + 1` with `n: Int?`, and `t + "!"` with `t: Text?`, are errors: say what none means (`if n == none { 0 } else { n }`), or check first (`if n != none { … }` makes `n` an Int inside). Giving a value that may be none for a required parameter is an error too.
- **A built-in takes its kinds:** `year(t)` of a Time is an error that says `date_of(t)` (the day in the app's time zone); `round("x")` and `days_between(time, date)` are errors.
- **`text(row)`** is an error (`TEXT_ROW`): write the field to show.

**Numbers.** The result of Decimal arithmetic is shown with the most places either side has (a product with both's, a quotient with at least 2). `round(x)` is the Int nearest, half to even; `round(x, 2)` keeps 2 places as a Decimal; `floor(x)` and `ceil(x)` are the Int at or below, at or above; `abs(x)` drops the sign; `max(a, b)` and `min(a, b)` take Ints or Decimals. `%` is the remainder, with the sign of the left side (as SQL's). As text (`text(x)`, or on a page), a Decimal shows its places: `12.50`.

**Dates.** A `Date` is a day on the calendar; a `Time` is an instant. Which day an instant is depends on where you are, so `today()` and `date_of(t)` use the app's `time_zone`: at 11 pm in New York on Nov 17 it's already Nov 18 in UTC, and `today()` is still the 17th. The calendar functions follow how people count:
- `years_between(born, today()) >= 18`: 18 on the birthday itself, not a day before;
- `months_between(date(2024, 1, 31), date(2024, 2, 29))` is 1, and `add_months(date(2024, 1, 31), 1)` is Feb 29 (a missing day becomes the month's last);
- `last_visit < add_years(today(), -1)`: more than a year ago;
- `format_date(d, "dddd, MMMM D")` is `Wednesday, November 18` (tokens `YYYY YY MMMM MMM MM M DD D dddd ddd`);
- a day's bounds are Times: `Shift where .check_in >= start_of_day(d) and .check_in <= end_of_day(d)` (the day clocks go forward is 23 hours).
A Date is stored as its day number, so a `where` on one is a plain comparison in SQL; the prover reasons about `add_days` and `days_between` exactly, and about the other calendar functions as unknown values.

**Sums and means.** `sum(.amount for Expense where .owner == u)` adds an Int or a Decimal for each matching row, and `avg(…)` is their mean. Over Decimals both are exact (a mean to the scale, shown with at least 2 places). Over Ints:
- a row where `e` is none (an optional Int) adds nothing and isn't counted;
- a sum of no rows is `0`; a mean of no rows is `none`, so it is an `Int?` to check before use;
- a mean is truncated toward zero (`sum / count` in whole numbers: 65 over 3 rows is 21, -15 over 2 is -7), so it never rounds up;
- a sum past what a whole number holds (64 bits) is refused with `invalid`;
- `e` must be an Int (`TYPE_MISMATCH` otherwise). The `for` is what makes it a sum: a `fn` of your own called `sum` is still a call.

When the field is an Int column the database adds it (a subquery in a larger query's `where` or the generated statement); otherwise the matching rows are read and added in the app. Either way a page that shows a sum is told when one of those rows' fields it read changes, and not of other rows.

**Values in text.** `{…}` in a string is a value, shown as a page shows it: `"{h.name}: {left} {plural(left, "visit")} left"`.
- An enum value shows its label (`Extra large`), a Decimal its places (`3.00`), and none shows nothing.
- A row is refused (`TEXT_ROW`): write the field to show, `{u.name}`.
- The value is any expression, text in it included: `"{if note == none { "" } else { " ({note})" }}"`.
- `\{` and `\}` are the characters.

It's the same as joining with `+`: `"{n} left"` is `text(n) + " left"`: it works wherever text does.

**Calling a function on a value.** `x.f(a)` is the call `f(x, a)`: the value before the dot is the first argument. It works for your functions and the built-ins alike, and both ways of writing a call are valid: `p.name.trim().lower()` is `lower(trim(p.name))`, `actor.member(room)` is `member(actor, room)`, and `.born.year() < 2000` works in a query. The parentheses make it a call: `p.born` is a field, `p.born.year()` a call.

**One name for different types.** Functions may share a name when their first parameters' types differ; the first argument's type picks which runs, in either way of writing the call:
```
fn age(p: Person): Int = p.born.years_between(today())
fn age(p: Pet): Int = p.adopted.days_between(today())
… p.age() … pet.age() … age(p) …
```
A function of yours may share a built-in's name the same way: `fn round(p: Pet)` sits beside the built-in `round` for numbers, so `price.round(2)` still rounds. Two of one name on the same first-parameter type are declared twice (`DUPLICATE`), and a first argument of a type none is declared for is `FN_OVERLOAD`.

**`fn`** is a pure function of any type; one that returns `Bool` is a predicate, a named condition. A function may not call itself. Its body is `= expression`, or lets and then the value it gives, in braces:
```
fn status_line(h: Household): Text {
  let left = h.visits_left()
  let word = if left == 1 { "visit" } else { "visits" }
  if left <= 0 { "No visits left" } else { "{left} {word} left" }
}
```
A let names a value for the rest of the body; a later let may use an earlier one. Its name can't be a parameter's or another let's (`FN_LET_NAME`), one read nowhere is `LET_UNUSED`, and the body ends with one expression (`FN_BODY`): a function changes nothing. A let is the same as its value written where its name is used, so the prover and the queries see the value itself. **An owner-only rule** for actions is a predicate called from `require`: `fn owns(r: Recipe, who: User): Bool = r.owner == who`, then `require owns(recipe, actor) else forbidden` in each action; an entity's owner rule is better written once as `policy … else forbidden for writes to Recipe`; a `policy` with `else` and no `for` is for screens (`require <policy>`), and a `policy … for rows of` takes no `else` (it only filters the rows anyone may see). `match` (in the UI, below) chooses by an enum's value, and must cover every value.

Queries compile to SQL: conditions, orders and limits run in the database (see Query costs). An app's data is never held in memory, apart from `data` tables.
