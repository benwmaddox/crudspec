/-
Running a writer on a store, over every way the oracle can choose, and the two checks:
- search: random small stores where every invariant holds; a run that breaks one is a way to
  break it the interpreter found by itself;
- replay: Z3's counterexample, rebuilt as a store; the interpreter must agree it is a store the
  app can hold and that the action breaks the invariant from it.
-/
import CrudCheck.Eval
open Lean

namespace CrudCheck

/-- the outcome of one run of a writer, for one way of choosing -/
inductive Outcome where
  | ok (post : Store)
  | refused (why : String)
  | unsupported (what : String)

structure Input where
  pre : Store
  params : List (String × Val)
  actor : Val
  now : Int

def baseEnv (sp : Spec) (inp : Input) : Env :=
  let vs := inp.params ++ [("now", .int inp.now)]
  { vars := if sp.actor.isSome then ("actor", inp.actor) :: vs else vs }

/-- one run, with the oracle given: the gates (true refuses), the body, then what the store
must hold after (the runtime refuses a write that breaks it) -/
def runOnce (sp : Spec) (act : Json) (inp : Input) (oracle : Array Nat) : Outcome × Array Nat :=
  let skips := (jarr act "skips").map (·.getStr?.toOption.getD "")
  let prog : M Unit := do
    let env := baseEnv sp inp
    for g in sp.gates do
      if skips.contains (jstr g "name") then continue
      if ← asBool (← eval sp env (jget g "cond")) then refuse s!"gate {jstr g "name"}"
    discard <| exec sp env (jarr act "body").toList
    modify fun st => { st with lenient := true }
    if let some why ← wellFormed sp (.int inp.now) then refuse s!"after: {why}"
  match prog.run.run { store := inp.pre, oracle } with
  | (.ok (), st) => (.ok st.store, st.sizes)
  | (.error (.refused w), st) => (.refused w, st.sizes)
  | (.error (.unsupported w), st) => (.unsupported w, st.sizes)

/-- every way of choosing, depth first over the choices each run made (at most `cap` runs) -/
partial def runAll (sp : Spec) (act : Json) (inp : Input) (cap : Nat := 64) : List Outcome := Id.run do
  let mut out := []
  let mut oracle : Array Nat := #[]
  for _ in [:cap] do
    let (o, sizes) := runOnce sp act inp oracle
    out := out ++ [o]
    -- the next way: the last choice that can move, moved; the ones after it back to the first way
    let full := (List.range sizes.size).toArray.map fun i => oracle.getD i 0
    let mut i := sizes.size
    let mut moved := false
    while i > 0 && !moved do
      i := i - 1
      if full[i]! + 1 < sizes[i]! then
        oracle := (full.extract 0 i).push (full[i]! + 1)
        moved := true
    if !moved then break
  return out

/-- whether a store is one the app can hold and every invariant holds of it -/
def validPre (sp : Spec) (inp : Input) : Option String :=
  let prog : M (Option String) := do
    if let some why ← wellFormed sp (.int inp.now) then return some why
    for (n, c) in sp.invs do
      if !(← invHolds sp (.int inp.now) c) then return some s!"{n} doesn't hold before"
    -- who acts: none, or a row of the actor's entity that a session names
    match sp.actor, inp.actor with
    | some a, .row e id =>
      if e != a || !(← store).has e id then return some "the actor isn't there"
      if let some (se, sf) := sp.session then
        if !((← store).rows se).any (·.get sf == .row e id) then return some "the actor has no session"
    | _, _ => pure ()
    for (n, v) in inp.params do
      if let .row e id := v then
        if !(← store).has e id then return some s!"the argument {n} names {e}#{id}, which isn't there"
    return none
  match prog.run.run { store := inp.pre, lenient := true } with
  | (.ok r, _) => r
  | (.error (.refused w), _) => some w
  | (.error (.unsupported w), _) => some s!"can't check: {w}"

/-- the invariants a store breaks (none read a value the interpreter can't compute: those are
checked by Z3 as unproven, and left out here) -/
def broken (sp : Spec) (now : Int) (s : Store) : List String :=
  sp.invs.toList.filterMap fun (n, c) =>
    match (invHolds sp (.int now) c).run.run { store := s, lenient := true } with
    | (.ok true, _) => none
    | (.ok false, st) => if st.metUnk then none else some n
    | (.error _, _) => none

def showStore (s : Store) : String :=
  "; ".intercalate (s.tabs.reverse.filterMap fun (e, rs) =>
    if rs.isEmpty then none else some (", ".intercalate (rs.map fun r =>
      s!"{e}#{r.id}(" ++ " ".intercalate ((r.vals.reverse.filter (fun (f, v) => v != .none && f != "created" && f != "updated")).map fun (f, v) => s!"{f}={v.show}") ++ ")")))

-- ---- random stores

abbrev G := StateM StdGen

