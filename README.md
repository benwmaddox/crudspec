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

Status: **plan only.** No phase has started. Thresholds marked *proposed* need
the owner's approval before Phase 0 begins.
