# Baseline: the hand-written Rust port of Campfire

The baseline arm is **once-campfire-rust at `6dae2fd`**, a complete, hand-written
Rust implementation of ONCE Campfire. Its `reference/` submodule is the Rails app
at `90b3300`, the same commit the oracle runs.

Why this port, and not one written for the experiment: its tests were written
before, and without knowledge of, the seeded-bug corpus. A baseline written now,
by anyone who has seen the bugs, would be contaminated.

## Setup and tests (WSL)

```
wsl -d Ubuntu -u ben -- bash /mnt/d/code/crudspec/baseline/setup-wsl.sh   # clone and pin (once)
wsl -d Ubuntu -u ben -- bash -lc "bash /mnt/d/code/crudspec/baseline/test-wsl.sh"
```

First measurement, 16 Oct 2026:

| Crate | Tests passed | Ignored | Test time |
| --- | ---: | ---: | ---: |
| `campfire` (controllers, channels, app chain) | 202 | 4 | 9.7 s |
| `campfire_db` (models, callbacks, columns) | 149 | 4 | 1.6 s |

## Slice coverage seen in its tests (not exhaustive)

| Area | Examples |
| --- | --- |
| Unread state | `creating_a_message_touches_the_room_marks_disconnected_members_unread…`, `invisible_members_are_not_marked_unread` |
| Rooms | `direct_rooms_keep_their_type`, `only_one_direct_room_will_exist_for_the_same_users`, `inaccessible_rooms_redirect_home_with_an_alert`, `default_involvement_for_new_users` |
| Involvement | `involvement_is_shown_and_changed` |
| Messages and boosts | `boosts_are_listed_created_and_removed`, plus message controller tests |
| Bans | `bans_and_unbans`, `a_ban_from_a_private_address_is_unprocessable`, `the_application_chain_blocks_banned_ips…` |
| Deactivation | `deactivating_disconnects_for_good`, plus user model tests |

## Agreement with the domain oracle

`oracle/rails/replay-rust.sh` replays every oracle scenario over real HTTP against a
Rust build (the baseline, or a patched copy for a seeded bug). Rails models build
each scenario's setup in a fresh database and normalize the final state afterwards.
Every action in between is served by the Rust server, with its caches off and
X-Forwarded-For carrying each actor's IP. `oracle/compare.py` then diffs the
results with the Rails golden files: outcome per action, listed rows, and the
initial and final state.

```
wsl -d Ubuntu -u root -- bash /mnt/d/code/crudspec/oracle/rails/replay-rust.sh <run> oracle/scenarios/slice-v1 [patched-src]
python oracle/compare.py oracle/golden/slice-v1-e oracle/replays/<run>
```

Measured 16 Oct 2026:

| Run | Build | Result |
| --- | --- | --- |
| `smoke-r2` | `6dae2fd` | 3/3 scenarios match |
| `slice-v1-r3` | `6dae2fd` | **24/24 scenarios match**, with no differences on the slice |
| `mutant-b3c` (negative control) | `6dae2fd` with `Boost::find_by_message_and_booster` ignoring the booster | 23/24. The `b-boosts` diff shows Bob allowed to remove Cy's boost (Rails: not_found) |

The negative control shows the harness really exercises the Rust server: a known
wrong rule surfaces as a domain-level diff. The same check confirms that each seeded
bug's `baseline.patch` is really wrong.

Two harness facts found along the way:

- The runner's query cache hides rows another process wrote. In replay mode, the oracle clears it after every request.
- Request URLs must not read live rows, which may have been deleted by then. For example, an unboost needs its boost's message, which the oracle now records when the boost is named.

## Still to check

- Time `cargo-mutants` on one diff. That is needed for H2, not H1.
