# Lessons from AgentLang

AgentLang (archived 16 October 2026) built a typed, introspectable language for
AI agents. It produced a byte-exact native port of Campfire's read pages. Its
central hypothesis, that agents make more reliable changes in it than in F#,
was not supported. The full report is at
`D:\code\AgentLang\reports\final-report\index.html`.

The rules this experiment adopts, and why:

| Rule here | Because, in AgentLang |
| --- | --- |
| Compare against a **strong, layered** mainstream baseline | F# was equally correct in every matched comparison, and needed about 1.7–5× fewer agent interactions |
| Score with **independent oracles** and **calibrated controls** only | Agent-written tests with full coverage passed wrong behaviour (reports 084, 182) |
| Measure **preservation** with behaviour diffs, separately from correctness | Both of AgentLang's reliability failures were unrequested edits to inherited tests that still passed (reports 222, 231) |
| Plan **sample sizes** that can move a decision | Comparisons with one or two agents per arm were careful, but couldn't decide anything |
| Keep the DSL **small and non-Turing-complete** | Every general feature removes a decidable check; Flow needed tests and oracles anyway |
| Use **files plus an LSP** as the editing surface | Command-only editing raised interaction cost and invited collateral edits |
| Make the **edit–check loop fast from day one** (H9 before agent phases) | 5–10 minute builds shaped most of AgentLang's work |
| Generate code in a **mainstream language** on Postgres; build no VM | The bespoke runtime and backend were most of AgentLang's 70,000+ lines |
| Make **differential checks** mandatory, not opt-in | The incremental-vs-full check found a real semantic gap, but was left opt-in |
| Put **kill criteria** in writing before each phase, and **stop** when one is met | AgentLang drifted from its question after day 8 and never retested it |

What to reuse directly from AgentLang:
- the Rails reference snapshot and the oracle approach (`rails runner`, byte and behaviour diffs);
- the fair-benchmark protocol from report 282, with its harness;
- the evidence-archive and secret-scan practice.
