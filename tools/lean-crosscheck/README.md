# Lean cross-check of the invariant prover

A prototype. It checks the Z3 invariant proofs (`lang/invariants.ts`) against a second,
independent reading of the same spec, written in Lean 4.

**Why:** a Z3 proof is only as good as its encoding, the code that turns actions into formulas.
If that code misreads a statement, Z3 can call a broken invariant "proven". The encoding is about
950 lines of TypeScript, and nothing else checks it.

**How:** a plain interpreter in Lean runs the same actions on small in-memory stores. It follows
what the Go runtime does (`lang/gogen/rt`), not the Z3 encoding. The two then check each other:

- **Z3 says broken.** Its counterexample (the starting rows, the arguments, who acts) is run
  again in Lean. Lean must agree on two things: the start is a store the app can hold, with every
  invariant true, and the run ends with the invariant false.
- **Z3 says proven.** Lean searches random small stores where every invariant holds (2 rows of
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
- `the_or_none` finds none when two rows match (`theOrNone_two`).

## Results on Campfire (2026-11-18)

- **The spec as written:** Z3 proves all 220 pairs. Lean checks the 200 that come from actions
  (40 actions × 5 invariants; workflow steps aren't run yet) on 1,000 random valid stores each,
  and finds no break. All agree.
- **70 mutants** (single-line `require` or `set` removed): Z3 finds a break in 4, all of
  `admin_exists`. Lean replays all 4 counterexamples, and its own search finds the same 4
  breaks. There are no disagreements. Most mutants remove an authorization check, which no
  invariant states, so neither side sees a change: that's expected, not a miss.
- **Replaying needs the proof's slice.** Z3 assumes references, unique keys and entity invariants
  only of the entities the proof needs. Other entities' rows in a model can be junk, such as
  memberships of rooms that don't exist. Before a fix, this made one replay fail. Now the model
  lists those entities (`inPlay`), and replay drops the other rows when they make the store
  invalid. It keeps the actor's session, which Z3 does assume.
- **One known difference, not yet seen to matter:** the Go runtime's `the_or_none` is none when
  two or more rows match. The Z3 encoding assumes a matching row is found. On Campfire this
  hasn't changed a verdict, because the lookups that use it match on unique keys.

## Run it

```
node tools/lean-crosscheck/export.ts apps/campfire/campfire.crud tools/lean-crosscheck/out/campfire.json
cd tools/lean-crosscheck && lake build && cd ../..
tools/lean-crosscheck/.lake/build/bin/crosscheck tools/lean-crosscheck/out/campfire.json --samples 300 --verbose
node tools/lean-crosscheck/mutate.ts apps/campfire/campfire.crud <workdir>
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
