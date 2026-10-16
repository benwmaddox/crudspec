# Test process

The process exists to reach a **decision** cheaply. Each phase tests the
hypotheses that can be decided with the least new code. Each ends at a gate:
continue, adjust, or stop.

## Phases and gates

| Phase | Builds | Decides | Gate |
| --- | --- | --- | --- |
| **0. Ground truth for Phase 1 only** | Rule inventory, domain-level oracle (golden files), baseline checks, DSL v1 plus the reference spec, seeded bugs and controls | Nothing yet. It makes H1 and H5 measurable. | Inventory, oracle, DSL v1 and corpus frozen; the baseline passes the oracle on the slice |
| **1. Spec and checker** | Spec parser, type checker, SMT/graph checks, reference interpreter | H1 (catch rate), H5 (coverage), H9 (check speed) | Stop if H1 and H5 both hit their kill criteria |
| **2. Agent change study** | Language reference, LSP, error messages; agent harness | H2 (accuracy), H3 (cost), H8 (workflow slice) | Stop if H2 and H3 both hit their kill criteria |
| **3. Generation and performance** | Postgres schema and migrations, generated Rust or Go service | H6 (efficiency), H7 (migrations), H9 (generation speed) | Stop if H6 hits its kill criterion with no credible fix |
| **4. Human review study** | Semantic spec diff and behaviour diff views | H4 (review) | Report; no gate |
| **5. Report** | — | Overall verdict | Continue as a product, keep parts as tools, or archive |

Phases 1 and 2 need no code generation. The reference interpreter runs specs
against the oracle directly, so the two cheapest, most decisive questions get
answered before the expensive part is built.

## Ground truth (Phase 0)

### Order (revised before any work began)
1. Record the delegated threshold approval and commit it. That commit is the pre-registration.
2. **Rule inventory** for the slice, from the Rails source with citations. It is H5's fixed denominator.
3. **Domain-level oracle as golden files.**
   - A scenario is a fixture, a list of actions, a per-action outcome (`ok`, `forbidden`, `not_found` or `invalid`), and the normalized final state of the slice's tables.
   - Rails runs once per scenario in WSL, and the JSON output is frozen. Other arms compare offline.
4. **Requests go through Rails controllers** (`ActionDispatch::Integration::Session` in `rails runner`), not models, because Campfire's authorization lives in controller filters.
5. **The baseline is the existing Rust port, pinned at `6dae2fd`.**
   - Its tests predate the corpus, so they can't be contaminated by it.
   - First confirm that it has slice tests, that it passes the oracle, and how long mutation testing takes.
6. **DSL v1 and the reference spec of the slice** are written and frozen before any bug is.
7. **Seeded bugs and controls** are written by separate agent sessions into a directory the checker author never reads. The checker author sees only `MANIFEST.json` hashes. Scoring runs in a separate session against a frozen checker version.

Change tasks (H2) and planted changes (H4) are built only after the Phase 1 gate passes.

### Slice
- Rooms: open, closed and direct.
- Memberships and involvement.
- Messages: create, edit and delete, by the creator or an admin.
- Boosts.
- Deactivating and banning users.
- Unread state.

Out of scope: rich-text rendering, attachments, websockets, search and push.

### Domain and oracle
- **Domain:** Campfire (37signals, MIT): accounts, users, rooms, memberships, messages, boosts, searches, bans and the permission rules around them.
- **Oracle:** the pinned Rails reference app on a fixed snapshot, reused from AgentLang. The oracle is driven through its HTTP API and through `rails runner` scripts that print expected values. Every comparison is **behavioural**: same request, same state, so same response and same resulting database state.

### Baseline
A **layered conventional implementation** of the same domain slice, in Rust (axum + sqlx) or TypeScript (Kysely). It has:
- newtypes;
- exhaustive matching;
- compile-time-checked SQL;
- property tests;
- mutation testing on the diff.

It must pass the oracle before any comparison runs.

### Corpora
- **Seeded bugs:** 60–100 bugs across the categories in `corpus/README.md`. Each is expressed **both** as a spec change and as a baseline code change with the same intended wrong behaviour. Each bug is confirmed wrong by the oracle.
- **Correct controls:** 20–30 changes that look suspicious but are correct. These measure false alarms.
- **Change tasks:** 15–25 realistic feature or maintenance requests, written as issue text. Each comes with oracle cases and a list of the behaviours that must **not** change (preservation).
- **Planted wrong changes:** for H4. Each is a correct-looking change with one deliberate behavioural error.

The corpora are frozen and hashed before Phase 1. They are never edited after a run; new items go into a new, versioned corpus.

## Protocol rules

1. **Pre-register.** For each phase, write the hypotheses, metrics, thresholds, sample sizes and analysis *before* running. Commit the plan, then run.
2. **A strong baseline only.** Never compare against a deliberately weak conventional setup.
3. **Independent oracles.** Results are scored by the oracle and by behaviour diffs, never by tests the participant wrote.
4. **Calibrated controls.** Every scoring run includes known-wrong and known-right controls. A run whose controls score incorrectly is invalid.
5. **Sample size.** Decide n from the effect size that would change a decision. As a starting point, ≥ 40 task runs per arm for H2, which detects about a 15-point difference. Don't run more studies of n = 1–2 per arm; they couldn't move a decision in AgentLang.
6. **Randomize.** Randomize arm order, task order and agent assignment. Use fresh agent sessions, identical budgets and identical tools, except for the language-specific ones.
7. **Measure tokens when possible.** Record model tokens if the agent platform exposes them. Otherwise record tool calls and wall time, and label them as proxies.
8. **Separate endpoints.** Report correctness, preservation, completion, cost and time separately. Never collapse them into one score.
9. **No pooling across protocol changes.** If the protocol changes, start a new labelled study.
10. **Report negative results first.** If a kill criterion is met, say so plainly in the report's first paragraph.

## Measurements and tools

| Measure | How |
| --- | --- |
| Correctness | Oracle cases per task; the response and the resulting database state must both match |
| Preservation | **Behaviour diff.** Run the old and new versions on generated and boundary inputs, flag any differing output not covered by the task's intended changes |
| Bug caught | The checker rejects it, or a gate fails, before merge |
| False alarm | The checker rejects a correct control |
| Interaction cost | Tool calls, tokens and wall time from the harness logs |
| Performance | The fair-benchmark protocol: pinned cores, interleaved repetitions, saturation labelling, every response validated against the oracle |
| Review | Detection and time per planted change, in random order, the reviewer blind to which ones are planted |

## Statistics

- Use proportions with Wilson 95% intervals, and a two-proportion test for arm differences.
- For costs, use medians with bootstrap intervals.
- With small n, report raw counts and intervals, and don't claim significance.
- The analysis scripts are committed before data collection, and run unchanged.

## Reporting

Each phase produces a short report in `reports/`, with:
- the plan link and the frozen-input hashes;
- raw counts;
- intervals;
- the gate decision;
- what surprised us.

Phase 5 produces the final verdict in the same honest format as the AgentLang final report.
