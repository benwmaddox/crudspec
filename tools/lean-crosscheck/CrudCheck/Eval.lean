/-
A plain interpreter for crudspec actions over a small in-memory store, written from what the
Go runtime does (lang/gogen/rt), not from the Z3 encoding (lang/invariants.ts). Where the two
could differ, this file follows the runtime:
- `the(E where …)` refuses unless exactly one row matches; `the_or_none` is none unless exactly
  one matches; `first_or_none` is any matching row (the order is a choice).
- a write a reference, a unique key or an entity invariant forbids refuses the whole action;
  a delete follows `on delete cascade` and is refused by `restrict`.
- what the interpreter can't compute (the request, a text function, a Go call) is a choice: an
  oracle supplies it, and the search tries every way the oracle can choose.
-/
import CrudCheck.Spec
open Lean

namespace CrudCheck

inductive Val where
  | none
  | bool (b : Bool)
  | int (i : Int)
  | enum (v : String)
  | text (s : String)
  | other (k : String)
  | row (e : String) (id : Nat)
  | list (vs : List Val)
  | rows (e : String) (ids : List Nat)
  | unk
  /-- a Decimal: its value × 10^6, as the runtime stores it -/
  | dec (n : Int)
  deriving BEq, Repr, Inhabited

/-- a Decimal (× 10^6) with its 6 places: 12.500000 -/
def decText (n : Int) : String :=
  let neg := n < 0
  let a := if neg then -n else n
  let frac := toString (a % 1000000)
  (if neg then "-" else "") ++ toString (a / 1000000) ++ "." ++ String.mk (List.replicate (6 - frac.length) '0') ++ frac

partial def Val.show : Val → String
  | .none => "none" | .bool b => toString b | .int i => toString i | .enum v => v
  | .text s => s!"\"{s}\"" | .other k => s!"<{k}>" | .row e id => s!"{e}#{id}"
  | .list vs => "[" ++ ", ".intercalate (vs.map Val.show) ++ "]"
  | .rows e ids => "{" ++ ", ".intercalate (ids.map fun i => s!"{e}#{i}") ++ "}"
  | .unk => "?"
  | .dec n => decText n

structure Row where
  id : Nat
  vals : List (String × Val)
  deriving Inhabited, Repr

def Row.get (r : Row) (f : String) : Val := (r.vals.lookup f).getD .none
def Row.set (r : Row) (f : String) (v : Val) : Row := { r with vals := (f, v) :: r.vals.filter (·.1 != f) }

structure Store where
  tabs : List (String × List Row) := []
  next : Nat := 1
  /-- the highest id each entity has used (a deleted row's id isn't used again, as in SQLite's
  AUTOINCREMENT): a new row's id is one more than the highest, per entity -/
  high : List (String × Nat) := []
  deriving Inhabited, Repr

def Store.rows (s : Store) (e : String) : List Row := (s.tabs.lookup e).getD []
def Store.setRows (s : Store) (e : String) (rs : List Row) : Store := { s with tabs := (e, rs) :: s.tabs.filter (·.1 != e) }
def Store.get? (s : Store) (e : String) (id : Nat) : Option Row := (s.rows e).find? (·.id == id)
def Store.has (s : Store) (e : String) (id : Nat) : Bool := (s.get? e id).isSome
def Store.highOf (s : Store) (e : String) : Nat :=
  max ((s.high.lookup e).getD 0) ((s.rows e).foldl (fun m r => max m r.id) 0)
def Store.noteHigh (s : Store) (e : String) : Store := { s with high := (e, s.highOf e) :: s.high.filter (·.1 != e) }
def Store.update (s : Store) (e : String) (r : Row) : Store := s.setRows e ((s.rows e).map fun x => if x.id == r.id then r else x)

inductive Stop where
  | refused (why : String)
  | unsupported (what : String)
  deriving Inhabited

structure IS where
  store : Store
  oracle : Array Nat := #[]
  pos : Nat := 0
  /-- the size of each choice made, in order: the search moves through these -/
  sizes : Array Nat := #[]
  fresh : Nat := 0
  /-- checking what holds of a store: a value the interpreter can't compute is taken as holding -/
  lenient : Bool := false
  /-- whether a check met such a value -/
  metUnk : Bool := false
  /-- differential mode: a text, number or file the interpreter can't compute stays unknown (it
  matches whatever the compiled app stored) instead of being chosen from a small domain -/
  wild : Bool := false

