/-
crosscheck <export.json> [--samples N] [--rows K] [--seed S] [--json out.json]

For each action and invariant, Z3's verdict (from the export) against this interpreter's:
- Z3 "broken": its counterexample is run again here; it must start from a store the app can
  hold, with every invariant true, and end with the invariant false.
- Z3 "proven": random small stores are searched here for a run that breaks it; finding one
  means the Z3 encoding missed something (or this interpreter is wrong: either way, a bug).
-/
import CrudCheck.Search
open Lean CrudCheck

structure Pair where
  inv : String
  writer : String
  z3 : String
  lean : String
  agree : Bool
  detail : String := ""

def argNat (args : List String) (flag : String) (d : Nat) : Nat :=
  match args.dropWhile (· != flag) with
  | _ :: v :: _ => v.toNat?.getD d
  | _ => d

def argStr (args : List String) (flag : String) : Option String :=
  match args.dropWhile (· != flag) with
  | _ :: v :: _ => some v
  | _ => none

structure WriterRun where
  valid : Nat := 0
  runs : Nat := 0
  ok : Nat := 0
  refused : Nat := 0
  unsupported : Nat := 0
  why : String := ""
  breaks : List (String × String) := []

def searchWriter (sp : Spec) (act : Json) (samples rows : Nat) (gen : StdGen) : WriterRun × StdGen := Id.run do
  let mut w : WriterRun := {}
  let mut g := gen
  for _ in [:samples * 400] do
    if w.valid ≥ samples then break
    let (inp?, g') := (genInput sp act rows).run g
    g := g'
    let some inp := inp? | continue
    if (validPre sp inp).isSome then continue
    w := { w with valid := w.valid + 1 }
    for o in runAll sp act inp do
      w := { w with runs := w.runs + 1 }
      match o with
      | .refused _ => w := { w with refused := w.refused + 1 }
      | .unsupported why => w := { w with unsupported := w.unsupported + 1, why }
      | .ok post =>
        w := { w with ok := w.ok + 1 }
        for n in broken sp inp.now post do
          if (w.breaks.lookup n).isNone then
            let ps := ", ".intercalate (inp.params.map fun (p, v) => s!"{p}: {v.show}")
            w := { w with breaks := w.breaks ++ [(n, s!"({ps}) by {inp.actor.show}, now {inp.now}: before {showStore inp.pre}; after {showStore post}")] }
  return (w, g)

def replay (sp : Spec) (act : Json) (inv : String) (model : Json) : Bool × String :=
  let full := inputOfModel sp model act
  -- Z3 assumed references, unique keys and entity invariants only of the entities in play (its
  -- slice); other entities' rows it picked freely. When those make the store one the app can't
  -- hold, they are left out (the break must not need them)
  let inPlay := (jarr model "inPlay").toList.map (·.getStr?.toOption.getD "")
  -- (Z3 also assumed the actor has a session: the actor's own session rows stay)
  let keep (e : String) (r : Row) : Bool := inPlay.contains e || (match sp.session with
    | some (se, sf) => se == e && full.actor != .none && r.get sf == full.actor
    | none => false)
  let sliced : Input := { full with pre := { full.pre with tabs := full.pre.tabs.map fun (e, rs) => (e, rs.filter (keep e)) } }
  let (inp, note) := match validPre sp full with
    | none => (full, "")
    | some why => (sliced, s!" (rows outside the proof's slice dropped: {why})")
  match validPre sp inp with
  | some why => (false, s!"Z3's starting store isn't one the app can hold: {why} [{showStore inp.pre}]")
  | none =>
    let outs := runAll sp act inp
    let hit := outs.any fun o => match o with
      | .ok post => (broken sp inp.now post).contains inv
      | _ => false
    if hit then (true, "the run breaks it here too" ++ note)
    else
      let what := outs.map fun o => match o with
        | .ok post => s!"ends with {showStore post}"
        | .refused w => s!"refused ({w})"
        | .unsupported w => s!"can't run: {w}"
      (false, s!"no run breaks it here{note}: " ++ "; ".intercalate (what.take 3) ++ s!" [start {showStore inp.pre}]")

-- ---- differential cases: what the compiled Go app must do one of (tools/lean-crosscheck/diff-go.ts)

/-- a value as the cases file writes it; {"wild": true}: one the interpreter didn't compute (it
matches anything the app stored) -/
partial def valJson : Val → Json
  | .none => Json.null
  | .bool b => Json.bool b
  | .int i => Json.num (JsonNumber.fromInt i)
  | .enum v => Json.str v
  | .text t => Json.str t
  | .row e id => Json.mkObj [("ref", e), ("id", Json.num (JsonNumber.fromNat id))]
  | .rows e ids => Json.mkObj [("entity", e), ("set", Json.arr (ids.toArray.map fun i => Json.num (JsonNumber.fromNat i)))]
  | .list vs => Json.arr (vs.toArray.map valJson)
  | .other _ | .unk => Json.mkObj [("wild", true)]
  | .dec n => Json.mkObj [("dec", Json.str (decText n))]   -- exact, 6 places

def storeJson (sp : Spec) (s : Store) : Json :=
  Json.mkObj (sp.ents.toList.map fun d => (d.name, Json.arr ((s.rows d.name).toArray.map fun r =>
    Json.mkObj [("id", Json.num (JsonNumber.fromNat r.id)),
                ("fields", Json.mkObj ((d.fields.toList.filter (fun f => f.ty != "set" && f.ty != "other")).map fun f => (f.name, valJson (r.get f.name))))])))

/-- the values the compiled app's /_test/run fixes: the request, and each identity's name -/
def fixedForGo (sp : Spec) : List (String × Val) :=
  let cookie := sp.identities.toList.headD ""
  [("request.ip", .text "203.0.113.1"), ("request.method", .text "write"), ("request.identity", .text (sp.cookieIdentity.getD cookie))]
    ++ sp.identities.toList.map fun n => (n, .text n)

def casesMain (args : List String) : IO UInt32 := do
  let some path := args.tail.head? | IO.eprintln "usage: crosscheck cases <export.json> --out cases.json [--only A] [--samples N] [--rows K] [--seed S]"; return 64
  let some out := argStr args "--out" | IO.eprintln "cases: --out is required"; return 64
  let samples := argNat args "--samples" 50
  let rows := argNat args "--rows" 3
  let only := argStr args "--only"
  let j ← IO.ofExcept (Json.parse (← IO.FS.readFile path))
  let sp := Spec.load j
  let mut g := mkStdGen (argNat args "--seed" 1)
  let mut cases : Array Json := #[]
  let mut skipped : Array Json := #[]
  for act in sp.actions do
    let name := jstr act "name"
    if only.isSome && only != some name then continue
    let mut made := 0
    let mut why := ""
    for _ in [:samples * 400] do
      if made ≥ samples then break
      let (inp?, g') := (genInput sp act rows true).run g
      g := g'
      let some inp := inp? | continue
      let inp := { inp with fixed := fixedForGo sp }
      if (validPre sp inp).isSome then continue
      let (outs, complete) := runAllC sp act inp 64 true
      if let some w := outs.findSome? (fun o => match o with | .unsupported w => some w | _ => none) then
        why := w; continue
      made := made + 1
      let os := outs.map fun o => match o with
        | .ok post => Json.mkObj [("ok", true), ("post", storeJson sp post)]
        | .refused w => Json.mkObj [("ok", false), ("why", w)]
        | .unsupported w => Json.mkObj [("ok", false), ("why", w)]
      cases := cases.push (Json.mkObj [
        ("action", name), ("now", Json.num (JsonNumber.fromInt inp.now)),
        ("actor", valJson inp.actor),
        ("params", Json.mkObj (inp.params.map fun (n, v) => (n, valJson v))),
        ("pre", storeJson sp inp.pre), ("complete", complete), ("outcomes", Json.arr os.toArray)])
    if made == 0 then skipped := skipped.push (Json.mkObj [("action", name), ("why", if why == "" then "no valid starting store found" else s!"can't run: {why}")])
  IO.FS.writeFile out (Json.mkObj [("cases", Json.arr cases), ("skipped", Json.arr skipped)]).compress
  IO.println s!"{cases.size} cases, {skipped.size} actions skipped → {out}"
  return 0

def main (args : List String) : IO UInt32 := do
  if args.head? == some "cases" then return ← casesMain args
  let some path := args.head? | IO.eprintln "usage: crosscheck <export.json> [--samples N] [--rows K] [--seed S] [--json out.json]
       crosscheck cases <export.json> --out cases.json [--only A] [--samples N]"; return 64
  let samples := argNat args "--samples" 2000
  let rows := argNat args "--rows" 3
  let seed := argNat args "--seed" 1
  let j ← IO.ofExcept (Json.parse (← IO.FS.readFile path))
  let sp := Spec.load j
  let results := jarr j "results"
  let mut pairs : Array Pair := #[]
  let mut g := mkStdGen seed
  let mut skipped : Array (String × String) := #[]
  let only := argStr args "--only"
  for act in sp.actions do
    if only.isSome && only != some (jstr act "name") then continue
    let writer := s!"action {jstr act "name"}"
    let (w, g') := searchWriter sp act samples rows g
    g := g'
    let mine := results.filter (jstr · "where" == writer)
    if args.contains "--verbose" then
      IO.println s!"{writer}: {w.valid} stores, {w.runs} runs: {w.ok} ended, {w.refused} refused, {w.unsupported} can't run{if w.why == "" then "" else s!" ({w.why})"}"
    if w.valid == 0 || w.unsupported * 2 > w.runs then
      skipped := skipped.push (writer, if w.valid == 0 then "no valid starting store found" else s!"can't run: {w.why}")
      continue
    for r in mine do
      let inv := jstr r "invariant"
      let z3 := jstr r "status"
      let found := w.breaks.lookup inv
      let p : Pair := match z3, found with
        | "proven", none => { inv, writer, z3, lean := s!"no break in {w.valid} stores ({w.ok} runs ended)", agree := true }
        | "proven", some ce => { inv, writer, z3, lean := "BREAKS IT", agree := false, detail := ce }
        | "broken", _ =>
          if jhas r "model" then
            let (ok, why) := replay sp act inv (jget r "model")
            { inv, writer, z3, lean := if ok then "replayed: breaks it" else "REPLAY FAILS", agree := ok,
              detail := s!"Z3: {jstr r "counterexample"} — {why}" ++ (match found with | some ce => s!" — search also found: {ce}" | none => "") }
          else { inv, writer, z3, lean := (if found.isSome then "breaks it" else "no break found"), agree := found.isSome, detail := jstr r "counterexample" }
        | _, some ce => { inv, writer, z3, lean := "breaks it", agree := true, detail := s!"Z3 unproven ({jstr r "reason"}); here: {ce}" }
        | _, none => { inv, writer, z3, lean := s!"no break in {w.valid} stores", agree := true, detail := jstr r "reason" }
      pairs := pairs.push p
  let dis := pairs.filter (!·.agree)
  IO.println s!"{pairs.size} pairs checked, {pairs.size - dis.size} agree, {dis.size} disagree; {skipped.size} writers skipped"
  for p in dis do IO.println s!"  DISAGREE {p.inv} × {p.writer}: Z3 {p.z3}, Lean {p.lean}\n    {p.detail}"
  for (wr, why) in skipped do IO.println s!"  skipped {wr}: {why}"
  if let some out := argStr args "--json" then
    let pj := pairs.map fun p => Json.mkObj [("invariant", p.inv), ("writer", p.writer), ("z3", p.z3), ("lean", p.lean), ("agree", p.agree), ("detail", p.detail)]
    let sj := skipped.map fun (w, why) => Json.mkObj [("writer", w), ("why", why)]
    IO.FS.writeFile out (Json.mkObj [("pairs", Json.arr pj), ("skipped", Json.arr sj)]).pretty
  return if dis.isEmpty then 0 else 1