def rnd (n : Nat) : G Nat := do
  if n == 0 then return 0
  let g ← get
  let (v, g') := randNat g 0 (n - 1)
  set g'
  return v

def pick (vs : List Val) : G (Option Val) := do
  if vs.isEmpty then return none
  return some vs[← rnd vs.length]!

def genValue (sp : Spec) (fi : FieldInfo) (s : Store) : G (Option Val) := do
  if fi.optional && (← rnd 3) == 0 then return some .none
  pick (domainOf sp { fi with optional := false } s)

/-- a random store: 0 to `rows` rows of each kind (a singleton 0 or 1), fields from small domains -/
def genStore (sp : Spec) (rows : Nat) : G (Option Store) := do
  let mut s : Store := {}
  let mut next := 1
  for d in sp.ents do
    let n ← rnd ((if d.singleton then 1 else rows) + 1)
    let mut rs := []
    for _ in [:n] do
      rs := rs ++ [{ id := next, vals := [] : Row }]
      next := next + 1
    s := s.setRows d.name rs
  s := { s with next }
  for d in sp.ents do
    let mut rs := []
    for r in s.rows d.name do
      let mut r := r
      for f in d.fields do
        if f.ty == "other" || f.ty == "set" then continue
        match ← genValue sp f s with
        | some v => r := r.set f.name v
        | none => return none
      r := (r.set "created" (.int 0)).set "updated" (.int 0)
      rs := rs ++ [r]
    s := s.setRows d.name rs
  return some s

def paramType (sp : Spec) (p : Json) : FieldInfo :=
  fieldOfType sp.enums (sp.ents.map (·.name)) (jstr p "name") (jget p "type")

def genInput (sp : Spec) (act : Json) (rows : Nat) : G (Option Input) := do
  let some s ← genStore sp rows | return none
  let mut s := s
  let mut params := []
  for p in jarr act "params" do
    let fi := paramType sp p
    let v ← if fi.ty == "set" then do
        let mut ids := []
        for r in s.rows fi.target do if (← rnd 2) == 1 then ids := ids ++ [r.id]
        pure (some (Val.rows fi.target ids))
      else genValue sp fi s
    let some v := v | return none
    params := params ++ [(fi.name, v)]
  let mut actor := Val.none
  if let some a := sp.actor then
    if (← rnd 4) != 0 then
      let some v ← pick ((s.rows a).map fun r => .row a r.id) | return none
      actor := v
      -- the actor signed in: give them a session row when the store has none
      if let some (se, sf) := sp.session then
        if !(s.rows se).any (·.get sf == v) then
          if let some d := sp.ent? se then
            let mut r : Row := { id := s.next, vals := [] }
            for f in d.fields do
              if f.ty == "other" || f.ty == "set" then continue
              if f.name == sf then r := r.set f.name v
              else match ← genValue sp f s with
                | some x => r := r.set f.name x
                | none => return none
            s := { (s.setRows se (s.rows se ++ [r])) with next := s.next + 1 }
  let now := ints[← rnd ints.length]!
  return some { pre := s, params, actor, now }

-- ---- Z3's counterexamples, as stores

/-- a value of the export (InvVal), with rows named "User#1" given ids -/
def ofJson (ids : List (String × Nat)) (j : Json) : Val :=
  match j with
  | .null => .none
  | .bool b => .bool b
  | .str s => .enum s
  | .num _ => .int (j.getInt?.toOption.getD 0)
  | _ =>
    let rowId (r : String) : Val := match ids.lookup r with
      | some id => .row ((r.splitOn "#").headD "") id
      | none => .unk
    if jhas j "row" then rowId (jstr j "row")
    else if jhas j "text" then .text (jstr j "text")
    else if jhas j "rows" then
      let rs := (jarr j "rows").toList.map (·.getStr?.toOption.getD "")
      .rows (((rs.headD "").splitOn "#").headD "") (rs.filterMap fun r => ids.lookup r)
    else .other (jstr j "other")

def inputOfModel (_sp : Spec) (m : Json) : Input := Id.run do
  let tables := jarr m "rows"
  let mut ids : List (String × Nat) := []
  let mut next := 1
  for t in tables do
    for r in jarr t "rows" do
      ids := ids ++ [(jstr r "id", next)]
      next := next + 1
  let mut s : Store := { next }
  for t in tables do
    let e := jstr t "entity"
    let rs := (jarr t "rows").toList.map fun r =>
      let id := (ids.lookup (jstr r "id")).getD 0
      { id, vals := (jarr r "fields").toList.map fun fv =>
          let a := fv.getArr?.toOption.getD #[]
          ((a.getD 0 Json.null).getStr?.toOption.getD "", ofJson ids (a.getD 1 Json.null)) : Row }
    s := s.setRows e rs
  let params := (jarr m "params").toList.map fun pv =>
    let a := pv.getArr?.toOption.getD #[]
    ((a.getD 0 Json.null).getStr?.toOption.getD "", ofJson ids (a.getD 1 Json.null))
  return { pre := s, params, actor := ofJson ids (jget m "actor"), now := (jget m "now").getInt?.toOption.getD 0 }

end CrudCheck
