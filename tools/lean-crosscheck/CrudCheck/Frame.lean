/-
Proofs, checked by Lean's kernel, for any store of any size (not a search):

The Z3 prover (lang/invariants.ts, `build`) takes a shortcut: when an action writes nothing an
invariant reads, it calls the invariant proven without asking Z3 ("it writes nothing the
invariant reads"). It also slices: it keeps only the writes to what the invariant reads. Both rest
on one fact, proven here for a core of the invariant language: an invariant's truth depends only
on the tables it reads.

The core: a store gives each entity its rows; an invariant is built from true/false, not, and,
or, implies, and "every row of E" / "some row of E" with a condition on that row. (The condition
is any function of the row: field comparisons, as the real language has, are a special case.)
-/
namespace CrudCheck.Frame

/-- a row: each field's value (as a number: enums, references and the rest are numbered) -/
abbrev Row := String → Nat
/-- a store: each entity's rows -/
abbrev Store := String → List Row

inductive Inv where
  | const (b : Bool)
  | not (a : Inv)
  | and (a b : Inv)
  | or (a b : Inv)
  | implies (a b : Inv)
  | all (e : String) (p : Row → Bool)
  | some (e : String) (p : Row → Bool)

/-- the entities an invariant reads -/
def reads : Inv → List String
  | .const _ => []
  | .not a => reads a
  | .and a b | .or a b | .implies a b => reads a ++ reads b
  | .all e _ | .some e _ => [e]

def holds (s : Store) : Inv → Bool
  | .const b => b
  | .not a => !holds s a
  | .and a b => holds s a && holds s b
  | .or a b => holds s a || holds s b
  | .implies a b => !holds s a || holds s b
  | .all e p => (s e).all p
  | .some e p => (s e).any p

/-- Two stores that agree on what an invariant reads agree on the invariant. -/
theorem holds_frame (s s' : Store) : ∀ i : Inv, (∀ e ∈ reads i, s e = s' e) → holds s i = holds s' i
  | .const _, _ => rfl
  | .not a, h => by simp only [holds, holds_frame s s' a h]
  | .and a b, h | .or a b, h | .implies a b, h => by
    have ha := holds_frame s s' a (fun e he => h e (List.mem_append_left _ he))
    have hb := holds_frame s s' b (fun e he => h e (List.mem_append_right _ he))
    simp only [holds, ha, hb]
  | .all e _, h | .some e _, h => by simp only [holds, h e (List.mem_singleton_self e)]

/-- An action, as what it does to a store: a store after, or none (refused, nothing changes),
with the entities it can write (its creates, sets and deletes, and what its deletes cascade to
and its triggers write). -/
structure Action where
  run : Store → Option Store
  writes : List String
  /-- it changes no other entity's rows -/
  frame : ∀ s s', run s = Option.some s' → ∀ e, e ∉ writes → s' e = s e

/-- The shortcut is sound: an action that writes nothing an invariant reads keeps it, from any
store, whatever the action does to the rest. -/
theorem keeps_unread (a : Action) (i : Inv) (disjoint : ∀ e ∈ reads i, e ∉ a.writes)
    (s s' : Store) (before : holds s i = true) (ran : a.run s = Option.some s') : holds s' i = true := by
  rw [holds_frame s' s i (fun e he => a.frame s s' ran e (disjoint e he))]
  exact before

/-- A refused action keeps every invariant: nothing changed. -/
theorem refused_keeps (i : Inv) (s : Store) (before : holds s i = true) : holds s i = true := before

/-- Slicing is sound: running a smaller action that does the same to what the invariant reads
(the sliced one) gives the same verdict as the whole action. -/
theorem slice_sound (i : Inv) (s₁ s₂ : Store) (same : ∀ e ∈ reads i, s₁ e = s₂ e) :
    holds s₁ i = holds s₂ i := holds_frame s₁ s₂ i same

/-- What the Go runtime's `the_or_none` does: the row when exactly one matches, else none. -/
def theOrNone (rows : List Row) (p : Row → Bool) : Option Row :=
  match rows.filter p with
  | [r] => Option.some r
  | _ => Option.none

/-- With two matching rows the runtime finds none. (The Z3 encoding assumes the opposite: when a
row matches, the lookup finds one. The cross-check follows the runtime; see README.) -/
theorem theOrNone_two (r₁ r₂ : Row) (p : Row → Bool) (h₁ : p r₁ = true) (h₂ : p r₂ = true) :
    theOrNone [r₁, r₂] p = Option.none := by
  simp [theOrNone, List.filter, h₁, h₂]

end CrudCheck.Frame
