# Hypotheses

Each hypothesis has:
- a **metric**;
- a **baseline**;
- a **success criterion** (we'd keep going);
- a **kill criterion** (the claim is not valuable, or not worth its cost);
- the **cheapest experiment** that can decide it.

All thresholds were **approved by delegation on 16 October 2026**: the owner told
the implementer to use its best judgement. They **freeze when Phase 1 starts**;
from then on, a threshold may change only in a new, labelled study. "*Proposed*"
below marks the original wording.

**The baseline is always a strong, layered mainstream implementation**, never a strawman. It is the same app in Rust or TypeScript with:
- newtypes;
- compile-time-checked SQL (sqlx or Kysely);
- exhaustive matching;
- property tests;
- mutation testing on the diff.

AgentLang lost to plain F#. A new approach has to beat best practice, not bad practice.

---

## H1 — Spec checks catch logic bugs that tests miss

**Claim.** The checker finds seeded logic bugs in a domain model, for example:
- an invariant violated by an action;
- a missing state guard;
- a permission leak;
- a trigger loop;
- an unsafe cascade.

Conventional tests in the baseline, including mutation-gated ones, miss them.

- **Metric:** catch rate before merge on the seeded-bug corpus (`corpus/bugs`), and false-alarm rate on correct controls.
- **"Caught" means (fixed before Phase 1):**
  - *Spec arm:* the checker rejects `spec.patch`.
  - *Baseline arm:* the baseline's existing test suite, plus its property tests, fails on `baseline.patch`.
  - Two comparisons are reported: checker alone against baseline tests, and checker plus the spec's own example tests against baseline tests.
  - Mutation testing is **not** part of H1. It measures the strength of tests for new code, so it belongs to H2.
- **Overlap screen (fixed before the corpus is written):**
  - The checker author already knows about 26 bugs: the 25 spec mutations in `tools/scenario_adequacy.py` and the replay negative control (B3, unboost ignores the booster).
  - The separate scoring session flags every corpus bug that makes the same behavioural change as one of these.
  - H1 is reported both with and without the flagged bugs. If the two results lead to different decisions, the decision uses the result without them.
- **Confirmed corpus only:** a bug counts only if `tools/confirm_bug.py` confirmed that both forms are wrong in the same way, with the reference forms matching Rails.
- **Scoring, fixed before any case of the restarted corpus is written** (16 Oct 2026, with the checker frozen at tag `phase1-checker-v1`):
  - *Checker, primary rule:* `tools/check_patch.py` rejects `spec.patch` when the checker reports any **error**. This rule decides H1.
  - *Checker, secondary rule:* the same tool rejects when the checker reports any finding, error or warning, that the reference spec doesn't also produce. It is reported alongside, with its own false-alarm rate on the controls; it doesn't decide H1.
  - A checker crash counts as **not caught** and is listed separately.
  - *Spec plus its example tests:* the primary rule, or any mismatch on the frozen slice scenarios (`cli.ts scenarios` with `oracle/golden/slice-v1-e`).
  - *Baseline arm:* `cargo test -p campfire -p campfire_db` on 6dae2fd with `baseline.patch` applied. Any failing test, or a failed build, counts as caught.
  - *Controls:* a false alarm is a control that an arm rejects under the same rule.
  - *Flags:* bugs flagged by the overlap screen or in `docs/DEVIATIONS.md` are reported with and without; the decision uses the result without them if the two differ.
- **Corpus size (amended from 60–100, before the restart):**
  - **30 confirmed bugs and 20 confirmed controls**, fixed in advance; no early stopping.
  - 30 bugs resolve a gap of 20–40 points between arms, and the development set suggests the gap will be large.
  - 20 controls separate a 5% false-alarm rate from 15% only roughly; that limit is stated with the result.
- **Kill-rule wording, clarified before any data:** "within 10 points" means the checker catches fewer than 10 points *more* than the baseline. The checker trailing the baseline also kills.
- **Baseline:** the layered conventional implementation of the same domain, with its full test suite, property tests and mutation gate.
- **Success:** the checker catches **≥ 20 percentage points more** corpus bugs than the baseline gates, with a false-alarm rate **≤ 5%** on correct controls *(proposed)*.
- **Kill:** the checker's catch rate is within **10 points** of the baseline, *or* the false-alarm rate is above **15%** *(proposed)*.
- **Cheapest test:** Phase 1. It needs only the spec language and checker, with no code generation and no agents. Encode the corpus in both forms and run both.
- **How to hit it:** keep the language non-Turing-complete so invariant, state-machine, trigger-graph and permission-coverage checks stay decidable (SMT plus graph analysis). Focus the corpus on categories the checks target, *and* include categories they don't target, so we learn their limits.

## H2 — AI agents change specs more correctly than code

**Claim.** Given the same change request, fresh agents produce correct, preserving changes more often by editing the spec than by editing conventional code.

- **Metric:** the share of change tasks that are **correct** (independent oracle, all cases) **and preserving** (no unrequested behaviour change, measured by behaviour diff) **and complete** (session finished normally).
- **Baseline:** the same tasks on the layered conventional app.
- **Success:** a correct-and-preserving rate **≥ 15 points higher**, over **≥ 40 task runs per arm**, with a 95% interval that excludes zero *(proposed)*.
- **Kill:** the difference is not significant at that sample size, *or* the spec arm is worse. That is the AgentLang outcome; accept it if it recurs.
- **Cheapest test:** Phase 2, once the checker exists. Generated code isn't needed if the oracle runs against a reference interpreter of the spec.
- **How to hit it:** keep the spec small enough to fit in context whole, make the error messages precise, offer an LSP, and use ordinary files as the editing surface. Agents start cold on this DSL, so measure **learning cost** separately (H3).

## H3 — Interaction cost is not worse

**Claim.** Agents don't need materially more interactions, tokens or time to work in the DSL.

- **Metric:** tool calls, model tokens (if available) and wall time per accepted change.
- **Baseline:** the conventional arm of H2.
- **Success:** the median is **≤ 1.2×** the baseline *(proposed)*.
- **Kill:** the median is **> 1.5×** the baseline after the documentation and error-message fixes from the first five runs *(proposed)*. AgentLang was 1.7–5×.
- **How to hit it:** a one-page language reference, good error codes with suggested fixes, generated docs and examples in the repository, and no command-only interfaces.

## H4 — Humans review spec changes faster and catch more

**Claim.** Reviewing a *semantic spec diff* catches more wrong changes in less time than reviewing a code diff. A semantic diff lists new transitions, changed permissions, newly reachable states, affected views and changed behaviour on boundary inputs.

- **Metric:** detection rate of planted wrong changes, and review time per change.
- **Baseline:** the same changes reviewed as conventional pull-request diffs.
- **Success:** **≥ 25% faster** review with an **equal or higher** detection rate *(proposed)*.
- **Kill:** no time saving, *or* a lower detection rate.
- **Cheapest test:** Phase 4, with the owner as reviewer on 20+ changes. Order is randomized, and half the changes contain a planted wrong behaviour.
- **Caveat:** with one reviewer this is an n-of-1 study. Report it as such.

## H5 — The DSL covers a real domain without escaping to code

**Claim.** Most of a real CRUD domain (Campfire: accounts, users, rooms, memberships, messages, boosts, searches, permissions) fits in the spec without escape hatches.

- **Metric:** the share of domain rules, actions and queries expressed in the spec rather than in host-language escape hatches. Count rules, not lines.
- **Success:** **≥ 80%** in the spec *(proposed)*.
- **Kill:** **< 60%**. The checks then cover too little of the app to matter.
- **Denominator:** the frozen rule inventory (`docs/RULE-INVENTORY.md`). It lists every rule in the slice from the Rails source, each with a file and line citation, and is written *before* the spec. The spec author can't choose what counts.
- **Cheapest test:** Phase 1, by modelling the domain on paper and then in the spec. No generator is needed.

## H6 — Generated code is efficient

**Claim.** The generated service performs close to hand-written code on the same workload.

- **Metric:** throughput and CPU per request at saturation, p99 latency, and memory. Use the fair-benchmark protocol from AgentLang report 282: pinned cores, interleaved repetitions, every response validated, plan declared first.
- **Baseline:** a hand-written Rust or Go service for the same API routes.
- **Success:** **≥ 0.8×** throughput and **≤ 1.25×** p99, with no N+1 query patterns (every route's query count independent of row count) *(proposed)*.
- **Kill:** **< 0.5×** throughput after one optimization pass, *or* N+1 patterns that the generator design can't remove.
- **Cheapest test:** Phase 3, on three representative routes first: a list with relations, a write with a trigger, a derived summary view.

## H7 — Migrations generated from spec diffs are safe

**Claim.** Spec changes produce correct migrations. Destructive steps are caught, and data is preserved, or explicitly mapped and checked.

- **Metric:** across the schema-evolution tasks in the corpus:
  - data equivalence after migration against an oracle migration;
  - destructive steps detected;
  - expand/contract phases enforced.
- **Baseline:** hand-written migrations with Atlas or squawk linting.
- **Success:** **100%** of destructive steps flagged and **0** silent data losses, with migration effort no greater than baseline *(proposed)*.
- **Kill:** any silent data loss that the design can't prevent, *or* no measurable improvement over Atlas lint plus review.

## H8 — Triggers and workflows are clearer and safer

**Claim.** Separating in-transaction triggers from durable workflows, with static trigger-graph checks, prevents a class of bugs that conventional callback code allows:
- trigger loops;
- order-dependent triggers;
- side effects inside a transaction;
- lost timers.

- **Metric:** catch rate on the trigger and workflow slice of the bug corpus, plus agent accuracy on workflow change tasks (a subset of H2).
- **Success / kill:** as H1 and H2, restricted to this slice.

## H9 — The loop is fast

**Claim.** Checking and generating stay interactive.

- **Metric:** full check time and full generate time on the Campfire spec.
- **Success:** check **< 1 s**, generate **< 10 s**, and incremental re-check after a one-line change **< 200 ms** *(proposed)*.
- **Note (16 Oct 2026):** the shipped app will probably be compiled ahead of time, so H9 is about checking and test speed, and about the compile time of a live update. Interpreter request throughput isn't a goal; H6 measures the compiled form.
- **Kill:** none on its own; this is a requirement to fix, not a value claim. If it is missed it invalidates H2, H3 and H4 measurements, so check it before those phases.

## H10 — The spec is the living app

**Claim.** The spec is the running app's only source of truth. To change the app, you edit
the spec. One step then checks the edit, plans the data migration from the spec diff, and
updates the running app with its data preserved. There is no generated code to edit by
hand, and no separate migration to write.

*Added 16 Oct 2026, at the owner's request, after H1 was frozen. It doesn't change H1.*

- **Metric:** across the schema-and-behaviour change tasks in the corpus:
  - **live:** the edit is live on a running app, which serves the new behaviour and passes the task's oracle and preserve cases;
  - **data:** existing rows survive, or are explicitly mapped, with the H7 checks applied;
  - **hand work:** the number of files touched other than the spec;
  - **time:** wall time from saving the spec to the app being live.
  - **UI:**
    - in tasks that change what users see or do, the generated or declared UI follows with no UI code touched;
    - the UI never offers an action that the server then rejects for that user (checked by exploring screens against the interpreter).
- **Baseline:** the same change in the Rust port, with a hand-written migration and a redeploy.
- **Success:** every task needs only the spec edit, including its UI. The app is live within **10 s** of saving, with **0** silent data losses, and the oracle passes as often as in the baseline *(proposed)*.
- **Kill:** routine changes need edits outside the spec, such as generated code, migrations or host code, in more than **20%** of tasks, *or* live updates lose or corrupt data *(proposed)*.
- **How to hit it:**
  - Run the app from the spec, with the interpreter's semantics, over a real database. The shipped form will probably be compiled ahead of time from each spec version. A live update compiles, migrates and swaps, and the 10 s target includes compiling. Compiled builds must match the interpreter on the oracle, and are never edited by hand.
  - Version the deployed spec.
  - Plan each update as a typed diff (H7). Additive steps apply at once; destructive ones need a declared mapping and a check.
  - Have running workflows finish on the spec version they started on.

---

## What would end the experiment early

Any of these:
- **Phase 1 fails H1 *and* H5.** The checks don't catch more than strong conventional gates, and the domain doesn't fit.
- **Phase 2 fails H2 *and* H3.** Agents are no more accurate and cost more. This is AgentLang's result again.
- **Phase 3 fails H6's kill criterion with no credible fix.**

If the experiment ends, write the report and record which parts transfer, such as the checker run as a linter over a conventional schema. Then archive it.
