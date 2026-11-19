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

**Numbers.** An `Int` and a `Decimal` mix: an Int widens, and the result is a Decimal shown with the most places either has (a product with both's, a quotient with at least 2). `round(x)` is the Int nearest, half to even; `round(x, 2)` keeps 2 places as a Decimal; `floor(x)` and `ceil(x)` are the Int at or below, at or above; `abs(x)` drops the sign; `max(a, b)` and `min(a, b)` take Ints or Decimals. `%` is the remainder, with the sign of the left side (as SQL's). As text (`text(x)`, or on a page), a Decimal shows its places: `12.50`.

**Sums and means.** `sum(.amount for Expense where .owner == u)` adds an Int or a Decimal for each matching row, and `avg(…)` is their mean. Over Decimals both are exact (a mean to the scale, shown with at least 2 places). Over Ints:
- a row where `e` is none (an optional Int) adds nothing and isn't counted;
- a sum of no rows is `0`; a mean of no rows is `none`, so it is an `Int?` to check before use;
- a mean is truncated toward zero (`sum / count` in whole numbers: 65 over 3 rows is 21, -15 over 2 is -7), so it never rounds up;
- a sum past what a whole number holds (64 bits) is refused with `invalid`;
- `e` must be an Int (`TYPE_MISMATCH` otherwise). The `for` is what makes it a sum: a `fn` of your own called `sum` is still a call.

When the field is an Int column the database adds it (a subquery in a larger query's `where` or the generated statement); otherwise the matching rows are read and added in the app. Either way a page that shows a sum is told when one of those rows' fields it read changes, and not of other rows.

**`fn`** is a pure function of any type; one that returns `Bool` is a predicate, a named condition. A function may not call itself. **An owner-only rule** for actions is a predicate called from `require`: `fn owns(r: Recipe, who: User): Bool = r.owner == who`, then `require owns(recipe, actor) else forbidden` in each action; an entity's owner rule is better written once as `policy … else forbidden for writes to Recipe`; a `policy` with `else` and no `for` is for screens (`require <policy>`), and a `policy … for rows of` takes no `else` (it only filters the rows anyone may see). `match` (in the UI, below) chooses by an enum's value, and must cover every value.

Queries compile to SQL: conditions, orders and limits run in the database (see Query costs). An app's data is never held in memory, apart from `data` tables.
