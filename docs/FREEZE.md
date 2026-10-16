# Phase 0 freeze: DSL v1, the reference spec and the slice oracle

Frozen 16 Oct 2026 at git tag `phase0-dsl-v1`, before any seeded bug or checker
code exists. From here on:

- **DSL v1** (`docs/LANGUAGE.md`) and the **reference spec** (`spec/campfire.crud`) don't change. A change means v2 and a new, separately labelled study (protocol rule 9).
- The **rule inventory** and the **slice oracle** (25 scenarios, goldens `slice-v1-e`) don't change. Seeded bugs may add oracle scenarios of their own, under `corpus/`, but never edit these.
- The **interpreter** may get bug fixes only if they don't change any slice result. Any fix is recorded here.

State at the freeze:

| Check | Result |
| --- | --- |
| Reference spec vs Rails, slice | 25/25 scenarios match |
| Rust baseline `6dae2fd` vs Rails, slice (`oracle/replays/slice-v1-r4`) | 25/25 scenarios match |
| Scenario adequacy (`tools/scenario_adequacy.py`) | 25/25 targeted spec mutations caught |
| Replay negative control (`oracle/replays/mutant-b3c`) | caught |

The spec declares four invariants, each backed by inventory rules: sessions belong
to active users; bans belong to banned users; a deactivated user keeps only
direct-room memberships; direct rooms have no name. The obvious fifth one,
"every active user is in every open room", is **false in Rails**: an unbanned
user doesn't get the open rooms created or converted while they were banned.
Scenario `n3-unban-misses-new-open-rooms` records that.

Working-tree hashes (LF line endings):

| File | SHA-256 |
| --- | --- |
| `docs/LANGUAGE.md` | `e9f0c267f56c9e2717e5a8dc7b7d592c16c15de7d047c541bf49a1ab0b29eaeb` |
| `spec/campfire.crud` | `3de6cdf7a918c654ccf07ad54231240da7bb8211c549d4812aad5b64633b4049` |
| `docs/RULE-INVENTORY.md` | `0f2abf6ead127f43270197101a206e99da38d3c86e86d66cf9a6c9861acacaac` |
| `oracle/scenarios/slice-v1/*.json` (sorted, concatenated) | `ab2cea6449f85698b31cc46c49ca4865b119454cbb83fcf5816a098172efd9e1` |
| `oracle/golden/slice-v1-e/*.json` (sorted, concatenated) | `1d8e801a0b7b10202c322b8d77fb221b440096e8137135cdac4cb248fe093230` |
