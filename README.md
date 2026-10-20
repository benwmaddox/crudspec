# crudspec

`crudspec` is an experiment: **a compact, checkable language for data-centred web apps**,
which people and AI agents can change safely. A spec describes a whole app (its data, rules,
actions, screens, API and what agents may call), and the compiler checks it as a whole before
compiling it to a Go program that keeps its data in SQLite. Campfire is about a sixth of the code of the
Rails app it reproduces (see Code size below).

- **The connected pieces are validated together.** Links and forms must name real screens and
  actions, forms must fill their actions' parameters, permissions must cover every row a screen
  or view shows, every action must keep the invariants the spec states (proved with Z3), and a
  change is reviewed for what it widens, breaks or puts at risk.
- **Rules carry through every layer.** A size written once (`title: Text max 80`) is a CHECK in
  the database, a refusal in the action, `maxlength` on the form field and `maxLength` in the
  agent schema.
- **Queries are shaped by what the app actually reads:** the indexes they need are derived from
  them and checked against SQLite's own plans, a page's reads are batched, and order and limits
  run in the database.
- **Strong performance:** many times Rails' throughput, at a fraction of its memory (see
  Performance below). Hand-optimized C or Rust can still go further.

```
entity Ticket { subject: Text max 120  owner: User  state: TicketState = open }
enum TicketState { open, waiting, closed }
permission read Ticket: ticket.owner == actor

// Opens a ticket of your own.
action open_ticket(subject: Text) { create Ticket { subject: subject, owner: actor } }
view my_tickets() { rows Ticket where .owner == actor  order by created desc }

screen tickets {
  route "/"
  layout page
  <Main>
    <h1>Your tickets</h1>
    {for each t in my_tickets() {
      <p>{t.subject} <Text>{t.state}</Text></p>
    }}
    {if my_tickets() == [] { <p>No tickets yet.</p> }}
    <Form action={open_ticket()}>
      <Field name=subject kind=text label="What's wrong?" />
      <Submit label="Open" />
    </Form>
  </Main>
}
```

- **An app is a directory.** Every `.crud` file in it is part of the app, with no imports.
- **The UI is HTML.** A lowercase tag is plain HTML, a tag with a dash a web component, and a
  capitalised one a built-in element or a component. Text is written as it shows, values in
  `{…}`, and code in braces. The built-ins are declared in [`lang/std/`](lang/std/ui.crud),
  and the standard library's components are compiled only when an app uses them.
- **Checked as a whole:** names and types, permissions, links and forms, unreachable states,
  query costs against SQLite's own plans, and invariants proven for every action (Z3).
- **Changes are reviewed and upgraded:** `review` reports what a new version widens, breaks or
  puts at risk, and `migrate` upgrades the data, rehearsed on a copy first.
- **Agents call it directly:** every action and view over JSON and MCP, with dry runs,
  confirmation for deletes, idempotency keys, an audit log and `/llms.txt`; people issue
  agent tokens at `/_agents`.

**Try it** (Node 24; Go 1.27 to build):

```
node lang/cli.ts check apps/todomvc            # the checks
node lang/cli.ts build apps/todomvc --out out  # the Go program
out/app --data data --assets apps/todomvc/assets --port 3000   # http://127.0.0.1:3000
```

The language is explained in [`lang/LANGUAGE.md`](lang/LANGUAGE.md), and everything in it is
listed in [`lang/REFERENCE.md`](lang/REFERENCE.md), generated from the compiler.

## Performance

Campfire's room page (40 messages), the same data in each, every response checked against
the same contract. Throughput is shown as a multiple of Rails (Ruby) in the same column, with
req/s in brackets. Rails has no whole-response cache, so the full-cache column is compared with
its fragment-cached run, its fastest.

| Server | Uncached | Fragment cache | Full cache (page or response) | Memory (PSS: uncached / fragment / full) |
| --- | ---: | ---: | ---: | ---: |
| Rails 8.2 (Ruby 3.4, YJIT) | 1× (24) | 1× (205) | none (1× = 205 with fragments) | 967 / 913 MB |
| Rust port | 62× (1,481) | 46× (9,349) | 76× (15,556) | 98 / 52 / 56 MB (0.10× / 0.06× / 0.06× Rails) |
| crudspec (Go) | 79× (1,893) | 73× (14,861) | at least 156× (31,942)* | 131 / 105 / 50 MB (0.14× / 0.12× / 0.05× Rails) |

* The load generator was 89% busy, so this is a lower bound.

**How it was measured, and its limits.** This was done in WSL2 on one Windows machine (22
vCPUs, 31 GB), because of hardware limitations in testing: there was no separate machine for
the load, so the server and the load generator share one host, on separate cores.
- Each server ran alone, in its own network namespace (loopback only) and cgroup, pinned to the
  same 4 vCPUs (a cpuset); the load generator had 10 others.
- Uncompressed responses, a 10 s warmup, then 20 s windows at 16, 32, 64 and 128 connections;
  each figure is the best window, averaged over two passes (the second in reverse order), timed
  by the load generator's own clock. CPU use per request: Rails 165 ms uncached and 19 ms
  cached; Rust 2.45 / 0.41 / 0.24 ms; crudspec 2.08 / 0.27 / 0.12 ms.
- Rails ran with 4 Puma workers of 5 threads (one per vCPU; 3 workers measured slower) and its
  Redis fragment cache; Rust with its fragment cache, and its response cache for the last
  column; crudspec with its fragment cache, and its whole-page cache for the last column.
