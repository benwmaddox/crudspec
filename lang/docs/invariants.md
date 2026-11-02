[← the language guide](../LANGUAGE.md)

## Invariants

```
invariant admin_exists: not exists(Account where true) or exists(User where .role == administrator and .status == active)
invariant sessions_of_active: all(.user.status == active for Session where true)
```

`invariant name: condition` is a fact about the stored data that every action and workflow step must keep. It can't read the actor, the request or the time (`INVARIANT_AMBIENT`).

**Proven, not tested.** For each invariant and each writer, the compiler asks Z3 whether any database, arguments and actor could make the invariant false after the writer runs. The database is assumed to start with every invariant, reference, unique key and entity invariant holding. The proof follows:
- requires, gates and rejects;
- `if`s, creates, sets and deletes, with their cascades;
- loops over rows, and the triggers each write sets off.

Each proof ends one of three ways:
- **proven:** no run breaks it;
- **broken:** a run that does, as a counterexample. For example `(user: User#1) by User#1: User#1 status active → deactivated (role administrator)` is the last administrator deactivating themselves. A search over three rows of each kind runs first, so a counterexample is small and concrete;
- **unproven:** the proof can't follow something (a text function such as `upper`, a Go call, a loop that writes another row), with the reason. A run that would break it only through such a value is unproven, never called broken.

Campfire states five invariants and all 220 proofs (5 invariants × 44 writers) are proven.

**In the build:**
- **When:** `build` proves every invariant with a 6 s limit per proof, and `verify` with 20 s.
- **Broken:** the build stops on a broken one (`INVARIANT_BROKEN`, with the counterexample), as on a type error.
- **Unproven:** for each writer an invariant is unproven for, the build compiles a check into it. An action refuses (`invalid`) a run that would break the invariant, before it commits. A workflow step, which runs outside a transaction, reports it (`invariant broken: …`). Writers it's proven for carry no check.
- **The cache:** proofs are cached per writer in `.crudspec-cache/` beside the spec. The key is a hash of only what that writer's proofs can read: the prover, the limit, the writer, the triggers it can set off, what every proof assumes, and the functions, fields and enums those name. So changing one action, or adding a field nothing reads, proves again only what it reaches. On Campfire, a cold run is 11 s, nothing changed is 0.1 s, and one trigger changed is 1.5 s.
- **Upgrades:** invariants are part of the schema, with the functions and predicates they call. Adding or changing one checks the data first, and rows that already break it block the upgrade, named.
- **Inductive:** an invariant true of every database the app can reach can still fail to prove, because a counterexample may start from a database no action could make. Strengthen it (`not exists(Account where true) or …` covers the empty database), or state the missing fact as another invariant.

**Suggested invariants.** `node lang/cli.ts suggest-invariants <spec> --data <dir> [--min <rows>]` puts forward facts the data holds that the spec doesn't state. The compiled app mines them from a copy of the data, in Go (`app suggest-invariants`):
- an optional field never none;
- a field set, or none, whenever an enum or Bool has a value;
- one enum value fixing another;
- the row a reference names always holding a value;
- every row having a row that refers to it.

Each must hold on at least `--min` rows. The candidates are proven together, the ones not proven are dropped, and the rest are proven again until none is dropped. What's left holds given the others, and is printed as invariants to add. A candidate an action can break comes with its counterexample: a case the data hasn't met yet, or a rule to enforce. On Campfire's data, this showed that `change_role` can make a bot an administrator.
