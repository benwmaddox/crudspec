# Lean cross-check of the invariant prover

A prototype. It checks the Z3 invariant proofs (`lang/invariants.ts`) against a second,
independent reading of the same spec, written in Lean 4.

**Why:** a Z3 proof is only as good as its encoding, the code that turns actions into formulas.
If that code misreads a statement, Z3 can call a broken invariant "proven". The encoding is about
950 lines of TypeScript, and nothing else checks it.

## Found so far: two encoding bugs (both fixed in `lang/invariants.ts`)

1. **A false "proven" (unsound).** The runtime's `the_or_none` gives none when two or more rows
   match (`rt.TheOrNone`). The Z3 encoding gives none only when *no* row matches. An action
   that acts on the none case can then break an invariant Z3 calls proven. A proven pair gets no
   runtime check, so nothing would catch it. See `examples/the-or-none/app.crud`: Z3 proves
   `admin_exists` for `tidy`. With two administrators and one member, Lean shows `tidy`
   deleting both administrators. Repro:
   `crosscheck out/the-or-none.json --rows 3`. Campfire isn't affected: its only writer that
   uses `the_or_none` (`sign_in`) looks a user up by email, a unique key.
2. **A false "broken" (too strict).** After an action, the runtime re-checks the entity
   invariants of the rows it touched *and of the rows that refer to them* (the generated
   `invariants()`, `lang/gogen/gen.ts`). The encoding assumes them only for the touched
   entities.
   - Example: remove `delete Session where .user == user` from `deactivate_user`. Z3 then calls
     `sessions_of_active` broken. But the runtime refuses that run, because
     `Session.invariant self.user.status == active` is re-checked for the deactivated user's
     sessions.
   - Effect: the build would stop with `INVARIANT_BROKEN` on a run that can't happen.
   - It shows up in 3 of the 89 mutants.

**How:** a plain interpreter in Lean runs the same actions on small in-memory stores. It follows
what the Go runtime does (`lang/gogen/rt`), not the Z3 encoding. The two then check each other:

- **Z3 says broken.** Its counterexample (the starting rows, the arguments, who acts) is run
  again in Lean. Lean must agree on two things: the start is a store the app can hold, with every
  invariant true, and the run ends with the invariant false.
- **Z3 says proven.** Lean searches random small stores where every invariant holds (3 rows of
  each kind, small value ranges) for a run that breaks it. Finding one means the encoding, or the
  interpreter, has a bug.
- **Mutants** (`mutate.ts`) check that agreement means something. One `require` or `set` at a
  time is removed from an action. When Z3 then finds a way to break an invariant, Lean must
  replay it.

`CrudCheck/Frame.lean` also holds proofs, checked by Lean's kernel, that hold for stores of any
size, not just the searched ones:

- an invariant's truth depends only on the tables it reads (`holds_frame`);
- so the prover's shortcut is sound: an action that writes nothing an invariant reads keeps it
  (`keeps_unread`), and so is slicing (`slice_sound`);
- `the_or_none` finds none when two rows match (`theOrNone_two`): the runtime's side of finding 1.

## Results on Campfire (2026-11-18, after the fixes)

