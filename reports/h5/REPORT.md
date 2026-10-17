# H5 result: coverage of the rule inventory

**Decision: success.** **41 of 45 rules (91%)** are fully expressed in spec v1.1, with no
escape hatches. The success threshold is 80% and the kill threshold 60%
(`docs/HYPOTHESES.md`).

The denominator is the frozen rule inventory, `docs/RULE-INVENTORY.md`, written from the
Rails source before the spec. Every one of the 45 rules is tagged in `spec/campfire.crud`.
Counted strictly, four of them are only partly expressed, and those count as **not**
covered:

| Rule | What the spec can't say in v1 |
| --- | --- |
| U1 | Unread state is a Boolean. Rails stores `unread_at`, the time of the message. |
| U2 | "Connected within the last 60 s" needs wall-clock time, which v1 doesn't have (`connected` is a Boolean). |
| U3 | Rails clears unread over the presence websocket channel. The spec models it as an action, `become_present`. |
| D3 | Deactivation also deletes saved searches, which aren't modelled, and rewrites the email. The spec records the rewrite as a flag, `email_deactivated`. |

**The gap is time.** Three of the four gaps need timestamps and durations. Time is the
first thing a v2 language should add.

**Phase 1 gate.** H1 is killed (`reports/h1/REPORT.md`), but H5 succeeds. The gate stops
the experiment only if both hit their kill criteria (`docs/TEST-PROCESS.md`), so Phase 2
(H2, H3) goes ahead.
