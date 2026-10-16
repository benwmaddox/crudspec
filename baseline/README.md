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

## Still to check before Phase 1 scoring

- Run the baseline against the domain oracle on the slice. Report 285 found byte-level page differences from Rails, but H1 needs domain-level equality on the slice's actions.
- Time `cargo-mutants` on one diff. That is needed for H2, not H1.
