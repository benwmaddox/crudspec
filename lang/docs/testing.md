[← the language guide](../LANGUAGE.md)

## Tests

A test is written in the spec. It runs against the app as built, on an empty database:

```
test "a stranger can't read a private wiki" {
  create User { name: "Ann", email: "ann@example.test", password: "secret-123" } as ann
  create User { name: "Bo", email: "bo@example.test", password: "secret-123" } as bo
  run create_wiki("hollow", "Hollow Wiki", none, private) by ann as w
  run all_pages(w) by ann expect 1 row
  run all_pages(w) by bo expect not_found
  run all_pages(w) by none expect not_found
  run create_page(w, title: "Notes", body: "…", spoilers: false) by bo expect forbidden
  expect not can_read(bo, w) and can_read(ann, w)
}
```

Put tests where they read best: beside what they test, or in a file of their own (`tests.crud`),
since an app is every `.crud` file in its folder.

- **Run them:** `node lang/cli.ts test <spec> [--only <text>]` builds the app, starts it in test
  mode and runs each test. It prints `ok` or `FAIL` with the step's `file:line` and why, and exits
  1 if one fails. `verify` runs them too, when the spec has tests and checks clean, and fails on a
  failing test. Building needs Go and a C compiler, as `build` does.
- **Each test starts empty.** Every table is empty, the clock is frozen at 2026-01-15 15:00 UTC and
  moves one second a step, and tokens are the same from run to run. A test sees only what it made.
- **The steps stop at the first that fails,** since the ones after build on it.
- **Unit and integration.** A test of conditions alone (`expect`, `wait`) is a *unit* test: it
  checks the app's functions and queries (`expect subdomain_of("a.wikis.test", "wikis.test") == "a"`).
  One that makes rows or runs actions and views is an *integration* test: the rules, the database
  and the outcomes together. Unit tests run first, and `test` and `verify` count each kind:
  `tests: unit: 3 passed; integration: 8 passed`. Neither drives a browser: a test calls the
  app's code in its own process.

### Steps

- **`create Entity { field: value, … } as name`** makes a row as `create` does: defaults, sizes,
  unique keys, entity invariants, a password hashed. It doesn't run an action. To test an action,
  `run` it.
- **`run name(args) [by who] [on "host"] [expect …] [as name]`** runs an action or a view as a
  person would, through the gates, the policies and the requires.
  - **Arguments** go by position or by name (`create_page(w, title: "Notes")`). Each is a value as
    written (`"text"`, `12`, `true`, `none`, an enum value) or a row the test made. Work anything
    else out in an `expect` (`TEST_ARG`). A parameter left out is none.
  - **`by ann`** runs it as a row the test made; `by none`, or no `by`, as someone signed out.
  - **`on "wiki.example.com"`** is the address it was asked at: `request.host`.
  - **`expect`** is an outcome (`ok`, `forbidden`, `not_found`, `invalid`, `blocked`,
    `unauthenticated`), `ok` when not said. For a view that gives rows, `expect 3 rows` is how
    many the person sees, after the read policies.
  - **`as w`** names the row the action gives (its `result`). The test knows its type when
    `result` names a row the action created, or one of its parameters; otherwise write it,
    `as w: Wiki` (`TEST_RESULT_TYPE`).
- **`expect <condition> [on "host"]`** is a condition that must hold: any expression, over the rows
  the test made and the database (`count(Page where .wiki == w) == 2`, `w.name == "Hollow"`,
  `can_read(bo, w)`). It is checked as code is, so a misspelled field is an error before anything
  runs. A row the test made comes with the rows it refers to, so `p.wiki.name` reads, and `p`
  may be given to a function that needs `p: Page with .wiki`.
- **`wait <Duration>`** moves the clock on (`wait Duration.minutes(5)`), for rate limits and
  times.

### What to test: the test plan

`node lang/cli.ts test-plan <spec> [--untested] [--json]` lists each action and view with every
outcome it can end with: `ok`, and each refusal its requires, rejects, rate limits and policies
(woven in, so a row policy's `not_found` and a write policy's `forbidden` are there) can give.
Each is *tested* when a test runs it with that outcome (`run name(…) … expect forbidden`), with
the line that gives it, so the tests to write are the `UNTESTED` lines. `verify` prints how many
are tested. An outcome can be impossible (a require a policy already settles); say so in a
comment rather than writing a test that can't pass.

### What a condition sees

A condition is a query of the database as it is. **The read policies don't apply to it**, which
are about what a person may see: `count(Page where .wiki == w)` counts every page. To test what
someone sees, run a view `by` them and expect its rows or its outcome.

### How it works

Each `expect` and `wait` is compiled into the app as a function of the rows it names
(`lang/testdecls.ts`), so the types, the loading rules and the generator all read it. In test
mode the app's `/_test/spec` (`lang/gogen/rt/spectest.go`) runs a whole test in the app's own
process, and `lang/spectest.ts` sends each test to it and prints what came back. The test
functions are in every build. They are small, nothing calls them outside test mode, and agents
aren't told of them.

### What the checks say

| Code | |
| --- | --- |
| `TEST_CALL` | `run` names no action or view |
| `TEST_ENTITY`, `TEST_FIELD` | `create` names no entity, or a field it hasn't |
| `TEST_NAME`, `TEST_NAME_TWICE` | a name the test didn't make before, or made twice |
| `TEST_ARG` | an argument that isn't a value as written or a made row; a parameter that isn't there; too many |
| `TEST_ACTOR` | `by` a row that isn't the app's actor |
| `TEST_OUTCOME` | an outcome that isn't one |
| `TEST_ROWS` | `expect N rows` of an action, or of a view that gives a value |
| `TEST_RESULT_TYPE` | `as x` where the result's type can't be told |
| `TEST_DUPLICATE` | two tests with one name |
