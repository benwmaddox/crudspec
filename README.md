# crudspec

`crudspec` is a working name for an experiment: **a small, checkable DSL for CRUD
applications with interconnected data, explicit workflows and triggers, and
efficient generated code.**

One spec file describes the domain:
- entities and their relations;
- invariants;
- state machines;
- actions;
- in-transaction triggers and durable workflows;
- derived views;
- permissions.

A checker proves structural properties of it: invariants preserved, triggers
terminate, permissions cover everything, migrations are safe. A generator then
produces a Postgres schema, migrations and a typed service in a mainstream
language.

## Layout

| Path | What it is |
| --- | --- |
| [`lang/`](lang/README.md) | **The language**, generic: reference, parser, checker, type pass and the compiler to Go (with its runtime library). Nothing in it names an app |
| [`apps/campfire/`](apps/campfire/README.md) | **Campfire, an app written in it**: the spec, the Rails oracle and its scenarios, the equity tests, browser checks |
| [`apps/tasks/`](apps/tasks/README.md) | **A second app**, a small team task tracker, on the same language and runtime with no changes. It shows the language isn't Campfire-shaped |
| `docs/`, `reports/`, `corpus/`, `h2/`, `baseline/` | **The experiment**: hypotheses, protocol, results |
| `spec/campfire.crud`, `tools/` | The frozen Phase 1 (v1) artefacts: the slice spec, the v1 interpreter, the checker and the scoring tools. They are kept where their tags and reports expect them |

This repository starts with the **test plan**, not the implementation. The
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
| **v2: all of Campfire, UI included** (`apps/campfire/campfire.crud`, review in `reports/v2-review/REPORT.md`) | **Behaviour equity:** the spec, compiled to Go (`lang/gogen/`), matches Rails on all 42 oracle scenarios over HTTP; independently reviewed. The room page serves 11,300 req/s with the fragment cache, past the Rust port's 9,855; live pages refresh only the fragments a change touched |
| **H10 pilot** (`reports/h10-pilot/REPORT.md`) | Feature changes by fresh agents: right in 3 of 3 runs through the spec, 1 of 3 through Rails. A pilot: no decision |
| **H1** (`reports/h1/REPORT.md`) | **Killed.** The checker caught 2 of 22 unflagged bugs; the baseline tests caught 3 of 22. The example scenarios caught 19 of 22 in both the spec and Rust |