/-- failure keeps the state: a refused run still says which choices it made -/
abbrev M := ExceptT Stop (StateM IS)

def refuse (why : String) : M α := throw (.refused why)
def unsup (what : String) : M α := throw (.unsupported what)
def store : M Store := return (← get).store
def setStore (s : Store) : M Unit := modify fun st => { st with store := s }

/-- one of n ways (n > 0), from the oracle -/
def choose (n : Nat) : M Nat := do
  let st ← get
  let v := if h : st.pos < st.oracle.size then st.oracle[st.pos] % n else 0
  set { st with pos := st.pos + 1, sizes := st.sizes.push n }
  return v

def chooseFrom (vs : List Val) : M Val := do
  if vs.isEmpty then refuse "no value to choose" else
  let i ← choose vs.length
  return vs[i]!

def ints : List Int := [0, 1, 100000]
def texts : List String := ["", "a", "b"]

def domainOf (sp : Spec) (fi : FieldInfo) (s : Store) : List Val :=
  let base : List Val := match fi.ty with
    | "bool" => [.bool false, .bool true]
    | "enum" => (sp.enumVals fi.target).toList.map .enum
    | "ref" => (s.rows fi.target).map fun r => .row fi.target r.id
    | "num" => ints.map .int
    | "dec" => ([0, 1, 250, 1999, 100000] : List Int).map fun c => .dec (c * 10000)   -- 0, 0.01, 2.50, 19.99, 1000.00
    | "text" => (match fi.format with
      | "Email" => ["a@x.io", "b@x.io"]
      | "Url" => ["https://a.io", "https://b.io"]
      | "Ip" => ["10.0.0.1", "10.0.0.2"]
      | _ => texts).map .text
    | _ => [.other "f"]
  if fi.optional then .none :: base else base

-- ---- Decimals: × 10^6, as the runtime (rt/decimal.go) keeps them

def decScale : Int := 1000000

/-- a number on the Decimal scale: an Int × 10^6 -/
def decOf : Val → Int
  | .dec n => n
  | .int i => i * decScale
  | _ => 0

-- ---- the calendar, on day numbers (days since 1970-01-01), as the Go runtime's rt/date.go