- **The spec as written:** Z3 proves all 220 pairs. Lean checks the 200 that come from actions
  (40 actions × 5 invariants; workflow steps aren't run yet), with 3 rows of each kind. Each
  action gets up to 1,000 valid random stores, and Lean finds no break. All agree.
  The weakest coverage is for actions whose runs are almost all refused (at 1,000 samples):
  `delete_bot` ended 8 runs, `reset_bot_key` 26, `update_bot` 32.
- **89 mutants** (one single-line `require`, `set` or `delete` removed): Z3 finds a break in 6.
  Lean replays all 6 counterexamples, and its own search finds the same breaks. There are no
  disagreements.
  - Before fix 2, three more mutants disagreed: Z3 reported breaks the runtime refuses.
  - A first version of fix 2 broke the other direction, and the mutants caught it. It assumed
    entity invariants of rows the slice had left as they were, which hid two real breaks. It is
    now limited to entities whose writes the slice keeps, and `lang/test/invariants.test.ts`
    covers that case.
- Most mutants remove an authorization check, which no invariant states, so neither side sees a
  change: that's expected, not a miss.
- **Replaying needs the proof's slice.** Z3 assumes references, unique keys and entity invariants
  only of the entities the proof needs. Other entities' rows in a model can be junk, such as
  memberships of rooms that don't exist. So the model lists the entities the proof constrained
  (`inPlay`). Replay drops the other rows when they make the store invalid, and keeps the
  actor's session, which Z3 does assume.
- **Rows matter:** with 2 rows of each kind, the search misses finding 1, which needs two
  administrators and a third user. The default is now 3.

## Differential check against the compiled Go app (`diff-go.ts`)

The checks above compare Lean with the Z3 encoding. This one compares Lean with the Go program
the compiler generates:

1. `crosscheck cases` writes random valid cases: a store, an action, its arguments, who acts and
   `now`. For each case it lists every outcome Lean allows: each way its choices can go, each
   either a refusal or the store after.
2. `diff-go.ts` builds the app, then for each case loads the store (`/_test/load`), runs the
   action (`/_test/run`, a test-mode endpoint added for this) and dumps the store
   (`/_test/dump`).
3. The app's result must be one of Lean's outcomes:
   - **ok:** the same rows by id, with the same field values. Values Lean didn't compute, files,
     passwords, rich text and timestamps aren't compared.
   - **refused:** Lean must allow a refusal too.

In this mode Lean fixes what the app fixes (the request's ip, method and identity) and doesn't
treat unknowns as holding in the after-run checks. New rows get per-entity ids, as SQLite does.
Actions that start a workflow after commit are left out, because Lean doesn't run workflows.

**First run on Campfire (2026-11-18): 1,705 cases.** 1,670 match and 26 are inconclusive (Lean
hit its limit of 64 choice paths). The 9 mismatches are two generator bugs, both confirmed in
the generated Go (not fixed in this change):

1. **A missing singleton's field reads as the Go zero value.** The typed fast path compiles
   `Account.join_code` to `rt.AsStr(c.FieldOf(Singleton Account …))`. With no Account row that
   gives `""`, not none. So before setup, `join` with an empty join code succeeds, and anyone
   can create an account (7 cases). Z3 can't see this, because it assumes the singleton exists.
2. **Batched `ensure` functions are shared by the wrong key.** `ensureLoop` names the batch
   function `CTE_<entity>_<given-fields mask>` (`gen.ts`), which doesn't say which field the
   loop varies.
   - `on create User`'s `for each r in Room … ensure Membership { room: r, user: u }` reuses
     the function made for a loop over users.
   - That function reads only the first record's room and skips "duplicates" by user, so a new
     user joins only the first open room (2 cases, `create_bot`). The same trigger runs for
     `join` and `first_run`.

## Run it

```
node tools/lean-crosscheck/export.ts apps/campfire/campfire.crud tools/lean-crosscheck/out/campfire.json
cd tools/lean-crosscheck && lake build && cd ../..
tools/lean-crosscheck/.lake/build/bin/crosscheck tools/lean-crosscheck/out/campfire.json --samples 300 --verbose
node tools/lean-crosscheck/mutate.ts apps/campfire/campfire.crud <workdir>
# Go app against Lean (needs Go; on Windows, in WSL):
tools/lean-crosscheck/.lake/build/bin/crosscheck cases tools/lean-crosscheck/out/campfire.json --samples 50 --out tools/lean-crosscheck/out/campfire-cases.json
node tools/lean-crosscheck/diff-go.ts apps/campfire/campfire.crud tools/lean-crosscheck/out/campfire.json tools/lean-crosscheck/out/campfire-cases.json
# finding 1:
node tools/lean-crosscheck/export.ts tools/lean-crosscheck/examples/the-or-none/app.crud tools/lean-crosscheck/out/the-or-none.json
tools/lean-crosscheck/.lake/build/bin/crosscheck tools/lean-crosscheck/out/the-or-none.json
```

This needs Lean (`elan`, with the toolchain in `lean-toolchain`); it doesn't use Mathlib.
`export.ts` sets `CRUDSPEC_INV_MODELS=1`, which makes the prover attach each bounded
counterexample as data (`InvResult.model`). Nothing else in the prover changes.

## What the interpreter does with what it can't compute

Some values come from the request, a text function or a Go call. For each of these the
interpreter makes a choice, and the search tries every way of choosing, up to 64 per store. This
matches the Z3 encoding, where such a value can be anything. Checks of what a store must hold
(entity invariants, invariants) treat such a value as holding.

## Limits (prototype)

- **Random search finds bugs; it doesn't prove their absence.** A writer whose runs are almost
  always refused gets few tests (see `--verbose`: `update_bot` and `reset_bot_key` end only a few
  runs).
- **Workflow steps aren't run yet** (only actions), and enum `transitions` aren't applied.
- **`diff-go.ts` checks the store after each action only:** not screens, live pages, mail or
  workflows. Cases leave optional files and passwords empty.
- **Only bounded counterexamples carry a model**, so a "broken" verdict from the unbounded proof
  can't be replayed.
- **The interpreter is a second reading of the language, not a proven one.** When the two
  disagree, either side may be wrong.
- **`Frame.lean` proves its facts about a core model of invariants**, not about the TypeScript
  code itself.
