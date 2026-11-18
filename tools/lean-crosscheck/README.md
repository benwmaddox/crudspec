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

## Run it

```
node tools/lean-crosscheck/export.ts apps/campfire/campfire.crud tools/lean-crosscheck/out/campfire.json
cd tools/lean-crosscheck && lake build && cd ../..
tools/lean-crosscheck/.lake/build/bin/crosscheck tools/lean-crosscheck/out/campfire.json --samples 300 --verbose
node tools/lean-crosscheck/mutate.ts apps/campfire/campfire.crud <workdir>
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
- **Only bounded counterexamples carry a model**, so a "broken" verdict from the unbounded proof
  can't be replayed.
- **The interpreter is a second reading of the language, not a proven one.** When the two
  disagree, either side may be wrong.
- **`Frame.lean` proves its facts about a core model of invariants**, not about the TypeScript
  code itself.
