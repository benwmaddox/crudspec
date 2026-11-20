# Working on crudspec apps: a guide for agents

crudspec apps are written and changed by AI agents, with a person owning them who reads results,
not code. This file is how to do that well here. The language is in `lang/LANGUAGE.md` and its
guide (`lang/docs/`); every element, builtin and check code is in `lang/REFERENCE.md`;
`node lang/cli.ts explain <declaration>` says what a declaration is made of.

## The loop

1. **Read before writing.** An app is every `.crud` file in its folder (`apps/<app>/`). Read
   them all, along with its `README.md` and `tests.crud`: the whole app usually fits in your
   context, and that's the point.
2. **Change the spec.** Keep the language generic: nothing under `lang/` names an app's
   entities, screens or styles. When an app needs something the language lacks, add it to the
   language as a general feature, with a test in `lang/test/` and docs in `lang/docs/`.
3. **`node lang/cli.ts check apps/<app>`** until it says `0 errors`, and read its warnings:
   most are real.
4. **Write the tests the change needs.** `node lang/cli.ts test-plan apps/<app> --untested`
   lists every outcome an action or view can end with that no test runs. A new action needs at
   least its `ok` and each refusal a person could hit (`forbidden`, `not_found`, `invalid`).
   Test what someone *sees* by running a view `by` them; an `expect` condition reads the
   database past the policies (`lang/docs/testing.md`).
5. **`node lang/cli.ts test apps/<app>`**, then **`node lang/cli.ts verify apps/<app>`**: the
   checks, the invariant proofs and the tests together.
6. **`node lang/cli.ts review <old-spec> <new-spec>`** (or `verify --against`) says what the
   change does:
   - who gains access;
   - which callers break;
   - what data could be lost;
   - which outcomes screens don't handle.

   Read it as the owner will. Every pull request gets it as a comment from
   `.github/workflows/check.yml`; a change that widens access is marked there for a read, and
   say what it widens in the pull request.
7. **Look at it.** Build and run the app, and check the screens you changed in a browser, on a
   narrow screen too.

Building needs Node 24, Go 1.27 and a C compiler: gcc on Linux, MinGW-w64 gcc (WinLibs) on
Windows with `CGO_ENABLED=1`. `node lang/cli.ts build` passes `-tags sqlite_fts5`. The
language's own tests are `node lang/test/<name>.test.ts`. The full suite is slow, so run it in
the background and read the result.

## Errors you'll meet, and their fixes

| You see | Do |
| --- | --- |
| `NOT_LOADED … add with .x` | Say what to load where the row comes from: `p: Page with .wiki` on a parameter, `with .author` on a view's rows or a `the_or_none(… with .x)`. A `{let p = …}` in markup and a query function's `the(… with …)` carry what they load. |
| `QUERY_IN_APP` | Write the condition so SQL can do it (a field, not a function of it), or say `in_app(…)` if reading the rows into the app is meant. |
| `UI_FILL` | `<Fill name=…>` only at the top of a screen. To change what a place shows, put the `{if}` inside the fill. A layout's places are `nav`, `main`, `sidebar` and `footer`. |
| `FIELD_WITHOUT_CHOICES` | A `kind=choice` field of an enum needs `from={[a, b, c]}`. |
| `TYPE_MISMATCH … X compared with Y` (an enum) | Two enums share a value name (`members`), so the bare name was read as the other enum's. Give values distinct names across enums. |
| `UNKNOWN_FUNCTION` for an `extern` | Call externs with `call name(…)`. |
| `UNKNOWN_NAME` for a row inside a nested `where` | A query nested in a loop's `where` can't name the loop's row. Store the fact on the row (a `last_editor` field) and filter on it. |
| `UI_CLASS_UNKNOWN … class foo-` | A class built with `+` is read as a literal. Compute it in a `fn` (`fn accent_class(w: Wiki): Text = "accent-" + text(w.accent)`): a function's result isn't checked against the stylesheet. |
| `LINK_TEXT` | Never build an address from text. Use `url_of(screen(…))`, or `path(url_of(screen(…)))` for a path. A row's address can be its slug (`address slug`). |
| `HREF_INTERNAL` | Link with `<Link to={screen(…)}>`, not `href="/…"`, unless it's a runtime page (`/_agents`, `/llms.txt`). |
| A singleton reads as none | A `singleton` has no row until something creates it: `create Site { }` in the setup action. |
| `ACTION_UNREACHABLE` | No screen offers the action. Give it a form or button, or mark it `callers api` or `callers internal`. |
| `AGENT_UNDOCUMENTED` | Put a `// comment` above each action and view, saying what it does: agents read it as the description. |
| A test fails with `lazy load` | A test's rows come with the rows they refer to, one step deep. Pass a function what it needs, or load it in the function's own query. |

## Habits that keep apps safe

- **Rules once, in policies.**
  - `policy x: … for rows in <Container>` decides who reads everything inside a tenant or space;
  - `policy y: … else forbidden for writes to <Entity>` decides who changes it;
  - an action's own `require` lines hold only what's particular to it.
- **Every new action gets tests** for who may and who may not, and a view `by` someone outside
  for what they can't see.
- **Invariants for what must always hold** (`invariant self.user != self.wiki.owner or self.role == admin`):
  the compiler proves them or the app checks them at every write, everywhere, including `/_admin`.
- **Settings that grant power** (custom domains, admin flags) belong to the most trusted role.
  Ask what a malicious member could do with each new field.
- **Escape hatches are unchecked.** A browser script (`element … from "x.js"`) and a Go
  `extern` run outside the language's rules. Keep them small, and don't put rules in them.
- **Every page handles every outcome its forms can produce** (`<On blocked …>`, `<On invalid …>`).
  The review lists the ones that aren't handled.
