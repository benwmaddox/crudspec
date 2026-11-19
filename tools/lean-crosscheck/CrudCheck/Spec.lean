/-
The spec, as tools/lean-crosscheck/export.ts writes it: the parser's declarations as JSON, read
here into the few tables the interpreter looks things up in. Expressions and statements stay JSON:
the interpreter walks them by their "kind".
-/
import Lean.Data.Json
open Lean

namespace CrudCheck

def jget (j : Json) (k : String) : Json := j.getObjValD k
def jstr (j : Json) (k : String) : String := ((jget j k).getStr?).toOption.getD ""
def jarr (j : Json) (k : String) : Array Json := ((jget j k).getArr?).toOption.getD #[]
def jbool (j : Json) (k : String) : Bool := ((jget j k).getBool?).toOption.getD false
def jhas (j : Json) (k : String) : Bool := match j.getObjVal? k with
  | .ok Json.null => false
  | .ok _ => true
  | .error _ => false
def kindOf (j : Json) : String := jstr j "kind"

/-- What a field holds. ty: ref, enum, bool, num, text, opaque, set, other -/
structure FieldInfo where
  name : String
  ty : String
  target : String := ""
  optional : Bool := false
  onDelete : String := "restrict"
  default : Option Json := none
  /-- a Decimal's places (what a write keeps) -/
  places : Nat := 2
  deriving Inhabited

structure EntInfo where
  name : String
  singleton : Bool
  fields : Array FieldInfo
  uniques : Array (Array String)
  invs : Array Json
  deriving Inhabited

structure FnInfo where
  params : Array String
  body : Json
  pred : Bool
  deriving Inhabited

structure Spec where
  ents : Array EntInfo
  enums : Array (String × Array String)
  fns : Array (String × FnInfo)
  triggers : Array Json
  gates : Array Json
  identities : Array String
  actor : Option String
  /-- the cookie identity's entity, and its field that names the actor -/
  session : Option (String × String)
  invs : Array (String × Json)
  actions : Array Json
  /-- the identity a browser session signs in with (source cookie) -/
  cookieIdentity : Option String := none
  deriving Inhabited

def Spec.ent? (sp : Spec) (e : String) : Option EntInfo := sp.ents.find? (·.name == e)
def Spec.isEnt (sp : Spec) (e : String) : Bool := (sp.ent? e).isSome
def Spec.enumVals (sp : Spec) (n : String) : Array String := ((sp.enums.find? (·.1 == n)).map (·.2)).getD #[]
def Spec.isEnumVal (sp : Spec) (v : String) : Bool := sp.enums.any (·.2.contains v)
def Spec.isEnumName (sp : Spec) (n : String) : Bool := sp.enums.any (·.1 == n)
def Spec.fn? (sp : Spec) (n : String) : Option FnInfo := (sp.fns.find? (·.1 == n)).map (·.2)

def stamps : Array FieldInfo := #[{ name := "created", ty := "num" }, { name := "updated", ty := "num" }]

def Spec.field? (sp : Spec) (e f : String) : Option FieldInfo :=
  if f == "created" || f == "updated" then stamps.find? (·.name == f)
  else (sp.ent? e).bind fun d => d.fields.find? (·.name == f)

def fieldOfType (enums : Array (String × Array String)) (ents : Array String) (name : String) (t : Json) : FieldInfo :=
  let opt := jbool t "optional"
  match kindOf t with
  | "named" =>
    let n := jstr t "name"
    if ents.contains n then { name, ty := "ref", target := n, optional := opt }
    else if enums.any (·.1 == n) then { name, ty := "enum", target := n, optional := opt }
    else if n == "Bool" then { name, ty := "bool", optional := opt }
    else if n == "Decimal" then { name, ty := "dec", optional := opt, places := ((jget t "places").getNat?.toOption.getD 2) }
    else if ["Int", "Time", "Duration"].contains n then { name, ty := "num", optional := opt }
    else if ["Text", "Email", "Url", "Ip"].contains n then { name, ty := "text", optional := opt }
    else { name, ty := "opaque", optional := opt }
  | "set" => { name, ty := "set", target := jstr t "of" }
  | _ => { name, ty := "other" }

def Spec.load (j : Json) : Spec := Id.run do
  let decls := jarr j "decls"
  let of (k : String) := decls.filter (kindOf · == k)
  let enums := (of "enum").map fun d => (jstr d "name", ((jarr d "values").map fun v => (v.getStr?.toOption.getD "")))
  let entNames := (of "entity").map (jstr · "name")
  let ents := (of "entity").map fun d =>
    { name := jstr d "name", singleton := jbool d "singleton"
      fields := (jarr d "fields").map fun f =>
        let fi := fieldOfType enums entNames (jstr f "name") (jget f "type")
        { fi with onDelete := (if jhas f "onDelete" then jstr f "onDelete" else "restrict"),
                  default := if jhas f "default" then some (jget f "default") else none }
      uniques := (jarr d "uniques").map fun u => (u.getArr?.toOption.getD #[]).map (·.getStr?.toOption.getD "")
      invs := jarr d "invariants" : EntInfo }
  let fns := (of "fn" ++ of "predicate").map fun d =>
    (jstr d "name", { params := (jarr d "params").map (jstr · "name"), body := jget d "body", pred := kindOf d == "predicate" : FnInfo })
  let app := (of "app")[0]?
  let actor := app.bind fun a => let n := jstr (jget (jget a "props") "actor") "name"; if n == "" then none else some n
  let cookie := (of "identity").find? (jstr · "source" == "cookie")
  let session := match cookie, actor with
    | some c, some a =>
      let e := jstr c "entity"
      match (ents.find? (·.name == e)).bind (fun d => d.fields.find? (fun f => f.ty == "ref" && f.target == a)) with
      | some f => some (e, f.name)
      | none => none
    | _, _ => none
  return { ents, enums, fns, triggers := of "trigger", gates := of "gate"
           identities := (of "identity").map (jstr · "name"), actor, session
           cookieIdentity := cookie.map (jstr · "name")
           invs := (of "invariant").map fun d => (jstr d "name", jget d "cond")
           actions := of "action" }

end CrudCheck