/-- the day number of a year, month and day (Howard Hinnant's days_from_civil) -/
def daysFromCivil (y0 m d : Int) : Int :=
  let y := if m ≤ 2 then y0 - 1 else y0
  let era := y / 400   -- toward negative infinity
  let yoe := y - era * 400
  let doy := (153 * (if m > 2 then m - 3 else m + 9) + 2) / 5 + d - 1
  let doe := yoe * 365 + yoe / 4 - yoe / 100 + doy
  era * 146097 + doe - 719468

/-- the year, month and day of a day number (civil_from_days) -/
def civilFromDays (z0 : Int) : Int × Int × Int :=
  let z := z0 + 719468
  let era := z / 146097
  let doe := z - era * 146097
  let yoe := (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365
  let doy := doe - (365 * yoe + yoe / 4 - yoe / 100)
  let mp := (5 * doy + 2) / 153
  let d := doy - (153 * mp + 2) / 5 + 1
  let m := if mp < 10 then mp + 3 else mp - 9
  (if m ≤ 2 then yoe + era * 400 + 1 else yoe + era * 400, m, d)

def daysInMonth (y m : Int) : Int :=
  if m == 2 then (if (y % 4 == 0 && y % 100 != 0) || y % 400 == 0 then 29 else 28)
  else if [4, 6, 9, 11].contains m then 30 else 31

/-- n months on, the day clamped to the month's last (Jan 31 + 1 month: Feb 28 or 29) -/
def addMonths (d : Int) (n : Int) : Int :=
  let (y, m, dd) := civilFromDays d
  let total := y * 12 + (m - 1) + n
  let ny := total / 12
  let nm := total % 12 + 1
  daysFromCivil ny nm (min dd (daysInMonth ny nm))

/-- whole months from a to b, as relativedelta counts them -/
def monthsBetween (a b : Int) : Int :=
  let go (a b : Int) : Int :=
    let (ay, am, _) := civilFromDays a
    let (by_, bm, _) := civilFromDays b
    let n := (by_ - ay) * 12 + (bm - am)
    if addMonths a n > b then n - 1 else n
  if b < a then -(go b a) else go a b

/-- division toward zero (Go's) -/
def tdiv (a b : Int) : Int := if a < 0 then -((-a) / b) else a / b

/-- x / y rounded half to even (y ≠ 0) -/
def divHalfEven (x y : Int) : Int :=
  let q := x / y   -- Lean's / rounds toward negative infinity for Int (Euclidean on y > 0)
  let r := x - q * y
  let ay := if y < 0 then -y else y
  let r' := if y < 0 then -r else r   -- 0 ≤ r' < |y|
  if 2 * r' > ay || (2 * r' == ay && q % 2 != 0) then (if y < 0 then q - 1 else q + 1) else q

/-- n rounded half to even to the given places, still × 10^6 -/
def roundPlaces (n : Int) (places : Nat) : Int :=
  if places ≥ 6 then n else
  let unit : Int := (10 : Int) ^ (6 - places)
  divHalfEven n unit * unit

def decOp (op : String) (a b : Int) : M Val := do
  match op with
  | "+" => return .dec (a + b)
  | "-" => return .dec (a - b)
  | "*" => return .dec (divHalfEven (a * b) decScale)
  | "/" => if b == 0 then refuse "division by zero" else return .dec (divHalfEven (a * decScale) b)
  | "%" => if b == 0 then refuse "division by zero" else return .dec (Int.tmod a b)
  | "<" => return .bool (a < b)
  | "<=" => return .bool (a ≤ b)
  | ">" => return .bool (a > b)
  | ">=" => return .bool (a ≥ b)
  | _ => return .unk

/-- a Decimal literal's text (12.50) on the scale, past 6 places half to even -/
def parseDec (s : String) : Int :=
  let neg := s.startsWith "-"
  let body := if neg then (s.drop 1).toString else s
  let parts := body.splitOn "."
  let w := (parts.headD "0").toInt?.getD 0
  let f := parts.getD 1 ""
  let f6 := ((f ++ "000000").take 6).toString
  let n := w * decScale + (if f6 == "" then 0 else f6.toInt?.getD 0)
  let rest := (f.drop 6).toString
  let n := if rest == "" then n else
    let half := "5" ++ String.mk (List.replicate (rest.length - 1) '0')
    if rest > half || (rest == half && n % 2 != 0) then n + 1 else n
  if neg then -n else n

def asBool (v : Val) : M Bool := do
  match v with
  | .bool b => return b
  | .none => return false
  | .unk =>
    if (← get).lenient then modify (fun st => { st with metUnk := true }); return true
    return (← choose 2) == 1
  | _ => unsup s!"a condition that isn't a Bool ({v.show})"

def eqV (a b : Val) : M Bool := do
  if a == .unk || b == .unk then
    if (← get).lenient then modify (fun st => { st with metUnk := true }); return true
    return (← choose 2) == 1
  -- an Int beside a Decimal is equal by value (3 == 3.00)
  match a, b with
  | .dec m, .int i => return m == i * 1000000
  | .int i, .dec m => return m == i * 1000000
  | _, _ => return a == b

structure Env where
  vars : List (String × Val) := []
  row : Option (String × Nat) := none
  old : Option Store := none
  depth : Nat := 0

def Env.bind (env : Env) (n : String) (v : Val) : Env := { env with vars := (n, v) :: env.vars }

def readField (sp : Spec) (s : Store) (e : String) (id : Nat) (f : String) : M Val := do
  if f == "id" then return .int id
  if (sp.field? e f).isNone then unsup s!"the field {e}.{f}"
  match s.get? e id with
  | some r => return r.get f
  | none => return .none

def durMs (unit : String) : Int := match unit with
  | "ms" => 1 | "s" => 1000 | "min" => 60000 | "h" => 3600000 | "day" => 86400000 | _ => 1

def outsideNames : List String := ["request", "query", "client", "input", "typed", "theme", "app"]

mutual

partial def matching (sp : Spec) (env : Env) (q : Json) : M (List Nat) := do
  let e := jstr q "entity"
  if !sp.isEnt e then unsup s!"rows of {e}"
  let s ← store
  let mut out := []
  for r in s.rows e do
    let ok ← if jhas q "where" then do asBool (← eval sp { env with row := some (e, r.id) } (jget q "where")) else pure true
    if ok then out := out ++ [r.id]
  return out

partial def eval (sp : Spec) (env : Env) (x : Json) : M Val := do
  match kindOf x with
  | "lit" =>
    match jget x "value" with
    | .null => return .none
    | .bool b => return .bool b
    | .str s => return if sp.isEnumVal s then .enum s else .text s
    | v => match v.getInt? with
      | .ok i => return .int i
      | .error _ => unsup "a literal"
  | "decimal" => return .dec (parseDec (jstr x "text"))
  | "duration" => return .int (((jget x "amount").getInt?.toOption.getD 0) * durMs (jstr x "unit"))
  | "now" => return (env.vars.lookup "now").getD .unk
  | "it" => match env.row with
    | some (e, id) => return .row e id
    | none => unsup "it outside a query"
  | "rowfield" => match env.row with
    | some (e, id) => readField sp (← store) e id (jstr x "name")
    | none => unsup ".field outside a query"
  | "name" =>
    let n := jstr x "name"
    match env.vars.lookup n with
    | some v => return v
    | none =>
      if outsideNames.contains n || sp.identities.contains n then return .unk
      if n == "get" || n == "write" then return .text n
      if sp.isEnumVal n then return .enum n
      if let some d := sp.ent? n then
        if d.singleton then
          return match (← store).rows n with
            | r :: _ => .row n r.id
            | [] => .none
      if let some (e, id) := env.row then
        if (sp.field? e n).isSome then return ← readField sp (← store) e id n
      unsup s!"the name {n}"
  | "field" =>
    let t := jget x "target"
    let f := jstr x "name"
    if kindOf t == "name" && sp.isEnumName (jstr t "name") && (env.vars.lookup (jstr t "name")).isNone then return .enum f
    if kindOf t == "name" && jstr t "name" == "request" then
      if let some v := env.vars.lookup ("request." ++ f) then return v
    if kindOf t == "name" && jstr t "name" == "old" then
      if let some old := env.old then
        if let some (.row e id) := env.vars.lookup "old" then return ← readField sp old e id f
    match ← eval sp env t with
    | .row e id => readField sp (← store) e id f
    | .none => return .none
    | _ => return .unk
  | "unary" =>
    let a ← eval sp env (jget x "arg")
    if jstr x "op" == "not" then return .bool !(← asBool a)
    match a with
    | .int i => return .int (-i)
    | _ => return .unk
  | "binary" =>
    let op := jstr x "op"
    if op == "and" then
      if !(← asBool (← eval sp env (jget x "left"))) then return .bool false
      return .bool (← asBool (← eval sp env (jget x "right")))
    if op == "or" then
      if ← asBool (← eval sp env (jget x "left")) then return .bool true
      return .bool (← asBool (← eval sp env (jget x "right")))
    if op == "implies" then
      if !(← asBool (← eval sp env (jget x "left"))) then return .bool true
      return .bool (← asBool (← eval sp env (jget x "right")))
    let a ← eval sp env (jget x "left")
    let b ← eval sp env (jget x "right")
    if op == "in" then
      match b with
      | .list vs => do
        for v in vs do if ← eqV a v then return .bool true
        return .bool false
      | .rows e ids => match a with
        | .row e2 id => return .bool (e == e2 && ids.contains id)
        | .none => return .bool false
        | _ => return .bool ((← choose 2) == 1)
      | _ => return .bool ((← choose 2) == 1)
    if op == "==" then return .bool (← eqV a b)
    if op == "!=" then return .bool !(← eqV a b)
    match op, a, b with
    | "+", .rows e xs, .rows _ ys => return .rows e (xs ++ ys.filter (!xs.contains ·))
    | "+", .rows e xs, .row _ y => return .rows e (if xs.contains y then xs else xs ++ [y])
    | "<", .int i, .int j => return .bool (i < j)
    | "<=", .int i, .int j => return .bool (i ≤ j)
    | ">", .int i, .int j => return .bool (i > j)
    | ">=", .int i, .int j => return .bool (i ≥ j)
    | "+", .int i, .int j => return .int (i + j)
    | "-", .int i, .int j => return .int (i - j)
    | "*", .int i, .int j => return .int (i * j)
    | "/", .int i, .int j => return .int (if j == 0 then 0 else Int.tdiv i j)   -- toward zero; / 0 is 0
    | "%", .int i, .int j => return .int (if j == 0 then 0 else Int.tmod i j)
    -- a Decimal, and an Int or a Decimal: exact, × 10^6; a product or quotient rounded half-even
    | _, .dec _, .int _ | _, .int _, .dec _ | _, .dec _, .dec _ => decOp op (decOf a) (decOf b)
    | _, .none, _ => return if ["<", "<=", ">", ">="].contains op then .bool false else .none
    | _, _, .none => return if ["<", "<=", ">", ">="].contains op then .bool false else .none
    | _, _, _ => if ["<", "<=", ">", ">="].contains op then return .bool ((← choose 2) == 1) else return .unk
  | "if" =>
    if ← asBool (← eval sp env (jget x "cond")) then eval sp env (jget x "then") else eval sp env (jget x "else")
  | "listlit" | "setlit" => return .list ((← (jarr x "items").toList.mapM (eval sp env)))
  | "query" =>
    let op := jstr x "op"
    let e := jstr x "entity"
    if !["exists", "set", "the", "the_or_none", "first_or_none", "count"].contains op then return .unk
    let ids ← matching sp env x
    match op with
    | "exists" => return .bool !ids.isEmpty
    | "set" => return .rows e ids
    | "count" => return .int ids.length
    | "the" => match ids with
      | [id] => return .row e id
      | _ => refuse s!"the({e} …) matched {ids.length} rows"
    | "the_or_none" => match ids with
      | [id] => return .row e id
      | _ => return .none
    | _ => if ids.isEmpty then return .none else return .row e ids[← choose ids.length]!
  | "all" =>
    let e := jstr x "entity"
    for id in ← matching sp env x do
      if !(← asBool (← eval sp { env with row := some (e, id) } (jget x "cond"))) then return .bool false
    return .bool true
  | "call" =>
    let n := jstr x "name"
    let args := jarr x "args"
    if let some f := sp.fn? n then
      if env.depth > 8 then unsup s!"{n} calls too deep"
      let mut inner : Env := { env with row := none, depth := env.depth + 1 }
      for i in [:f.params.size] do
        let p := f.params[i]!
        let a := if h : i < args.size then args[i] else (match (jget x "named").getObjVal? p with | .ok v => v | .error _ => Json.mkObj [("kind", "lit"), ("value", Json.null)])
        inner := inner.bind p (← eval sp env a)
      let v ← eval sp inner f.body
      if f.pred then return .bool (← asBool v) else return v
    if n == "token" then
      modify fun st => { st with fresh := st.fresh + 1 }
      return .other s!"token{(← get).fresh}"
    if n == "set" then
      let vs ← args.toList.mapM (eval sp env)
      match vs with
      | .row e _ :: _ => return .rows e (vs.filterMap fun v => match v with | .row _ id => some id | _ => none)
      | _ => return .unk
    -- trim, exactly (Go's strings.TrimSpace; the same on the search's texts): left unknown, each
    -- use would be chosen apart, and present(trim(t)) could hold while the stored trim(t) is ""
    if n == "trim" && args.size == 1 then
      match ← eval sp env args[0]! with
      | .text s => return .text ((s.toList.dropWhile Char.isWhitespace).reverse.dropWhile Char.isWhitespace).reverse.asString
      | .none => return .none
      | _ => return .unk
    -- in_app(x): x (worked out in the app rather than the database: the same value)
    if n == "in_app" && args.size == 1 then
      return (← eval sp env args[0]!)
    -- default(x, fallback): x, or the fallback when x is none
    if n == "default" && args.size == 2 then
      match ← eval sp env args[0]! with
      | .none => return (← eval sp env args[1]!)
      | .unk => return .unk
      | v => return v
    -- an Int as a Decimal, exactly (the conversions to an Email, Url or Ip stay unknown)
    if n == "to_decimal" && args.size == 1 then
      match ← eval sp env args[0]! with
      | .int i => return .dec (i * decScale)
      | .none => return .none
      | _ => return .unk
    if n == "present" || n == "blank" then
      let a ← eval sp env args[0]!
      let p ← match a with
        | .none => pure false
        | .text s => pure (s != "")
        | .unk => pure ((← choose 2) == 1)
        | _ => pure true
      return .bool (if n == "present" then p else !p)
    -- numbers: round (half to even; to places: a Decimal), floor, ceil, abs, max, min
    if ["round", "floor", "ceil", "abs"].contains n && args.size ≥ 1 then
      match ← eval sp env args[0]! with
      | .none => return .none
      | .int i => return (if n == "abs" then .int (if i < 0 then -i else i) else .int i)
      | .dec d =>
        if n == "abs" then return .dec (if d < 0 then -d else d)
        if n == "floor" then return .int (d / decScale)   -- toward negative infinity
        if n == "ceil" then return .int (-((-d) / decScale))
        if args.size > 1 then
          match ← eval sp env args[1]! with
          | .int p => return .dec (roundPlaces d p.toNat)
          | _ => return .unk
        return .int (divHalfEven d decScale)
      | _ => return .unk
    if (n == "max" || n == "min") && args.size == 2 then
      let a ← eval sp env args[0]!
      let b ← eval sp env args[1]!
      match a, b with
      | .int i, .int j => return .int (if (n == "max") == (i ≥ j) then i else j)
      | .dec _, _ | _, .dec _ =>
        if a == .none || b == .none || a == .unk || b == .unk then return .unk
        return .dec (if (n == "max") == (decOf a ≥ decOf b) then decOf a else decOf b)
      | _, _ => return .unk
    -- the calendar: a Date is its day number; today is the day in UTC (the Go diff runs the app in
    -- UTC; a replay of a Z3 model takes the day Z3 picked)
    if n == "today" && args.size == 0 then
      match env.vars.lookup "today" with
      | some t => return t
      | none => match env.vars.lookup "now" with
        | some (.int t) => return .int (t / 86400000)
        | _ => return .unk
    let dateFns := ["date", "year", "month", "day", "weekday", "add_days", "add_months", "add_years",
      "days_between", "months_between", "years_between", "start_of_month", "end_of_month"]
    if dateFns.contains n then
      let vs ← args.toList.mapM (eval sp env ·)
      if vs.any (· == .none) then return .none
      let is := vs.filterMap fun v => match v with | .int i => some i | _ => none
      if is.length != vs.length then return .unk
      let a := is.headD 0
      let b := is.getD 1 0
      -- a date is years 1 to 9999 (written YYYY-MM-DD): a step past them refuses, as the runtime
      let inRange (d : Int) : M Val := if d < -719162 || d > 2932896 then refuse "date out of range" else pure (.int d)
      match n with
      | "date" =>
        let c := is.getD 2 0
        if a < 1 || a > 9999 then refuse "date out of range"
        if b < 1 || b > 12 || c < 1 || c > daysInMonth a b then refuse s!"no such date: {a}-{b}-{c}"
        return .int (daysFromCivil a b c)
      | "year" => return .int (civilFromDays a).1
      | "month" => return .int (civilFromDays a).2.1
      | "day" => return .int (civilFromDays a).2.2
      | "weekday" => return .int ((a + 3) % 7 + 1)   -- 1970-01-01 was a Thursday (4)
      | "add_days" => return (← inRange (a + b))
      | "add_months" => if b > 120000 || b < -120000 then refuse "date out of range" else return (← inRange (addMonths a b))
      | "add_years" => if b > 10000 || b < -10000 then refuse "date out of range" else return (← inRange (addMonths a (12 * b)))
      | "days_between" => return .int (b - a)
      | "months_between" => return .int (monthsBetween a b)
      | "years_between" => return .int (tdiv (monthsBetween a b) 12)
      | "start_of_month" => let (y, m, _) := civilFromDays a; return .int (daysFromCivil y m 1)
      | "end_of_month" => let (y, m, _) := civilFromDays a; return .int (daysFromCivil y m (daysInMonth y m))
      | _ => return .unk
    if n == "distinct" && args.size == 1 then
      match ← eval sp env args[0]! with
      | .list vs => return .list (vs.foldl (fun acc v => if acc.contains v then acc else acc ++ [v]) [])
      | _ => return .unk
    return .unk
  | "listq" =>
    -- a list of rows' values, in id order (an order or a limit: which rows, or in what order, is
    -- left to the runtime, so the list is unknown)
    if jhas x "limit" || jhas x "order" then return .unk
    let e := jstr x "entity"
    let ids ← matching sp env x
    return .list (← ids.mapM fun id => if jhas x "map" then eval sp { env with row := some (e, id) } (jget x "map") else pure (.row e id))
  | "extern" => return .unk
  | k => unsup s!"a {k} expression"

end

def checkWrite (fi : FieldInfo) (v : Val) : M Unit := do
  if !fi.optional && v == .none then refuse s!"{fi.name} set to none"

/-- a value for a field: computed, or (when the interpreter can't) any value the field can hold -/
def settle (sp : Spec) (fi : FieldInfo) (v : Val) : M Val := do
  -- a Decimal field keeps its places (half to even), as the runtime writes it
  if fi.ty == "dec" then
    match v with
    | .int i => return .dec (i * decScale)
    | .dec n => return .dec (roundPlaces n fi.places)
    | _ => pure ()
  if v != .unk then return v
  if (← get).wild && !["enum", "bool", "ref"].contains fi.ty then return .unk
  chooseFrom (domainOf sp fi (← store))

mutual

partial def runTriggers (sp : Spec) (env : Env) (kind e field : String) (subject : Val) (old : Option Store) : M Unit := do
  for t in sp.triggers do
    let on := jget t "on"
    if jstr on "kind" != kind || jstr on "entity" != e then continue
    if kind == "update" && jstr on "field" != field then continue
    if env.depth > 6 then unsup "triggers too deep"
    let mut tenv : Env := { env with depth := env.depth + 1, old := old }
    tenv := tenv.bind (jstr t "bind") subject
    if old.isSome then tenv := tenv.bind "old" subject
    if jhas t "when" then
      if !(← asBool (← eval sp tenv (jget t "when"))) then continue
    discard <| exec sp tenv (jarr t "body").toList

partial def deleteRows (sp : Spec) (env : Env) (e : String) (ids : List Nat) : M Unit := do
  if ids.isEmpty then return
  let s := (← store).noteHigh e
  let gone := (s.rows e).filter (ids.contains ·.id)
  setStore (s.setRows e ((s.rows e).filter (!ids.contains ·.id)))
  for d in sp.ents do
    for f in d.fields do
      if f.ty != "ref" || f.target != e then continue
      let refs := ((← store).rows d.name).filter fun r => match r.get f.name with
        | .row _ id => ids.contains id
        | _ => false
      if refs.isEmpty then continue
      if f.onDelete == "cascade" then deleteRows sp env d.name (refs.map (·.id))
      else if f.onDelete == "restrict" then refuse s!"{d.name}.{f.name} restricts the delete of {e}"
      else unsup s!"on delete {f.onDelete}"
  for r in gone do runTriggers sp env "delete" e "" (.row e r.id) none

partial def create (sp : Spec) (env : Env) (s : Json) : M Env := do
  let e := jstr s "entity"
  let some d := sp.ent? e | unsup s!"create {e}"
  let given := jarr s "fields"
  let givenVal (f : String) : Option Json := (given.find? (jstr · "name" == f)).map (jget · "value")
  if jbool s "ensure" then
    -- ensure: a row with the given values is there already, or it is made
    let mut want : List (String × Val) := []
    for g in given do want := want ++ [(jstr g "name", ← eval sp env (jget g "value"))]
    for r in (← store).rows e do
      let mut same := true
      for (f, v) in want do if !(← eqV (r.get f) v) then same := false
      if same then
        return if jhas s "as" then env.bind (jstr s "as") (.row e r.id) else env
  let mut vals : List (String × Val) := []
  for fi in d.fields do
    if fi.ty == "other" || fi.ty == "set" then continue
    let v ← match givenVal fi.name, fi.default with
      | some x, _ => do settle sp fi (← eval sp env x)
      | none, some dx => do
        let v ← tryCatch (eval sp env dx) (fun stop => match stop with
          | .unsupported _ => pure .unk
          | other => throw other)
        settle sp fi v
      | none, none => if fi.optional then pure .none else settle sp fi .unk
    checkWrite fi v
    vals := vals ++ [(fi.name, v)]
  let now := (env.vars.lookup "now").getD (.int 0)
  let st ← store
  let id := st.highOf e + 1
  let row : Row := { id, vals := vals ++ [("created", now), ("updated", now)] }
  setStore { (st.setRows e (st.rows e ++ [row])) with next := id + 1, high := (e, id) :: st.high.filter (·.1 != e) }
  let env' := if jhas s "as" then env.bind (jstr s "as") (.row e id) else env
  runTriggers sp env "create" e "" (.row e id) none
  return env'

partial def exec (sp : Spec) (env : Env) : List Json → M Env
  | [] => return env
  | s :: rest => do
    let env' ← execOne sp env s
    exec sp env' rest

partial def execOne (sp : Spec) (env : Env) (s : Json) : M Env := do
  match kindOf s with
  | "require" =>
    if !(← asBool (← eval sp env (jget s "cond"))) then refuse "require"
    return env
  | "reject" => refuse "reject"
  | "rate_limit" | "emit" | "sendmail" | "result" | "touch" | "callstmt" => return env
  | "let" => return env.bind (jstr s "name") (← eval sp env (jget s "value"))
  | "if" =>
    if ← asBool (← eval sp env (jget s "cond")) then discard <| exec sp env (jarr s "then").toList
    else discard <| exec sp env (jarr s "else").toList
    return env
  | "create" => create sp env s
  | "set" =>
    match ← eval sp env (jget s "target") with
    | .row e id =>
      let f := jstr s "name"
      let some fi := sp.field? e f | unsup s!"set {e}.{f}"
      let v ← settle sp fi (← eval sp env (jget s "value"))
      checkWrite fi v
      let before ← store
      let some r := before.get? e id | refuse "set on a row that isn't there"
      setStore (before.update e (r.set f v))
      -- an update trigger runs when the value changes (as the runtime's SET_…: rt.Equal(before, v))
      let old := r.get f
      let changed ← if old == .unk || v == .unk then pure ((← choose 2) == 1) else pure (old != v)
      if changed then runTriggers sp env "update" e f (.row e id) (some before)
      return env
    | .none => refuse "set on none"
    | _ => unsup "set on a value that isn't a row"
  | "delete" =>
    match ← eval sp env (jget s "target") with
    | .row e id => deleteRows sp env e [id]; return env
    | .none => refuse "delete of none"
    | _ => unsup "delete of a value that isn't a row"
  | "deleteWhere" =>
    deleteRows sp env (jstr s "entity") (← matching sp env s)
    return env
  | "foreach" =>
    let e := jstr s "entity"
    for id in ← matching sp env s do
      discard <| exec sp (env.bind (jstr s "bind") (.row e id)) (jarr s "body").toList
    return env
  | "foreachList" =>
    match ← eval sp env (jget s "over") with
    | .list vs => for v in vs do discard <| exec sp (env.bind (jstr s "bind") v) (jarr s "body").toList
    | .rows e ids => for id in ids do discard <| exec sp (env.bind (jstr s "bind") (.row e id)) (jarr s "body").toList
    | _ => unsup "a loop over a list the interpreter can't compute"
    return env
  | k => unsup s!"a {k} statement"

end

/-- whether a store is one the app can hold: references name rows that exist, unique keys, entity
invariants (lenient: a value the interpreter can't compute is taken as holding) -/
def wellFormed (sp : Spec) (now : Val) : M (Option String) := do
  let s ← store
  for d in sp.ents do
    let rs := s.rows d.name
    if d.singleton && rs.length > 1 then return some s!"two {d.name} rows"
    for r in rs do
      for f in d.fields do
        match r.get f.name with
        | .row e id => if !s.has e id then return some s!"{d.name}#{r.id}.{f.name} names {e}#{id}, which isn't there"
        | .none => if !f.optional && f.ty != "set" && f.ty != "other" then return some s!"{d.name}#{r.id}.{f.name} is none"
        | _ => pure ()
      for inv in d.invs do
        let env : Env := { vars := [("self", .row d.name r.id), ("now", now)] }
        if !(← asBool (← eval sp env inv)) then return some s!"{d.name}#{r.id} breaks its entity invariant"
    for u in d.uniques do
      for r in rs do
        for r2 in rs do
          if r.id < r2.id && u.all (fun f => r.get f != .none && r.get f == r2.get f) then
            return some s!"{d.name}#{r.id} and #{r2.id} share the unique key ({", ".intercalate u.toList})"
  return none

def invHolds (sp : Spec) (now : Val) (cond : Json) : M Bool := do
  asBool (← eval sp { vars := [("now", now)] } cond)

end CrudCheck
