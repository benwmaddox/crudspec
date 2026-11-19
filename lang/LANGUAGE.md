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
- `explain`: what each kind of declaration is made of (`explain action`), and the rest of the language (`explain statements`, `explain expressions`, `explain elements`, `explain outcomes`);
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

fn mine(t: Ticket): Bool = t.owner == actor
policy ticket_rows: mine(it) or (actor != none and actor.admin) for rows of Ticket
policy signed_in: actor != none else unauthenticated for every action

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

layout page { <main><Slot name=main /></main> <Flash /> }
screen tickets_screen {
  route "/"
  layout page
  <Fill name=main>
    <h1>Your tickets</h1>
    <List of={my_tickets()} as=t>
      <div><span>{t.subject}</span> <span>{t.state}</span></div>
    </List>
    <Form action={open_ticket()}>
      <Field name=subject kind=text placeholder="What's wrong?" />
      <Submit label="Open" />
      <On ok stay flash="Opened." />
    </Form>
  </Fill>
}
```

From this, the compiler:
- checks names, types and what can be none;
- proves that every action keeps `closed_have_notes`;
- checks that each query has an index;
- generates the database tables, the pages, the form handling, the session cookie, an agent API with JSON Schema, and a default screen for anything no screen offers (here `close`).

It also warns that nothing ever sets `User.admin`, and that a ticket can never be `waiting`: both true of this sketch, and the kind of thing the checks are for.

## The rest of the guide

- [Data](docs/data.md)
- [Expressions and queries](docs/expressions.md)
- [Actions](docs/actions.md)
- [Views, screens and the UI](docs/ui.md)
- [Effects outside the app](docs/effects.md)
- [Extending with Go](docs/go.md)
- [The API and agents](docs/api-and-agents.md)
- [What the compiler checks](docs/checks.md)
- [Invariants](docs/invariants.md)
- [Changing an app](docs/changing-an-app.md)

Everything the language has, generated from the compiler (UI elements and attributes, field kinds, outcomes, builtins, every check by code): [REFERENCE.md](REFERENCE.md). `node lang/cli.ts explain` says what each kind of declaration, statement and expression is made of.