- The pages aren't byte-identical: Rails' is 464 KB, Rust's 416 KB and crudspec's 366 KB.
- Run on 20 Oct 2026 with [`bench/fair-run.sh`](bench/fair-run.sh); the results are in
  `bench/runs/fair-r2-*`, summarised by `bench/fair-summary.ts`.

## Code size

Every line counted, comments and blank lines included, on both sides.

| App | crudspec | Compared with |
| --- | ---: | --- |
| Campfire (`apps/campfire`) | 1,828: 1,778 spec, 50 Go (widgets) | Rails Campfire: 10,896 (Ruby 4,874, ERB views 2,243, JavaScript 3,779) |
| Desk, a helpdesk (`app3`) | 461 spec | written for crudspec; no other version |
| Tasks, a team task tracker (`apps/tasks`) | 413 spec | written for crudspec; no other version |
| TodoMVC (`apps/todomvc`) | 190: 167 spec, 23 Go (widgets) | not compared |

What the counts leave out:
- **Stylesheets and images,** on both sides. crudspec's Campfire uses Rails Campfire's own
  stylesheets (3,378 lines of CSS) and images; Tasks and TodoMVC each have one CSS file.
- **The language and its runtime** (`lang/`), as the Rails count leaves out Rails, Hotwire
  and the other gems. The runtime's browser script (live updates, pickers, forms) is in that.
- **Tests:** crudspec's are under `apps/*/test` and `lang/test`; the Rails install measured here ships without its tests.
- **On the Rails side,** vendored and built files. It does include `config/`,
  `db/schema.rb` and `lib/`, whose crudspec counterparts (settings, the schema) are in the spec.
- Campfire's spec is longer than it needs to be: many of its lines carry a comment citing the
  Rails code a rule comes from.

## Layout

| Path | What it is |
| --- | --- |
| [`lang/`](lang/README.md) | **The language**, generic: the guide and reference, the standard library (`lang/std/`), parser, checker, type pass, invariant prover, change review and the compiler to Go (with its runtime library). Nothing in it names an app |
| [`apps/campfire/`](apps/campfire/README.md) | **Campfire, an app written in it**: the spec, the Rails oracle and its scenarios, the equity tests, browser checks |
| [`apps/tasks/`](apps/tasks/README.md) | **A second app**, a small team task tracker, on the same language and runtime with no changes. It shows the language isn't Campfire-shaped |
| [`apps/todomvc/`](apps/todomvc/README.md) | **TodoMVC**, rendered on the server |
| [`app3/`](app3/BRIEF.md) | **Desk**, a helpdesk built from a brief, to test the language on an app nobody designed it for |
| `docs/`, `reports/`, `corpus/`, `h2/`, `baseline/` | **The experiment**: hypotheses, protocol, results |
| `spec/campfire.crud`, `tools/` | The frozen Phase 1 (v1) artefacts: the slice spec, the v1 interpreter, the checker and the scoring tools. They are kept where their tags and reports expect them |

The repository started with the **test plan**, not the implementation. The
question is whether the approach is *worth it*. Each claim has a success
criterion and a kill criterion, decided before anything is built.

| Document | Purpose |
| --- | --- |
| [docs/HYPOTHESES.md](docs/HYPOTHESES.md) | What we want to be true, how we'd measure it, what counts as success, and what would show it isn't valuable |
| [docs/TEST-PROCESS.md](docs/TEST-PROCESS.md) | Phases, gates, protocol rules, baselines, sample sizes and reporting |
| [docs/DESIGN-SKETCH.md](docs/DESIGN-SKETCH.md) | The DSL under test: concepts, example syntax, checks, non-goals |
| [corpus/README.md](corpus/README.md) | The seeded-bug and change-task corpus that every comparison uses |
| [docs/LESSONS-FROM-AGENTLANG.md](docs/LESSONS-FROM-AGENTLANG.md) | What the previous experiment taught, and the rules that follow from it |

Status: **Phase 1 scored; H1 killed** (thresholds approved by delegation; see `docs/HYPOTHESES.md`).

| Phase 0 item | State |
| --- | --- |
| Rule inventory (`docs/RULE-INVENTORY.md`) | 45 rules, cited at Rails `90b3300` |
| Rails domain oracle (`oracle/`) | 24 slice scenarios plus 3 smoke scenarios, as golden files |
| DSL v1 (`docs/LANGUAGE.md`), reference spec (`spec/campfire.crud`), interpreter (`tools/`) | Spec matches Rails on 24/24 slice scenarios; the scenarios catch 25/25 targeted spec mutations |
| Baseline (`baseline/`) | 351 tests pass; matches Rails on 24/24 slice scenarios over HTTP; the negative control is caught |
| Checker (`docs/CHECKER.md`), corpus v1 (30 bugs, 20 controls) | Frozen and scored |
| **v2: all of Campfire, UI included** (`apps/campfire/campfire.crud`, review in `reports/v2-review/REPORT.md`) | **Behaviour equity:** the spec, compiled to Go (`lang/gogen/`), matches Rails on all 42 oracle scenarios over HTTP; independently reviewed. Live pages refresh only the fragments a change touched; see Performance above |
| **H10 pilot** (`reports/h10-pilot/REPORT.md`) | Feature changes by fresh agents: right in 3 of 3 runs through the spec, 1 of 3 through Rails. A pilot: no decision |
| **H1** (`reports/h1/REPORT.md`) | **Killed.** The checker caught 2 of 22 unflagged bugs; the baseline tests caught 3 of 22. The example scenarios caught 19 of 22 in both the spec and Rust |
