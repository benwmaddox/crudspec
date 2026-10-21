// The Go backend: compiles a spec to a Go program against the runtime in lang/gogen/rt.
// Expressions, statements and queries become Go code; each query's `where` is planned as SQL
// here, once, with the rules the TypeScript runtime's planner had (the same rows as the
// rows); the UI becomes element trees with compiled expressions, which rt renders as
// the TypeScript runtime did. Nothing here is app-specific.
//
//   node lang/gogen/gen.ts <spec.crud> --out <dir> [--widgets <widgets.go>]
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync, rmSync, mkdtempSync } from "node:fs";
import { join, dirname, relative, resolve, basename } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { parse, VOID, type Decl, type El, type Expr, type Stmt, type Spec } from "../parser.ts";
// the HTML attributes that hold an address: a value is kept to safe schemes
const URL_ATTRS = new Set(["href", "src", "action", "formaction", "poster", "srcset", "cite", "data"]);
import { withGenerated } from "../scaffold.ts";
import { schemaOf, schemaHash } from "../schema.ts";
import { upgrade } from "../runtime/upgrade.ts";
import { describe } from "../describe.ts";
import { at, readSource, readSpec } from "../source.ts";
import { explainer } from "../explain.ts";
import { liveKeys, liveKeysText } from "./livekeys.ts";
import { typecheck, type Ty } from "../types.ts";
import { fieldSize, paramSizes } from "../sizes.ts";
import * as cost from "../cost.ts";

class GenError extends Error {}
const q = (s: string) => JSON.stringify(s);
const TEXTLIKE = new Set(["Text", "Email", "Url", "Ip"]);
// SQL constants a request's shape folds to, and an expression's identity (no positions)
const TRUE_SQL = "(1 = 1)", FALSE_SQL = "(1 = 0)";
const canonE = (x: any) => JSON.stringify(x, (k, v) => (k === "pos" ? undefined : v));
const UNIT_MS: Record<string, number> = { ms: 1, s: 1000, min: 60000, h: 3600000, day: 86400000 };
const snake = (s: string) => s.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();
const ident = (s: string) => s.replace(/[^A-Za-z0-9_]/g, "_");

// ---- the compile scope of an expression
type CS = {
  locals: Map<string, string>;   // names bound to Go code (function parameters, inlined arguments)
  dyn: Set<string>;              // names that may be variables at run time (c.Vars, ambient)
  dynAll?: boolean;              // any unknown name may be a variable
  row?: string;                  // the entity of the row in context (where, order, defaults, …)
  wf?: boolean;                  // a workflow step: extern calls run
  types?: Map<string, string>;   // names known to hold a row of an entity ("" when it varies)
  tlocals?: Map<string, { c: string; g: string }>;   // names bound to typed Go variables
  typable?: Set<string>;         // top-level lets bound once: a typed Go variable when their type is known
};
const scope = (o: Partial<CS> = {}): CS => ({ locals: new Map(), dyn: new Set(), ...o });

// the last generate()'s query costs (lang/cost.ts): each query's plan, and the indexes that would
// serve the ones that scan or sort (an app with indexes auto has them)
export type CostReport = { planned: cost.Planned[]; indexes: cost.Index[]; auto: boolean; declared: { name: string; entity: string }[] };
export let lastCost: CostReport | undefined;

export function generate(specPath: string, widgetsPath?: string): Record<string, string> {
  const source = readSpec(specPath);
  const spec: Spec = parse(source);
  cost.start();
  withGenerated(spec, parse);   // default screens under /_auto, as the runtime adds them
  const typing = typecheck(spec);   // the types the code is compiled to
  const decls = spec.decls;
  const of = (k: string) => decls.filter((d) => d.kind === k);
  const explain = explainer(spec);
  // the Go packages externs bind to, each with an alias in app.go
  const goPkgs = new Map<string, string>();
  for (const d of of("extern") as any[]) if (d.go?.pkg && !goPkgs.has(d.go.pkg)) goPkgs.set(d.go.pkg, `gopkg${goPkgs.size}`);
  const byKind = new Map<string, Decl>();
  for (const d of decls) if (!["trigger", "workflow", "permission"].includes(d.kind)) byKind.set(`${d.kind}:${d.name}`, d);
  const get = (k: string, n: string) => byKind.get(`${k}:${n}`);
  const ents = new Map<string, Decl>();
  for (const d of decls) if (d.kind === "entity" || d.kind === "data") ents.set(d.name, d);
  const stored = (e: string) => ents.get(e)?.kind === "entity";
  const enums = new Map<string, string[]>(of("enum").map((d) => [d.name, d.values]));
  // a field's storage kind (as fkind, below, which the entity code uses): r t p i b m d f h j
  const fkindOf = (f: any) => { const t = f.type.kind === "named" ? f.type.name : f.type.kind; return ents.has(t) ? "r" : TEXTLIKE.has(t) || enums.has(t) ? "t" : t === "Password" ? "p" : t === "Int" ? "i" : t === "Bool" ? "b" : t === "Time" ? "m" : t === "Duration" ? "d" : t === "File" ? "f" : t === "RichText" ? "h" : "j"; };
  const enumOf = new Map<string, string>();
  for (const [n, vs] of enums) for (const v of vs) enumOf.set(v, n);
  const perms = new Map<string, Expr>(of("permission").map((d) => [d.entity, d.cond]));
  const appDecl = of("app")[0];
  const actorEntity: string = appDecl?.props.actor?.name ?? "";
  const fail = (msg: string, pos?: { line: number }): never => { throw new GenError(`${specPath}:${pos?.line ?? "?"}: ${msg}`); };

  const routeRe = (route: string) => { const names: string[] = []; const re = "^" + route.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/:(\w+)/g, (_m: string, n: string) => { names.push(n); return "([^/]+)"; }) + "$"; return { re, names }; };
  const consts: string[] = [];   // SQL text
  let hoistN = 0;
  const sqlConst = (sql: string) => { const n = `sq${consts.length}`; consts.push(`const ${n} = ${q(sql)}`); return n; };
  // the planner's parameters it could type: the parameter as the []any form has it -> its typed
  // bind (rt.Stmt's method) and the typed Go value
  const typedParam = new Map<string, { b: string; c: string }>();
  // the generated statement functions: a query whose whole condition is SQL, with typed
  // parameters, compiled to one function that binds them and scans (rendered at the end, when
  // every entity's columns are known)
  const stmtIds = new Map<string, number>();
  const stmtFns = new Map<string, { id: number; mode: "rows" | "count"; entity: string; where: string; order: string; binds: string[] }>();
  const stmtNum = (entity: string, where: string, order: string, binds: string[]): number => {
    const k = `${entity}\0${where}\0${order}\0${binds.join(",")}`;
    let id = stmtIds.get(k);
    if (id === undefined) { id = stmtIds.size; stmtIds.set(k, id); }
    return id;
  };
  const stmtFn = (mode: "rows" | "count", entity: string, where: string, order: string, binds: string[]): string => {
    const id = stmtNum(entity, where, order, binds);
    const name = `${mode === "rows" ? "qr" : "qn"}${id}`;
    if (!stmtFns.has(name)) stmtFns.set(name, { id, mode, entity, where, order, binds });
    return name;
  };
  const E = (name: string) => { if (!ents.has(name)) fail(`unknown entity ${name}`); return `E_${ident(name)}`; };

  // ---- types: the entity a row-valued expression refers to, where it is known
  const fieldIndex = (e: string, f: string) => ents.get(e)?.fields.findIndex((x: any) => x.name === f) ?? -1;
  const METAF: Record<string, string> = { id: "MetaID", created: "MetaCreated", updated: "MetaUpdated" };
  const rowAt = (e: string, f: string) => METAF[f] ? `c.Row${METAF[f]}()` : fieldIndex(e, f) >= 0 ? `c.RowAt(${fieldIndex(e, f)})` : `c.RowField(${q(f)})`;
  const entOf = (e: any, s: CS): string | null => {
    if (!e) return null;
    switch (e.kind) {
      case "name": {
        const t = s.types?.get(e.name);
        if (t !== undefined) return t || null;
        if (s.locals.has(e.name) || s.dyn.has(e.name)) return null;
        if (e.name === "actor") return actorEntity || null;
        if (ents.get(e.name)?.singleton) return e.name;
        if (s.row) { const f = ents.get(s.row)!.fields.find((x: any) => x.name === e.name); if (f?.type.kind === "named" && ents.has(f.type.name)) return f.type.name; }
        return null;
      }
      case "it": return s.row ?? null;
      case "rowfield": { if (!s.row) return null; const f = ents.get(s.row)!.fields.find((x: any) => x.name === e.name); return f?.type.kind === "named" && ents.has(f.type.name) ? f.type.name : null; }
      case "field": {
        const t = entOf(e.target, s); if (!t) return null;
        const f = ents.get(t)!.fields.find((x: any) => x.name === e.name);
        return f?.type.kind === "named" && ents.has(f.type.name) ? f.type.name : null;
      }
      case "query": return ["the", "the_or_none", "first_or_none"].includes(e.op) ? e.entity : null;
      case "call": { if (e.name === "verify" && e.args[0]?.kind === "name" && ents.has(e.args[0].name)) return e.args[0].name; const d = get("fn", e.name); return d?.returns?.kind === "named" && ents.has(d.returns.name) ? d.returns.name : null; }
      case "if": { const a = entOf(e.then, s), b = entOf(e.else, s); if (e.then.kind === "lit" && e.then.value === null) return b; if (e.else.kind === "lit" && e.else.value === null) return a; return a === b ? a : null; }
    }
    return null;
  };
  const addType = (m: Map<string, string>, n: string, t: string | null) => { const had = m.get(n); m.set(n, had === undefined ? (t ?? "") : had === t ? had : ""); };
  const paramTypes = (ps: any[], m = new Map<string, string>()) => { for (const p of ps ?? []) addType(m, p.name, p.type.kind === "named" && ents.has(p.type.name) ? p.type.name : null); return m; };
  // the names a body binds, with their entities, in order
  const bodyTypes = (ss: any[], s: CS) => {
    const m = s.types!;
    const walk = (xs: any[]) => { for (const x of xs ?? []) {
      if (x.kind === "let") addType(m, x.name, entOf(x.value, s));
      if (x.kind === "create" && x.as) addType(m, x.as, x.entity);
      if (x.kind === "foreach") addType(m, x.bind, x.entity);
      if (x.kind === "foreachList") addType(m, x.bind, null);
      if (x.body) walk(x.body); if (x.then) walk(x.then); if (x.else) walk(x.else);
    } };
    walk(ss);
  };

  const eventTypes = new Map<string, string>();
  const emitsIn = (xs: any[], sc: CS) => { for (const x of xs ?? []) {
    if (x.kind === "emit") addType(eventTypes, x.event, x.args[0] ? entOf(x.args[0], sc) : null);
    if (x.body) emitsIn(x.body, sc); if (x.then) emitsIn(x.then, sc); if (x.else) emitsIn(x.else, sc);
  } };
  const typeEvents = () => {
    for (const a of decls.filter((d) => d.kind === "action")) { const sc = scope({ types: paramTypes(a.params) }); bodyTypes(a.body, sc); emitsIn(a.body, sc); }
    for (const t of decls.filter((d) => d.kind === "trigger")) { const sc = scope({ types: new Map([[t.bind, t.on.kind === "create" || t.on.kind === "update" ? t.on.entity : ""]]) }); bodyTypes(t.body, sc); emitsIn(t.body, sc); }
  };

  // ---- names
  function staticName(n: string, s: CS): string | null {
    if (n === "actor") return "c.Actor";
    if (n === "result") return "c.Res()";
    if (n === "request") return "c.ReqObj()";
    if (n === "get" || n === "write" || get("identity", n)) return q(n);
    if (enumOf.has(n)) return q(n);
    const ent = ents.get(n);
    if (ent?.singleton) return `rt.Singleton{E: ${q(n)}}`;
    if (ent) return `rt.EntityName{E: ${q(n)}}`;
    if (get("view", n) || get("action", n) || get("screen", n)) return `rt.Reference{Name: ${q(n)}}`;
    if (s.row && (["created", "updated", "id"].includes(n) || ents.get(s.row)!.fields.some((f: any) => f.name === n))) return rowAt(s.row, n);
    return null;
  }
  function name(e: Expr, s: CS): string {
    const n = e.name;
    const tl = s.tlocals?.get(n);
    if (tl) return box(tl as any);
    if (s.locals.has(n)) return s.locals.get(n)!;
    const st = staticName(n, s);
    if (s.dyn.has(n) || (s.dynAll && st === null)) return st === null ? `c.Var(${q(n)})` : `c.VarOr(${q(n)}, func() rt.Val { return ${st} })`;
    if (st === null) fail(`unknown name ${n}`, e.pos);
    return st!;
  }

  // ---- expressions: Go code of type rt.Val (ex) or bool (exB)
  function exBDyn(e: Expr, s: CS): string {
    switch (e.kind) {
      case "lit": if (typeof e.value === "boolean") return String(e.value); break;
      case "unary": if (e.op === "not") return `!(${exB(e.arg, s)})`; break;
      case "binary":
        switch (e.op) {
          case "and": return `(${exB(e.left, s)} && ${exB(e.right, s)})`;
          case "or": return `(${exB(e.left, s)} || ${exB(e.right, s)})`;
          case "implies": return `(!(${exB(e.left, s)}) || ${exB(e.right, s)})`;
          case "==": return `rt.Equal(${ex(e.left, s)}, ${ex(e.right, s)})`;
          case "!=": return `!rt.Equal(${ex(e.left, s)}, ${ex(e.right, s)})`;
          case "<": case "<=": case ">": case ">=": return `(rt.Compare(${ex(e.left, s)}, ${ex(e.right, s)}) ${e.op} 0)`;
          case "in": return `rt.In(${ex(e.left, s)}, ${ex(e.right, s)})`;
        }
        break;
      case "query": if (e.op === "exists") return `(${countCode(e, s)} > 0)`; break;
      case "all": return `c.AllRows(${E(e.entity)}, ${rowsCode(e, s)}, func(c *rt.Ctx) bool { return ${exB(e.cond, { ...s, row: e.entity })} })`;
      case "call": if (get("predicate", e.name)) return callFn(e, s, true); break;
    }
    return `rt.Truthy(${ex(e, s)})`;
  }
  function exDyn(e: Expr, s: CS): string {
    switch (e.kind) {
      case "lit":
        if (e.value === null) return "rt.Val(nil)";
        if (typeof e.value === "string") return q(e.value);
        if (typeof e.value === "number") return `int64(${e.value})`;
        return `rt.Val(${e.value})`;
      case "duration": return `rt.Dur{MS: ${e.amount * UNIT_MS[e.unit]}}`;
      case "now": return "rt.Time{T: c.Now(), Seq: rt.MaxSeq}";
      case "it": if (!s.row) fail("'it' outside a where", e.pos); return "c.It()";
      case "rowfield": if (!s.row) fail(`.${e.name} outside a where`, e.pos); return rowAt(s.row, e.name);
      case "name": return name(e, s);
      case "field": {
        if (e.target.kind === "name" && enums.has(e.target.name) && !s.locals.has(e.target.name) && !s.dyn.has(e.target.name)) return q(e.name);
        if (e.target.kind === "name" && e.target.name === "request" && !s.locals.has("request") && !s.dyn.has("request")) return `c.ReqField(${q(e.name)})`;
        const te = entOf(e.target, s);
        if (te && METAF[e.name]) return `c.${METAF[e.name]}(${ex(e.target, s)}, E_${ident(te)})`;
        if (te && fieldIndex(te, e.name) >= 0) return `c.FieldOf(${ex(e.target, s)}, E_${ident(te)}, ${fieldIndex(te, e.name)}, ${q(e.name)})`;
        return `c.Field(${ex(e.target, s)}, ${q(e.name)})`;
      }
      case "unary": return e.op === "not" ? `rt.Val(!(${exB(e.arg, s)}))` : `rt.Neg(${ex(e.arg, s)})`;
      case "binary":
        switch (e.op) {
          case "+": return `rt.Add(${ex(e.left, s)}, ${ex(e.right, s)})`;
          case "-": return `rt.Sub(${ex(e.left, s)}, ${ex(e.right, s)})`;
          case "*": return `rt.Mul(${ex(e.left, s)}, ${ex(e.right, s)})`;
          case "/": return `rt.Div(${ex(e.left, s)}, ${ex(e.right, s)})`;
        }
        return `rt.Val(${exB(e, s)})`;
      case "if": return `func() rt.Val { if ${exB(e.cond, s)} { return ${ex(e.then, s)} }; return ${ex(e.else, s)} }()`;
      case "listlit": case "setlit": return `rt.List{${e.items.map((i: Expr) => ex(i, s)).join(", ")}}`;
      case "json": return `rt.Obj{${Object.entries(e.fields).map(([k, v]) => `${q(k)}: ${ex(v as Expr, s)}`).join(", ")}}`;
      case "query":
        switch (e.op) {
          case "exists": return `rt.Val(${exB(e, s)})`;
          case "count": return `rt.Val(${countCode(e, s)})`;
          case "the": return `c.The(${E(e.entity)}, ${rowsCode(e, s)})`;
          case "the_or_none": return `rt.TheOrNone(${E(e.entity)}, ${rowsCode(e, s)})`;
          // only the first row is used: the query stops there
          case "first_or_none": return `rt.FirstOrNone(${E(e.entity)}, ${rowsCode(e.limit ? e : { ...e, limit: { kind: "lit", value: 1, pos: e.pos } }, s)})`;
          case "set": return `rt.SetOf(${E(e.entity)}, ${rowsCode(e, s)})`;
        }
        return fail(`query ${e.op}`, e.pos);
      case "all": return `rt.Val(${exB(e, s)})`;
      case "listq": return e.map
        ? `c.MapRows(${E(e.entity)}, ${rowsCode(e, s)}, func(c *rt.Ctx) rt.Val { return ${ex(e.map, { ...s, row: e.entity })} })`
        : `rt.RefsOf(${E(e.entity)}, ${rowsCode(e, s)})`;
      // a pure extern runs anywhere; any other, outside a workflow's let or call, is an effect that returns none
      case "extern": return get("extern", e.name)?.effect === "pure" ? externRun(e, s) : "rt.Val(nil)";
      case "call": return call(e, s);
      case "hoisted": return e.code;
    }
    return fail(`unknown expression ${e.kind}`, e.pos);
  }
  // ---- typed expressions: Go code with a Go type, from the type pass. A value is boxed into
  // rt.Val only where something dynamic needs it (a variable, a builtin, a record).
  type G = "int" | "oint" | "bool" | "obool" | "str" | "ostr" | "time" | "otime" | "dur" | "rich" | "orich" | "ref" | "set" | "none" | "val";
  type TX = { c: string; g: G };
  const tyOf = (e: any): Ty => (e && typing.types.get(e)) || { k: "any" };
  const labelsOf = (e: any): string => { const t: any = tyOf(e); return t.k === "enum" && enums.has(t.e) ? `EL_${ident(t.e)}` : "nil"; };
  const gOf = (t: Ty): G => {
    const o = (t as any).opt === true;
    switch (t.k) {
      case "int": return o ? "oint" : "int";
      case "bool": return o ? "obool" : "bool";
      case "text": case "enum": return o ? "ostr" : "str";
      case "time": return o ? "otime" : "time";
      case "dur": return o ? "val" : "dur";
      case "rich": return o ? "orich" : "rich";
      case "ref": return "ref";
      case "set": return "set";
      case "none": return "none";
    }
    return "val";
  };
  const UNBOX: Record<string, string> = { int: "rt.AsInt", oint: "rt.AsOptInt", bool: "rt.AsBool", obool: "rt.AsOptBool", str: "rt.AsStr", ostr: "rt.AsOptStr", time: "rt.AsTime", otime: "rt.AsOptTime", dur: "rt.AsDur", rich: "rt.AsRich", orich: "rt.AsOptRich", ref: "rt.AsRef", set: "rt.AsSet" };
  const unbox = (code: string, g: G): TX => (g === "val" || g === "none" ? { c: code, g: "val" } : { c: `${UNBOX[g]}(${code})`, g });
  const box = (x: TX): string => {
    switch (x.g) {
      case "val": return x.c;
      case "none": return "rt.Val(nil)";
      case "oint": case "obool": case "ostr": case "otime": case "orich": return `${x.c}.Val()`;
      case "ref": return `rt.BoxRef(${x.c})`;
    }
    return `rt.Val(${x.c})`;
  };
  const base = (g: G): G => ({ oint: "int", obool: "bool", ostr: "str", otime: "time", orich: "rich" } as any)[g] ?? g;
  const isOpt = (g: G) => ["oint", "obool", "ostr", "otime", "orich"].includes(g);
  const toBool = (x: TX): string => x.g === "bool" ? x.c : x.g === "obool" ? `rt.OptIs(${x.c}, true)` : x.g === "val" ? `rt.Truthy(${x.c})` : "false";
  // as the interpreter's plain(): text for concatenation and text builtins
  const textOf = (x: TX): string => {
    switch (x.g) {
      case "str": return x.c;
      case "ostr": return `${x.c}.V`;
      case "int": return `rt.IntText(${x.c})`;
      case "oint": return `rt.OptIntText(${x.c})`;
      case "bool": return `rt.BoolText(${x.c})`;
      case "rich": return `${x.c}.Text`;
      case "orich": return `${x.c}.V.Text`;
      case "none": return `""`;
    }
    return `rt.Plain(${box(x)})`;
  };
  // the interpreter's Number(): none is 0
  const intOf = (x: TX): string | null => x.g === "int" ? x.c : x.g === "oint" ? `${x.c}.V` : null;
  const eqCode = (l: TX, r: TX): string => {
    if (l.g === "none" && r.g === "none") return "true";
    if (r.g === "none" || l.g === "none") {
      const x = r.g === "none" ? l : r;
      if (isOpt(x.g)) return `!${x.c}.Ok`;
      if (x.g === "ref") return `(${x.c}.ID == 0)`;
      if (x.g === "val") return `(${x.c} == nil)`;
      return "false";
    }
    const bl = base(l.g), br = base(r.g);
    if (bl === br && ["int", "bool", "str"].includes(bl)) {
      if (!isOpt(l.g) && !isOpt(r.g)) return `(${l.c} == ${r.c})`;
      if (isOpt(l.g) && isOpt(r.g)) return `rt.OptEq(${l.c}, ${r.c})`;
      return isOpt(l.g) ? `rt.OptIs(${l.c}, ${r.c})` : `rt.OptIs(${r.c}, ${l.c})`;
    }
    if (l.g === "ref" && r.g === "ref") return `rt.RefEq(${l.c}, ${r.c})`;
    if (l.g === "time" && r.g === "time") return `(${l.c} == ${r.c})`;
    if ((bl === "rich" || br === "rich") && ["str", "rich"].includes(bl) && ["str", "rich"].includes(br) && !isOpt(l.g) && !isOpt(r.g)) return `(${textOf(l)} == ${textOf(r)})`;
    return `rt.Equal(${box(l)}, ${box(r)})`;
  };
  const cmpCode = (l: TX, r: TX, op: string): string => {
    const cmp = (a: TX, b: TX): string | null => {
      if (a.g === "int" && b.g === "int") return null;
      if (base(a.g) === "int" && base(b.g) === "int") return `rt.OptCmp(${isOpt(a.g) ? a.c : `rt.Some(${a.c})`}, ${isOpt(b.g) ? b.c : `rt.Some(${b.c})`}, rt.IntCmp)`;
      if (a.g === "time" && b.g === "time") return `rt.TimeCmp(${a.c}, ${b.c})`;
      if (base(a.g) === "time" && base(b.g) === "time") return `rt.OptCmp(${isOpt(a.g) ? a.c : `rt.Some(${a.c})`}, ${isOpt(b.g) ? b.c : `rt.Some(${b.c})`}, rt.TimeCmp)`;
      if (a.g === "str" && b.g === "str") return `rt.StrCmp(${a.c}, ${b.c})`;
      return `rt.Compare(${box(a)}, ${box(b)})`;
    };
    const c = cmp(l, r);
    return c === null ? `(${l.c} ${op} ${r.c})` : `(${c} ${op} 0)`;
  };
  function tx(e: Expr, s: CS): TX {
    const t = tyOf(e);
    switch (e.kind) {
      case "lit":
        if (e.value === null) return { c: "rt.Val(nil)", g: "none" };
        if (typeof e.value === "string") return { c: q(e.value), g: "str" };
        if (typeof e.value === "number") return { c: `int64(${e.value})`, g: "int" };
        return { c: String(e.value), g: "bool" };
      case "duration": return { c: `rt.Dur{MS: ${e.amount * UNIT_MS[e.unit]}}`, g: "dur" };
      case "now": return { c: "rt.Time{T: c.Now(), Seq: rt.MaxSeq}", g: "time" };
      case "it": if (!s.row) fail("'it' outside a where", e.pos); return { c: `rt.Ref{E: ${q(s.row!)}, ID: c.Row.ID}`, g: "ref" };
      case "name": {
        const tl = s.tlocals?.get(e.name);
        if (tl) return tl as TX;
        const code = name(e, s);
        // singletons, entity names, references and literals stay as they are
        if (/^rt\.(Singleton|EntityName|Reference)\{/.test(code)) return { c: code, g: "val" };
        if (/^"/.test(code)) return { c: code, g: "str" };
        return unbox(code, gOf(t));
      }
      case "rowfield": case "field": {
        if (e.kind === "field" && e.target.kind === "name" && enums.has(e.target.name) && !s.locals.has(e.target.name) && !s.dyn.has(e.target.name)) return { c: q(e.name), g: "str" };
        // a stored entity's field, read typed (the R_<Entity> getters): no FieldOf, no unbox
        {
          const ent = e.kind === "rowfield" ? s.row : (tyOf(e.target) as any).k === "ref" ? (tyOf(e.target) as any).e : undefined;
          const dd = ent ? ents.get(ent) : undefined;
          const f = dd?.kind === "entity" ? dd.fields.find((x: any) => x.name === e.name) : undefined;
          const g = gOf(t);
          const fits: Record<string, string[]> = { t: ["str", "ostr"], i: ["int", "oint"], b: ["bool", "obool"], m: ["time", "otime"], h: ["rich", "orich"], r: ["ref"], d: ["dur"] };
          if (f && fits[fkindOf(f)]?.includes(g) && !(fkindOf(f) === "d" && f.type.optional)) {
            const tgt = e.kind === "rowfield" ? null : tx(e.target, s);
            if (e.kind === "rowfield" || tgt!.g === "ref") {
              const call = e.kind === "rowfield" ? `rf_${ident(ent)}_${ident(f.name)}(c)` : `gf_${ident(ent)}_${ident(f.name)}(c, ${tgt!.c})`;
              return { c: g === "ref" || isOpt(g) ? call : `${call}.V`, g };
            }
          }
        }
        return unbox(exDyn(e, s), gOf(t));
      }
      case "unary":
        if (e.op === "not") return { c: `!(${toBool(tx(e.arg, s))})`, g: "bool" };
        { const a = tx(e.arg, s); const n = intOf(a); return n ? { c: `(-${n})`, g: "int" } : unbox(exDyn(e, s), gOf(t)); }
      case "binary": {
        if (e.op === "and") return { c: `(${toBool(tx(e.left, s))} && ${toBool(tx(e.right, s))})`, g: "bool" };
        if (e.op === "or") return { c: `(${toBool(tx(e.left, s))} || ${toBool(tx(e.right, s))})`, g: "bool" };
        if (e.op === "implies") return { c: `(!(${toBool(tx(e.left, s))}) || ${toBool(tx(e.right, s))})`, g: "bool" };
        const l = tx(e.left, s), r = tx(e.right, s);
        switch (e.op) {
          case "==": return { c: eqCode(l, r), g: "bool" };
          case "!=": return { c: `!${eqCode(l, r)}`, g: "bool" };
          case "<": case "<=": case ">": case ">=": return { c: cmpCode(l, r, e.op), g: "bool" };
          case "in": return { c: l.g === "ref" && r.g === "set" ? `rt.InSet(${l.c}, ${r.c})` : `rt.In(${box(l)}, ${box(r)})`, g: "bool" };
          case "+": {
            if (t.k === "int") { const a = intOf(l), b = intOf(r); if (a && b) return { c: `(${a} + ${b})`, g: "int" }; }
            if (t.k === "time" && l.g === "time" && r.g === "dur") return { c: `rt.TimePlus(${l.c}, ${r.c})`, g: "time" };
            if (t.k === "text" && !["val", "ref", "set", "time", "dur"].includes(l.g) && !["val", "ref", "set", "time", "dur"].includes(r.g)) return { c: `(${textOf(l)} + ${textOf(r)})`, g: "str" };
            return unbox(`rt.Add(${box(l)}, ${box(r)})`, gOf(t));
          }
          case "-": {
            if (t.k === "time" && l.g === "time" && r.g === "dur") return { c: `rt.TimeMinus(${l.c}, ${r.c})`, g: "time" };
            const a = intOf(l), b = intOf(r);
            if (a && b) return { c: `(${a} - ${b})`, g: "int" };
            return unbox(`rt.Sub(${box(l)}, ${box(r)})`, gOf(t));
          }
          case "*": { const a = intOf(l), b = intOf(r); if (a && b) return { c: `(${a} * ${b})`, g: "int" }; return unbox(`rt.Mul(${box(l)}, ${box(r)})`, gOf(t)); }
          case "/": { const a = intOf(l), b = intOf(r); if (a && b) return { c: `rt.DivInt(${a}, ${b})`, g: "int" }; return unbox(`rt.Div(${box(l)}, ${box(r)})`, gOf(t)); }
        }
        return { c: exBDyn(e, s), g: "bool" };
      }
      case "if": {
        const cnd = toBool(tx(e.cond, s));
        const a = tx(e.then, s), b = tx(e.else, s);
        const g = gOf(t);
        // both branches as the expression's type
        const as = (x: TX): string => {
          if (x.g === g) return x.c;
          if (x.g === "none" && isOpt(g)) return `rt.Opt[${GO[base(g)]}]{}`;
          if (x.g === "none" && g === "ref") return "rt.Ref{}";
          if (isOpt(g) && x.g === base(g)) return `rt.Some(${x.c})`;
          return `${UNBOX[g]}(${box(x)})`;
        };
        if (g !== "val" && g !== "none" && g !== "set") return { c: `func() ${GO[g]} { if ${cnd} { return ${as(a)} }; return ${as(b)} }()`, g };
        return { c: `func() rt.Val { if ${cnd} { return ${box(a)} }; return ${box(b)} }()`, g: "val" };
      }
      case "query":
        if (e.op === "exists") return { c: `(${countCode(e, s)} > 0)`, g: "bool" };
        if (e.op === "count") return { c: countCode(e, s), g: "int" };
        return unbox(exDyn(e, s), gOf(t));
      case "all": return { c: exBDyn(e, s), g: "bool" };
      case "call": {
        if (get("predicate", e.name) || get("fn", e.name)) return callTyped(e, s);
        if (!get("fn", e.name) && !get("screen", e.name) && !get("view", e.name) && BUILTINS.has(e.name)) {
          const a0 = e.args[0] ? tx(e.args[0], s) : null;
          switch (e.name) {
            case "plain": case "text": case "html": if (a0) return { c: textOf(a0), g: "str" }; break;
            // an enum value's label (its declared one, or its name made readable)
            case "label": if (a0) return { c: `rt.EnumLabel(${labelsOf(e.args[0])}, ${textOf(a0)})`, g: "str" }; break;
            case "present": if (a0) return { c: a0.g === "ostr" ? `!rt.OptBlank(${a0.c})` : a0.g === "str" ? `!rt.Blank(${a0.c})` : `!rt.Blank(${textOf(a0)}) && ${box(a0)} != nil`, g: "bool" }; break;
            case "blank": if (a0) return { c: a0.g === "ostr" ? `rt.OptBlank(${a0.c})` : a0.g === "str" ? `rt.Blank(${a0.c})` : `(${box(a0)} == nil || rt.Blank(${textOf(a0)}))`, g: "bool" }; break;
            case "lower": if (a0) return { c: `strings.ToLower(${textOf(a0)})`, g: "str" }; break;
            case "upper": if (a0) return { c: `strings.ToUpper(${textOf(a0)})`, g: "str" }; break;
            case "trim": if (a0) return { c: `strings.TrimSpace(${textOf(a0)})`, g: "str" }; break;
          }
        }
        return unbox(exDyn(e, s), gOf(t));
      }
      case "hoisted": return { c: e.code, g: "val" };
    }
    return unbox(exDyn(e, s), gOf(t));
  }
  const GO: Record<string, string> = { int: "int64", oint: "rt.Opt[int64]", bool: "bool", obool: "rt.Opt[bool]", str: "string", ostr: "rt.Opt[string]", time: "rt.Time", otime: "rt.Opt[rt.Time]", dur: "rt.Dur", rich: "rt.Rich", orich: "rt.Opt[rt.Rich]", ref: "rt.Ref", set: "rt.Set" };
  function ex(e: Expr, s: CS): string { return box(tx(e, s)); }
  // a typed value as another Go type (the parameter's, the result's)
  const convert = (x: TX, g: G): string => {
    if (x.g === g) return x.c;
    if (g === "val") return box(x);
    if (x.g === "none") return isOpt(g) ? `rt.Opt[${GO[base(g)]}]{}` : g === "ref" ? "rt.Ref{}" : g === "set" ? "rt.Set{}" : `${UNBOX[g]}(nil)`;
    if (isOpt(g) && x.g === base(g)) return `rt.Some(${x.c})`;
    if (isOpt(x.g) && base(x.g) === g) return `${x.c}.V`;
    return `${UNBOX[g]}(${box(x)})`;
  };
  const gOfDecl = (t: any): G => {
    if (!t) return "val";
    if (t.kind === "set") return "set";
    if (t.kind !== "named") return "val";
    const o = !!t.optional, n = t.name;
    if (ents.has(n)) return "ref";
    if (enums.has(n) || ["Text", "Email", "Url", "Ip"].includes(n)) return o ? "ostr" : "str";
    if (n === "Int") return o ? "oint" : "int";
    if (n === "Bool") return o ? "obool" : "bool";
    if (n === "Time") return o ? "otime" : "time";
    if (n === "RichText") return o ? "orich" : "rich";
    if (n === "Duration" && !o) return "dur";
    return "val";
  };
  const goType = (g: G) => (g === "val" || g === "none" ? "rt.Val" : GO[g]);
  const typedParams = (ps: any[]) => new Map<string, { c: string; g: string }>(ps.map((p: any) => [p.name, { c: `l_${ident(p.name)}`, g: gOfDecl(p.type) }]));
  const typedSig = (ps: any[]) => ps.map((p: any) => `l_${ident(p.name)} ${goType(gOfDecl(p.type))}`).join(", ");

  function exB(e: Expr, s: CS): string { return toBool(tx(e, s)); }

  // an extern call that runs (workflow steps, fetching views): its arguments in declared order
  function externRun(e: Expr, s: CS): string {
    const d = get("extern", e.name);
    const args = d ? d.params.map((p: any, i: number) => i < e.args.length ? ex(e.args[i], s) : e.named[p.name] ? ex(e.named[p.name], s) : "nil")
      : [...e.args.map((a: Expr) => ex(a, s)), ...Object.values(e.named).map((a) => ex(a as Expr, s))];
    return `c.Extern(${[q(e.name), ...args].join(", ")})`;
  }
  function callArgs(params: any[], e: Expr, s: CS): string[] {
    return params.map((p: any, i: number) => i < e.args.length ? ex(e.args[i], s) : e.named?.[p.name] ? ex(e.named[p.name], s) : "nil");
  }
  function callTyped(e: Expr, s: CS): TX {
    const pred = get("predicate", e.name);
    const d = pred ?? get("fn", e.name)!;
    const args = d.params.map((p: any, i: number) => {
      const a = i < e.args.length ? e.args[i] : e.named?.[p.name];
      return a ? convert(tx(a, s), gOfDecl(p.type)) : convert({ c: "rt.Val(nil)", g: "none" }, gOfDecl(p.type));
    });
    const code = `${pred ? "P" : "F"}_${ident(e.name)}(${["c", ...args].join(", ")})`;
    return { c: code, g: pred ? "bool" : gOfDecl(d.returns) };
  }
  function callFn(e: Expr, s: CS, asBool: boolean): string {
    const r = callTyped(e, s);
    return asBool ? toBool(r) : box(r);
  }
  function call(e: Expr, s: CS): string {
    if (get("predicate", e.name) || get("fn", e.name)) return callFn(e, s, false);
    const args = () => e.args.map((a: Expr) => ex(a, s));
    if (get("screen", e.name)) return `rt.ScreenRef{Name: ${q(e.name)}, Args: rt.List{${args().join(", ")}}}`;
    const view = get("view", e.name);
    if (view?.rows) return `c.ViewRefs(${q(e.name)}, map[string]rt.Val{${view.params.map((p: any, i: number) => `${q(p.name)}: ${i < e.args.length ? ex(e.args[i], s) : e.named[p.name] ? ex(e.named[p.name], s) : "nil"}`).join(", ")}})`;
    if (decls.some((d) => d.kind === "api" && d.name === e.name)) return `rt.APIRef{Name: ${q(e.name)}, Args: rt.List{${args().join(", ")}}}`;
    if (!BUILTINS.has(e.name)) fail(`unknown function ${e.name}`, e.pos);
    return `rt.B_${e.name}(${["c", ...args()].join(", ")})`;
  }

  // ---- queries
  // `for each x in E where p { set x.f = v … }` as one write (rt Ctx.SetWhere), when that is the
  // loop exactly: the body only sets fields of x; p is all SQL and reads none of them (so a set
  // can't change which rows p picks); each v doesn't name x (the same for every row); and no
  // trigger on those fields, no touch of a parent, no rich text, password or size check is
  // involved. Else "" (the loop, row by row)
  function setWhere(st: any, s: CS): string {
    const d = ents.get(st.entity);
    if (!d || !stored(st.entity) || !st.where || !st.body.length) return "";
    if (d.fields.some((f: any) => f.touches)) return "";
    const sets: { i: number; f: any; value: Expr }[] = [];
    for (const x of st.body) {
      if (x.kind !== "set" || x.target?.kind !== "name" || x.target.name !== st.bind) return "";
      const i = d.fields.findIndex((f: any) => f.name === x.name);
      if (i < 0 || sets.some((y) => y.i === i)) return "";
      const f = d.fields[i];
      // rich text has its side tables, a password is hashed, a size is checked: row by row
      if (f.type?.kind !== "named" || ["RichText", "Password"].includes(f.type.name) || f.max !== undefined || f.min !== undefined || ["Email", "Url", "Ip"].includes(f.type.name)) return "";
      if (JSON.stringify(x.value).includes(`"kind":"name","name":${JSON.stringify(st.bind)}`)) return "";
      if (decls.some((t) => t.kind === "trigger" && t.on.kind === "update" && t.on.entity === st.entity && t.on.field === x.name)) return "";
      sets.push({ i, f, value: x.value });
    }
    const p = new Planner(s).plan(st.entity, st.where);
    if (!p.sql || p.residual.length) return "";
    // the condition reads a field it sets (its column, or a Time's or File's others): row by row
    for (const { f } of sets) if (p.sql.includes(`"${f.name}"`) || p.sql.includes(`"${f.name}__`)) return "";
    cost.onQuery({ entity: st.entity, where: p.sql, orderBy: "t0.seq", limited: false });
    return `c.SetWhere(${E(st.entity)}, ${sqlConst(p.sql)}, []any{${p.params.join(", ")}}, []int{${sets.map((x) => x.i).join(", ")}}, []rt.Val{${sets.map((x) => ex(x.value, s)).join(", ")}})`;
  }
  // a query as its generated statement called directly (no rt.Query, no []any), for each
  // request shape when it has several; null when some shape needs the general path
  function directCode(lit: QLit, mode: "rows" | "count"): string | null {
    const one = (l: QLit): string | null => {
      if (l.never) return mode === "rows" ? "[]*rt.Row{}" : "int64(0)";
      if (!l.direct || l.hoisted.length) return null;
      const d = l.direct;
      return `${stmtFn(mode, d.entity, d.where, mode === "rows" ? d.order : "", d.binds)}(c${d.args.map((a) => ", " + a).join("")})`;
    };
    if (!lit.shapes) return one(lit);
    const calls = lit.shapes.cases.map((x) => one(x.one));
    if (calls.some((x) => x === null)) return null;
    const cs = lit.shapes.cases.map((x, i) => (i === calls.length - 1 ? `default: return ${calls[i]}` : `case ${x.when}: return ${calls[i]}`));
    return `func() ${mode === "rows" ? "[]*rt.Row" : "int64"} { ${lit.shapes.tests.map((t, i) => `a${i} := ${t}`).join("; ")}; switch { ${cs.join("; ")} } }()`;
  }
  // ---- creates, typed: a create statement fills the entity's row struct field by field (each
  // value as its Go type where it has it) and calls a create made for exactly the fields it
  // gives (CT_<Entity>_<mask>): no []rt.Val, no mask tested at run time. Else "" (C_<Entity>)
  const optF = (f: any) => !!(f.type.kind === "named" && f.type.optional);
  // a typed value into field i of the row struct rv
  const assignField = (f: any, i: number, t: TX, rv: string): string => {
    const k = fkindOf(f), o = optF(f), F = `${rv}.F_${ident(f.name)}`;
    const set = () => `${rv}.Set(${i}, ${k === "h" ? `rt.BindRich(${box(t)})` : box(t)})`;
    if (t.g === "none") return o ? "" : set();
    if (k === "r") return t.g === "ref" ? `${F} = ${t.c}.ID` : set();
    const base = ({ t: "str", i: "int", b: "bool", m: "time", h: "rich", d: "dur" } as Record<string, string>)[k];
    if (!base) return set();
    if (!o) return t.g === base ? `${F} = ${t.c}` : set();
    if (k === "d") return set();
    if (t.g === "o" + base) return `${F} = ${t.c}`;
    if (t.g === base) return `${F} = rt.Some(${t.c})`;
    return set();
  };
  const ctFns = new Map<string, { entity: string; given: Set<number> }>();
  function createTyped(st: any, s: CS): string {
    const d = ents.get(st.entity);
    if (!d || d.kind !== "entity" || !stored(st.entity) || (st.ensure && d.uniques?.length)) return "";
    const given = new Map<number, Expr>();
    for (const a of st.fields) { const i = d.fields.findIndex((f: any) => f.name === a.name); if (i < 0) return ""; given.set(i, a.value); }
    for (const [i, f] of d.fields.entries()) {
      const t = f.type.kind === "named" ? f.type.name : "";
      if (given.has(i) ? t === "Password" : !f.default && !optF(f) && t !== "Int") return "";   // a password is hashed, a missing field refused: C_
    }
    let mask = 0n;
    for (const i of given.keys()) mask |= 1n << BigInt(i);
    const name = `CT_${ident(st.entity)}_${mask}`;
    if (!ctFns.has(name)) ctFns.set(name, { entity: st.entity, given: new Set(given.keys()) });
    const sets = [...given].map(([i, v]) => assignField(d.fields[i], i, tx(v, s), "r")).filter(Boolean);
    return `r := &R_${ident(st.entity)}{}; ${sets.map((x) => x + "; ").join("")}ref := ${name}(c, r)`;
  }
  // ---- a loop that only ensures a row for each of its rows, as one batch: the loop is `for
  // each u in E where p { ensure F { a: v, …, b: u } }` with F's one unique key made of b (u
  // itself) and fields whose values don't depend on u (references); F has no create trigger
  const cteFns = new Map<string, { entity: string; given: Set<number>; fixed: number[]; vary: number }>();
  function ensureLoop(st: any, s: CS): string[] | null {
    if (st.body.length !== 1) return null;
    const x = st.body[0];
    if (x.kind !== "create" || !x.ensure || x.as) return null;
    const d = ents.get(x.entity);
    if (!d || d.kind !== "entity" || !stored(x.entity) || d.singleton || (d.uniques?.length ?? 0) !== 1) return null;
    if (fireCode("create", x.entity, "", "ref", "nil")) return null;
    const given = new Map<number, Expr>();
    for (const a of x.fields) { const i = d.fields.findIndex((f: any) => f.name === a.name); if (i < 0) return null; given.set(i, a.value); }
    for (const [i, f] of d.fields.entries()) {
      const t = f.type.kind === "named" ? f.type.name : "";
      if (given.has(i) ? t === "Password" : !f.default && !optF(f) && t !== "Int") return null;
    }
    const mentions = (e: any) => JSON.stringify(e).includes(`"kind":"name","name":${JSON.stringify(st.bind)}`);
    const key = d.uniques[0].map((nm: string) => d.fields.findIndex((f: any) => f.name === nm));
    let vary = -1;
    const fixed: number[] = [];
    for (const i of key) {
      const v = given.get(i), f = d.fields[i];
      if (!v || fkindOf(f) !== "r") return null;
      if (v.kind === "name" && v.name === st.bind && f.type.name === st.entity) { if (vary >= 0) return null; vary = i; }
      else if (mentions(v)) return null;
      else fixed.push(i);
    }
    if (vary < 0) return null;
    for (const [i, v] of given) if (i !== vary && mentions(v)) return null;   // every other value is the same for every row
    let mask = 0n;
    for (const i of given.keys()) mask |= 1n << BigInt(i);
    const name = `CTE_${ident(x.entity)}_${mask}`;
    if (!cteFns.has(name)) cteFns.set(name, { entity: x.entity, given: new Set(given.keys()), fixed, vary });
    const n = loopN++, rows = `rows${n}`, row = `row${n}`, recs = `recs${n}`;
    const out = [`${rows} := ${rowsCode({ entity: st.entity, where: st.where }, s)}`];
    // the values the same for every row, worked out once
    const sets: string[] = [];
    for (const [i, v] of given) {
      if (i === vary) { sets.push(`r.F_${ident(d.fields[i].name)} = ${row}.ID`); continue; }
      const t = tx(v, s), lv = `ev${n}_${i}`;
      out.push(`${lv} := ${t.c}; _ = ${lv}`);
      const a = assignField(d.fields[i], i, { c: lv, g: t.g } as TX, "r");
      if (a) sets.push(a);
    }
    out.push(`${recs} := make([]*R_${ident(x.entity)}, 0, len(${rows}))`);
    out.push(`for _, ${row} := range ${rows} { if c.S.Find(${E(st.entity)}, ${row}.ID) == nil { continue }; r := &R_${ident(x.entity)}{}; ${sets.join("; ")}; ${recs} = append(${recs}, r) }`);
    out.push(`${name}(c, ${recs})`);
    return out;
  }
  // ---- loops over rows, batched: `for each x in E … { for each y in F where .f == x.g … }`
  // asks F once per x; when x.g is a required reference, the rows for every x are read in one
  // query before the loop and kept under the inner query's statement (its SQL is `.f = ?` with
  // the reference bound typed, as the planner writes it), so the inner loop finds them there
  let loopN = 0;
  function nestedPrefetch(st: any, rowsVar: string): string[] {
    const out: string[] = [];
    const outer = ents.get(st.entity);
    if (!outer || outer.kind !== "entity" || !stored(st.entity)) return out;
    const isOuterField = (e: any) => e?.kind === "field" && e.target?.kind === "name" && e.target.name === st.bind;
    for (const x of st.body) {
      if (x.kind !== "foreach" || !stored(x.entity) || x.where?.kind !== "binary" || x.where.op !== "==") continue;
      const w = x.where;
      const [colE, valE] = w.left?.kind === "rowfield" && isOuterField(w.right) ? [w.left, w.right] : w.right?.kind === "rowfield" && isOuterField(w.left) ? [w.right, w.left] : [];
      if (!colE) continue;
      const fi = fieldIndex(st.entity, valE.name), ci = fieldIndex(x.entity, colE.name);
      if (fi < 0 || ci < 0) continue;
      const ff = outer.fields[fi], cf = ents.get(x.entity)!.fields[ci];
      if (fkindOf(ff) !== "r" || fkindOf(cf) !== "r" || optF(ff) || ff.type.name !== cf.type.name) continue;
      const num = stmtNum(x.entity, `(t0.${sq(colE.name)} = ?)`, "t0.seq", ["Ref"]);
      const ids = `ids${loopN++}`;
      out.push(`${ids} := make([]int64, 0, len(${rowsVar})); for _, x := range ${rowsVar} { ${ids} = append(${ids}, x.R.(*R_${ident(st.entity)}).F_${ident(ff.name)}) }`);
      out.push(`c.S.PrefetchBy(${E(x.entity)}, ${num}, ${ci}, "t0.seq", ${ids})`);
    }
    return out;
  }
  function rowsCode(qy: any, s: CS, perm?: { name: string; cond: Expr }): string {
    const lit = queryLit(qy, s, perm);
    const dc = directCode(lit, "rows");
    if (dc) return dc;
    const call = `c.Rows(${lit.lit}${lit.args.map((a) => `, ${a}`).join("")})`;
    return lit.hoisted.length ? `func() []*rt.Row { ${lit.hoisted.join("; ")}; return ${call} }()` : call;
  }
  function countCode(qy: any, s: CS): string {
    const lit = queryLit(qy, s);
    const dc = directCode(lit, "count");
    if (dc) return dc;
    const call = `c.Count(${lit.lit}${lit.args.map((a) => `, ${a}`).join("")})`;
    return lit.hoisted.length ? `func() int64 { ${lit.hoisted.join("; ")}; return ${call} }()` : call;
  }
  type QLit = { lit: string; args: string[]; permDone: boolean; hoisted: string[]; pushed: boolean; never?: boolean; direct?: { entity: string; where: string; order: string; binds: string[]; args: string[] }; shapes?: { tests: string[]; cases: { when: string; one: QLit }[] } };
  type Shape = { known: Map<string, boolean>; present: Set<string>; absent: Set<string> };
  // a query, as one statement per request shape: the row-free conditions its SQL depends on and
  // the optional values it compares with columns are worked out first, in Go, and pick the SQL
  // planned for exactly that shape (none of the shape is left for SQL to test: no ? IS NULL, no
  // CASE, no parameter that is only a condition). A shape whose condition is false runs nothing.
  // With more than three such things, one statement for all of them
  function queryLit(qy: any, s: CS, perm?: { name: string; cond: Expr }): QLit {
    if (!ents.has(qy.entity)) fail(`unknown entity ${qy.entity}`, qy.pos);
    const atoms = stored(qy.entity) ? shapeAtoms(qy, s, perm) : [];
    if (!atoms.length || atoms.length > 3) return queryLitOne(qy, s, perm);
    const tests = atoms.map((a) => (a.kind === "cond" ? exB(a.expr, s) : presentCode(a.expr, s)));
    const cases: string[] = [], shapeCases: { when: string; one: QLit }[] = [];
    let permDone = true, pushed = true;
    for (let m = 0; m < 1 << atoms.length; m++) {
      const sh: Shape = { known: new Map(), present: new Set(), absent: new Set() };
      atoms.forEach((a, i) => {
        const v = !!(m & (1 << i));
        if (a.kind === "value") { (v ? sh.present : sh.absent).add(a.key); return; }
        sh.known.set(a.key, v);
        const nt = noneTest(a.expr);   // x == none, x != none: what it says of x
        if (nt) (v === nt.isNone ? sh.absent : sh.present).add(canonE(nt.target));
      });
      const one = queryLitOne(qy, s, perm, sh);
      permDone &&= one.permDone; pushed &&= one.pushed;
      const when = atoms.map((_, i) => (m & (1 << i) ? `a${i}` : `!a${i}`)).join(" && ");
      cases.push(`case ${when}: ${one.hoisted.map((h) => h + "; ").join("")}return ${one.lit}, []any{${one.args.join(", ")}}`);
      shapeCases.push({ when, one });
    }
    const pick = `qv, qa := func() (*rt.Query, []any) { ${atoms.map((_, i) => `a${i} := ${tests[i]}`).join("; ")}; switch { ${cases.join("; ")} }; panic("unreachable") }()`;
    return { lit: "qv", args: ["qa..."], permDone, hoisted: [pick], pushed, shapes: { tests, cases: shapeCases } };
  }
  // a query's order as SQL, when the database can order it (insertion, created, id); null when
  // Go has to (by any other key)
  function sqlOrderOf(qy: any): string | null {
    const orderName = !qy.order ? "" : (qy.order.kind === "name" || qy.order.kind === "rowfield") ? qy.order.name : "?";
    let so = ({ "": "t0.seq", created: "t0.created,t0.seq", id: "t0.id" } as Record<string, string>)[orderName];
    // a field of the row whose order SQL keeps as rt.Compare does (text byte by byte, numbers,
    // a time by its moment then its sequence; none first), ties by insertion
    const f = !so && qy.order?.kind === "rowfield" && stored(qy.entity) ? ents.get(qy.entity)?.fields.find((x: any) => x.name === orderName) : undefined;
    if (f) {
      const k = fkindOf(f), c = `t0.${sq(f.name)}`;
      if (k === "t" || k === "i" || k === "b") so = `${c},t0.seq`;
      else if (k === "m") so = `${c},t0.${sq(f.name + "__seq")},t0.seq`;
    }
    if (!so) return null;
    return so.split(",").map((c) => (qy.order && qy.desc ? c + " DESC" : c)).join(", ");
  }
  // whether an optional value is present, typed where it can be
  function presentCode(e: Expr, s: CS): string {
    const t = tx(e, s);
    if (isOpt(t.g)) return `${t.c}.Ok`;
    if (t.g === "ref") return `(${t.c}.ID != 0)`;
    return `(${box(t)} != nil)`;
  }
  const noneTest = (e: any): { target: any; isNone: boolean } | null => {
    if (e?.kind !== "binary" || (e.op !== "==" && e.op !== "!=")) return null;
    const none = (x: any) => x?.kind === "none" || (x?.kind === "lit" && x.value === null);
    if (none(e.right)) return { target: e.left, isNone: e.op === "==" };
    if (none(e.left)) return { target: e.right, isNone: e.op === "==" };
    return null;
  };
  // what a query's SQL depends on that the request decides: row-free conditions (cond), and
  // optional values compared with a column (value), through predicates too, as the call site
  // writes them. A value whose presence a condition already decides (x.f, with x == none
  // among the conditions) is that condition's
  function shapeAtoms(qy: any, s: CS, perm?: { name: string; cond: Expr }): { key: string; expr: Expr; kind: "cond" | "value" }[] {
    const pl = new Planner(s);
    const out = new Map<string, { key: string; expr: Expr; kind: "cond" | "value" }>();
    const visit = (x: any, env: Map<string, Bind>, depth: number) => {
      if (!x || typeof x !== "object" || depth > 6) return;
      if (Array.isArray(x)) { for (const y of x) visit(y, env, depth); return; }
      if (x.kind === "lit" || x.kind === "hoisted" || x.kind === "none") return;
      const t: any = tyOf(x);
      if (t.k === "bool" && pl.rowFree(x, env)) { const r = pl.resolve(x, env); out.set("c" + canonE(r), { key: canonE(r), expr: r, kind: "cond" }); return; }
      if (x.kind === "binary" && ["==", "!=", "<", "<=", ">", ">="].includes(x.op)) {
        for (const [a, b] of [[x.left, x.right], [x.right, x.left]]) {
          if (pl.rowFree(b, env) && !pl.rowFree(a, env) && pl.noneness(b, env) === "maybe") { const r = pl.resolve(b, env); out.set("v" + canonE(r), { key: canonE(r), expr: r, kind: "value" }); }
        }
      }
      if (x.kind === "call") {
        const d: any = get("predicate", x.name) ?? get("fn", x.name);
        if (d && d.params.length === (x.args ?? []).length && !Object.keys(x.named ?? {}).length) {
          const inner = new Map<string, Bind>();
          d.params.forEach((p: any, i: number) => { const a = x.args[i]; inner.set(p.name, pl.rowFree(a, env) ? { kind: "value", code: "", src: a, srcEnv: env } : { kind: "row", alias: "t0", entity: "" }); });
          visit(d.body, inner, depth + 1);
        }
      }
      for (const [k, v] of Object.entries(x)) if (k !== "pos") visit(v, env, depth);
    };
    visit(qy.where, new Map(), 0);
    if (perm) visit(perm.cond, new Map([[perm.name, { kind: "row", alias: "t0", entity: qy.entity } as Bind]]), 0);
    const all = [...out.values()];
    const decided = new Set(all.filter((a) => a.kind === "cond").map((a) => noneTest(a.expr)).filter(Boolean).map((n) => canonE(n!.target)));
    const rootOf = (e: any): string => (e?.kind === "field" ? rootOf(e.target) : canonE(e));
    return all.filter((a) => a.kind === "cond" || !(decided.has(a.key) || decided.has(rootOf(a.expr))));
  }
  function queryLitOne(qy: any, s: CS, perm?: { name: string; cond: Expr }, shape?: Shape): QLit {
    const rs: CS = { ...s, row: qy.entity };
    let sql = "", args: string[] = [], residual: Expr[] = [], permDone = false;
    if (stored(qy.entity)) {
      const pl0 = new Planner(s);
      if (shape) { pl0.known = shape.known; pl0.present = shape.present; pl0.absent = shape.absent; }
      const p = pl0.plan(qy.entity, qy.where, perm?.name, perm?.cond);
      if (p.never) return { lit: `&rt.Query{E: ${E(qy.entity)}, Never: true}`, args: [], permDone: true, hoisted: [], pushed: true, never: true };
      sql = p.sql; args = p.params; residual = p.residual; permDone = !p.permResidual;
    } else if (qy.where) residual = [qy.where];
    const parts = [`E: ${E(qy.entity)}`];
    if (sql) parts.push(`SQL: ${sqlConst(sql)}`);
    // the filter's subexpressions that don't depend on the row are worked out once, when
    // first needed, rather than for every row
    const hoisted: string[] = [];
    if (residual.length) {
      const pl = new Planner(s);
      const hoist = (x: any): any => {
        if (!x || typeof x !== "object") return x;
        if (Array.isArray(x)) return x.map(hoist);
        if (x.kind && ["call", "field", "query", "listq", "all", "binary", "if"].includes(x.kind) && pl.rowFree(x, new Map())) {
          const n = `h${hoistN++}`;
          hoisted.push(`${n} := rt.Memo(func() rt.Val { return ${ex(x, s)} })`);
          return { kind: "hoisted", code: `${n}()`, pos: x.pos };
        }
        if (["query", "listq", "all"].includes(x.kind)) return x;   // a nested query's row is its own
        const out: any = {};
        for (const [k, v] of Object.entries(x)) out[k] = k === "pos" ? v : hoist(v);
        return out;
      };
      residual = residual.map(hoist);
      parts.push(`Residual: func(c *rt.Ctx) bool { return ${residual.map((r) => exB(r, rs)).join(" && ")} }`);
    }
    if (qy.order) parts.push(`Order: func(c *rt.Ctx) rt.Val { return ${ex(qy.order, rs)} }`);
    if (qy.desc) parts.push("Desc: true");
    if (qy.limit) parts.push(`Limit: func(c *rt.Ctx) rt.Val { return ${ex(qy.limit, s)} }`);
    // ordered by a row's updated time: a touch can move a row into the window (live pages)
    if (qy.order && JSON.stringify(qy.order).includes('"updated"')) parts.push("ByUpdated: true");
    // the database orders and limits the rows itself when the whole condition is SQL and the
    // order is one no write changes: insertion (seq), created (as Time{created, seq}), id. The
    // order is Go's: by the key, then by seq; desc reverses both.
    const sqlOrder = (sqlOrderOf({ ...qy, desc: false }) ?? "").split(", ").join(",");
    const pushed = stored(qy.entity) && !residual.length && (!perm || permDone) && !!sqlOrder;
    if (pushed) parts.push(`SQLOrder: ${q(sqlOrder.split(",").join(", "))}`, `SQLOrderDesc: ${q(sqlOrder.split(",").map((c) => c + " DESC").join(", "))}`);
    // for the cost report (lang/cost.ts): the SQL the database will run for it
    if (stored(qy.entity)) cost.onQuery({ entity: qy.entity, where: sql, orderBy: pushed ? sqlOrder.split(",").join(", ") : "t0.seq", limited: pushed && !!(qy.limit || qy.windowed) });
    // the whole condition in SQL, in insertion order, every parameter typed: one statement,
    // called directly (stmtFn)
    let direct: QLit["direct"];
    const litLimit = qy.limit?.kind === "lit" && typeof qy.limit.value === "number" ? Math.max(0, qy.limit.value) : undefined;
    if (pushed && (!qy.limit || litLimit !== undefined) && !qy.windowed && args.every((a) => typedParam.has(a)))
      direct = { entity: qy.entity, where: sql, order: sqlOrderOf(qy)! + (litLimit !== undefined ? ` LIMIT ${litLimit}` : ""), binds: args.map((a) => typedParam.get(a)!.b), args: args.map((a) => typedParam.get(a)!.c) };

    return { lit: `&rt.Query{${parts.join(", ")}}`, args, permDone, hoisted, pushed, direct };
  }

  // The planner, at compile time: SQL text, and Go code for each
  // parameter (evaluated where the query runs).
  type Kind = { k: "id" | "ref" | "enum" | "text" | "bool" | "int" | "json" | "time" | "count"; entity?: string; nullable: boolean };
  type Frag = { sql: string; params: string[] };
  type Col = Frag & Kind;
  // a predicate parameter given a row-free value keeps what it was given (src, in srcEnv), so a
  // request shape known for that expression holds for the parameter too
  type Bind = { kind: "row"; alias: string; entity: string } | { kind: "col"; col: Col } | { kind: "value"; code: string; t?: TX; src?: any; srcEnv?: Map<string, Bind> };
  // neg: under an odd number of nots (a NULL makes = and NOT (=) both false, where the
  // language's none != v is true, so there = with a column that can be NULL isn't exact)
  type PS = { alias: string; entity: string; env: Map<string, Bind>; depth: number; neg?: boolean };
  const sq = (n: string) => `"${n.replace(/"/g, '""')}"`;
  class Planner {
    aliases = 0;
    cs: CS;
    // the request's shape this plan is for: row-free conditions known true or false (by the
    // expression as the call site writes it), and optional values known present or absent
    known = new Map<string, boolean>();
    present = new Set<string>();
    absent = new Set<string>();
    constructor(cs: CS) { this.cs = cs; }
    // an expression as the call site writes it: a predicate's parameters replaced by what they
    // were given (only row-free values are)
    resolve(x: any, env: Map<string, Bind>): any {
      if (!x || typeof x !== "object") return x;
      if (Array.isArray(x)) return x.map((y) => this.resolve(y, env));
      if (x.kind === "name") { const b: any = env.get(x.name); if (b?.kind === "value" && b.src) return this.resolve(b.src, b.srcEnv); return x; }
      // the node itself when nothing in it is replaced (its type is the type pass's)
      let changed = false;
      const out: any = {};
      for (const [k, v] of Object.entries(x)) { out[k] = k === "pos" ? v : this.resolve(v, env); if (out[k] !== v) changed = true; }
      return changed ? out : x;
    }
    // whether a row-free value can be none for this shape
    noneness(v: any, env: Map<string, Bind>): "present" | "absent" | "maybe" {
      const x = this.resolve(v, env), k = canonE(x);
      if (this.present.has(k)) return "present";
      if (this.absent.has(k)) return "absent";
      if (x?.kind === "none" || (x?.kind === "lit" && x.value === null)) return "absent";
      const t: any = tyOf(x);
      if (t.k === "any" || t.k === "none") return "maybe";
      if (!t.opt) return "present";
      // a required field of a value known present
      if (x.kind === "field" && this.present.has(canonE(x.target))) {
        const te: any = tyOf(x.target), f = te.k === "ref" ? ents.get(te.e)?.fields.find((y: any) => y.name === x.name) : undefined;
        if (f && !(f.type.kind === "named" && f.type.optional)) return "present";
      }
      return "maybe";
    }
    rowFree(e: any, env: Map<string, Bind>, top = true): boolean {
      if (!e || typeof e !== "object") return true;
      if (Array.isArray(e)) return e.every((x) => this.rowFree(x, env, top));
      if (top && (e.kind === "rowfield" || e.kind === "it")) return false;
      if (e.kind === "name") { const b = env.get(e.name); return !b || b.kind === "value"; }
      if (["query", "listq", "all"].includes(e.kind)) return this.rowFree(e.where, env, false) && this.rowFree(e.order, env, false) && this.rowFree(e.map ?? e.cond, env, false);
      for (const [k, v] of Object.entries(e)) if (k !== "pos" && !this.rowFree(v, env, top)) return false;
      return true;
    }
    // a row-free expression, evaluated where the query runs, with the inlined arguments bound
    value(e: any, env: Map<string, Bind>): string { return box(this.typed(e, env)); }
    // the same, typed (an inlined argument as typed as the call site has it)
    typed(e: any, env: Map<string, Bind>): TX {
      const locals = new Map(this.cs.locals), tlocals = new Map(this.cs.tlocals ?? []);
      for (const [n, b] of env) {
        if (b.kind !== "value") continue;
        if (b.t) tlocals.set(n, b.t);
        else { tlocals.delete(n); locals.set(n, b.code); }
      }
      return tx(e, { ...this.cs, locals, tlocals, row: undefined });
    }
    encode(kind: Kind, code: string): string {
      const ch = { id: "d", ref: "r", enum: "t", text: "t", bool: "b", int: "i", count: "i", json: "x", time: "x" }[kind.k];
      return `rt.${{ d: "PR", r: "PR", t: "PT", b: "PB", i: "PI", x: "PX" }[ch as string]}(${code})`;
    }
    // a value compared with a column: typed where the value's Go type is the column's (then a
    // generated statement binds it as that type), else as encode has it
    encodeE(kind: Kind, e: any, env: Map<string, Bind>): string {
      const t = this.typed(e, env), k = kind.k;
      const as = (b: string, legacy: string) => { const code = `${legacy}(${t.c})`; typedParam.set(code, { b, c: t.c }); return code; };
      if ((k === "ref" || k === "id") && t.g === "ref") return as("Ref", "rt.PRef");
      if ((k === "text" || k === "enum") && t.g === "str") return as("Text", "rt.PStr");
      if ((k === "text" || k === "enum") && t.g === "ostr") return as("OptText", "rt.POptStr");
      if ((k === "int" || k === "count") && t.g === "int") return as("Int", "rt.PInt");
      if ((k === "int" || k === "count") && t.g === "oint") return as("OptInt", "rt.POptInt");
      if (k === "bool" && t.g === "bool") return as("Bool", "rt.PBool");
      // a value held untyped whose type the checker knows: unboxed once, then bound typed (none
      // binds NULL, as the untyped encoders give nil for it)
      if (t.g === "val") {
        const st: any = tyOf(e);
        const un = (b: string, conv: string, legacy: string) => { const c = `${conv}(${t.c})`, code = `${legacy}(${c})`; typedParam.set(code, { b, c }); return code; };
        if ((k === "ref" || k === "id") && st.k === "ref") return un("Ref", "rt.AsRef", "rt.PRef");
        if ((k === "text" || k === "enum") && (st.k === "text" || st.k === "enum")) return un("OptText", "rt.AsOptStr", "rt.POptStr");
        if ((k === "int" || k === "count") && st.k === "int") return un("OptInt", "rt.AsOptInt", "rt.POptInt");
      }
      return this.encode(kind, box(t));
    }
    column(e: any, s: PS): Col | null {
      if (!e) return null;
      if (e.kind === "it") return { sql: `${s.alias}.id`, params: [], k: "ref", entity: s.entity, nullable: false };
      if (e.kind === "rowfield") return this.field(s.alias, s.entity, e.name);
      if (e.kind === "name") {
        const b = s.env.get(e.name);
        if (b?.kind === "row") return { sql: `${b.alias}.id`, params: [], k: "ref", entity: b.entity, nullable: false };
        if (b?.kind === "col") return b.col;
        return null;
      }
      if (e.kind === "field") {
        const t = this.column(e.target, s);
        if (!t || !(t.k === "ref" || t.k === "id") || !t.entity || !stored(t.entity)) return null;
        // a field of a query's own row (t0.id, as a predicate's row parameter is): its column
        const own = /^(t\d+)\.id$/.exec(t.sql);
        if (own && !t.params.length) return this.field(own[1], t.entity, e.name);
        const inner = this.field("x", t.entity, e.name);
        if (!inner) return null;
        return { ...inner, sql: `(SELECT ${inner.sql.replace(/^x\./, "")} FROM ${sq(t.entity)} x WHERE x.id = ${t.sql})`, params: [...t.params], nullable: true };
      }
      if (e.kind === "query" && e.op === "count") {
        const sub = this.subquery(e, s); if (!sub) return null;
        return { sql: `(SELECT count(*) FROM ${sub.from} WHERE ${sub.where})`, params: sub.params, k: "count", nullable: false };
      }
      return null;
    }
    field(alias: string, entity: string, nm: string): Col | null {
      if (nm === "id") return { sql: `${alias}.id`, params: [], k: "id", entity, nullable: false };
      if (nm === "created" || nm === "updated") return { sql: `${alias}.${nm}`, params: [], k: "time", nullable: false };
      const f = ents.get(entity)?.fields.find((x: any) => x.name === nm);
      if (!f || f.type.kind !== "named") return null;
      const t = f.type.name, nullable = !!f.type.optional, sql = `${alias}.${sq(nm)}`;
      if (ents.has(t)) return { sql, params: [], k: "ref", entity: t, nullable };
      if (enums.has(t)) return { sql, params: [], k: "enum", nullable };
      if (TEXTLIKE.has(t)) return { sql, params: [], k: "text", nullable };
      if (t === "Int") return { sql, params: [], k: "int", nullable };
      if (t === "Bool") return { sql, params: [], k: "bool", nullable };
      if (t === "Time") return { sql, params: [], k: "time", nullable };   // (ordered by its __seq too: sqlOrderOf)
      return { sql, params: [], k: "json", nullable };
    }
    bool(e: any, s: PS): Frag | null {
      if (!e) return null;
      if (s.depth > 12) return null;
      if (e.kind === "lit" && typeof e.value === "boolean") return { sql: e.value ? TRUE_SQL : FALSE_SQL, params: [] };
      // a condition this shape knows: a constant (folded by and, or, not below)
      if (this.known.size && this.rowFree(e, s.env)) { const k = this.known.get(canonE(this.resolve(e, s.env))); if (k !== undefined) return { sql: k ? TRUE_SQL : FALSE_SQL, params: [] }; }
      if (this.rowFree(e, s.env)) { const v = this.value(e, s.env); return { sql: "(? = 1)", params: [`rt.B01(rt.Truthy(${v}))`] }; }
      if (e.kind === "binary" && (e.op === "and" || e.op === "or")) {
        const a = this.bool(e.left, s), b = a && this.bool(e.right, s);
        if (!a || !b) return null;
        const and = e.op === "and", zero = and ? FALSE_SQL : TRUE_SQL, one = and ? TRUE_SQL : FALSE_SQL;
        if (a.sql === zero || b.sql === zero) return { sql: zero, params: [] };
        if (a.sql === one) return b;
        if (b.sql === one) return a;
        return { sql: `(${a.sql} ${and ? "AND" : "OR"} ${b.sql})`, params: [...a.params, ...b.params] };
      }
      if (e.kind === "binary" && e.op === "implies") {
        const a = this.bool(e.left, { ...s, neg: !s.neg }), b = a && this.bool(e.right, s);
        return a && b ? { sql: `(NOT ${a.sql} OR ${b.sql})`, params: [...a.params, ...b.params] } : null;
      }
      if (e.kind === "unary" && e.op === "not") { const a = this.bool(e.arg, { ...s, neg: !s.neg }); if (!a) return null; if (a.sql === TRUE_SQL) return { sql: FALSE_SQL, params: [] }; if (a.sql === FALSE_SQL) return { sql: TRUE_SQL, params: [] }; return { sql: `(NOT ${a.sql})`, params: a.params }; }
      if (e.kind === "binary" && (e.op === "==" || e.op === "!=")) return this.equality(e, s);
      if (e.kind === "binary" && ["<", ">", "<=", ">="].includes(e.op)) return this.ordering(e, s);
      if (e.kind === "binary" && e.op === "in") {
        const l = this.column(e.left, s);
        if (!l || l.k === "json" || l.k === "time" || !this.rowFree(e.right, s.env)) return null;
        const ch = { id: "d", ref: "r", enum: "t", text: "t", bool: "b", int: "i", count: "i" }[l.k as string] ?? "x";
        // a typed set of references: its ids as the JSON list, bound as text
        if (ch === "d" || ch === "r") {
          const t = this.typed(e.right, s.env);
          if (t.g === "set") { const code = `rt.PLSet(${q(l.entity ?? "")}, ${t.c})`; typedParam.set(code, { b: "Text", c: code }); return { sql: `(${l.sql} IN (SELECT value FROM json_each(?)))`, params: [...l.params, code] }; }
        }
        const v = this.value(e.right, s.env);
        return { sql: `(${l.sql} IN (SELECT value FROM json_each(?)))`, params: [...l.params, ch === "d" || ch === "r" ? `rt.PLRef(${q(l.entity ?? "")}, ${v})` : ch === "t" ? `rt.PLText(${v})` : ch === "i" ? `rt.PLInt(${v})` : ch === "b" ? `rt.PLBool(${v})` : `"[]"`] };
      }
      if (e.kind === "query" && e.op === "exists") {
        const semi = this.semijoin(e, s); if (semi) return semi;
        const sub = this.subquery(e, s); if (!sub) return null;
        return { sql: `(EXISTS (SELECT 1 FROM ${sub.from} WHERE ${sub.where}))`, params: sub.params };
      }
      if (e.kind === "call") return this.inline(e, s, (body, inner) => this.bool(body, inner));
      return null;
    }
    equality(e: any, s: PS): Frag | null {
      const neg = e.op === "!=";
      const wrap = (f: Frag) => (neg ? { sql: `(NOT ${f.sql})`, params: f.params } : f);
      let l = this.column(e.left, s);
      const r = this.column(e.right, s);
      if (l && r) {
        if (l.k === "json" || r.k === "json" || l.k === "time" || r.k === "time") return null;
        const same = l.k === r.k || ((l.k === "ref" || l.k === "id") && (r.k === "ref" || r.k === "id") && l.entity === r.entity);
        if (!same) return null;
        // two columns that are never NULL compare with =; IS only where NULL is possible
        return wrap({ sql: `(${l.sql} ${(l.nullable || r.nullable) && !!s.neg !== neg ? "IS" : "="} ${r.sql})`, params: [...l.params, ...r.params] });
      }
      let valueSide = e.right;
      if (!l && r) { l = r; valueSide = e.left; }
      // a time (or JSON) against none: whether the column is empty
      const isNone = (x: any) => x?.kind === "none" || (x?.kind === "lit" && x.value === null) || (x?.kind === "name" && x.name === "none");
      if (l && (l.k === "time" || l.k === "json") && isNone(valueSide)) return wrap({ sql: `(${l.sql} IS NULL)`, params: [...l.params] });
      if (!l || l.k === "json" || l.k === "time" || !this.rowFree(valueSide, s.env)) return null;
      const col = l;
      // the value as this shape has it: absent (NULL only matches an empty column), present
      // (with a column that is never NULL, plain =), or either (IS, which is both)
      const nn = this.noneness(valueSide, s.env);
      if (nn === "absent") return wrap(col.nullable ? { sql: `(${col.sql} IS NULL)`, params: [...col.params] } : { sql: FALSE_SQL, params: [] });
      // = is exact with a column that is never NULL, or anywhere not negated
      if (nn === "present" && (!col.nullable || !(!!s.neg !== neg))) return wrap({ sql: `(${col.sql} = ?)`, params: [...col.params, this.encodeE(col, valueSide, s.env)] });
      return wrap({ sql: `(${col.sql} IS ?)`, params: [...col.params, this.encodeE(col, valueSide, s.env)] });
    }
    ordering(e: any, s: PS): Frag | null {
      const flip: Record<string, string> = { "<": ">", ">": "<", "<=": ">=", ">=": "<=" };
      let l = this.column(e.left, s), valueSide = e.right, op = e.op;
      if (!l) { l = this.column(e.right, s); valueSide = e.left; op = flip[op]; }
      if (!l || !["time", "int", "count", "id"].includes(l.k) || !this.rowFree(valueSide, s.env)) return null;
      const v = this.value(valueSide, s.env), col = l;
      // a column that can be none: the comparison is false then, as the language has it (not
      // NULL, which under a not would differ)
      const guard = (f: Frag): Frag => (col.nullable ? { sql: `(${col.sql} IS NOT NULL AND ${f.sql})`, params: [...col.params, ...f.params] } : f);
      const whenNone = op === ">" || op === ">=" ? "1" : "0";
      // none orders below everything: against an absent value the comparison is a constant; a
      // value this shape has present compares plainly; only one that may be either asks SQL
      const nn = this.noneness(valueSide, s.env);
      if (nn === "absent") return guard({ sql: whenNone === "1" ? TRUE_SQL : FALSE_SQL, params: [] });
      if (col.k === "time") {
        const seqCol = (col as any).seq ?? col.sql.replace(/\.(created|updated)$/, ".seq");
        if (nn === "present") {
          // a typed time: its moment and its sequence, bound as integers
          const tv = this.typed(valueSide, s.env);
          if (tv.g === "time") {
            const a = `rt.PInt(${tv.c}.T)`, b = `rt.PInt(${tv.c}.Seq)`;
            typedParam.set(a, { b: "Int", c: `${tv.c}.T` }); typedParam.set(b, { b: "Int", c: `${tv.c}.Seq` });
            return guard({ sql: `((${col.sql}, ${seqCol}) ${op} (?, ?))`, params: [...col.params, a, b] });
          }
          return guard({ sql: `((${col.sql}, ${seqCol}) ${op} (?, ?))`, params: [`rt.TimeT(${v})`, `rt.TimeSeq(${v})`] });
        }
        return guard({ sql: `(CASE WHEN ? IS NULL THEN ${whenNone} ELSE (${col.sql}, ${seqCol}) ${op} (?, ?) END)`, params: [`rt.TimeNull(${v})`, `rt.TimeT(${v})`, `rt.TimeSeq(${v})`] });
      }
      const enc = this.encodeE(col, valueSide, s.env);
      if (nn === "present") return guard({ sql: `(${col.sql} ${op} ?)`, params: [...col.params, enc] });
      return guard({ sql: `(CASE WHEN ? IS NULL THEN ${whenNone} ELSE ${col.sql} ${op} ? END)`, params: [enc, ...col.params, enc] });
    }
    // exists(E where .f == outer and rest), where rest doesn't read the outer query, as
    // outer IN (SELECT f FROM E WHERE f IS NOT NULL AND rest): the rows rest picks, found once,
    // then the outer rows by their own index, not one correlated lookup per outer row. Exact:
    // the outer side is a row or a required column (never NULL), and the list holds no NULL
    semijoin(e: any, s: PS): Frag | null {
      if (!stored(e.entity) || e.order || e.limit || !e.where) return null;
      const conj = (x: any): any[] => (x?.kind === "binary" && x.op === "and" ? [...conj(x.left), ...conj(x.right)] : [x]);
      const outerName = (x: any) => x?.kind === "name" && (s.env.get(x.name)?.kind === "row" || s.env.get(x.name)?.kind === "col");
      const readsOuter = (x: any): boolean => !!x && typeof x === "object" && (Array.isArray(x) ? x.some(readsOuter) : outerName(x) || Object.entries(x).some(([k, v]) => k !== "pos" && readsOuter(v)));
      const parts = conj(e.where);
      for (const [i, c] of parts.entries()) {
        if (c?.kind !== "binary" || c.op !== "==") continue;
        const [inner, outer] = c.left?.kind === "rowfield" && outerName(c.right) ? [c.left, c.right] : c.right?.kind === "rowfield" && outerName(c.left) ? [c.right, c.left] : [];
        if (!inner) continue;
        const rest = parts.filter((_, j) => j !== i);
        if (rest.some(readsOuter)) return null;
        const b = s.env.get(outer.name)!;
        const o: Col = b.kind === "row" ? { sql: `${b.alias}.id`, params: [], k: "ref", entity: b.entity, nullable: false } : (b as any).col;
        if (!o || o.nullable || o.k === "json" || o.k === "time") return null;
        const alias = `t${++this.aliases}`;
        const ps: PS = { alias, entity: e.entity, env: s.env, depth: s.depth + 1, neg: false };
        const f = this.field(alias, e.entity, inner.name);
        if (!f || f.k === "json" || f.k === "time" || (f.k === "ref") !== (o.k === "ref" || o.k === "id")) return null;
        // a column that can be NULL is kept out of the list (IN with a NULL would differ under
        // a not); one that never is needs no such test
        const conds = f.nullable ? [`${f.sql} IS NOT NULL`] : [];
        let params: string[] = [];
        for (const r of rest) {
          const w = this.bool(r, ps); if (!w) return null;
          if (w.sql === FALSE_SQL) return { sql: FALSE_SQL, params: [] };   // nothing in the list
          if (w.sql !== TRUE_SQL) { conds.push(w.sql); params = [...params, ...w.params]; }
        }
        return { sql: `(${o.sql} IN (SELECT ${f.sql} FROM ${sq(e.entity)} ${alias}${conds.length ? ` WHERE ${conds.join(" AND ")}` : ""}))`, params: [...o.params, ...params] };
      }
      return null;
    }
    subquery(e: any, s: PS): { from: string; where: string; params: string[] } | null {
      if (!stored(e.entity) || e.order || e.limit) return null;
      const alias = `t${++this.aliases}`;
      const inner: PS = { alias, entity: e.entity, env: s.env, depth: s.depth + 1, neg: false };
      if (!e.where) return { from: `${sq(e.entity)} ${alias}`, where: "1", params: [] };
      const w = this.bool(e.where, inner);
      return w ? { from: `${sq(e.entity)} ${alias}`, where: w.sql, params: w.params } : null;
    }
    inline(e: any, s: PS, compile: (body: any, inner: PS) => Frag | null): Frag | null {
      const d = get("predicate", e.name) ?? get("fn", e.name);
      if (!d || d.params.length !== e.args.length || Object.keys(e.named ?? {}).length) return null;
      const env = new Map<string, Bind>();
      for (const [i, p] of d.params.entries()) {
        const a = e.args[i];
        if (this.rowFree(a, s.env)) { const t = this.typed(a, s.env); env.set(p.name, { kind: "value", code: box(t), t, src: a, srcEnv: s.env }); continue; }
        if (a.kind === "it") { env.set(p.name, { kind: "row", alias: s.alias, entity: s.entity }); continue; }
        if (a.kind === "name" && s.env.get(a.name)?.kind === "row") { env.set(p.name, s.env.get(a.name)!); continue; }
        const c = this.column(a, s); if (!c) return null;
        env.set(p.name, { kind: "col", col: c });
      }
      return compile(d.body, { ...s, env, depth: s.depth + 1 });
    }
    plan(entity: string, where: any, permName?: string, perm?: any): { sql: string; params: string[]; residual: Expr[]; permResidual: boolean; never: boolean } {
      const conj: any[] = [];
      const flat = (x: any) => { if (x?.kind === "binary" && x.op === "and") { flat(x.left); flat(x.right); } else if (x) conj.push(x); };
      flat(where);
      const s: PS = { alias: "t0", entity, env: new Map(), depth: 0 };
      const parts: string[] = [], params: string[] = [], residual: Expr[] = [];
      // a part this shape makes true is left out; one it makes false: no rows (never)
      let never = false;
      const take = (f: Frag) => { if (f.sql === FALSE_SQL) never = true; else if (f.sql !== TRUE_SQL) { parts.push(f.sql); params.push(...f.params); } };
      for (const c of conj) { const f = this.bool(c, s); if (f) take(f); else residual.push(c); }
      let permResidual = false;
      if (perm) {
        const f = this.bool(perm, { ...s, env: new Map([[permName!, { kind: "row", alias: "t0", entity } as Bind]]) });
        if (f) take(f); else permResidual = true;
      }
      return { sql: parts.join(" AND "), params, residual, permResidual, never };
    }
  }

  // ---- statements
  type Out = string[];
  function stmts(ss: Stmt[], s: CS, out: Out, ind: string) { for (const st of ss) stmt(st, s, out, ind); }
  // each statement's first line names its spec line (specLines turns that into a //line directive)
  function stmt(st: Stmt, s: CS, out: Out, ind: string) {
    const at = out.length;
    stmtIn(st, s, out, ind);
    if (out.length > at && st.pos) out[at] += ` // @spec ${st.pos.line}`;
  }
  // a require's refusal, worded by lang/explain.ts
  function refusal(st: any, s: CS): string {
    const why = explain.require(st.cond, st.outcome, st.reason, (n) => !!s.types?.get(n));
    if (st.outcome === "not_found") return `c.RefuseHidden(${why.hidden.map(q).join(", ")})`;
    return `rt.RefuseWhy(${q(st.outcome)}, ${q(why.message)}, ${q(why.hint)}, "require")`;
  }
  function stmtIn(st: Stmt, s: CS, out: Out, ind: string) {
    const w = (line: string) => out.push(ind + line);
    switch (st.kind) {
      case "require": w(`if !(${exB(st.cond, s)}) { ${refusal(st, s)} }`); return;
      case "reject": w(`rt.RefuseWhy(${q(st.outcome)}, ${q(st.reason ?? "rejected")}, "", "reject")`); return;
      case "let": {
        if (s.typable?.has(st.name) && !(s.wf && st.value.kind === "extern")) {
          const t = tx(st.value, s);
          if (t.g !== "val" && t.g !== "none") { const v = `v_${ident(st.name)}`; w(`${v} := ${t.c}; _ = ${v}`); s.tlocals!.set(st.name, { c: v, g: t.g }); return; }
        }
        w(`c.Vars[${q(st.name)}] = ${s.wf && st.value.kind === "extern" ? externRun(st.value, s) : ex(st.value, s)}`); return;
      }
      case "result": w(`c.SetResult(${ex(st.value, s)})`); return;
      case "callstmt": w(`_ = ${s.wf && st.call.kind === "extern" ? externRun(st.call, s) : ex(st.call, s)}`); return;
      case "rate_limit": w(`c.RateLimit(${st.pos.line}, ${ex(st.by, s)}, ${st.n}, rt.DurMS(${ex(st.per, s)}), ${q(st.outcome)})`); return;
      case "create": {
        const ent = ents.get(st.entity) ?? fail(`unknown entity ${st.entity}`, st.pos);
        const typed = createTyped(st, s);
        if (typed) {
          w(`{ ${typed}; ${st.as && s.typable?.has(st.as) ? `v_${ident(st.as)} = ref` : st.as ? `c.Vars[${q(st.as)}] = ref` : "_ = ref"} }`);
          if (st.as && s.typable?.has(st.as)) { out.splice(out.length - 1, 0, `${ind}var v_${ident(st.as)} rt.Ref; _ = v_${ident(st.as)}`); s.tlocals!.set(st.as, { c: `v_${ident(st.as)}`, g: "ref" }); }
          return;
        }
        let mask = 0n;
        const given = st.fields.map((a: any) => {
          const i = ent.fields.findIndex((f: any) => f.name === a.name);
          if (i < 0) fail(`${st.entity} has no field ${a.name}`, st.pos);
          mask |= 1n << BigInt(i);
          return `f[${i}] = ${ex(a.value, s)}`;
        });
        w(`{ f := make([]rt.Val, ${ent.fields.length}); ${given.join("; ")}${given.length ? "; " : ""}ref, _ := C_${ident(st.entity)}(c, f, ${mask}, ${!!st.ensure}); ${st.as && s.typable?.has(st.as) ? `v_${ident(st.as)} = ref` : st.as ? `c.Vars[${q(st.as)}] = ref` : "_ = ref"} }`);
        if (st.as && s.typable?.has(st.as)) { out.splice(out.length - 1, 0, `${ind}var v_${ident(st.as)} rt.Ref; _ = v_${ident(st.as)}`); s.tlocals!.set(st.as, { c: `v_${ident(st.as)}`, g: "ref" }); }
        return;
      }
      case "set": { const te = entOf(st.target, s); w(te && fieldIndex(te, st.name) >= 0 ? `SET_${ident(te)}_${ident(st.name)}(c, ${ex(st.target, s)}, ${ex(st.value, s)})` : `c.Set(${ex(st.target, s)}, ${q(st.name)}, ${ex(st.value, s)})`); return; }
      case "touch": w(`c.Touch(${ex(st.target, s)})`); return;
      case "delete": w(`c.Delete(${ex(st.target, s)})`); return;
      case "deleteWhere": w(`c.DeleteRows(${E(st.entity)}, ${rowsCode({ entity: st.entity, where: st.where }, s)})`); return;
      case "foreach": {
        // for each x in E where p { set x.f = v … }: one write, where that is exact (c.SetWhere)
        const bulk = setWhere(st, s);
        if (bulk) { w(bulk); return; }
        // for each u in E where p { ensure F { key: fixed, other: u } }: the rows already there
        // found in one query, the rest inserted in batches (CTE_)
        const many = ensureLoop(st, s);
        if (many) { for (const l of many) w(l); return; }
        // a plain loop: the rows are chosen first, a row deleted meanwhile is skipped, the row is
        // a typed local (and a variable, for what reads it dynamically)
        const n = loopN++, rows = `rows${n}`, row = `row${n}`, v = `v_${ident(st.bind)}${n}`;
        w(`${rows} := ${rowsCode({ entity: st.entity, where: st.where }, s)}`);
        for (const p of nestedPrefetch(st, rows)) w(p);
        w(`for _, ${row} := range ${rows} {`);
        w(`\tif c.S.Find(${E(st.entity)}, ${row}.ID) == nil { continue }`);
        w(`\tc := c.Child(); c.Row, c.RowE = nil, nil`);
        w(`\t${v} := rt.Ref{E: ${q(st.entity)}, ID: ${row}.ID}; c.Vars[${q(st.bind)}] = ${v}`);
        cost.pushLoop(`for each ${st.bind} in ${st.entity}`);
        const tl = new Map(s.tlocals ?? []);
        tl.set(st.bind, { c: v, g: "ref" });
        stmts(st.body, { ...s, row: undefined, tlocals: tl }, out, ind + "\t");
        cost.popLoop();
        w("}");
        return;
      }
      case "foreachList": {
        w(`c.ForList(${ex(st.over, s)}, ${q(st.bind)}, func(c *rt.Ctx) {`);
        cost.pushLoop(`for each ${st.bind}`);
        stmts(st.body, { ...s, row: undefined }, out, ind + "\t");
        cost.popLoop();
        w("})");
        return;
      }
      case "if": {
        w(`if ${exB(st.cond, s)} {`);
        stmts(st.then, s, out, ind + "\t");
        if (st.else?.length) { w("} else {"); stmts(st.else, s, out, ind + "\t"); }
        w("}");
        return;
      }
      case "sendmail": {
        const f = (k: string) => (st.fields[k] ? ex(st.fields[k], s) : "rt.Val(nil)");
        w(`c.SendMail(${f("to")}, ${f("subject")}, ${f("text")}, ${f("unsubscribe")})`);
        return;
      }
      case "emit": {
        const ts = triggerKey("event", st.event);
        w(`{ args := []rt.Val{${st.args.map((a: Expr) => ex(a, s)).join(", ")}}; c.Emit(${q(st.event)}, args...)${ts.length ? `; if !c.NoTriggers { first := rt.Arg(args, 0); ${ts.map((i) => `T_${i}(c, first, nil)`).join("; ")} }` : ""} }`);
        return;
      }
    }
    fail(`unknown statement ${st.kind}`, st.pos);
  }
  // the body's top-level lets and creates whose name is bound nowhere else
  function typableNames(body: Stmt[], taken: string[]): Set<string> {
    const count = new Map<string, number>();
    const walk = (x: any) => {
      if (!x || typeof x !== "object") return;
      if (Array.isArray(x)) { x.forEach(walk); return; }
      const n = x.kind === "let" && typeof x.name === "string" ? x.name : x.kind === "create" ? x.as : (x.kind === "foreach" || x.kind === "foreachList") ? x.bind : undefined;
      if (n) count.set(n, (count.get(n) ?? 0) + 1);
      for (const [k, v] of Object.entries(x)) if (k !== "pos") walk(v);
    };
    walk(body);
    // a name bound once in the whole body, at any depth: a Go variable of the block it is bound
    // in (the language scopes it to that block too)
    const out = new Set<string>();
    for (const [n, k] of count) if (k === 1 && !taken.includes(n)) out.add(n);
    return out;
  }
  // every name a body may bind
  function binders(x: any, out = new Set<string>()): Set<string> {
    if (!x || typeof x !== "object") return out;
    if (Array.isArray(x)) { for (const y of x) binders(y, out); return out; }
    if (x.kind === "let" && typeof x.name === "string") out.add(x.name);
    if (x.kind === "create" && x.as) out.add(x.as);
    if ((x.kind === "foreach" || x.kind === "foreachList") && x.bind) out.add(x.bind);
    for (const [k, v] of Object.entries(x)) if (k !== "pos") binders(v, out);
    return out;
  }

  typeEvents();
  const triggerKey = (kind: string, entity: string, field = "") => decls.filter((d) => d.kind === "trigger").map((t, i) => [t, i] as [Decl, number])
    .filter(([t]) => t.on.kind === kind && (kind === "event" ? t.on.event === entity : t.on.entity === entity && (kind !== "update" || t.on.field === field))).map(([, i]) => i);
  const fireCode = (kind: string, entity: string, field: string, subject: string, old: string) => {
    const ts = triggerKey(kind, entity, field);
    return ts.length ? `if !c.NoTriggers { ${ts.map((i) => `T_${i}(c, ${subject}, ${old})`).join("; ")} }` : "";
  };
  // ---- the program
  const go: string[] = [];
  const P = (line = "") => go.push(line);
  const goParam = (p: any) => `{Name: ${q(p.name)}, Type: ${q(p.type.kind === "set" ? "set" : p.type.kind === "list" ? "list" : p.type.name)}, Of: ${q(p.type.of && typeof p.type.of === "string" ? p.type.of : "")}, Optional: ${!!(p.type.kind === "named" && p.type.optional)}}`;
  const goParams = (ps: any[]) => `[]rt.Param{${ps.map(goParam).join(", ")}}`;

  // each enum's labels: the declared ones, else the name made readable
  for (const d of decls.filter((d) => d.kind === "enum")) P(`var EL_${ident(d.name)} = map[string]string{${d.values.map((v: string) => `${q(v)}: ${q(d.labels?.[v] ?? readable(v))}`).join(", ")}}`);
  // entities
  for (const [n, d] of ents) {
    const fields = d.fields.map((f: any) => {
      const t = f.type.kind === "named" ? f.type.name : f.type.kind;
      const kind = ents.has(t) ? "r" : TEXTLIKE.has(t) || enums.has(t) ? "t" : t === "Int" ? "i" : t === "Bool" ? "b" : "j";
      return `{Name: ${q(f.name)}, Kind: '${kind}', Ref: ${q(ents.has(t) ? t : "")}, Type: ${q(t)}, Optional: ${!!(f.type.kind === "named" && f.type.optional)}}`;
    });
    P(`var E_${ident(n)} = &rt.Entity{Name: ${q(n)}, Fields: []rt.Field{${fields.join(", ")}}, Uniques: [][]string{${(d.uniques ?? []).map((u: string[]) => `{${u.map(q).join(", ")}}`).join(", ")}}, Stored: ${d.kind === "entity"}, Singleton: ${!!d.singleton}}`);
  }
  P();

  // functions and predicates: Go functions over their parameters
  for (const d of [...of("fn"), ...of("predicate")]) {
    const s = scope({ tlocals: typedParams(d.params), types: paramTypes(d.params) });
    const sig = typedSig(d.params);
    cost.pushDecl(`${d.kind} ${d.name}`);
    if (d.kind === "predicate") P(`func P_${ident(d.name)}(c *rt.Ctx${sig ? ", " + sig : ""}) bool { c = c.NoRow(); return ${exB(d.body, s)} }`);
    else { const g = gOfDecl(d.returns); P(`func F_${ident(d.name)}(c *rt.Ctx${sig ? ", " + sig : ""}) ${goType(g)} { c = c.NoRow(); return ${convert(tx(d.body, s), g)} }`); }
    cost.popDecl();
  }
  P();
  // read permissions: whether the row (bound to the entity's snake-case name) may be read
  for (const [entity, cond] of perms) {
    const locals = new Map([[snake(entity), "row"]]);
    cost.pushDecl(`permission ${entity}`);
    P(`func Perm_${ident(entity)}(c *rt.Ctx, row rt.Val) bool { c = c.NoRow(); return ${exB(cond, scope({ locals, types: new Map([[snake(entity), entity]]) }))} }`);
    cost.popDecl();
  }
  P();

  // actions
  for (const a of of("action")) {
    const s = scope({ dyn: new Set([...a.params.map((p: any) => p.name), ...binders(a.body)]), types: paramTypes(a.params), tlocals: new Map(), typable: typableNames(a.body, a.params.map((p: any) => p.name)) });
    bodyTypes(a.body, s);
    // parameters the body never binds again: typed Go variables, read from the call's
    // variables once. An entity parameter stays lazy (a typed rt.Lazy), so a missing row is
    // not_found only where it is used; a set's members were checked when it was bound
    const rebound = binders(a.body), heads: string[] = [];
    for (const pp of a.params) {
      const g = gOfDecl(pp.type);
      if (rebound.has(pp.name)) continue;
      if (g === "ref" || g === "set") {
        const v = `l_${ident(pp.name)}`;
        heads.push(g === "ref" ? `\t${v} := c.LazyVar(${q(pp.name)}); _ = ${v}` : `\t${v} := rt.AsSet(c.Var(${q(pp.name)})); _ = ${v}`);
        s.tlocals!.set(pp.name, { c: g === "ref" ? `c.RefOf(${v})` : v, g });
        continue;
      }
      if (["val", "none"].includes(g)) continue;
      const v = `l_${ident(pp.name)}`;
      heads.push(`\t${v} := ${unbox(`c.Var(${q(pp.name)})`, g as G).c}; _ = ${v}`);
      s.tlocals!.set(pp.name, { c: v, g });
    }
    const out: Out = [];
    cost.pushDecl(`action ${a.name}`);
    stmts(a.body, s, out, "\t");
    cost.popDecl();
    P(`func A_${ident(a.name)}(c *rt.Ctx) {`);
    for (const pp of a.params) if (pp.max !== undefined || pp.min !== undefined) P(`\trt.CheckSize(c.Var(${q(pp.name)}), ${pp.max ?? -1}, ${pp.min ?? -1}, ${q(pp.name)})`);
    go.push(...heads, ...out);
    // an invariant not proven for this action: checked before it commits, and refused if broken
    for (const inv of decls.filter((d) => d.kind === "invariant")) if (backstops.has(`action ${a.name}|${inv.name}`))
      P(`\tif !rt.Holds(func() bool { return ${exB(inv.cond, scope({ dyn: new Set(), types: new Map() }))} }) { rt.Refuse("invalid", ${q(`invariant ${inv.name} would no longer hold (not proven for ${a.name} at build, so checked when it runs)`)}, "invariant") }`);
    P("}");
    // the guards: the leading lets and requires, up to the first statement that writes
    for (const typed of [false, true]) {
      const gs = { ...s, tlocals: typed ? typedParams(a.params) : new Map() };
      P(typed ? `func GT_${ident(a.name)}(c *rt.Ctx${a.params.length ? ", " + typedSig(a.params) : ""}) (string, string) {` : `func G_${ident(a.name)}(c *rt.Ctx) (string, string) {`);
      for (const st of a.body) {
        if (st.kind === "let") { const o: Out = []; stmt(st, gs, o, "	"); go.push(...o); }
        else if (st.kind === "require") P(`\tif !(${exB(st.cond, gs)}) { return ${q(st.outcome)}, "require" }`);
        else if (st.kind === "rate_limit") continue;
        else break;
      }
      P(`\treturn "ok", ""`);
      P("}");
    }
  }
  P();

  // schedules: each one's time for a row and its condition, read again in the run's transaction
  const scheduleOf = (d: any) => {
    let a = d.at, off = 0;
    if (a?.kind === "binary" && (a.op === "+" || a.op === "-") && a.right.kind === "duration") { off = durMS(a.right) * (a.op === "-" ? -1 : 1); a = a.left; }
    return { field: a?.name as string, off };
  };
  const durMS = (x: any) => x.amount * ({ ms: 1, s: 1000, min: 60_000, h: 3_600_000, day: 86_400_000 } as Record<string, number>)[x.unit];
  for (const d of of("schedule") as any[]) {
    if (!d.entity) continue;
    const ps = [{ name: d.bind, type: { kind: "named", name: d.entity, optional: false } }];
    const s = scope({ dyn: new Set([d.bind]), types: paramTypes(ps) });
    P(`func SAT_${ident(d.name)}(c *rt.Ctx) rt.Val { return ${ex(d.at, s)} }`);
    P(`func SW_${ident(d.name)}(c *rt.Ctx) bool { return ${d.where ? exB(d.where, s) : "true"} }`);
  }
  P();

  // views
  for (const v of of("view")) {
    const s = scope({ dyn: new Set(v.params.map((p: any) => p.name)), types: paramTypes(v.params) });
    P(`func VR_${ident(v.name)}(c *rt.Ctx) (string, string, string) {`);
    for (const r of v.requires) {
      const why = explain.require(r.cond, r.outcome, r.reason, (n) => !!s.types?.get(n));
      P(`\tif !(${exB(r.cond, s)}) { return ${q(r.outcome)}, ${r.outcome === "not_found" ? `c.HiddenMsg(${why.hidden.map(q).join(", ")})` : q(why.message)}, ${q(why.hint)} }`);
    }
    P(`\treturn "", "", ""`);
    P("}");
    if (v.value) {
      P(`func VV_${ident(v.name)}(c *rt.Ctx) rt.Val { return ${v.value.kind === "extern" ? externRun(v.value, s) : ex(v.value, s)} }`);
      continue;
    }
    const entity = v.rows.entity;
    const perm = perms.get(entity);
    cost.pushDecl(`view ${v.name}`);
    // the order may be the rows' own (rows E where … order by …) or the view's
    const lit = queryLit({ entity, where: v.rows.where, order: v.rows.order ?? v.order, desc: v.rows.order ? v.rows.desc : v.desc, limit: v.rows.limit, windowed: !!(v.window || v.limit || v.page) }, s, perm ? { name: snake(entity), cond: perm } : undefined);
    cost.popDecl();
    const win: string[] = [];
    if (v.around) win.push(`AroundAt: func(c *rt.Ctx) rt.Val { return ${ex(v.around.at, s)} }`, `AroundSize: ${v.around.size}`);
    if (v.window) {
      win.push(`Size: ${v.window.size}`, `End: ${q(v.window.end)}`);
      if (v.window.unless) win.push(`Unless: func(c *rt.Ctx) bool { return ${exB(v.window.unless, s)} }`);
    }
    if (v.limit) win.push(`Limit: func(c *rt.Ctx) rt.Val { return ${ex(v.limit, s)} }`);
    if (v.page) win.push(`Page: ${v.page}`);
    P(`func VRows_${ident(v.name)}(c *rt.Ctx) []*rt.Row {`);
    // no window and the whole query a statement: that statement, called directly
    const dc = !win.length && !(perm && !lit.permDone) ? directCode(lit, "rows") : null;
    if (dc) { P(`\treturn ${dc}`); P("}"); continue; }
    for (const h of lit.hoisted) P(`\t${h}`);
    const qargs = lit.args.map((x) => `, ${x}`).join("");
    // a window over rows the database can order: only the window's rows are read
    if (win.length && lit.pushed && !(perm && !lit.permDone)) P(`\treturn c.WindowRows(${lit.lit}, &rt.Window{${win.join(", ")}}${qargs})`);
    else {
      P(`\trows := c.Rows(${lit.lit}${qargs})`);
      if (perm && !lit.permDone) P(`\trows = rt.Filter(rows, func(r *rt.Row) bool { return Perm_${ident(entity)}(c, rt.Ref{E: ${q(entity)}, ID: r.ID}) })`);
      P(win.length ? `\treturn c.ViewWindow(rows, &rt.Window{${win.join(", ")}})` : "\treturn rows");
    }
    P("}");
  }
  P();

  // triggers, dispatched by event
  const triggers = of("trigger");
  triggers.forEach((t, i) => {
    const s = scope({ tlocals: new Map(), typable: typableNames(t.body, [t.bind, "old"]), dyn: new Set([t.bind, "old", ...binders(t.body)]), types: new Map([["old", ""], [t.bind, t.on.kind === "create" || t.on.kind === "update" ? t.on.entity : t.on.kind === "event" ? eventTypes.get(t.on.event) ?? "" : ""]]) });
    // the row it fires for (a create or update of an entity): a typed local
    const subjRef = (t.on.kind === "create" || t.on.kind === "update") && ents.has(t.on.entity) && !binders(t.body).has(t.bind);
    if (subjRef) s.tlocals!.set(t.bind, { c: `l_${ident(t.bind)}`, g: "ref" });
    bodyTypes(t.body, s);
    const out: Out = [];
    cost.pushDecl(`trigger ${t.name}`);
    stmts(t.body, s, out, "\t");
    P(`func T_${i}(c *rt.Ctx, subject, old rt.Val) {`);
    P(`\tc = c.Trigger(${q(t.bind)}, subject, old, ${q(t.on.kind)})`);
    if (subjRef) P(`\tl_${ident(t.bind)} := rt.AsRef(subject); _ = l_${ident(t.bind)}`);
    if (t.when) P(`\tif !(${exB(t.when, s)}) { return }`);
    cost.popDecl();
    go.push(...out);
    P("}");
  });
  P();

  // workflows: their steps, by event, in the spec's order
  const steps = new Map<string, string[]>();
  of("workflow").forEach((w, i) => {
    w.steps.forEach((step: any, j: number) => {
      const s = scope({ dyn: new Set([w.bind, ...binders(step.body)]), wf: true, types: new Map([[w.bind, eventTypes.get(w.event) ?? ""]]), tlocals: new Map(), typable: typableNames(step.body, [w.bind]) });
      // the event's row, when it is one: a typed local
      const argRef = ents.has(eventTypes.get(w.event) ?? "") && !binders(step.body).has(w.bind);
      if (argRef) s.tlocals!.set(w.bind, { c: `l_${ident(w.bind)}`, g: "ref" });
      bodyTypes(step.body, s);
      const out: Out = [];
      cost.pushDecl(`${w.name}`);
      stmts(step.body, s, out, "\t");
      cost.popDecl();
      P(`func W_${i}_${j}(c *rt.Ctx, arg rt.Val) { // ${w.event}: ${step.name}`);
      P(`\tc.Vars[${q(w.bind)}] = arg`);
      if (argRef) P(`\tl_${ident(w.bind)} := rt.AsRef(arg); _ = l_${ident(w.bind)}`);
      go.push(...out);
      // an invariant not proven for this step: checked after it, and reported if broken
      for (const inv of decls.filter((d) => d.kind === "invariant")) if (backstops.has(`${w.name}: ${step.name}|${inv.name}`))
        P(`\tif !rt.Holds(func() bool { return ${exB(inv.cond, scope({ dyn: new Set(), types: new Map() }))} }) { rt.InvariantBroken(${q(`${inv.name}, after ${w.name}: ${step.name}`)}) }`);
      P("}");
      steps.set(w.event, [...(steps.get(w.event) ?? []), `W_${i}_${j}`]);
    });
  });
  P();

  // ---- the UI
  const ambient = ["theme", "app", "client", "input"];
  const uiNames = new Set<string>([...ambient, "result", "typed"]);
  const walkUI = (els: El[]) => { for (const el of els) { if (el.name === "let") uiNames.add(el.head.name); if (el.name === "each" || el.name === "list") uiNames.add(el.head.bind); walkUI(el.children); if (el.else) walkUI(el.else); } };
  for (const d of decls) {
    if (d.kind === "screen" || d.kind === "component") { for (const p of d.params ?? []) uiNames.add(p.name); walkUI(d.body); }
    if (d.kind === "layout") walkUI(d.body);
  }
  const uiBase = scope({ dyn: uiNames });
  let ui = uiBase;
  // a screen's or component's names that hold rows: its parameters, lets and loop variables
  const uiTypes = (d: Decl): Map<string, string> => {
    const m = paramTypes(d.params);
    const sc = scope({ dyn: uiNames, types: m });
    const walk = (els: El[]) => { for (const x of els) {
      if (x.name === "let") addType(m, x.head.name, entOf(x.head.value, sc));
      if (x.name === "each") addType(m, x.head.bind, x.head.over.kind === "listq" ? (x.head.over.map ? entOf(x.head.over.map, scope({ row: x.head.over.entity })) : x.head.over.entity) : null);
      if (x.name === "list") addType(m, x.head.bind, x.head.source.kind === "query" ? x.head.source.entity : get("view", x.head.source.name)?.rows?.entity ?? null);
      walk(x.children); if (x.else) walk(x.else);
    } };
    walk(d.body ?? []);
    return m;
  };
  const fnc = (e: Expr | undefined, s: CS = ui) => (e ? `func(c *rt.Ctx) rt.Val { return ${ex(e, s)} }` : "nil");
  const target = (t: any, s: CS = ui): string => {
    if (t.kind === "url") return `&rt.Target{URL: ${fnc(t.value, s)}}`;
    const named = Object.entries(t.named ?? {}).map(([k, v]) => `{Name: ${q(k)}, E: ${fnc(v as Expr, s)}}`);
    return `&rt.Target{Name: ${q(t.name)}, Bare: ${!!t.bare}, Args: []rt.Expr{${(t.args ?? []).map((a: Expr) => fnc(a, s)).join(", ")}}, Named: []rt.NamedExpr{${named.join(", ")}}}`;
  };
  let elId = 0;
  // Elements whose HTML may be kept in the fragment cache (rt/cache.go): none that set the page's
  // title, open a channel, write to a slot, or read the clock or a random token, here or in a
  // component they use. (Reading the clock while rendering is also caught at run time.)
  const SIDE = new Set(["title", "channel", "nav", "main", "footer", "sidebar"]);
  const cacheMemo = new Map<string, boolean>();
  const pureExpr = (x: any): boolean => {
    if (!x || typeof x !== "object") return true;
    if (Array.isArray(x)) return x.every(pureExpr);
    if (x.kind === "now" || (x.kind === "call" && ["token", "signed"].includes(x.name))) return false;
    return Object.entries(x).every(([k, v]) => k === "pos" || pureExpr(v));
  };
  const cacheable = (els: El[]): boolean => els.every((x) => {
    if (SIDE.has(x.name)) return false;
    if (x.name === "use") {
      const name = x.head.name;
      if (!cacheMemo.has(name)) { cacheMemo.set(name, true); const c = get("component", name); cacheMemo.set(name, !!c && cacheable(c.body)); }
      if (!cacheMemo.get(name)) return false;
    }
    return pureExpr(x.head) && pureExpr(x.attrs) && cacheable(x.children) && cacheable(x.else ?? []);
  });
  const componentCacheable = (name: string) => { const c = get("component", name); return !!c && cacheable([{ name: "use", head: { name }, attrs: {}, children: [], pos: c.pos } as any]); };
  let atScreen = false;   // compiling a screen's own elements (not a component's, nor a list's items)
  let loopNames: string[] = [];   // the loop variables around the element being compiled
  const loopVars = () => `rc.LoopVars(${loopNames.map(q).join(", ")})`;
  // names bound in a body (lets and loop variables), counted: one bound once can be typed
  let uiBinds = new Map<string, number>();
  const countBinds = (els: El[], m = new Map<string, number>()) => { for (const x of els) {
    const n = x.name === "let" ? x.head.name : x.name === "each" || x.name === "list" ? x.head.bind : undefined;
    if (n) m.set(n, (m.get(n) ?? 0) + 1);
    countBinds(x.children, m); if (x.else) countBinds(x.else, m);
  } return m; };
  // a loop variable that holds a row, bound once: a typed Go variable (rt.Ref) in the loop body
  const typedLoopVar = (bind: string, item: string, at: (s: string) => void): (() => void) => {
    const e = ui.types?.get(bind);
    if (!e || !ents.has(e) || uiBinds.get(bind) !== 1 || ui.tlocals?.has(bind)) return () => {};
    const v = `u_${ident(bind)}`;
    at(`\t${v} := rt.AsRef(${item}); _ = ${v}`);
    ui.tlocals!.set(bind, { c: v, g: "ref" });
    return () => { ui.tlocals!.delete(bind); };
  };
  const ids = new Map<El, number>();
  const number = (els: El[]) => { for (const el of els) { ids.set(el, ++elId); number(el.children); if (el.else) number(el.else); } };
  for (const d of decls) if (d.body && Array.isArray(d.body) && ["screen", "component", "layout"].includes(d.kind)) number(d.body);
  // ---- prefetch plans: for a list's rows, what its body will read through the row variable
  //   - the rows its references point at (m.creator), and theirs in turn (m.creator.x);
  //   - child lists keyed by it (list Boost where .message == m), and what they read.
  // Read from the elements, the components they use and the functions they call.
  type Plan = { refs: Map<number, Plan>; kids: { entity: string; col: number; where: string; order: string; plan: Plan }[] };
  const newPlan = (): Plan => ({ refs: new Map(), kids: [] });
  const isPlanEmpty = (p: Plan): boolean => p.refs.size === 0 && p.kids.length === 0;
  function planFor(els: El[], v: string, ent: string, depth = 0, seen = new Set<string>()): Plan {
    const plan = newPlan();
    if (depth > 3 || !stored(ent)) return plan;
    const addChain = (p: Plan, e: string, chain: string[]) => {
      if (!chain.length) return;
      const i = fieldIndex(e, chain[0]);
      if (i < 0) return;
      const f = ents.get(e)!.fields[i];
      if (f.type.kind !== "named" || !ents.has(f.type.name) || !stored(f.type.name)) return;
      if (!p.refs.has(i)) p.refs.set(i, newPlan());
      addChain(p.refs.get(i)!, f.type.name, chain.slice(1));
    };
    // field chains from the variable, in an expression (and in the functions it calls)
    const scanExpr = (x: any, name: string, p: Plan, e: string, fnSeen: Set<string>) => {
      if (!x || typeof x !== "object") return;
      if (Array.isArray(x)) { for (const y of x) scanExpr(y, name, p, e, fnSeen); return; }
      if (x.kind === "field") {
        const chain: string[] = []; let t = x;
        while (t?.kind === "field") { chain.unshift(t.name); t = t.target; }
        if (t?.kind === "name" && t.name === name) addChain(p, e, chain);
      }
      if (x.kind === "call") {
        const d = get("predicate", x.name) ?? get("fn", x.name);
        if (d) d.params.forEach((pr: any, i: number) => {
          const a = x.args[i];
          if (a?.kind === "name" && a.name === name && !fnSeen.has(`${d.name}:${pr.name}`)) { fnSeen.add(`${d.name}:${pr.name}`); scanExpr(d.body, pr.name, p, e, fnSeen); }
        });
      }
      for (const [k, y] of Object.entries(x)) if (k !== "pos") scanExpr(y, name, p, e, fnSeen);
    };
    const walk = (xs: El[], name: string, p: Plan) => {
      for (const x of xs) {
        const h = x.head;
        if (x.name === "let" && h.name === name) return;   // rebound from here on
        for (const a of Object.values(x.attrs)) if (a !== true) scanExpr(a, name, p, ent, new Set());
        if (x.name === "list" && h.source.kind === "query") {
          const src = h.source, w = src.where;
          const eqVar = (a: any, b: any) => a?.kind === "rowfield" && b?.kind === "name" && b.name === name;
          if (w?.kind === "binary" && w.op === "==" && (eqVar(w.left, w.right) || eqVar(w.right, w.left)) && !src.limit && stored(src.entity)) {
            const colName = (eqVar(w.left, w.right) ? w.left : w.right).name;
            const col = fieldIndex(src.entity, colName);
            const f = ents.get(src.entity)!.fields[col];
            if (col >= 0 && f.type.kind === "named" && f.type.name === ent)
              // the key is the per-parent query's SQL exactly as the planner writes it (a row is
              // always present, so =): the prefetched answers are found under it
              p.kids.push({ entity: src.entity, col, where: `(t0.${sq(colName)} = ?)`, order: sqlOrderOf(src) ?? "t0.seq", plan: h.bind === name ? newPlan() : planFor(x.children, h.bind, src.entity, depth + 1, seen) });
          }
          scanExpr(src, name, p, ent, new Set());
          if (h.bind !== name) walk(x.children, name, p);
          continue;
        }
        if (x.name === "each" && h.bind === name) { scanExpr(h.over, name, p, ent, new Set()); continue; }
        if (h && typeof h === "object") scanExpr(x.name === "use" ? h.args : h, name, p, ent, new Set());
        if (x.name === "use") {
          const comp = get("component", h.name);
          if (comp) comp.params.forEach((pr: any, i: number) => {
            const a = h.args[i];
            const k = `${comp.name}:${pr.name}`;
            if (a?.kind === "name" && a.name === name && !seen.has(k)) { seen.add(k); const sub = planFor(comp.body, pr.name, ent, depth, seen); mergePlan(p, sub); seen.delete(k); }
          });
        }
        walk(x.children, name, p);
        if (x.else) walk(x.else, name, p);
      }
    };
    walk(els, v, plan);
    return plan;
  }
  function mergePlan(into: Plan, from: Plan) {
    for (const [i, p] of from.refs) { if (!into.refs.has(i)) into.refs.set(i, newPlan()); mergePlan(into.refs.get(i)!, p); }
    for (const k of from.kids) { const have = into.kids.find((x) => x.entity === k.entity && x.col === k.col); if (have) mergePlan(have.plan, k.plan); else into.kids.push(k); }
  }
  let pfN = 0;
  // the Go statements that carry out a plan for rows held in `rowsVar` (of entity `ent`)
  function planCode(p: Plan, rowsVar: string, ent: string, out: string[]) {
    for (const [i, sub] of p.refs) {
      const t = ents.get(ent)!.fields[i].type.name;
      const v = `pf${pfN++}`;
      out.push(`${v} := rc.Ctx().S.PrefetchRefs(E_${ident(t)}, ${rowsVar}, ${i})`);
      if (isPlanEmpty(sub)) out.push(`_ = ${v}`); else planCode(sub, v, t, out);
    }
    for (const k of p.kids) {
      const v = `pf${pfN++}`;
      // kept under the number of the per-parent query's statement (the list's, when it is that)
      out.push(`${v} := rc.Ctx().S.PrefetchKids(E_${ident(k.entity)}, ${stmtNum(k.entity, k.where, k.order, ["Ref"])}, ${k.col}, ${q(k.order)}, ${rowsVar})`);
      if (isPlanEmpty(k.plan)) out.push(`_ = ${v}`); else planCode(k.plan, v, k.entity, out);
    }
  }
  // What a POST or a picker needs to find again by id: handlers, and fields with pickers.
  const registry = new Map<number, string>();
  // Every screen and component compiles to a Go function that evaluates its expressions and
  // writes its markup in order: no element tree is walked at run time.
  // ---- size estimates: a buffer's starting size is the static markup it gets, plus a quarter
  // of the size of each value written (a field's declared size, or a default by type), with
  // a loop's part times its bound
  let est = 0;
  let pendingUE: [string, number][] = [];
  const compEst = new Map<string, number>();
  const valueEst = (e: any): number => {
    if (e?.kind === "field") {
      const te = entOf(e.target, ui);
      const f = te ? ents.get(te)?.fields.find((x: any) => x.name === e.name) : undefined;
      const z = f ? fieldSize(f) : {};
      if (z.max !== undefined) return Math.ceil(z.max / 4);
    }
    const t = tyOf(e);
    return ({ text: 24, enum: 12, rich: 160, int: 6, bool: 5, time: 28, ref: 16 } as any)[t.k] ?? 16;
  };
  // a value as an element shows it: an enum value by its label
  const shown = (e: Expr | undefined) => (e && tyOf(e).k === "enum" ? UE({ kind: "call", name: "label", args: [e], named: {}, pos: e.pos } as any) : UE(e));
  // a text element's content as text: raw text and {…} parts (interp), each part as <text> shows it
  const textGo = (h: Expr): string => h.kind === "interp"
    ? h.parts.map((p: Expr) => (p.kind === "lit" && typeof p.value === "string" ? q(p.value) : `sv.TextOf(rc, ${shown(p)})`)).join(" + ")
    : `rt.Plain(${shown(h)})`;
  const UE = (e: Expr | undefined) => {
    if (!e) return "rt.Val(nil)";
    // a literal is its value: nothing to evaluate, nothing that can refuse
    if (e.kind === "lit") { const c = box(tx(e, ui)); pendingUE.push([c, valueEst(e)]); return c; }
    // so is a typed Go local (a loop's row, a typed parameter): reading it can't refuse
    if (e.kind === "name" && ui.tlocals?.has(e.name)) { const c = box(ui.tlocals.get(e.name) as TX); pendingUE.push([c, valueEst(e)]); return c; }
    const code = `rc.Ev(func(c *rt.Ctx) rt.Val { return ${ex(e, ui)} })`;
    pendingUE.push([code, valueEst(e)]);
    return code;
  };
  const loopBound = (x: El): number => {
    const h = x.head;
    // reference data has a known number of rows; a list with no bound is taken to be short
    const dataRows = (e: string) => (ents.get(e)?.kind === "data" ? ents.get(e)!.rows.length : undefined);
    if (x.name === "each") return h.over?.kind === "listlit" ? h.over.items.length : h.over?.kind === "listq" ? (h.over.limit?.kind === "lit" ? h.over.limit.value : dataRows(h.over.entity) ?? 5) : 5;
    const src = h.source;
    if (src.kind === "query") return src.limit?.kind === "lit" ? src.limit.value : dataRows(src.entity) ?? 5;
    const v = get("view", src.name);
    if (!v) return 10;
    return v.window?.size ?? v.page ?? (v.limit?.kind === "lit" ? v.limit.value : 25);
  };
  const attr = (x: El, k: string) => (x.attrs[k] === true ? "rt.Val(true)" : x.attrs[k] ? UE(x.attrs[k] as Expr) : "rt.Val(nil)");
  const has = (x: El, k: string) => k in x.attrs;
  const litStr = (e: any): string | null => (e && e !== true && e.kind === "lit" && typeof e.value === "string" ? e.value : null);
  // as rt.Esc escapes
  const escHTML = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  // an element's own class replaces the theme's class for its kind (a row's, a button's, a form's)
  const cls = (x: El, base: string) => `sv.Cls(${has(x, "class") ? `""` : base}, ${x.attrs.class ? UE(x.attrs.class as Expr) : "nil"}, ${has(x, "class")})`;
  // a field's label shows unless it says label_hidden; a link's or button's, when nothing else names it
  const visibleLabel = (x: El) => x.name === "field" ? !x.attrs.label_hidden : !has(x, "icon") && !has(x, "text") && ["submit", "button", "link"].includes(x.name);
  const label = (x: El) => {
    const l = litStr(x.attrs.label);
    if (!has(x, "label") || l === "") return `""`;
    if (l === null) return `sv.Label(${attr(x, "label")}, ${visibleLabel(x)})`;
    // a literal label is markup the generator writes (only the theme's class is looked up)
    return visibleLabel(x) ? q(`<span>${escHTML(l)}</span>`) : `"<span class=\\"" + sv.DC("screen_reader") + ${q(`">${escHTML(l)}</span>`)}`;
  };
  // a class attribute, escaped: written by the generator when it is a literal
  const clsEsc = (x: El, base: string) => {
    const l = litStr(x.attrs.class);
    if (has(x, "class")) base = `""`;   // its own class replaces the theme's
    if (base === `""` && !has(x, "class")) return `""`;
    if (base === `""` && l !== null) return q(escHTML(l.trim()));
    return `rt.Esc(${cls(x, base)})`;
  };
  const urlOf = (t: any): string => {
    if (t.kind === "url") return `sv.URLTarget(${UE(t.value)})`;
    if (t.bare && t.name === "back") return "sv.Back(rc)";
    if (t.bare && t.name === "home") return `"/"`;
    if (!get("screen", t.name)) fail(`unknown screen ${t.name}`, t.pos);
    return `sv.ScreenURL(${q(t.name)}, rt.List{${(t.args ?? []).map((a: Expr) => UE(a)).join(", ")}}, map[string]rt.Val{${Object.entries(t.named ?? {}).map(([k, v]) => `${q(k)}: ${UE(v as Expr)}`).join(", ")}})`;
  };
  const actionOf = (x: El) => get("action", x.head.name) ?? fail(`unknown action ${x.head.name}`, x.pos);
  const argMap = (t: any, params: any[]) => `map[string]rt.Val{${params.map((p: any, i: number) => `${q(p.name)}: rt.RawArg(${UE(i < t.args.length ? t.args[i] : t.named[p.name])})`).join(", ")}}`;
  const hiddenArgs = (t: any, params: any[], out: string[], ind: string) => {
    // a hidden argument: its markup the generator writes, its value written straight to the page
    const hidden = (name: string, v: string) => `${ind}w.WriteString(${q(`<input type="hidden" name="__arg_${name}" value="`)}); rt.WriteSerial(w, ${v}); w.WriteString(${q(`">`)})`;
    t.args.forEach((a: Expr, i: number) => { if (params[i]) out.push(hidden(params[i].name, UE(a))); });
    for (const [k, v] of Object.entries(t.named)) out.push(hidden(k, UE(v as Expr)));
  };
  // a write of a + b + c: one write per part, so no string is built for it
  const splitConcat = (code: string): string[] => {
    const parts: string[] = []; let depth = 0, inStr = false, start = 0;
    for (let i = 0; i < code.length; i++) {
      const ch = code[i];
      if (inStr) { if (ch === "\\") i++; else if (ch === "\"") inStr = false; continue; }
      if (ch === "\"") inStr = true;
      else if ("([{".includes(ch)) depth++;
      else if (")]}".includes(ch)) depth--;
      else if (depth === 0 && code.startsWith(" + ", i)) { parts.push(code.slice(start, i)); start = i + 3; i += 2; }
    }
    parts.push(code.slice(start));
    return parts.filter((p) => p !== "\"\"");
  };
  const W = (s: string) => {
    const parts = splitConcat(s);
    for (const part of parts) {
      if (/^"(?:[^"\\]|\\.)*"$/.test(part)) { est += JSON.parse(part).length; continue; }
      const hit = pendingUE.find(([c]) => part.includes(c));
      est += hit ? hit[1] : 16;
    }
    pendingUE = [];
    return parts.map((p) => `w.WriteString(${p})`).join("; ");
  };
  const lit = (s: string) => q(s);

  const actionSizes = new Map([...paramSizes(spec)].map(([d, m]) => [d.name, m]));
  let curForm: string | undefined;   // the form whose fields are being compiled
  function uiEls(xs: El[], out: string[], ind: string) {
    for (let i = 0; i < xs.length; i++) {
      const x = xs[i];
      if (x.name === "button") { const hs: El[] = []; while (xs[i + 1]?.name === "on") hs.push(xs[++i]); uiEl(x, out, ind, hs); }
      else if (x.name !== "on") uiEl(x, out, ind, []);
    }
  }
  // code that runs outside the component's function (handlers, pickers): no typed locals
  const outside = <T>(f: () => T): T => { const keep = ui; ui = { ...ui, tlocals: new Map() }; try { return f(); } finally { ui = keep; } };
  function onEntry(x: El) { outside(() => onEntryIn(x)); }
  function onEntryIn(x: El) {
    const h = x.head;
    const body = h.reactions.map((r: any) => r.kind === "go" ? `re.To = ${urlOf(r.target)}` : r.kind === "flash" ? (h.outcome === "ok" ? `sv.Flash(re, ${UE(r.value)})` : `sv.FlashAlert(re, ${UE(r.value)})`) : r.kind === "sign_in_as" ? `sv.SignInAs(rc, re, ${UE(r.value)})` : "").filter(Boolean);
    registry.set(ids.get(x)!, `${ids.get(x)}: {ID: ${ids.get(x)}, Name: "on", Outcome: ${q(h.outcome)}, React: func(sv *rt.Server, rc *rt.RCtx, re *rt.Reacted) { _, _ = sv, rc; ${body.join("; ")}${body.length ? "; " : ""}_ = re }}`);
  }
  function uiEl(x: El, out: string[], ind: string, handlers: El[]) {
    const w = (s: string) => out.push(ind + s);
    const h = x.head;
    const kids = (more = "\t") => uiEls(x.children, out, ind + more);
    w(`{ // ${x.name} (line ${x.pos.line}) // @spec ${x.pos.line}`);
    const inner = ind + "\t";
    const v = (s: string) => out.push(inner + s);
    let close = "}";
    if (x.attrs.if) { v(`if rt.Truthy(${UE(x.attrs.if as Expr)}) {`); close = "}}"; }
    const I = (s: string) => out.push(inner + "\t" + s);
    const at = x.attrs.if ? I : v;
    const k2 = x.attrs.if ? "\t\t" : "\t";
    switch (x.name) {
      case "title": if (h) at(h.kind === "interp" ? `rc.Title = ${textGo(h)}` : `rc.Title = rt.Plain(${UE(h)})`); break;
      // a heading's own class replaces the theme's (as a row's does)
      case "heading": at(W(`"<h1 class=\\"" + ${clsEsc(x, has(x, "class") ? `""` : `sv.DC("heading")`)} + "\\">" + rt.Esc(${textGo(h)}) + "</h1>"`)); break;
      // text among elements, and {value}: as it is, with no element of its own
      case "text": if ((x as any).plain) { at(h.kind === "interp" ? W(`rt.Esc(${textGo(h)})`) : h.kind === "lit" ? W(`rt.Esc(${q(String(h.value))})`) : `if v := ${shown(h)}; v != nil { ${W(`rt.Esc(sv.TextOf(rc, v))`)} }`); break; }
        if (h.kind === "interp") { at(W(`"<span class=\\"" + ${clsEsc(x, `""`)} + "\\">" + rt.Esc(${textGo(h)}) + "</span>"`)); break; }
        at(`if v := ${shown(h)}; v != nil { ${W(`"<span class=\\"" + ${clsEsc(x, `""`)} + "\\">" + rt.Esc(sv.TextOf(rc, v)) + "</span>"`)} }`); break;
      case "strong": at(W(`"<strong class=\\"" + ${clsEsc(x, `""`)} + "\\" title=\\"" + rt.Esc(rt.Plain(${attr(x, "title")})) + "\\">" + rt.Esc(${textGo(h)}) + "</strong>"`)); break;
      case "rich_text": at(W(`sv.RichHTML(${UE(h)}, ${attr(x, "id")}, ${cls(x, `""`)})`)); break;
      case "time": at(W(`rt.TimeHTML(${UE(h)}, ${q((x.attrs.as as any)?.name ?? "")}, func() string { return ${cls(x, `""`)} })`)); break;
      case "image": at(`if v := ${UE(h)}; rt.Present(v) { wd, ht := ${attr(x, "width")}, ${attr(x, "height")}; ${W(`sv.Image(${cls(x, `""`)}, v, wd, ht)`)} }`); break;
      case "icon": at(W(`sv.Icon(${UE(h)}, 20)`)); break;
      // bare: the image alone (inside something that is the avatar already, a link say)
      case "avatar": at(`{ u := ${UE(h)}; ${W(x.attrs.bare ? `sv.AvatarImg(u, ${attr(x, "label")})` : `sv.Avatar(${cls(x, `sv.DC("avatar")`)}, ${!!x.attrs.large}, u, ${attr(x, "label")})`)} }`); break;
      case "avatars": at(W(`rt.Avatars(${UE(h)})`)); break;
      case "field_display": at(`{ l := ${attr(x, "label")}; ${W(`rt.FieldDisplay(l, ${UE(h)})`)} }`); break;
      case "let": at(`rc.Let(${q(h.name)}, ${UE(h.value)})`); break;
      case "if":
        // at the screen's own level, an if is a fragment: what it reads doesn't refresh the page
        if (atScreen) at(`iff := rc.Frag(w, ${q(`if:${ids.get(x)}`)}, ${loopVars()}, false, nil)`);
        at(`if rt.Truthy(${UE(h)}) {`);
        { const before = est; kids(k2 + "\t".slice(1) + "\t"); const thenEst = est - before; est = before;
          if (x.else) { at("} else {"); uiEls(x.else, out, inner + k2); }
          est = before + Math.max(thenEst, est - before); }   // an if counts its larger branch
        at("}");
        if (atScreen) at("rc.EndFrag(w, iff)");
        break;
      case "each":
        at(`items := rt.Items(${UE(h.over)})`); at(`rc := rc.With1(${q(h.bind)}, nil)`); at("for _, x := range items {"); at(`\trc.Bind(${q(h.bind)}, x)`);
        { const undo = typedLoopVar(h.bind, "x", at); const before = est; loopNames.push(h.bind); cost.pushLoop(`${x.name} ${h.bind}`); kids(k2 + "\t"); cost.popLoop(); loopNames.pop(); est = before + (est - before) * loopBound(x); undo(); } at("}");
        break;
      case "list": {
        const src = h.source;
        // a fragment: its rows and items (its body reads the scope's variables: they are part of its cache key)
        at(`if lf := rc.Frag(w, ${q(`list:${ids.get(x)}`)}, ${loopVars()}, ${cacheable([x])}, rc.Vars); !lf.Hit() {`);
        if (src.kind === "query") at(`refs := sv.QueryRefs(rc, ${q(src.entity)}, func(c *rt.Ctx) []*rt.Row { return ${rowsCode(src, ui)} }(rc.Ctx()), ${perms.has(src.entity) ? `Perm_${ident(src.entity)}` : "nil"})`);
        else {
          const view = get("view", src.name) ?? fail(`unknown view ${src.name}`, x.pos);
          at(`refs := sv.ViewRefs(rc, ${q(src.name)}, map[string]rt.Val{${view.params.map((p: any, i: number) => `${q(p.name)}: rt.RawArg(${UE(src.args[i] ?? src.named[p.name])})`).join(", ")}})`);
        }
        {
          const entity = src.kind === "query" ? src.entity : get("view", src.name)?.rows?.entity;
          const plan = entity ? planFor(x.children, h.bind, entity) : newPlan();
          if (entity && !isPlanEmpty(plan)) { const pc: string[] = []; planCode(plan, "rows", entity, pc); at(`{ rows := rc.Ctx().S.RowsOf(E_${ident(entity)}, refs); ${pc.join("; ")} }`); }
        }
        at(W(`"<div class=\\"" + ${clsEsc(x, `""`)} + "\\" data-live-list>"`));
        const where = h.where ? `func(rc *rt.RCtx) bool { return rt.Truthy(${UE(h.where)}) }` : "nil";
        const order = h.order ? `func(rc *rt.RCtx) rt.Val { return ${UE(h.order)} }` : "nil";
        at(`items := sv.ListRefs(rc, refs, ${q(h.bind)}, ${where}, ${order}, ${!!h.desc})`); at(`rc := rc.With1(${q(h.bind)}, nil)`); at("for _, ref := range items {"); at(`\trc.Bind(${q(h.bind)}, ref)`);
        { const undo = typedLoopVar(h.bind, "ref", at); const before = est; const was = atScreen; atScreen = false; loopNames.push(h.bind); cost.pushLoop(`${x.name} ${h.bind}`); kids(k2 + "\t"); cost.popLoop(); loopNames.pop(); atScreen = was; est = before + (est - before) * loopBound(x); undo(); } at("}");
        at(W(lit("</div>")));
        at("rc.EndFrag(w, lf)");
        at("}");
        break;
      }
      case "use": {
        const comp = get("component", h.name) ?? fail(`unknown component ${h.name}`, x.pos);
        at(`vars := map[string]rt.Val{${comp.params.map((p: any, i: number) => `${q(p.name)}: ${UE(h.args[i])}`).join(", ")}}`);
        at(`if f := rc.Frag(w, ${q(h.name)}, vars, ${componentCacheable(h.name)}, nil); !f.Hit() {`);
        at(`\tUI_${ident(h.name)}(sv, rc.WithVars(vars), w)`);
        at("\trc.EndFrag(w, f)");
        at("}");
        est += compEst.get(h.name) ?? 0; pendingUE = [];
        break;
      }
      case "widget": {
        const attrsSwitch = Object.keys(x.attrs).filter((k) => x.attrs[k] !== true).map((k) => `case ${q(k)}: return ${UE(x.attrs[k] as Expr)}`).join("; ");
        at(W(`sv.Widget(rc, ${q(h.name)}, []rt.Val{${h.args.map((a: Expr) => UE(a)).join(", ")}}, rt.WidgetVals{Label: ${attr(x, "label")}, Icon: ${attr(x, "icon")}, Class: ${cls(x, `""`)}, ArgName: ${q(h.args[0]?.kind === "name" ? h.args[0].name : "")}, PushParams: ${q(h.args[0]?.kind === "name" && get("action", h.args[0].name) ? get("action", h.args[0].name)!.params.slice(0, 3).map((p: any) => p.name).join(",") : "")}, Attr: func(n string) rt.Val { switch n { ${attrsSwitch} }; return nil }})`));
        break;
      }
      case "channel": at(`rc.Channel(${q(h.name)}, []rt.Val{${h.args.map((a: Expr) => UE(a)).join(", ")}})`); break;
      case "signal": at(W(`"<div class=\\"" + sv.DC("signal") + "\\"></div>"`)); break;
      case "link": {
        at(`icon := ${attr(x, "icon")}`);
        at(`href := ${urlOf(h)}`);
        at(`unread := ${x.attrs.unread ? `rt.IfStr(rt.Truthy(${UE(x.attrs.unread as Expr)}), " unread", "")` : `""`}`);
        // title: a tooltip, and the link's name when it has no label (an icon or avatar alone)
        const ttl = has(x, "title") ? ` + " title=\\"" + rt.Esc(rt.Plain(${attr(x, "title")})) + "\\""` : "";
        at(W(`"<a href=\\"" + rt.Esc(href) + "\\" class=\\"" + ${clsEsc(x, x.children.length ? `""` : `sv.DC("button")`)} + unread + "\\""${ttl} + ">" + sv.Icon(icon, 20) + ${label(x)}`));
        kids(k2);
        at(W(lit("</a>")));
        break;
      }
      case "button": {
        const a = actionOf(x);
        for (const hd of handlers) onEntry(hd);
        { const targs = a.params.map((p: any, i: number) => { const e = i < h.args.length ? h.args[i] : h.named[p.name]; return e ? convert(tx(e, ui), gOfDecl(p.type)) : convert({ c: "rt.Val(nil)", g: "none" }, gOfDecl(p.type)); });
          at(`if sv.Offer(rc, ${q(a.name)}, func(gc *rt.Ctx) (string, string) { c := rc.Ctx(); _ = c; return GT_${ident(a.name)}(${["gc", ...targs].join(", ")}) }) {`); }
        const b = (s: string) => out.push(inner + k2 + s);
        b(`confirm, text, icon := ${attr(x, "confirm")}, ${attr(x, "text")}, ${attr(x, "icon")}`);
        b(`hid := sv.HandlerID([]int{${handlers.map((e) => ids.get(e)).join(", ")}}, rc)`);
        // selected={…}: the theme's selected class, and the pressed state for assistive tech
        b(x.attrs.selected ? `sel, pressed := "", " aria-pressed=\\"false\\""; if rt.Truthy(${UE(x.attrs.selected as Expr)}) { sel, pressed = " " + sv.DC("selected"), " aria-pressed=\\"true\\"" }` : `sel, pressed := "", ""`);
        // checked={…}: a button that shows a state it changes (a setting), a checkbox to assistive tech
        if (x.attrs.checked) b(`pressed += " role=\\"checkbox\\" aria-checked=\\"" + rt.IfStr(rt.Truthy(${UE(x.attrs.checked as Expr)}), "true", "false") + "\\""`);
        b(W(`"<form method=\\"post\\" action=\\"/_do/${a.name}\\" class=\\"" + sv.DC("button_form") + "\\" " + rt.OnSubmit(confirm) + ">"`));
        hiddenArgs(h, a.params, out, inner + k2);
        b(W(`"<input type=\\"hidden\\" name=\\"__h\\" value=\\"" + hid + "\\"><button type=\\"submit\\" class=\\"" + ${clsEsc(x, `sv.DC("button")`)} + sel + "\\"" + pressed + ">" + sv.Icon(icon, 20) + rt.TextOrEmpty(text) + ${label(x)}`));
        uiEls(x.children, out, inner + k2);
        b(W(lit("</button></form>")));
        at("}");
        break;
      }
      case "form": {
        const a = actionOf(x);
        const hs = x.children.filter((c) => c.name === "on");
        for (const hd of hs) onEntry(hd);
        at(`hid := sv.HandlerID([]int{${hs.map((e) => ids.get(e)).join(", ")}}, rc)`);
        at(`dis := ${x.attrs.readonly_unless ? `rt.IfStr(!rt.Truthy(${UE(x.attrs.readonly_unless as Expr)}), "disabled", "")` : `""`}`);
        at("body := rt.GetBuf()");
        at("{");
        at("\tw := body");
        { const pf = curForm; curForm = a.name; uiEls(x.children, out, inner + k2); curForm = pf; }
        at("}");
        at(W(`"<form method=\\"post\\" action=\\"/_do/${a.name}\\" enctype=\\"multipart/form-data\\" class=\\"" + ${clsEsc(x, `sv.DC("form")`)} + "\\" id=\\"" + rt.Esc(rt.Plain(${attr(x, "id")})) + "\\"${x.attrs.auto_submit ? ` onchange=\\"this.requestSubmit()\\"` : ""}>"`));
        hiddenArgs(h, a.params, out, inner + k2.slice(1));
        // bare: the fields laid out by the form's own class (its fieldset, there to disable them, takes no part)
        at(W(`"<input type=\\"hidden\\" name=\\"__h\\" value=\\"" + hid + "\\"><fieldset " + dis + ${x.attrs.bare ? `" style=\\"display: contents\\">"` : `" class=\\"" + sv.DC("fieldset") + "\\">"`}`));
        at("w.Write(body.Bytes())");
        at("rt.PutBuf(body)");
        at(W(lit("</fieldset></form>")));
        break;
      }
      case "field": {
        const flags = Object.keys(x.attrs).map((k) => `${q(k)}: true`);
        const parts = [`ID: ${ids.get(x)}`, `Name: "field"`, `FieldName: ${q(h.name)}`, `FieldKind: ${q(h.kind)}`, `Flags: map[string]bool{${flags.join(", ")}}`];
        const pc: any = x.attrs.mentions ?? x.attrs.autocomplete;
        if (pc && pc !== true) {
          const view = pc.kind === "call" ? get("view", pc.name) : undefined;
          if (view) parts.push(outside(() => `Pick: &rt.Pick{View: ${q(pc.name)}, Args: func(rc *rt.RCtx) map[string]rt.Val { return map[string]rt.Val{${view.params.map((p: any, i: number) => `${q(p.name)}: rt.RawArg(${UE(pc.args[i] ?? pc.named?.[p.name])})`).join(", ")}} }}`));
        }
        const uf: any = x.attrs.unfurl;
        if (uf && uf !== true && uf.kind === "name" && get("view", uf.name)) parts.push(`Unfurl: ${q(uf.name)}`, `UnfurlParam: ${q(get("view", uf.name)!.params[0]?.name ?? "link")}`);
        registry.set(ids.get(x)!, `${ids.get(x)}: {${parts.join(", ")}}`);
        const kind = h.kind;
        const sizeMax = curForm ? actionSizes.get(curForm)?.get(h.name)?.max : undefined;
        const vals = [`Value: ${attr(x, "value")}`, `PH: ${attr(x, "placeholder")}`, `Max: ${x.attrs.maxlength || sizeMax === undefined ? attr(x, "maxlength") : `rt.Val(int64(${sizeMax}))`}`, `Icon: ${attr(x, "icon")}`];
        if (kind === "textarea" || kind === "code") vals.push(`Rows: ${attr(x, "rows")}`);
        if (["choice", "users", "select"].includes(kind)) vals.push(`From: ${attr(x, "from")}`, `HasFrom: ${has(x, "from")}`);
        // a choice of enum values shows their labels
        if (kind === "choice" && x.attrs.from && x.attrs.from !== true) { const ft: any = tyOf(x.attrs.from); const et = ft.k === "list" ? ft.of : null; if (et?.k === "enum" && enums.has(et.e)) vals.push(`Labels: EL_${ident(et.e)}`); }
        if (kind === "file") vals.push(`Accept: ${attr(x, "accept")}`, `Preview: ${attr(x, "preview")}`);
        vals.push(`Label: ${attr(x, "label")}`, `Visible: ${visibleLabel(x)}`, `HasClass: ${has(x, "class")}`, `Class: ${attr(x, "class")}`);
        at(W(`sv.FieldHTML(rc, ${ids.get(x)}, rt.FieldVals{${vals.join(", ")}})`));
        break;
      }
      case "switch":
        at(`icon, link := ${attr(x, "icon")}, ${attr(x, "link")}`);
        at(`on := ${x.attrs.on === true ? "true" : x.attrs.value ? `rt.Truthy(${UE(x.attrs.value as Expr)})` : "false"}`);
        at(W(`sv.Switch(icon, on, ${x.attrs.auto_submit === true}, link, ${label(x)})`));
        break;
      case "submit": at(`icon := ${attr(x, "icon")}`); at(W(`"<button type=\\"submit\\" class=\\"" + sv.DC("submit") + "\\">" + sv.Icon(icon, 20) + ${label(x)} + "</button>"`)); break;
      case "section":
        at(`if lg := ${attr(x, "legend")}; rt.Present(lg) {`);
        out.push(inner + k2 + `banned := ${x.attrs.banned ? `rt.IfStr(rt.Present(${UE(x.attrs.banned as Expr)}), " banned", "")` : `""`}`);
        out.push(inner + k2 + W(`"<fieldset class=\\"" + ${clsEsc(x, `""`)} + banned + "\\"><legend><strong>" + rt.Esc(rt.Plain(lg)) + "</strong></legend>"`));
        uiEls(x.children, out, inner + k2);
        out.push(inner + k2 + W(lit("</fieldset>")));
        at("} else {");
        out.push(inner + k2 + `banned := ${x.attrs.banned ? `rt.IfStr(rt.Present(${UE(x.attrs.banned as Expr)}), " banned", "")` : `""`}`);
        out.push(inner + k2 + W(`"<section class=\\"" + ${clsEsc(x, `""`)} + banned + "\\" id=\\"" + rt.Esc(rt.Plain(${attr(x, "id")})) + "\\">"`));
        uiEls(x.children, out, inner + k2);
        out.push(inner + k2 + W(lit("</section>")));
        at("}");
        break;
      case "row":
        at(`d := ${attr(x, "data")}`);
        at(`banned := ${x.attrs.banned ? `rt.IfStr(rt.Present(${UE(x.attrs.banned as Expr)}), " banned", "")` : `""`}`);
        at(`rid := ${attr(x, "id")}`);
        at(W(`"<div" + rt.IfStr(rt.Present(rid), " id=\\"" + rt.Esc(rt.Plain(rid)) + "\\"", "") + " class=\\"" + rt.Esc(${x.attrs.class ? cls(x, `""`) : `sv.DC("row")`}) + banned + "\\"" + rt.DataAttrs(d) + ">"`));
        kids(k2);
        at(W(lit("</div>")));
        break;
      case "column": at(W(`"<div class=\\"" + rt.Esc(${x.attrs.class ? cls(x, `""`) : `sv.DC("column")`}) + "\\">"`)); kids(k2); at(W(lit("</div>"))); break;
      // plain HTML: its attributes as written; a value that is a Bool shows a bare attribute when
      // true, none leaves the attribute out, and an address is kept to safe schemes (rt.SafeURL)
      case "html": {
        const tag: string = h.tag;
        at(W(lit(`<${tag}`)));
        for (const [an, v] of Object.entries(x.attrs)) {
          if (an === "if") continue;
          if (v === true) { at(W(lit(` ${an}`))); continue; }
          const e = v as Expr;
          if (e.kind === "lit" && typeof e.value === "string") { at(W(lit(` ${an}="${e.value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;")}"`))); continue; }
          const shownV = URL_ATTRS.has(an) ? `rt.SafeURL(rt.Plain(v), ${an === "src" && tag === "img"})` : "rt.Plain(v)";
          at(`if v := ${UE(e)}; v != nil { if b, ok := v.(bool); ok { if b { ${W(lit(` ${an}`))} } } else { ${W(`" ${an}=\\"" + rt.Esc(${shownV}) + "\\""`)} } }`);
        }
        at(W(lit(">")));
        if (!VOID.has(tag)) { kids(k2); at(W(lit(`</${tag}>`))); }
        break;
      }
      case "menu":
        at(`icon := ${attr(x, "icon")}`);
        at(`if !rt.Present(icon) && ${!has(x, "label")} {`);
        out.push(inner + k2 + W(`"<menu class=\\"" + ${clsEsc(x, `sv.DC("menu")`)} + "\\">"`)); uiEls(x.children, out, inner + k2); out.push(inner + k2 + W(lit("</menu>")));
        at("} else {");
        out.push(inner + k2 + W(`"<details class=\\"" + sv.DC("dropdown") + "\\"><summary class=\\"" + sv.DC("button") + "\\">" + sv.Icon(icon, 20) + ${label(x)} + "</summary><menu class=\\"" + sv.DC("dropdown_panel") + "\\">"`));
        uiEls(x.children, out, inner + k2); out.push(inner + k2 + W(lit("</menu></details>")));
        at("}");
        break;
      case "popup":
        at(`icon, panel := ${attr(x, "icon")}, ${attr(x, "panel")}`);
        at(`pc := sv.DC("dropdown_panel"); if panel != nil { pc = rt.Plain(panel) }`);
        at(W(`"<details class=\\"" + sv.DC("dropdown") + "\\"><summary class=\\"" + ${clsEsc(x, `sv.DC("button")`)} + "\\">" + sv.Icon(icon, 20) + ${label(x)} + "</summary><div class=\\"" + rt.Esc(pc) + "\\">"`));
        kids(k2); at(W(lit("</div></details>")));
        break;
      case "dialog": case "frame": at(W(lit("<div>"))); kids(k2); at(W(lit("</div>"))); break;
      case "nav": case "main": case "footer": case "sidebar":
        // written straight into the slot's buffer (main starts at the screen's size)
        at("{"); at(`\tw := rc.Slot(${q(x.name)})`); at(`\tsf := rc.Frag(w, ${q(`slot:${ids.get(x)}`)}, ${loopVars()}, false, nil)`); kids(k2 + "\t"); at("\trc.EndFrag(w, sf)"); at("}");
        break;
      case "go": case "slot": case "aside": case "flash": break;
      default: fail(`unknown UI element ${x.name}`, x.pos);
    }
    w(close);
  }
  // components and screens as functions
  const usesW = (fnBody: string[]) => fnBody.some((l) => /\bw\b/.test(l));
  const compOrder: Decl[] = [];
  { const seenC = new Set<string>();
    const usesOf = (els: El[], out: string[] = []): string[] => { for (const x of els) { if (x.name === "use") out.push(x.head.name); usesOf(x.children, out); if (x.else) usesOf(x.else, out); } return out; };
    const visit = (d: Decl) => { if (seenC.has(d.name)) return; seenC.add(d.name); for (const u of usesOf(d.body)) { const c = get("component", u); if (c) visit(c); } compOrder.push(d); };
    for (const d of of("component")) visit(d); }
  for (const d of compOrder) {
    cost.pushDecl(`component ${d.name}`);
    atScreen = false; loopNames = [];
    ui = scope({ dyn: uiNames, types: uiTypes(d), tlocals: new Map() });
    uiBinds = countBinds(d.body);
    const body: string[] = [];
    for (const p of d.params ?? []) {
      const g = gOfDecl(p.type);
      if (uiBinds.has(p.name) || g === "val" || g === "none") continue;
      const v = `u_${ident(p.name)}`;
      body.push(`\t${v} := ${unbox(`rc.Vars[${q(p.name)}]`, g as G).c}; _ = ${v}`);
      ui.tlocals!.set(p.name, { c: v, g });
    }
    est = 0; pendingUE = [];
    uiEls(d.body, body, "\t");
    compEst.set(d.name, est);
    P(`func UI_${ident(d.name)}(sv *rt.Server, rc *rt.RCtx, w *bytes.Buffer) {`);
    if (!usesW(body)) P("\t_ = w");
    go.push(...body);
    P("}");
    cost.popDecl();
  }
  for (const d of of("screen")) {
    cost.pushDecl(`screen ${d.name}`);
    ui = scope({ dyn: uiNames, types: uiTypes(d), tlocals: new Map() });
    // an export: the view's rows as a file, a column per entry
    if ((d as any).file) {
      const f = (d as any).file, v = get("view", f.source.name);
      const rowScope = f.as ? { ...ui, row: v.rows.entity, dyn: new Set([...(ui.dyn ?? []), f.as]), types: new Map([...(ui.types ?? []), [f.as, v.rows.entity]]) } : { ...ui, row: v.rows.entity };
      const args = v.params.map((p: any, i: number) => `${q(p.name)}: ${f.source.args[i] ? ex(f.source.args[i], ui) : f.source.named?.[p.name] ? ex(f.source.named[p.name], ui) : "nil"}`);
      P(`func X_${ident(d.name)}(sv *rt.Server, rc *rt.RCtx) rt.Download {`);
      P(`\tc := rc.Ctx()`);
      P(`\treturn sv.Export(rc, ${q(f.format)}, ${q(v.name)}, E_${ident(v.rows.entity)}, ${q(f.as ?? "")}, map[string]rt.Val{${args.join(", ")}}, ${f.filename ? ex(f.filename, ui) : `rt.Val(${q(`${d.name}.${f.format}`)})`}, []string{${f.columns.map((c: any) => q(c.key)).join(", ")}}, []func(c *rt.Ctx) rt.Val{${f.columns.map((c: any) => `func(c *rt.Ctx) rt.Val { return ${ex(c.value, rowScope)} }`).join(", ")}})`);
      P("}");
      void P(`func S_${ident(d.name)}(sv *rt.Server, rc *rt.RCtx) string { return "" }`);
      continue;
    }
    uiBinds = countBinds(d.body);
    atScreen = true; loopNames = [];
    const body: string[] = [];
    est = 0; pendingUE = [];
    for (const x of d.body) {
      if (["nav", "main", "footer", "sidebar", "title", "channel", "let"].includes(x.name)) uiEl(x, body, "\t", []);
      else if (x.name === "if") {
        const g = x.children.find((c) => c.name === "go");
        body.push(g ? `\tif rt.Truthy(${UE(x.head)}) { return ${urlOf(g.head)} }` : `\t_ = rt.Truthy(${UE(x.head)})`);
      } else {
        body.push("\t{", "\t\tw := rc.Slot(\"main\")");
        uiEl(x, body, "\t\t", []);
        body.push("\t}");
      }
    }
    P(`func S_${ident(d.name)}(sv *rt.Server, rc *rt.RCtx) string {`);
    P(`\trc.SizeHint(${Math.ceil(est)}) // estimated: markup plus a quarter of each value's size`);
    go.push(...body);
    P("\treturn \"\"");
    P("}");
    cost.popDecl();
  }

  // ---- compiled per entity: columns, codecs, create, set, delete, parent touches
  const ftype = (f: any): string => (f.type.kind === "named" ? f.type.name : f.type.kind);
  // how each field is stored: r reference, t text, p password hash (text), i int, b bool, m time (two columns), d duration,
  // j JSON (File, RichText, Json)
  const fkind = (f: any) => { const t = ftype(f); return ents.has(t) ? "r" : TEXTLIKE.has(t) || enums.has(t) ? "t" : t === "Password" ? "p" : t === "Int" ? "i" : t === "Bool" ? "b" : t === "Time" ? "m" : t === "Duration" ? "d" : t === "File" ? "f" : t === "RichText" ? "h" : "j"; };
  const enc = (f: any, code: string) => `rt.Enc${fkind(f).toUpperCase()}(${code})`;
  // a field's stored columns, and its value from them (raw: the columns after the four row ones)
  const sqlCols = (f: any) => (fkind(f) === "m" ? [f.name, `${f.name}__seq`] : fkind(f) === "f" ? [f.name, `${f.name}__name`, `${f.name}__type`, `${f.name}__size`] : [f.name]);
  const decAt = (d: Decl) => { let at = 0; return d.fields.map((f: any) => { const i = at; at += sqlCols(f).length; const k = fkind(f);
    return k === "m" ? `rt.DecM(raw[${i}], raw[${i + 1}])` : k === "f" ? `rt.DecF(raw[${i}], raw[${i + 1}], raw[${i + 2}], raw[${i + 3}])` : k === "r" ? `rt.DecR(${q(ftype(f))}, raw[${i}])` : `rt.Dec${k.toUpperCase()}(raw[${i}])`; }); };
  const storeX = (f: any, code: string) => ftype(f) === "Password" ? `rt.StorePassword(${code})` : ftype(f) === "RichText" ? `rt.BindRich(${code})` : code;
  const optional = (f: any) => !!(f.type.kind === "named" && f.type.optional);
  const oldRow = (d: Decl, row: string) => `rt.OldRow{F: map[string]rt.Val{${d.fields.map((f: any, i: number) => `${q(f.name)}: ${row}.Get(${i})`).join(", ")}}}`;
  const colEq = (cols: string[]) => cols.map((c) => `t0.${sq(c)} = ?`).join(" AND ");
  // ---- a stored entity's row as a typed struct (rt.Rec): its fields as Go values, scanned
  // straight from the columns, so reading rows boxes nothing; Get and Set box one field for the
  // dynamic code (agents, the test protocol); Enc gives the stored values
  function recCode(n: string, d: Decl): string[] {
    const T = `R_${ident(n)}`, out: string[] = [];
    const goOf = (f: any): string => {
      const k = fkind(f), o = optional(f);
      const base = ({ t: "string", p: "string", i: "int64", b: "bool", m: "rt.Time", d: "rt.Dur", f: "rt.File", h: "rt.Rich" } as Record<string, string>)[k];
      if (k === "r") return "int64";   // the row's id; 0 is none
      if (k === "j") return "rt.Val";
      return o ? `rt.Opt[${base}]` : base;
    };
    const fname = (f: any) => `F_${ident(f.name)}`;
    // a required field's column can still be NULL (before an upgrade fills it): a bit says so
    const nb = (f: any) => !optional(f) && !['r', 'j'].includes(fkind(f));
    out.push(`type ${T} struct {`);
    for (const f of d.fields) out.push(`\t${fname(f)} ${goOf(f)}`);
    out.push(`\tnulls uint64 // required fields whose column is NULL`);
    out.push("}");
    // Get: a field as a dynamic value
    out.push(`func (r *${T}) Get(i int) rt.Val {`, "\tswitch i {");
    d.fields.forEach((f: any, i: number) => {
      const k = fkind(f), o = optional(f), x = `r.${fname(f)}`;
      let v: string;
      if (k === "r") v = `if ${x} == 0 { return nil }; return rt.Ref{E: ${q(ftype(f))}, ID: ${x}}`;
      else if (k === "j") v = `if raw, ok := ${x}.(rt.RawJSON); ok { ${x} = rt.FromJSON(string(raw)) }; return ${x}`;
      else if (k === "p") v = o ? `if !${x}.Ok { return nil }; return rt.DecP(${x}.V)` : `return rt.DecP(${x})`;
      else if (k === "f") v = o ? `if !${x}.Ok { return nil }; return ${x}.V.Val()` : `return ${x}.Val()`;
      else v = o ? `return ${x}.Val()` : `return ${x}`;
      out.push(`\tcase ${i}: ${nb(f) ? `if r.nulls&(1<<${i}) != 0 { return nil }; ` : ""}${v}`);
    });
    out.push("\t}", "\treturn nil", "}");
    // Set: from a dynamic value
    out.push(`func (r *${T}) Set(i int, v rt.Val) {`, "\tswitch i {");
    d.fields.forEach((f: any, i: number) => {
      const k = fkind(f), o = optional(f), x = `r.${fname(f)}`;
      let v: string;
      if (k === "r") v = `${x} = rt.AsRef(v).ID`;
      else if (k === "j") v = `${x} = v`;
      else if (k === "p") v = o ? `if s, ok := rt.EncP(v).(string); ok { ${x} = rt.Some(s) } else { ${x} = rt.Opt[string]{} }` : `${x}, _ = rt.EncP(v).(string)`;
      else if (k === "f") v = o ? `if fl, ok := rt.FileOf(v); ok { ${x} = rt.Some(fl) } else { ${x} = rt.Opt[rt.File]{} }` : `${x}, _ = rt.FileOf(v)`;
      else {
        const as = ({ t: "Str", i: "Int", b: "Bool", m: "Time", d: "Dur", h: "Rich" } as Record<string, string>)[k];
        v = o ? (k === "d" ? `if v == nil { ${x} = rt.Opt[rt.Dur]{} } else { ${x} = rt.Some(rt.AsDur(v)) }` : `${x} = rt.AsOpt${as}(v)`) : `${x} = rt.As${as}(v)`;
      }
      out.push(`\tcase ${i}: ${nb(f) ? `if v == nil { r.nulls |= 1 << ${i}; return }; r.nulls &^= 1 << ${i}; ` : ""}${v}`);
    });
    out.push("\t}", "}");
    // Enc: the stored values, one per field, as the store writes them
    const encs: string[] = [];
    d.fields.forEach((f: any, i: number) => {
      const k = fkind(f), o = optional(f), x = `r.${fname(f)}`;
      let v: string;
      if (k === "r") v = `rt.IDCol(${x})`;
      else if (k === "j") v = `rt.EncJ(${x})`;
      else if (k === "m") v = o ? `rt.OptTimeCol(${x})` : `rt.TimeCol{T: ${x}.T, Seq: ${x}.Seq}`;
      else if (k === "f") v = o ? `rt.OptFileCol(${x})` : `${x}.Col()`;
      else if (k === "h") v = o ? `rt.EncH(${x}.Val())` : `rt.EncH(${x})`;
      else if (k === "b") v = o ? `rt.OptBoolCol(${x})` : `rt.BoolCol(${x})`;
      else if (k === "d") v = o ? `rt.OptCol(rt.Opt[int64]{V: ${x}.V.MS, Ok: ${x}.Ok})` : `${x}.MS`;
      else v = o ? `rt.OptCol(${x})` : x;
      if (nb(f)) v = `rt.NullOr(r.nulls&(1<<${i}) != 0, ${k === "m" ? "rt.TimeCol{None: true}" : k === "f" ? "rt.FileCol{None: true}" : k === "h" ? "rt.RichCol{None: true}" : "nil"}, ${v})`;
      encs.push(v);
    });
    out.push(`func (r *${T}) Enc() []any {`, "\treturn []any{", ...encs.map((v) => `\t\t${v},`), "\t}", "}");
    // one field's stored value (a set-based write's bookkeeping needs only the fields it sets)
    out.push(`func (r *${T}) EncAt(i int) any {`, "\tswitch i {", ...encs.map((v, i) => `\tcase ${i}: return ${v}`), "\t}", "\treturn nil", "}");
    // its columns bound typed, as Flat spreads Enc's values (the insert statement's order)
    out.push(`func (r *${T}) Bind(st *rt.Stmt, at int) int {`);
    d.fields.forEach((f: any, i: number) => {
      const k = fkind(f), o = optional(f), x = `r.${fname(f)}`, nul = nb(f) ? `r.nulls&(1<<${i}) != 0` : "";
      const one = (typed: string) => (nul ? `\tif ${nul} { st.Null(at) } else { ${typed} }; at++` : `\t${typed}; at++`);
      if (k === "r") out.push(`\tst.Ref(at, rt.Ref{ID: ${x}}); at++`);
      else if (k === "t") out.push(o ? `\tst.OptText(at, ${x}); at++` : one(`st.Text(at, ${x})`));
      else if (k === "i") out.push(o ? `\tst.OptInt(at, ${x}); at++` : one(`st.Int(at, ${x})`));
      else if (k === "b") out.push(o ? `\tst.OptBool(at, ${x}); at++` : one(`st.Bool(at, ${x})`));
      else if (k === "m") out.push(o ? `\tif ${x}.Ok { st.Int(at, ${x}.V.T); st.Int(at+1, ${x}.V.Seq) } else { st.Null(at); st.Null(at+1) }; at += 2`
        : nul ? `\tif ${nul} { st.Null(at); st.Null(at+1) } else { st.Int(at, ${x}.T); st.Int(at+1, ${x}.Seq) }; at += 2` : `\tst.Int(at, ${x}.T); st.Int(at+1, ${x}.Seq); at += 2`);
      else out.push(`\tat = rt.BindEnc(st, at, r.EncAt(${i}))`);
    });
    out.push("\treturn at", "}");
    // the live-page keys of the values it holds (as Sess.wrote finds them from Enc), typed
    out.push(`func (r *${T}) Keys(e string, d rt.Deps) {`);
    d.fields.forEach((f: any, i: number) => {
      const k = fkind(f), o = optional(f), x = `r.${fname(f)}`, col = q(f.name);
      const put = (val: string) => `d.Add(rt.LK{K: '=', E: e, Col: ${col}, Val: ${val}})`;
      const nul = nb(f) ? `if r.nulls&(1<<${i}) != 0 { ${put(`"~"`)} } else ` : "";
      if (k === "r") out.push(`\t${put(`rt.KRef(rt.Ref{ID: ${x}})`)}`);
      else if (k === "i") out.push(`\t${nul}{ ${put(o ? `rt.KOptInt(${x})` : `rt.KInt(${x})`)} }`);
      else if (k === "b") out.push(`\t${nul}{ ${put(o ? `rt.KOptBool(${x})` : `rt.KBool(${x})`)} }`);
      else if (k === "t") out.push(o ? `\tif !${x}.Ok { ${put(`"~"`)} } else if len(${x}.V) <= 200 { ${put(`${x}.V`)} }` : `\t${nul}if len(${x}) <= 200 { ${put(x)} }`);
      else if (k === "m" || k === "f" || k === "h") return;   // not keyable (a TimeCol, FileCol, RichCol)
      else out.push(`\trt.AddValKey(d, e, ${col}, r.EncAt(${i}))`);
    });
    out.push("}");
    // the scanner: id, seq, created, updated, then each field's columns, read typed by position
    // (and the same for the fields a mask says, as rt's colsFor selects them: prune.go)
    const scanner = (masked: boolean) => {
      out.push(masked ? `func scanm_${ident(n)}(st *rt.Stmt, m uint64) *rt.Row {` : `func scan_${ident(n)}(st *rt.Stmt) *rt.Row {`, `\tr := &${T}{}`, "\trow := &rt.Row{ID: st.ColInt(0), Seq: st.ColInt(1), Created: st.ColInt(2), Updated: st.ColInt(3), R: r}");
      if (masked) out.push("\tc := 4");
      let col = 4;
      d.fields.forEach((f: any, i: number) => {
        const k = fkind(f), o = optional(f), x = `r.${fname(f)}`, n0 = k === "m" ? 2 : k === "f" ? 4 : 1;
        // a column: by its number, or after c's, under a mask
        const at = (j: number) => (masked ? (j ? `c+${j}` : "c") : String(col + j));
        const lines: string[] = [];
        const set = (v: string) => lines.push(o ? `\tif !st.ColNull(${at(0)}) { ${x} = rt.Some(${v}) }` : `\t${x} = ${v}`);
        // a required field whose column is NULL keeps its bit (its first column)
        if (nb(f)) lines.push(`\tif st.ColNull(${at(0)}) { r.nulls |= 1 << ${i} }`);
        if (k === "m") set(`rt.Time{T: st.ColInt(${at(0)}), Seq: st.ColInt(${at(1)})}`);
        else if (k === "f") set(`rt.File{Stored: st.ColText(${at(0)}), Name: st.ColText(${at(1)}), Type: st.ColText(${at(2)}), Size: st.ColInt(${at(3)})}`);
        else if (k === "r") lines.push(`\t${x} = st.ColInt(${at(0)})`);
        else if (k === "j") lines.push(`\tif !st.ColNull(${at(0)}) { ${x} = rt.RawJSON(st.ColText(${at(0)})) }`);
        else if (k === "h") set(`rt.Rich{Text: st.ColText(${at(0)}), Mentions: []int64{}}`);
        else if (k === "d") set(`rt.Dur{MS: st.ColInt(${at(0)})}`);
        else set(k === "i" ? `st.ColInt(${at(0)})` : k === "b" ? `st.ColBool(${at(0)})` : `st.ColText(${at(0)})`);
        // (a text field left out holds a marker in check mode, so a page that shows it is caught)
        const poison = k === "t" ? `${x} = ${o ? "rt.Some(rt.Pruned)" : "rt.Pruned"}` : k === "h" ? `${x} = ${o ? "rt.Some(rt.Rich{Text: rt.Pruned})" : "rt.Rich{Text: rt.Pruned}"}` : "";
        if (masked) out.push(`\tif m&(1<<${i}) != 0 {`, ...lines.map((l) => `\t${l}`), `\t\tc += ${n0}`, poison ? `\t} else if rt.PruneCheck { ${poison} }` : "\t}");
        else out.push(...lines);
        col += n0;
      });
      if (masked) out.push("\t_ = c");
      out.push("\treturn row", "}");
    };
    scanner(false);
    if (d.fields.length < 64) scanner(true);
    // typed getters: a field of a row a reference names (gf_), or of the query's own row (rf_),
    // as its Go type; none for a none reference or a NULL column; a deleted row refuses, as
    // FieldOf does. The generated expressions call these instead of FieldOf and an unbox
    const GK: Record<string, string> = { t: "string", i: "int64", b: "bool", m: "rt.Time", h: "rt.Rich", d: "rt.Dur" };
    d.fields.forEach((f: any, i: number) => {
      const k = fkind(f), o = optional(f), x = `x.${fname(f)}`;
      if (!GK[k] && k !== "r") return;
      if (k === "d" && o) return;
      const R = k === "r" ? "rt.Ref" : `rt.Opt[${GK[k]}]`, none = k === "r" ? "rt.Ref{}" : `${R}{}`;
      const val = k === "r" ? `if ${x} == 0 { return rt.Ref{} }; return rt.Ref{E: ${q(ftype(f))}, ID: ${x}}` : `${nb(f) ? `if x.nulls&(1<<${i}) != 0 { return ${none} }; ` : ""}return ${o ? x : `rt.Some(${x})`}`;
      out.push(`func gf_${ident(n)}_${ident(f.name)}(c *rt.Ctx, t rt.Ref) ${R} { if t.ID == 0 { return ${none} }; r := c.S.Find(E_${ident(n)}, t.ID); if r == nil { rt.Refuse("not_found", ${q(n)} + " was deleted", "missing") }; x := r.R.(*${T}); ${val} }`);
      out.push(`func rf_${ident(n)}_${ident(f.name)}(c *rt.Ctx) ${R} { x := c.Row.R.(*${T}); ${val} }`);
    });
    // from dynamic values (a create's fields, a test load, a draft)
    out.push(`func newRec_${ident(n)}(f []rt.Val) rt.Rec {`, `\tr := &${T}{}`, "\tfor i, v := range f { r.Set(i, v) }", "\treturn r", "}");
    return out;
  }
  for (const [n, d] of ents) {
    const En = `E_${ident(n)}`, id = ident(n);
    const idx = (f: string) => d.fields.findIndex((x: any) => x.name === f);
    if (d.fields.length > 64) fail(`${n} has more than 64 fields`, d.pos);
    if (stored(n)) for (const line of recCode(n, d)) P(line);
    // create
    P(`func C_${id}(c *rt.Ctx, f []rt.Val, set uint64, ensure bool) (rt.Ref, bool) {`);
    d.fields.forEach((f: any, i: number) => { const z = fieldSize(f); if (z.max !== undefined || z.min !== undefined) P(`\tif set&(1<<${i}) != 0 { rt.CheckSize(f[${i}], ${z.max ?? -1}, ${z.min ?? -1}, ${q(`${n}.${f.name}`)}) }`); });
    d.fields.forEach((f: any, i: number) => { if (ftype(f) === "Password" || ftype(f) === "RichText") P(`\tif set&(1<<${i}) != 0 { f[${i}] = ${storeX(f, `f[${i}]`)} }`); });
    if (d.fields.some((f: any) => f.default)) P(`\tdraft := c.Draft(${En}, f)`);
    d.fields.forEach((f: any, i: number) => {
      const fill = f.default ? `f[${i}] = func(c *rt.Ctx) rt.Val { return ${ex(f.default, scope({ row: n, dynAll: true }))} }(c.OnRow(${En}, draft))`
        : optional(f) ? `f[${i}] = nil` : ftype(f) === "Int" ? `f[${i}] = int64(0)` : `rt.Refuse("invalid", ${q(`${n}.${f.name} is required`)}, "required")`;
      // a default the row's later defaults may read: the draft holds it too
      const keep = d.fields.some((x: any) => x.default) && !fill.startsWith("rt.Refuse") ? `; draft.R.Set(${i}, f[${i}])` : "";
      P(`\tif set&(1<<${i}) == 0 { ${fill}${keep} }`);
    });
    for (const cols of d.uniques ?? []) {
      const is = cols.map(idx);
      // only ensure looks first (it gives the row that's there); a create's clash is the
      // database's unique index refusing the insert (Sess.constraint: invalid, the same message)
      P(`\tif ensure && ${is.map((i: number) => `f[${i}] != nil`).join(" && ")} {`);
      P(`\t\tif r := c.Clash(${En}, ${sqlConst(colEq(cols))}, 0, ${is.map((i: number) => enc(d.fields[i], `f[${i}]`)).join(", ")}); r != nil {`);
      P(`\t\t\tif ensure { return rt.Ref{E: ${q(n)}, ID: r.ID}, false }`);
      P(`\t\t\trt.Refuse("invalid", ${q(`unique (${n}: ${cols.join(", ")})`)}, "unique")`);
      P("\t\t}");
      P("\t}");
    }
    if (d.singleton) P(`\tif c.S.First(${En}) != nil { rt.Refuse("invalid", ${q(`${n} exists`)}, "unique") }`);
    P(`\trow := c.S.Insert(${En}, f, c.Now())`);
    P(`\tref := rt.Ref{E: ${q(n)}, ID: row.ID}`);
    P(`\tTP_${id}(c, row)`);
    { const f = fireCode("create", n, "", "ref", "nil"); if (f) P(`\t${f}`); }
    P("\treturn ref, true");
    P("}");
    // parent touches
    P(`func TP_${id}(c *rt.Ctx, row *rt.Row) {`);
    P("\t_ = row");
    d.fields.forEach((f: any, i: number) => { if (f.touches && ents.has(ftype(f))) P(`\tc.TouchRef(E_${ident(ftype(f))}, row.Get(${i}))`); });
    P("}");
    // set, one function per field
    d.fields.forEach((f: any, i: number) => {
      P(`func SET_${id}_${ident(f.name)}(c *rt.Ctx, target, v rt.Val) {`);
      P(`\trow := c.RowFor(${En}, target)`);
      { const z = fieldSize(f); if (z.max !== undefined || z.min !== undefined) P(`\trt.CheckSize(v, ${z.max ?? -1}, ${z.min ?? -1}, ${q(`${n}.${f.name}`)})`); }
      if (storeX(f, "v") !== "v") P(`\tv = ${storeX(f, "v")}`);
      // the row as it was, only for an update trigger on this field (old.f)
      const fc = fireCode("update", n, f.name, `rt.Ref{E: ${q(n)}, ID: row.ID}`, "old");
      P(fc ? `\tbefore, old := row.Get(${i}), ${oldRow(d, "row")}` : `\tbefore := row.Get(${i})`);
      P(`\trow.R.Set(${i}, v)`);
      // a clash on a unique key is the database's index refusing the update (Sess.constraint)
      P("\tif !rt.Equal(before, v) {");
      P("\t\trow.Updated = c.Now()");
      // exactly this field's columns (rich text keeps its side tables in step: the general save)
      if (fkind(f) === "h") P(`\t\tc.S.Save(${En}, row, []string{${q(f.name)}})`);
      else P(`\t\tc.S.SaveField(${En}, row, ${i}, ${sqlConst(`UPDATE ${sq(n)} SET updated = ?${sqlCols(f).map((col: string) => `, ${sq(col)} = ?`).join("")} WHERE id = ?`)})`);
      P(`\t\tTP_${id}(c, row)`);
      if (fc) P(`\t\t${fc}`);
      P("\t}");
      P("}");
    });
    // delete: the rows that refer to it, by each reference's rule, then the row
    P(`func D_${id}(c *rt.Ctx, ref rt.Ref) {`);
    P(`\trow := c.S.Find(${En}, ref.ID)`);
    P("\tif row == nil { return }");
    for (const [dn, dd] of ents) {
      dd.fields.forEach((f: any, i: number) => {
        if (ftype(f) !== n) return;
        const rows = dd.kind === "entity" ? `c.S.Select(E_${ident(dn)}, ${sqlConst(colEq([f.name]))}, ref.ID)`
          : `rt.Filter(c.S.Select(E_${ident(dn)}, ""), func(r *rt.Row) bool { return rt.Equal(r.Get(${i}), ref) })`;
        P(`\tif deps := ${rows}; len(deps) > 0 {`);
        if (f.onDelete === "cascade") P(`\t\tfor _, x := range deps { D_${ident(dn)}(c, rt.Ref{E: ${q(dn)}, ID: x.ID}) }`);
        else P(`\t\trt.Refuse("invalid", ${q(`${dn}.${f.name} restricts deleting ${n}`)}, "restrict")`);
        P("\t}");
      });
    }
    P(`\told := ${oldRow(d, "row")}`);
    P(`\tc.S.Remove(${En}, ref.ID)`);
    P(`\tTP_${id}(c, row)`);
    { const f = fireCode("delete", n, "", "ref", "old"); P(f ? `\t${f}` : "\t_ = old"); }
    P("}");
  }
  // invariants, for the rows an action touched and the rows that refer to touched rows
  P("func invariants(c *rt.Ctx, log []rt.Change) {");
  P("\tt := rt.TouchedBy(log)");
  P("\t_ = t");
  for (const [n, d] of ents) {
    if (!(d.invariants ?? []).length) continue;
    const En = `E_${ident(n)}`;
    const deps = new Map<string, Set<string>>();
    for (const inv of d.invariants) for (const [e, via] of invariantDeps(n, inv)) (deps.get(e) ?? deps.set(e, new Set()).get(e)!).add(via);
    P("\t{");
    P(`\t\tids, all := t.Live(${q(n)}), false`);
    for (const [e, vias] of deps) for (const via of vias) {
      if (via === "" || !stored(n)) P(`\t\tif len(t[${q(e)}]) > 0 { all = true }`);
      else P(`\t\tfor id := range t[${q(e)}] { for _, r := range c.S.Select(${En}, ${sqlConst(colEq([via]))}, id) { ids[r.ID] = true } }`);
    }
    P(`\t\tfor _, row := range c.InvariantRows(${En}, ids, all) {`);
    P(`\t\t\tic := c.InvariantCtx(${En}, row)`);
    for (const inv of d.invariants) P(`\t\t\tif !func(c *rt.Ctx) bool { return ${exB(inv, scope({ row: n, dyn: new Set(["self"]), types: new Map([["self", n]]) }))} }(ic) { rt.Refuse("invalid", ${q(`invariant of ${n} at ${inv.pos.line}`)}, "invariant") }`);
    P("\t\t}");
    P("\t}");
  }
  P("}");

  // ---- what an upgrade runs (rt/migrate.go): defaults for rows that predate a field, the data
  // migrations, and every invariant on every row (a failing or refusing one is a violation)
  P("var migrate = &rt.Migrate{");
  P("\tDefaults: map[string]func(c *rt.Ctx, row *rt.Row) rt.Val{");
  for (const [n, d] of ents) if (stored(n)) for (const f of d.fields) if (f.default)
    P(`\t\t${q(`${n}.${f.name}`)}: func(c *rt.Ctx, row *rt.Row) rt.Val { return ${ex(f.default, scope({ row: n, dynAll: true }))} },`);
  P("\t},");
  P("\tMigrations: map[string]func(c *rt.Ctx){");
  for (const m of decls.filter((d) => d.kind === "migration")) {
    const s = scope({ dyn: binders(m.body), types: new Map(), tlocals: new Map(), typable: typableNames(m.body, []) });
    bodyTypes(m.body, s);
    const out: Out = [];
    stmts(m.body, s, out, "\t\t\t");
    P(`\t\t${q(m.name)}: func(c *rt.Ctx) {`);
    go.push(...out);
    P("\t\t},");
  }
  P("\t},");
  P("\tInvariants: func(c *rt.Ctx, bad func(entity, detail string, id int64)) {");
  for (const [n, d] of ents) {
    if (!stored(n) || !(d.invariants ?? []).length) continue;
    P(`\t\tfor _, row := range c.S.Select(E_${ident(n)}, "") {`);
    P(`\t\t\tic := c.InvariantCtx(E_${ident(n)}, row)`);
    for (const inv of d.invariants)
      P(`\t\t\tif !rt.Holds(func() bool { return func(c *rt.Ctx) bool { return ${exB(inv, scope({ row: n, dyn: new Set(["self"]), types: new Map([["self", n]]) }))} }(ic) }) { bad(${q(n)}, ${q(`invariant of ${n} at line ${inv.pos.line}`)}, row.ID) }`);
    P("\t\t}");
  }
  // the app's invariants (invariant name: …): all(c for E where p) row by row, so the plan names
  // the rows that break it; any other form once
  for (const inv of spec.decls.filter((d) => d.kind === "invariant")) {
    const what = q(`invariant ${inv.name} at line ${inv.pos.line}`);
    const c = inv.cond;
    if (c.kind === "all" && stored(c.entity)) {
      const rs = scope({ row: c.entity, dyn: new Set(), types: new Map() });
      P(`\t\tfor _, row := range c.S.Select(E_${ident(c.entity)}, "") {`);
      P(`\t\t\tic := c.InvariantCtx(E_${ident(c.entity)}, row)`);
      P(`\t\t\tif !rt.Holds(func() bool { return func(c *rt.Ctx) bool { return ${c.where ? `!(${exB(c.where, rs)}) || ` : ""}(${exB(c.cond, rs)}) }(ic) }) { bad(${q(c.entity)}, ${what}, row.ID) }`);
      P("\t\t}");
    } else P(`\t\tif !rt.Holds(func() bool { return ${exB(c, scope({ dyn: new Set(), types: new Map() }))} }) { bad("", ${what}, 0) }`);
  }
  P("\t},");
  P("}");

  // ---- arguments, compiled per action and view: binding (by type) and decoding forms
  const bindCode = (ps: any[]) => `func(raw map[string]rt.Val, s *rt.Sess) map[string]rt.Val {\n\t_ = s\n\tv := map[string]rt.Val{}\n${ps.map((p: any) => {
    const t = p.type, nm = q(p.name);
    if (t.kind === "set") return `\tv[${nm}] = rt.BindSet(s, E_${ident(t.of)}, raw[${nm}])`;
    if (t.kind === "named" && ents.has(t.name)) return `\t{ x, ok := raw[${nm}]; v[${nm}] = rt.BindRef(${q(t.name)}, ${!!t.optional}, x, ok) }`;
    if (t.kind === "named" && enums.has(t.name)) return `\tv[${nm}] = rt.BindEnum(${q(t.name)}, raw[${nm}])`;
    if (t.kind === "named" && t.name === "RichText") return `\tv[${nm}] = rt.BindRich(raw[${nm}])`;
    if (t.kind === "named" && t.name === "Int") return `\tv[${nm}] = rt.BindInt(raw[${nm}])`;
    if (t.kind === "named" && t.name === "Time") return `\tv[${nm}] = rt.BindTime(raw[${nm}])`;
    return `\tv[${nm}] = raw[${nm}]`;
  }).join("\n")}\n\treturn v\n}`;
  const formCode = (ps: any[]) => `func(sv *rt.Server, r *rt.HTTPReq) map[string]rt.Val {\n\t_ = sv\n\treturn map[string]rt.Val{${ps.map((p: any) => {
    const t = p.type, nm = q(p.name);
    if (t.kind === "set") return `${nm}: r.FormSet(${nm})`;
    if (t.kind === "named" && ents.has(t.name)) return `${nm}: r.FormRef(${nm})`;
    if (t.kind === "named" && t.name === "Bool") return `${nm}: r.FormBool(${nm})`;
    if (t.kind === "named" && t.name === "Int") return `${nm}: r.FormInt(${nm})`;
    if (t.kind === "named" && t.name === "Time") return `${nm}: r.FormTime(${nm})`;
    if (t.kind === "named" && t.name === "RichText") return `${nm}: sv.FormRich(r, ${nm}, ${!!t.optional})`;
    return `${nm}: r.FormValue(${nm}, ${!!(t.kind === "named" && t.optional && t.name !== "Text")})`;
  }).join(", ")}}\n}`;
  const queryCode = (ps: any[]) => `func(q url.Values) map[string]rt.Val { return map[string]rt.Val{${ps.map((p: any) => `${q(p.name)}: rt.Query${p.type.kind === "named" && ents.has(p.type.name) ? "Ref" : "Text"}(q, ${q(p.name)})`).join(", ")}} }`;
  for (const a of of("action")) { P(`var BIND_${ident(a.name)} = ${bindCode(a.params)}`); P(`var FORM_${ident(a.name)} = ${formCode(a.params)}`); }
  for (const v of of("view")) { P(`var BIND_${ident(v.name)} = ${bindCode(v.params)}`); P(`var QUERY_${ident(v.name)} = ${queryCode(v.params)}`); }

  // ---- screens: parameters, guards, links
  for (const d of of("screen")) {
    ui = scope({ dyn: uiNames, types: uiTypes(d) });
    const id = ident(d.name);
    P(`func COERCE_${id}(sp map[string]string, q url.Values, s *rt.Sess) map[string]rt.Val {`);
    P("\t_ = s");
    P(`\treturn map[string]rt.Val{${d.params.map((p: any) => {
      const raw = `rt.ScreenRaw(sp, q, ${q(p.name)})`, t = p.type.name;
      return `${q(p.name)}: ${ents.has(t) ? `rt.CoerceRef(s, E_${ident(t)}, ${raw})` : enums.has(t) ? `rt.CoerceEnum(${raw}, EL_${ident(t)})` : t === "Bool" ? `rt.CoerceBool(${raw})` : t === "Int" ? `rt.CoerceInt(${raw})` : `rt.CoerceText(${raw})`}`;
    }).join(", ")}}`);
    P("}");
    if (d.requires.length) {
      P(`func GUARD_${id}(sv *rt.Server, rc *rt.RCtx) rt.Guarded {`);
      for (const r of d.requires) {
        P(`\tif !rt.Truthy(${UE(r.cond)}) {`);
        if (r.go) P(`\t\treturn rt.Guarded{Refused: true, To: ${urlOf(r.go)}${r.flash ? `, Cookies: []string{rt.FlashCookie("!" + rt.Plain(${UE(r.flash)}))}` : ""}}`);
        else P(`\t\treturn rt.Guarded{Refused: true, Outcome: ${q(r.outcome)}}`);
        P("\t}");
      }
      P("\treturn rt.Guarded{}");
      P("}");
    }
    // the screen's link: route parameters in the path, the others in the query
    const pieces: string[] = [];
    let route: string = d.route;
    const inRoute = new Set([...route.matchAll(/:(\w+)/g)].map((m) => m[1]));
    const arg = (i: number, p: any) => `func() rt.Val { if ${i} < len(args) { return args[${i}] }; return named[${q(p.name)}] }()`;
    let pathCode = q(route);
    d.params.forEach((p: any, i: number) => { if (inRoute.has(p.name)) pathCode = pathCode.replace(`:${p.name}`, `" + rt.EncodeURIComponent(rt.URLPart(${arg(i, p)})) + "`); else pieces.push(`rt.QueryPart(${q(p.name)}, ${arg(i, p)})`); });
    P(`func URL_${id}(args rt.List, named map[string]rt.Val) string { _ = named; return rt.JoinQuery(${pathCode}${pieces.map((x) => ", " + x).join("")}) }`);
    // url_of(screen(…)): the link's own address, query parameters included, made absolute
    P(`func URLOF_${id}(base string, args rt.List) string { return base + URL_${id}(args, nil) }`);
  }
  for (const d of of("api")) {
    let ofCode = q(String(d.route));
    [...String(d.route).matchAll(/:(\w+)/g)].forEach((m, i) => { ofCode = ofCode.replace(`:${m[1]}`, `" + rt.IDOrText(rt.Arg(args, ${i})) + "`); });
    P(`func URLOF_api_${ident(d.name)}(base string, args rt.List) string { _ = args; return base + ${ofCode} }`);
  }

  // ---- identities: a parameter identity's format, and the session's lookup
  for (const d of of("identity")) {
    const En = `E_${ident(d.entity)}`, ed = ents.get(d.entity) ?? fail(`unknown entity ${d.entity}`, d.pos);
    const where = d.where ? `func(c *rt.Ctx) bool { return ${exB(d.where, scope({ row: d.entity }))} }` : "nil";
    if (d.source === "param") {
      const fmt = d.format ? String(d.format.value) : "{id}";
      const names = [...fmt.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
      const re = "^" + fmt.split(/\{\w+\}/).map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("(.+?)") + "$";
      P(`var RE_${ident(d.name)} = regexp.MustCompile(${q(re)})`);
      P(`func RESOLVE_${ident(d.name)}(c *rt.Ctx, raw string) rt.Val {`);
      P(`\tm := RE_${ident(d.name)}.FindStringSubmatch(raw)`);
      P("\tif m == nil { return nil }");
      const k = (n: string) => names.indexOf(n) + 1;
      if (names.includes("id")) P(`\tvar rows []*rt.Row\n\tif n, ok := rt.ParseID(m[${k("id")}]); ok { if r := c.S.Find(${En}, n); r != nil { rows = []*rt.Row{r} } }`);
      else P(`\trows := c.S.Select(${En}, ${sqlConst(colEq([names[0]]))}, m[${k(names[0])}])`);
      P("\tfor _, row := range rows {");
      for (const nm of names) {
        if (nm === "id") P(`\t\tif strconv.FormatInt(row.ID, 10) != m[${k(nm)}] { continue }`);
        else { const i = ed.fields.findIndex((f: any) => f.name === nm); if (i < 0) fail(`${d.entity} has no field ${nm}`, d.pos); P(`\t\tif rt.JSString2(row.Get(${i})) != m[${k(nm)}] { continue }`); }
      }
      if (d.where) P(`\t\tif !(${where})(c.OnRow(${En}, row)) { continue }`);
      P(`\t\treturn rt.Ref{E: ${q(d.entity)}, ID: row.ID}`);
      P("\t}");
      P("\treturn nil");
      P("}");
    }
    if (d.source === "cookie") {
      const fi = ed.fields.findIndex((f: any) => f.name === (d.field ?? "token"));
      const ai = ed.fields.findIndex((f: any) => f.type.kind === "named" && f.type.name === actorEntity);
      if (fi < 0) fail(`${d.entity} has no field ${d.field ?? "token"}`, d.pos);
      P(`func SESSION_LOOKUP(c *rt.Ctx, token string) rt.Val {`);
      P(`\trows := c.S.Select(${En}, ${sqlConst(colEq([d.field ?? "token"]))}, token)`);
      P("\tif len(rows) == 0 { return nil }");
      // the session row's actor field; or, when the cookie names the actor's own row (User.token), that row
      P(ai >= 0 ? `\treturn rows[0].Get(${ai})` : d.entity === actorEntity ? `\treturn rt.Ref{E: ${q(d.entity)}, ID: rows[0].ID}` : "\treturn nil");
      P("}");
      P(`func SESSION_TOKEN(c *rt.Ctx, ref rt.Ref) (string, bool) {`);
      P(`\trow := c.S.Find(${En}, ref.ID)`);
      P(`\tif row == nil { return "", false }`);
      P(`\treturn rt.Plain(row.Get(${fi})), true`);
      P("}");
    }
    P(`var ID_${ident(d.name)} = &rt.Identity{Name: ${q(d.name)}, Entity: ${q(d.entity)}, Field: ${q(d.field ?? "")}, Source: ${q(d.source)}, Key: ${q(d.source === "cookie" ? String(d.key?.value ?? "") : d.source === "param" ? String(d.key?.name ?? d.key?.value ?? "") : "")}, Where: ${where}${d.source === "param" ? `, Resolve: RESOLVE_${ident(d.name)}` : ""}}`);
  }

  // ---- channels and API routes
  const chanCall = (t: any) => {
    if (!t) return "nil";
    const a = get("action", t.name) ?? fail(`unknown action ${t.name}`, t.pos);
    return `&rt.ChannelCall{Action: ${q(a.name)}, Args: func(parts []string) map[string]rt.Val { return map[string]rt.Val{${a.params.map((p: any, i: number) => `${q(p.name)}: rt.ChannelArg(parts, ${i})`).join(", ")}} }}`;
  };
  const apiRoutes = new Map<Decl, string[]>();
  for (const api of of("api")) {
    const names = new Set<string>([...ambient, "request", "query", "result"]);
    for (const r of api.routes) for (const m of (String(api.route) + (r.path ? "/" + r.path : "")).matchAll(/:(\w+)/g)) names.add(m[1]);
    const s = scope({ dyn: names });
    apiRoutes.set(api, api.routes.map((r: any) => {
      const t = r.target;
      const d = get("view", t.name) ?? get("action", t.name) ?? fail(`unknown API target ${t.name}`, r.pos);
      const pathNames = [...(String(api.route) + (r.path ? "/" + r.path : "")).matchAll(/:(\w+)/g)].map((m) => m[1]);
      const vars = pathNames.map((pn) => {
        const pt = d.params.find((x: any) => x.name === pn)?.type;
        return `${q(pn)}: ${pt?.kind === "named" && ents.has(pt.name) ? `rt.PathRef(p, ${q(pn)}, ${q(pt.name)})` : `rt.Val(p[${q(pn)}])`}`;
      });
      const args = d.params.map((p: any, i: number) => { const e = t.args[i] ?? t.named[p.name]; return `${q(p.name)}: rt.APIArg(${e ? `func(c *rt.Ctx) rt.Val { return ${ex(e, s)} }(rc.Ctx())` : "nil"})`; });
      const rr = routeRe(String(api.route) + (r.path ? "/" + r.path : ""));
      const parts = [`Method: ${q(r.method)}`, `Path: ${q(r.path)}`, `Target: ${q(t.name)}`, `Status: ${r.status ?? 200}`, `Pattern: regexp.MustCompile(${q(rr.re)})`, `Names: []string{${rr.names.map(q).join(", ")}}`,
        `Vars: func(p map[string]string) map[string]rt.Val { return map[string]rt.Val{${vars.join(", ")}} }`,
        `Args: func(rc *rt.RCtx) map[string]rt.Val { return map[string]rt.Val{${args.join(", ")}} }`];
      // the headers and Location a route sends when it succeeds (result: what the target gave)
      const extra = [...Object.entries(r.headers?.fields ?? {}).map(([k, v]: [string, any]) => [k, v]), ...(r.location ? [["Location", r.location]] : [])] as [string, any][];
      if (extra.length) parts.push(`Extra: func(rc *rt.RCtx) [][2]string { c := rc.Ctx(); return [][2]string{${extra.map(([k, v]) => `{${q(k)}, rt.Plain(${ex(v, s)})}`).join(", ")}} }`);
      if (r.json) { const jf = get("fn", r.json)!; parts.push(`JSON: func(c *rt.Ctx, v rt.Val) rt.Val { return ${box({ c: `F_${ident(r.json)}(c, ${convert({ c: "v", g: "val" }, gOfDecl(jf.params[0]?.type))})`, g: gOfDecl(jf.returns) } as any)} }`); }
      return `{${parts.join(", ")}}`;
    }));
  }

  ui = uiBase;
  // ---- assembling the app
  P("func build() (*rt.App, *rt.UI) {");
  P(`\tapp := &rt.App{Name: ${q(appDecl?.name ?? "")}, ActorEntity: ${q(actorEntity)}}`);
  P(`\tapp.Ents = map[string]*rt.Entity{${[...ents.keys()].map((n) => `${q(n)}: E_${ident(n)}`).join(", ")}}`);
  // externs bound to Go functions, checked against these types when the app starts (rt/gobind.go)
  const goName = (t: any): string => t.kind === "list" ? "List" : t.name + (t.optional ? "?" : "");
  const bound = of("extern").filter((d: any) => d.go);
  const scheds = of("schedule") as any[];
  if (JSON.stringify(decls).includes(`"kind":"sendmail"`)) P(`	app.SendsMail = true`);
  if (scheds.length) P(`\tapp.Schedules = []*rt.Schedule{${scheds.map((d) => {
    const parts = [`Name: ${q(d.name)}`, `Action: ${q(`schedule_${d.name}`)}`];
    if (d.entity) { const so = scheduleOf(d); parts.push(`Entity: ${q(d.entity)}`, `Bind: ${q(d.bind)}`, `Column: ${q(so.field)}`, `OffsetMS: ${so.off}`, `PastDueFire: ${d.pastDue === "fire"}`, `At: SAT_${ident(d.name)}`, `Where: SW_${ident(d.name)}`); }
    else if (d.every.daily) parts.push(`Daily: ${q(d.every.daily)}`, `Zone: ${q(d.every.zone ?? "")}`);
    else parts.push(`PeriodMS: ${durMS(d.every.period)}`);
    return `{${parts.join(", ")}}`;
  }).join(", ")}}`);
  if (bound.length) P(`\tapp.GoBindings = []rt.GoBinding{${bound.map((d: any) => `{Name: ${q(d.name)}, Where: ${q(`${basename(specPath)}:${d.pos.line}`)}, Params: []string{${d.params.map((x: any) => q(goName(x.type))).join(", ")}}, Returns: ${q(d.returns ? goName(d.returns) : "")}, Fn: ${d.go.pkg ? goPkgs.get(d.go.pkg) + "." : ""}${d.go.fn}}`).join(", ")}}`);
  P(`\tapp.LiveKeyChecks = liveKeyChecks`);
  P(`\tapp.EntityOrder =[]string{${[...ents.keys()].map(q).join(", ")}}`);
  for (const [n, d] of ents) {
    const En = `E_${ident(n)}`, id = ident(n);
    const stored = d.fields.flatMap(sqlCols);
    const cols = ["t0.id", "t0.seq", "t0.created", "t0.updated", ...stored.map((c: string) => `t0.${sq(c)}`)].join(", ");
    const names = ["id", "seq", "created", "updated", ...stored.map(sq)];
    P(`\t${En}.NCols = ${stored.length}`);
    P(`\t${En}.FieldCols = [][]string{${d.fields.map((f: any) => `{${sqlCols(f).map((c: string) => q(sq(c))).join(", ")}}`).join(", ")}}`);
    const rich = d.fields.map((f: any, i: number) => [f, i]).filter(([f]: any) => fkind(f) === "h");
    if (rich.length) P(`\t${En}.RichFields = []rt.RichField{${rich.map(([f, i]: any) => `{Idx: ${i}, Mentions: ${q(`${n}__${f.name}__mentions`)}, Embeds: ${q(`${n}__${f.name}__embeds`)}}`).join(", ")}}`);
    P(`\t${En}.Index = map[string]int{${d.fields.map((f: any, i: number) => `${q(f.name)}: ${i}`).join(", ")}}`);
    P(`\t${En}.Cols = ${q(cols)}`);
    P(`\t${En}.InsertSQL = ${q(`INSERT INTO ${sq(n)} (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`)}`);
    // a batch's insert: as many rows per statement as fit 32, under SQLite's 32766 parameters
    { const many = Math.max(1, Math.min(32, Math.floor(32766 / names.length))); const one = `(${names.map(() => "?").join(", ")})`;
      P(`\t${En}.InsertMany, ${En}.InsertManySQL = ${many}, ${q(`INSERT INTO ${sq(n)} (${names.join(", ")}) VALUES ${Array(many).fill(one).join(", ")}`)}`); }
    P(`\t${En}.UpdateSQL = ${q(`UPDATE ${sq(n)} SET updated = ?${stored.map((c: string) => `, ${sq(c)} = ?`).join("")} WHERE id = ?`)}`);
    P(d.kind === "entity" ? `\t${En}.NewRec, ${En}.Scan = newRec_${id}, scan_${id}` : `\t${En}.NewRec = func(f []rt.Val) rt.Rec { return rt.ValsRec(f) }`);
    if (d.kind === "entity" && d.fields.length < 64) P(`\t${En}.ScanMask = scanm_${id}`);
    P(`\t${En}.Create, ${En}.Delete, ${En}.TouchParents = C_${id}, D_${id}, TP_${id}`);
    P(`\t${En}.Setters = map[string]func(c *rt.Ctx, target, v rt.Val){${d.fields.map((f: any) => `${q(f.name)}: SET_${id}_${ident(f.name)}`).join(", ")}}`);
  }
  P("\tapp.Invariants = invariants");
  P("\tapp.Migrate = migrate");
  P(`\tapp.Enums = map[string][]string{${[...enums].map(([n, vs]) => `${q(n)}: {${vs.map(q).join(", ")}}`).join(", ")}}`);
  // reference data
  P("\tic := app.InitCtx()");
  P("\t_ = ic");
  let dataSeq = 1;
  for (const d of of("data")) {
    d.rows.forEach((assigns: any[], i: number) => {
      const vals = d.fields.map((f: any) => { const a = assigns.find((x: any) => x.name === f.name); return a ? ex(a.value, scope()).replace(/\bc\./g, "ic.") : "nil"; });
      P(`\tE_${ident(d.name)}.Data = append(E_${ident(d.name)}.Data, &rt.Row{ID: ${i + 1}, Seq: ${dataSeq++}, Created: 1767225600000, Updated: 1767225600000, R: rt.ValsRec{${vals.join(", ")}}})`);
    });
  }
  P(`\tapp.Actions = map[string]*rt.Action{`);
  for (const a of of("action")) P(`\t\t${q(a.name)}: {Name: ${q(a.name)}, Bind: BIND_${ident(a.name)}, Form: FORM_${ident(a.name)}, Skips: []string{${a.skips.map(q).join(", ")}}, Internal: ${!!a.internal}, AgentsOnly: ${!!a.noPeople}, Body: A_${ident(a.name)}, Guards: G_${ident(a.name)}},`);
  P("\t}");
  P(`\tapp.Views = map[string]*rt.View{`);
  for (const v of of("view")) {
    const parts = [`Name: ${q(v.name)}`, `Bind: BIND_${ident(v.name)}`, `Query: QUERY_${ident(v.name)}`, `Requires: VR_${ident(v.name)}`, `AgentsOnly: ${!!v.noPeople}`];
    if (v.value) { parts.push(`Value: VV_${ident(v.name)}`); if (v.value.kind === "extern" && get("extern", v.value.name)?.effect === "fetch") parts.push("Extern: true"); }
    else parts.push(`Entity: ${q(v.rows.entity)}`, `Rows: VRows_${ident(v.name)}`);
    P(`\t\t${q(v.name)}: {${parts.join(", ")}},`);
  }
  P("\t}");
  const fnDecls = [...of("fn"), ...of("predicate")];
  P(`\tapp.Fns = map[string]func(c *rt.Ctx, a []rt.Val) rt.Val{`);
  for (const d of fnDecls) { const callc = `${d.kind === "predicate" ? "P" : "F"}_${ident(d.name)}(${["c", ...d.params.map((pp: any, i: number) => convert({ c: `rt.Arg(a, ${i})`, g: "val" }, gOfDecl(pp.type)))].join(", ")})`; P(`\t\t${q(d.name)}: func(c *rt.Ctx, a []rt.Val) rt.Val { return ${box({ c: callc, g: d.kind === "predicate" ? "bool" : gOfDecl(d.returns) } as any)} },`); }
  P("\t}");
  P(`\tapp.FnArity = map[string]int{${fnDecls.map((d) => `${q(d.name)}: ${d.params.length}`).join(", ")}}`);
  P(`\tapp.Gates = []rt.Gate{${of("gate").map((g) => { cost.pushDecl(`gate ${g.name}`); const c = exB(g.cond, scope()); cost.popDecl(); return `{Name: ${q(g.name)}, Outcome: ${q(g.outcome)}, Cond: func(c *rt.Ctx) bool { return ${c} }}`; }).join(", ")}}`);
  P(`\tapp.Workflows = map[string][]func(c *rt.Ctx, arg rt.Val){${[...steps].map(([e, fs]) => `${q(e)}: {${fs.join(", ")}}`).join(", ")}}`);
  P(`\tapp.ScreenURLs = map[string]func(args rt.List, named map[string]rt.Val) string{${of("screen").map((d) => `${q(d.name)}: URL_${ident(d.name)}`).join(", ")}}`);
  P(`\tapp.URLsOf = map[string]func(base string, args rt.List) string{${[...of("screen").map((d) => `${q("screen:" + d.name)}: URLOF_${ident(d.name)}`), ...of("api").map((d) => `${q("api:" + d.name)}: URLOF_api_${ident(d.name)}`)].join(", ")}}`);

  P("\tu := &rt.UI{DefaultLabels: map[string]func(row *rt.Row) string{}}");
  P(`\tu.AppName = ${q(appDecl?.props.name ? String(appDecl.props.name.value) : "")}`);
  P(`\tu.SignIn = ${q(appDecl?.props.sign_in?.name ?? "")}`);
  P(`\tu.Setup = ${q(appDecl?.props.setup?.name ?? "")}`);
  if (appDecl?.props.setup_when) P(`\tu.SetupWhen = ${fnc(appDecl.props.setup_when, scope())}`);
  const theme = of("theme")[0];
  P(`\tu.Theme = map[string]rt.Expr{${theme ? Object.entries(theme.props).map(([k, v]) => `${q(k)}: ${fnc(v as Expr)}`).join(", ") : ""}}`);
  P(`\tu.Displays = map[string]func(c *rt.Ctx) rt.Val{${of("display").map((d) => `${q(d.entity)}: ${fnc(d.value, scope({ row: d.entity }))}`).join(", ")}}`);
  for (const [n, d] of ents) {
    if (of("display").some((x) => x.entity === n)) continue;
    const cands = ["name", "title", "label", "subject"].map((k) => fieldIndex(n, k)).filter((i) => i >= 0);
    P(`\tu.DefaultLabels[${q(n)}] = func(row *rt.Row) string { ${cands.map((i) => `if s, ok := row.Get(${i}).(string); ok && s != "" { return s }; `).join("")}_ = row; return "" }`);
  }
  P(`\tu.Avatars = map[string]func(c *rt.Ctx) rt.Val{${of("avatar").map((d) => `${q(d.entity)}: ${fnc(d.value, scope({ row: d.entity }))}`).join(", ")}}`);
  P(`\tu.Identities = []*rt.Identity{${of("identity").map((d) => `ID_${ident(d.name)}`).join(", ")}}`);
  if (of("identity").some((d) => d.source === "cookie")) {
    P("\tu.SessionLookup, u.SessionToken = SESSION_LOOKUP, SESSION_TOKEN");
    // what the lookup reads, so the app keeps its answers until a commit changes one: the
    // session's entity; with a where on it, anything ("*")
    const sess = of("identity").find((d) => d.source === "cookie")!;
    P(`\tu.SessionReads = []string{${sess.where ? `"*"` : q(sess.entity)}}`);
  }
  P(`\tu.Channels = map[string]*rt.ChannelDecl{${of("channel").map((d) => `${q(d.name)}: {Name: ${q(d.name)}, Open: ${chanCall(d.open)}, Close: ${chanCall(d.close)}, Every: ${chanCall(d.every?.target)}, EveryMS: ${d.every?.interval?.kind === "duration" ? d.every.interval.amount * UNIT_MS[d.every.interval.unit] : 0}}`).join(", ")}}`);
  P(`\tu.APIs = []*rt.APIDecl{`);
  for (const api of of("api")) {
    const ident0 = of("identity").find((d) => d.name === api.identity);
    P(`\t\t{Name: ${q(api.name)}, Route: ${q(String(api.route))}, Identity: ${q(api.identity)}, Ident: ${ident0 ? `ID_${ident(ident0.name)}` : "nil"}, Skips: []string{${(api.skips ?? []).map(q).join(", ")}}, Routes: []rt.APIRoute{${apiRoutes.get(api)!.join(", ")}}},`);
  }
  P("\t}");
  P(`\tu.Declared = map[string]bool{${of("widget").map((d) => `${q(d.name)}: true`).join(", ")}}`);
  P(`\tu.Permissions = map[string]func(c *rt.Ctx, row rt.Val) bool{${[...perms.keys()].map((e) => `${q(e)}: Perm_${ident(e)}`).join(", ")}}`);
  P(`\tu.Externs = map[string]string{${of("extern").map((d) => `${q(d.name)}: ${q(d.effect)}`).join(", ")}}`);
  // column pruning (rt prune.go): the fields each screen's render reads, a bit each, by entity:
  // its own reads, those of the components, functions, predicates, views and layout it names
  // (and theirs), and what every page reads (displays, avatars, read permissions, gates,
  // identities, the theme, and the name-like field an entity without a display shows). A row
  // given to a widget is read whole: its Go may read any field
  const screenMask = (() => {
    const kinds = new Set(["component", "fn", "predicate", "view", "layout"]);
    const named = new Map<string, Decl[]>();
    for (const d of decls) if (kinds.has(d.kind)) (named.get(d.name) ?? named.set(d.name, []).get(d.name)!).push(d);
    const always = [...typing.reads.keys()].filter((k) => /^(display|avatar|permission|gate|identity|theme) /.test(k));
    const labels: string[] = [];
    for (const [n, e] of ents) if (!of("display").some((x) => x.entity === n)) for (const f of ["name", "title", "label", "subject"]) if (e.fields.some((x: any) => x.name === f)) labels.push(`${n}.${f}`);
    return (screen: Decl): string => {
      const keys = new Set<string>(always), seen = new Set<Decl>(), whole = new Set<string>();
      const visit = (d: Decl) => {
        if (seen.has(d)) return;
        seen.add(d); keys.add(`${d.kind} ${d.name}`);
        if (d.layout) for (const l of named.get(d.layout) ?? []) visit(l);
        const walk = (x: any): void => {
          if (!x || typeof x !== "object") return;
          if (Array.isArray(x)) { x.forEach(walk); return; }
          if (x.kind === "el" && x.name === "widget") for (const a of [...(x.head?.args ?? []), ...Object.values(x.head?.named ?? {})]) { const t: any = typing.types.get(a as object); if (t?.k === "ref") whole.add(t.e); }
          for (const [k, v] of Object.entries(x)) {
            if (k === "pos") continue;
            if (typeof v === "string" && (k === "name" || k === "tag") && named.has(v)) for (const y of named.get(v)!) visit(y);
            else walk(v);
          }
        };
        walk(d);
      };
      visit(screen);
      const read = new Set([...[...keys].flatMap((k) => [...(typing.reads.get(k) ?? [])]), ...labels]);
      const parts: string[] = [];
      for (const [n, e] of ents) {
        if (e.kind !== "entity" || e.fields.length >= 64 || whole.has(n)) continue;
        let bits = 0n;
        e.fields.forEach((f: any, i: number) => { if (read.has(`${n}.${f.name}`)) bits |= 1n << BigInt(i); });
        if (bits !== (1n << BigInt(e.fields.length)) - 1n) parts.push(`${q(n)}: ${bits}`);
      }
      return parts.length ? `map[string]uint64{${parts.join(", ")}}` : "nil";
    };
  })();
  P(`\tu.Screens = []*rt.Screen{`);
  for (const d of of("screen")) {
    P(`\t\t{Name: ${q(d.name)}, Route: ${q(d.route)}, Public: ${!!d.public}, Remember: ${q(d.remember ?? "")}, RememberParam: ${q(d.params[0]?.name ?? "")}, Coerce: COERCE_${ident(d.name)}, Pattern: regexp.MustCompile(${q(routeRe(d.route).re)}), Names: []string{${routeRe(d.route).names.map(q).join(", ")}}, Guard: ${d.requires.length ? `GUARD_${ident(d.name)}` : "nil"}, Render: S_${ident(d.name)}${(d as any).file ? `, File: X_${ident(d.name)}` : `, Mask: ${screenMask(d)}`}},`);
  }
  P("\t}");
  // agents: what they may call (lang/describe.ts), and the fields they never see
  if (of("identity").some((d) => d.source === "token")) P(`\tu.Descriptor = ${q(JSON.stringify(describe(spec, source)))}`);
  const hidden = new Map<string, Set<string>>();
  const mark = (e: string, f: string) => (hidden.get(e) ?? hidden.set(e, new Set()).get(e)!).add(f);
  for (const x of decls) {
    if (x.kind === "entity") for (const f of x.fields) if (f.private || (f.type.kind === "named" && f.type.name === "Password")) mark(x.name, f.name);
    if (x.kind === "identity") {
      if (x.field) mark(x.entity, x.field);
      const fmt = x.format?.value; if (typeof fmt === "string") for (const m of fmt.matchAll(/\{(\w+)\}/g)) if (m[1] !== "id") mark(x.entity, m[1]);
    }
  }
  // agents: each entity's row without its private fields, and each callable's argument check
  for (const [n, d] of ents) {
    const vis = d.fields.map((f: any, i: number) => [f, i] as [any, number]).filter(([f]) => !hidden.get(n)?.has(f.name));
    P(`\tE_${ident(n)}.AgentRow = func(a *rt.Agents, s *rt.Sess, ref rt.Ref, row *rt.Row) map[string]any { m := a.AgentBase(s, ref, row); ${vis.map(([f, i]) => `m[${q(f.name)}] = a.Serialize(s, row.Get(${i}))`).join("; ")}${vis.length ? "; " : ""}return m }`);
  }
  if (of("identity").some((d) => d.source === "token")) {
    const desc = describe(spec, source);
    P("\tu.AgentArgs = map[string]func(given any) (map[string]rt.Val, map[string]any){");
    for (const c of desc.callables) {
      const schema = JSON.stringify(c.inputSchema);
      const names = c.params.map((x: any) => x.name);
      const lines = c.params.map((x: any) => {
        const sc = x.schema ?? {};
        const kind = x.type === "File" ? "file" : ["integer", "boolean", "string", "array"].includes(sc.type) ? sc.type : "";
        const en = Array.isArray(sc.enum) ? `[]string{${sc.enum.map((e: any) => q(String(e))).join(", ")}}` : "nil";
        return `if v, bad := rt.AgentArg(g, ${q(x.name)}, ${q(kind)}, ${en}, ${!x.optional && x.type !== "Bool"}, ${x.type === "RichText"}, ${q(JSON.stringify(sc))}, ${sc.maxLength ?? -1}, ${sc.minLength ?? -1}); bad != nil { return nil, bad } else { out[${q(x.name)}] = v }`;
      });
      P(`\t\t${q(c.name)}: func(given any) (map[string]rt.Val, map[string]any) { g, bad := rt.AgentObject(given, ${q(schema)}); if bad != nil { return nil, bad }; if bad := rt.AgentUnknown(g, []string{${names.map(q).join(", ")}}, ${q(c.name)}); bad != nil { return nil, bad }; out := map[string]rt.Val{}; ${lines.join("; ")}${lines.length ? "; " : ""}return out, nil },`);
    }
    P("\t}");
    P(`\tu.AgentRedact = map[string][]string{${desc.callables.filter((c: any) => c.params.some((x: any) => x.type === "Password")).map((c: any) => `${q(c.name)}: {${c.params.filter((x: any) => x.type === "Password").map((x: any) => q(x.name)).join(", ")}}`).join(", ")}}`);
  }
  P(`\tu.Elements = map[int]*rt.El{${[...registry.values()].join(", ")}}`);
  P("\treturn app, u");
  P("}");

  // invariant dependencies: entities whose changes can change the invariant's value, with the
  // reference field that reaches them from this entity ("" when reached some other way)
  function invariantDeps(entity: string, inv: Expr): Map<string, string> {
    const deps = new Map<string, string>();
    const ent = ents.get(entity)!;
    const all = (e: string) => deps.set(e, "");
    const seen = new Set<string>();
    const visit = (x: any, direct: boolean) => {
      if (!x || typeof x !== "object") return;
      if (Array.isArray(x)) { for (const y of x) visit(y, direct); return; }
      // self.f.g or .f.g, with f a reference: the row it points at
      if (direct && x.kind === "field" && x.target && (x.target.kind === "field" && x.target.target?.kind === "name" && x.target.target.name === "self" || x.target.kind === "rowfield")) {
        const fname = x.target.kind === "rowfield" ? x.target.name : x.target.name;
        const f = ent.fields.find((y: any) => y.name === fname);
        if (f && f.type.kind === "named" && ents.has(f.type.name)) {
          if (!deps.has(f.type.name)) deps.set(f.type.name, fname);
          else if (deps.get(f.type.name) !== fname) all(f.type.name);
          return;
        }
      }
      if (["query", "listq", "all"].includes(x.kind)) all(x.entity);
      if (x.kind === "call") {
        const d = get("predicate", x.name) ?? get("fn", x.name);
        if (d && !seen.has(d.name)) { seen.add(d.name); visit(d.body, false); }
        const v = get("view", x.name);
        if (v?.rows) all(v.rows.entity);
      }
      // a field of something other than this row: any row of any entity might be it
      if (!direct && x.kind === "field" && !(x.target?.kind === "name" && enums.has(x.target.name))) for (const e of ents.keys()) all(e);
      if (direct && x.kind === "field" && x.target?.kind === "field") for (const e of ents.keys()) all(e);
      for (const [k, v] of Object.entries(x)) if (k !== "pos") visit(v, direct);
    };
    visit(inv, true);
    deps.delete(entity);
    return deps;
  }

  // ---- storage: the same schema the TypeScript runtime creates
  const tmp = mkdtempSync(join(tmpdir(), "crudspec-gen-"));
  const dbPath = join(tmp, "app.sqlite");
  const plan = upgrade(dbPath, spec, { apply: true });
  if (plan.status === "blocked") fail("the schema can't be created");
  const db = new DatabaseSync(dbPath);
  const META = new Set(["crudspec_meta", "crudspec_versions", "crudspec_migrations", "crudspec_agent_tokens", "crudspec_audit", "crudspec_idempotency"]);
  const ddl = (db.prepare(`SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END, rowid`).all() as any[])
    .filter((r) => !META.has(r.name) && !String(r.name).startsWith("sqlite_")).map((r) => String(r.sql));
  // what the queries cost on this schema, as SQLite plans them; with indexes auto, the indexes
  // that serve the ones that scan or sort are the app's own (it keeps them in step when it starts)
  const growing = new Set(of("entity").filter((d) => !d.singleton).map((d) => d.name));
  const planned = cost.explain(db).filter((p) => growing.has(p.entity));
  const derived = cost.derive(db, planned);
  const auto = appDecl?.props.indexes?.name === "auto";
  // the indexes the spec declares (index (…)), to say which no query uses
  const declared = (db.prepare("SELECT name, tbl_name AS entity FROM sqlite_master WHERE type = 'index' AND name LIKE 'ix!_%!_!_%' ESCAPE '!'").all() as any[]).filter((r) => ents.has(String(r.entity))).map((r) => ({ name: String(r.name), entity: String(r.entity) }));
  lastCost = { planned, indexes: derived, auto, declared };
  db.close();
  rmSync(tmp, { recursive: true, force: true });
  const schema = schemaOf(spec);

  // the typed creates (createTyped), each for the fields its call sites give: their sizes
  // checked, the others' defaults worked out on the row being made, the row inserted from its
  // struct. Before the statement functions: a default may query
  // a row being made in r: the given fields' sizes checked, the others' defaults worked out
  const prepLines = (n: string, given: Set<number>, ind: string): string[] => {
    const d = ents.get(n)!, En = E(n), out: string[] = [];
    d.fields.forEach((f: any, i: number) => {
      if (!given.has(i)) return;
      const z = fieldSize(f);
      if (z.max === undefined && z.min === undefined) return;
      const k = fkind(f), o = optional(f), F = `r.F_${ident(f.name)}`, lim = `${z.max ?? -1}, ${z.min ?? -1}, ${q(`${n}.${f.name}`)}`;
      if (k === "t") out.push(o ? `${ind}if ${F}.Ok { rt.CheckText(${F}.V, ${lim}) }` : `${ind}if r.nulls&(1<<${i}) == 0 { rt.CheckText(${F}, ${lim}) }`);
      else if (k === "h") out.push(o ? `${ind}if ${F}.Ok { rt.CheckText(${F}.V.Text, ${lim}) }` : `${ind}if r.nulls&(1<<${i}) == 0 { rt.CheckText(${F}.Text, ${lim}) }`);
      else out.push(`${ind}rt.CheckSize(r.Get(${i}), ${lim})`);
    });
    const defs = d.fields.map((f: any, i: number) => [f, i] as [any, number]).filter(([f, i]) => !given.has(i) && f.default);
    if (defs.length) {
      out.push(`${ind}draft := c.DraftRec(r)`);
      for (const [f, i] of defs) {
        const a = assignField(f, i, tx(f.default, scope({ row: n, dynAll: true })), "r");
        if (a) out.push(`${ind}{ c := c.OnRow(${En}, draft); _ = c; ${a} }`);
      }
    }
    return out;
  };
  for (const [name, ct] of ctFns) {
    const d = ents.get(ct.entity)!, n = ct.entity, En = E(n);
    const out = [`func ${name}(c *rt.Ctx, r *R_${ident(n)}) rt.Ref {`, ...prepLines(n, ct.given, "\t")];
    if (d.singleton) out.push(`\tif c.S.First(${En}) != nil { rt.Refuse("invalid", ${q(`${n} exists`)}, "unique") }`);
    out.push(`\trow := c.S.InsertRec(${En}, r, c.Now())`, `\tref := rt.Ref{E: ${q(n)}, ID: row.ID}`, `\tTP_${ident(n)}(c, row)`);
    { const fc = fireCode("create", n, "", "ref", "nil"); if (fc) out.push(`\t${fc}`); }
    out.push("\treturn ref", "}");
    consts.push(out.join("\n"));
  }

  // the batched ensures (ensureLoop): the key's rows already there in one query, the others'
  // sizes checked and defaults worked out, then inserted InsertMany at a time
  for (const [name, ct] of cteFns) {
    const d = ents.get(ct.entity)!, n = ct.entity, En = E(n), F = (i: number) => `F_${ident(d.fields[i].name)}`;
    const vf = F(ct.vary), col = (i: number) => `t0.${sq(d.fields[i].name)}`;
    const sql = sqlConst(`SELECT ${col(ct.vary)} FROM ${sq(n)} t0 WHERE ${ct.fixed.map((i) => `${col(i)} = ? AND `).join("")}${col(ct.vary)} IN (SELECT value FROM json_each(?))`);
    const out = [`func ${name}(c *rt.Ctx, recs []*R_${ident(n)}) {`, "\tif len(recs) == 0 { return }",
      `\tids := make([]int64, len(recs)); for i, r := range recs { ids[i] = r.${vf} }`,
      // a key with a none part matches nothing stored (as ensure's lookup skips it)
      `\thave := map[int64]bool{}`,
      `\tif ${ct.fixed.map((i) => `recs[0].${F(i)} != 0`).join(" && ") || "true"} { have = c.S.KeyIDs(${sql}, []int64{${ct.fixed.map((i) => `recs[0].${F(i)}`).join(", ")}}, ids) }`,
      "\tout := make([]rt.Rec, 0, len(recs))",
      "\tfor _, r := range recs {",
      `\t\tif have[r.${vf}] { continue }`,
      `\t\thave[r.${vf}] = true`,
      ...prepLines(n, ct.given, "\t\t"),
      "\t\tout = append(out, r)", "\t}",
      `\tfor _, row := range c.S.InsertRecs(${En}, out, c.Now()) { TP_${ident(n)}(c, row) }`, "}"];
    consts.push(out.join("\n"));
  }

  // the statement functions (stmtFn): bind the typed parameters, scan with the entity's scanner;
  // a read-only request keeps each answer under the statement's number and its parameters
  {
    const GT: Record<string, string> = { Ref: "rt.Ref", Int: "int64", Text: "string", Bool: "bool", OptText: "rt.Opt[string]", OptInt: "rt.Opt[int64]" };
    const LEG: Record<string, string> = { Ref: "rt.PRef", Int: "rt.PInt", Text: "rt.PStr", Bool: "rt.PBool", OptText: "rt.POptStr", OptInt: "rt.POptInt" };
    const liveChecks: string[] = [];
    for (const [name, f] of stmtFns) {
      const En = E(f.entity), p = (i: number) => `p${i + 1}`;
      const from = `FROM ${sq(f.entity)} t0${f.where ? ` WHERE ${f.where}` : ""}`;
      const cols = ["t0.id", "t0.seq", "t0.created", "t0.updated", ...ents.get(f.entity)!.fields.flatMap(sqlCols).map((c: string) => `t0.${sq(c)}`)].join(", ");
      const sql = sqlConst(f.mode === "rows" ? `SELECT ${cols} ${from} ORDER BY ${f.order}` : `SELECT count(*) ${from}`);
      const ints: string[] = [], strs: string[] = [];
      let fits = true;
      f.binds.forEach((b, i) => { if (b === "Ref") ints.push(`${p(i)}.ID`); else if (b === "Int") ints.push(p(i)); else if (b === "Bool") ints.push(`rt.BoolInt(${p(i)})`); else if (b === "Text") strs.push(p(i)); else fits = false; });
      if (ints.length > 2 || strs.length > 1) fits = false;
      const key = `rt.MK{Q: ${f.id}${ints.map((x, i) => `, ${"AB"[i]}: ${x}`).join("")}${strs.length ? `, S: ${strs[0]}` : ""}}`;
      // its reads for live pages, found now (livekeys.ts); the app checks them in test mode
      const ks = liveKeys(f.entity, f.where), KF: Record<string, string> = { Ref: "rt.KRef", Int: "rt.KInt", Text: "", Bool: "rt.KBool", OptText: "rt.KOptText", OptInt: "rt.KOptInt" };
      liveChecks.push(`{${q(f.entity)}, ${q(f.where)}, ${q(liveKeysText(ks))}}`);
      const rd: string[] = [];
      let dynamic = false;
      for (const k of ks) {
        const b = f.binds[k.arg], v = `p${k.arg + 1}`;
        if (!k.col) { if (!k.cols?.length) rd.push(`s.ReadTable(${q(k.table)})`); else for (const c of k.cols) rd.push(`s.ReadCol(${q(k.table)}, ${q(c)})`); }
        else if (k.col === "id[]" || b === undefined) dynamic = true;
        else if (k.col === "id") { if (b === "Ref") rd.push(`s.ReadRow(${q(k.table)}, ${v}.ID)`); else if (b === "Int") rd.push(`s.ReadRow(${q(k.table)}, ${v})`); else dynamic = true; }
        else rd.push(`s.ReadEq(${q(k.table)}, ${q(k.col)}, ${KF[b]}(${v}))`);
      }
      const reads = dynamic ? `if s.Reads != nil { s.ReadWhere(${En}, ${q(f.where)}${f.binds.map((b, i) => `, ${LEG[b]}(${p(i)})`).join("")}) }` : rd.length ? `if s.Reads != nil { ${rd.join("; ")} }` : "";
      const binds = f.binds.map((b, i) => `st.${b}(${i + 1}, ${p(i)}); `).join("");
      const out = [`func ${name}(c *rt.Ctx${f.binds.map((b, i) => `, ${p(i)} ${GT[b]}`).join("")}) ${f.mode === "rows" ? "[]*rt.Row" : "int64"} {`, "\ts := c.S", `\t${reads}`];
      if (f.mode === "rows") {
        // (the columns a page reads, under its mask: rt prune.go)
        if (fits) out.push(`\tk := ${key}`, "\trows, ok := s.Kept(k)", "\tif !ok {", `\t\tst, cn := s.Stmt(s.SQL(${En}, ${sql})); ${binds}`, `\t\trows = s.ScanAll(${En}, st, cn)`, "\t\ts.Keep(k, rows)", "\t}");
        else out.push(`\tst, cn := s.Stmt(s.SQL(${En}, ${sql})); ${binds}`, `\trows := s.ScanAll(${En}, st, cn)`);
        out.push(`\tif s.Reads != nil { s.ReadKept(${En}, rows) }`, "\treturn rows", "}");
      } else {
        if (fits) out.push(`\tk := ${key}`, "\tif n, ok := s.KeptCount(k); ok { return n }");
        out.push(`\tst, cn := s.Stmt(${sql}); ${binds}`, "\tn := s.ScanCount(st, cn)");
        if (fits) out.push("\ts.KeepCount(k, n)");
        out.push("\treturn n", "}");
      }
      consts.push(out.join("\n"));
    }
    consts.push(`var liveKeyChecks = [][3]string{${liveChecks.join(", ")}}`);
  }

  const header = `// Code generated by lang/gogen/gen.ts from ${relative(process.cwd(), specPath).replace(/\\/g, "/")}. DO NOT EDIT.\npackage main\n\nimport (\n\t"bytes"\n\t"net/url"\n\t"regexp"\n\t"strconv"\n\t"strings"\n\n\t"crudspec/gogen/rt"\n${[...goPkgs].map(([pkg, alias]) => `\t${alias} ${JSON.stringify(pkg)}\n`).join("")})\n\nvar _ = rt.Val(nil)\nvar _ strings.Builder\nvar _ bytes.Buffer\nvar _ url.Values\nvar _ = regexp.MustCompile\nvar _ = strconv.Itoa\n\n`;
  const buildInfo = `var buildInfo = &rt.Build{DDL: []string{${ddl.map(q).join(", ")}}, SchemaHash: ${q(schemaHash(schema))}, SchemaJSON: ${q(JSON.stringify(schema))}, Migrations: []string{${of("migration").map((m) => q(m.name)).join(", ")}}, AutoIndexes: []string{${(auto ? derived : []).map((ix) => q(cost.indexSQL(ix))).join(", ")}}, Spec: ${q(relative(process.cwd(), specPath).replace(/\\/g, "/"))}}\n`;
  const files: Record<string, string> = {
    "app.go": specLines(header + consts.join("\n") + "\n\n" + go.join("\n") + "\n\n" + buildInfo + "\nfunc main() { app, ui := build(); rt.Main(app, ui, buildInfo, widgets) }\n", specWhere(specPath)),
  };
  const wpath = widgetsPath ?? join(dirname(specPath), "widgets.go");
  // the app's own Go functions that externs bind to (= go Func)
  const ext = join(dirname(specPath), "ext.go");
  if (existsSync(ext)) files["ext.go"] = readFileSync(ext, "utf8");
  files["widgets.go"] = existsSync(wpath) ? readFileSync(wpath, "utf8") : `package main\n\nimport "crudspec/gogen/rt"\n\nvar widgets = map[string]func([]rt.Val, rt.WidgetHelpers) string{}\n`;
  return files;
}

export const BUILTINS = new Set(["label", "plain", "text", "html", "mentions", "rich", "blank", "present", "authenticates", "token", "signed", "verify", "join", "split", "chunks", "sentence", "any", "count", "first", "last", "distinct", "set", "words", "initials", "first_word", "after", "lower", "upper", "trim", "length", "contains", "starts_with", "replace", "public_ip", "scheme", "port", "host_within", "url", "host", "path", "with_host", "url_of", "download", "file", "request_file", "words_only", "max", "min", "cookie", "matches"]);

// writes the program, with a go.mod that uses lang/gogen
// the invariants the build couldn't prove for a writer ("action post_message|admin_exists", "workflow
// MessagePosted: push|…"): the generated writer checks each when it runs (cli build sets them)
let backstops = new Set<string>();
export function setBackstops(pairs: Set<string>) { backstops = pairs; }
export function writeProgram(specPath: string, out: string, widgetsPath?: string) {
  const files = generate(specPath, widgetsPath);
  mkdirSync(out, { recursive: true });
  for (const [n, src] of Object.entries(files)) writeFileSync(join(out, n), src);
  const gogen = dirname(fileURLToPath(import.meta.url));
  const rel = relative(resolve(out), gogen).replace(/\\/g, "/");
  const mod = readFileSync(join(gogen, "go.mod"), "utf8");
  const requires = [...mod.matchAll(/^\s*([\w./-]+) (v[\w.+-]+)/gm)].map((m) => `\t${m[1]} ${m[2]}`);
  // the spec's pinned Go modules (import go "module@version"), with the app's go.sum for them
  for (const m of readSpec(specPath).matchAll(/^\s*import\s+go\s+"([^"@]+)@([^"]+)"/gm)) requires.push(`\t${m[1]} ${m[2]}`);
  writeFileSync(join(out, "go.mod"), `module crudspecapp\n\ngo 1.27\n\nrequire (\n\tcrudspec/gogen v0.0.0\n${requires.join("\n")}\n)\n\nreplace crudspec/gogen => ${rel.startsWith(".") ? rel : "./" + rel}\n`);
  const appSum = join(dirname(specPath), "go.sum");
  writeFileSync(join(out, "go.sum"), readFileSync(join(gogen, "go.sum"), "utf8") + (existsSync(appSum) ? readFileSync(appSum, "utf8") : ""));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const argv = process.argv.slice(2);
  const opt = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const [spec] = argv;
  const out = opt("--out");
  if (!spec || !out) { console.error("usage: node lang/gogen/gen.ts <spec.crud> --out <dir> [--widgets <widgets.go>]"); process.exit(64); }
  try { writeProgram(spec, out, opt("--widgets")); console.log(`wrote ${out}`); }
  catch (e) { if (e instanceof GenError) { console.error(e.message); process.exit(1); } throw e; }
}

// A line the generator marked with its spec line (// @spec N) gets a //line directive before
// it, so Go's stack traces and compile errors name the spec's line, and one after it that
// returns to app.go's own numbering.
// where a line of the app's joined source is, as file.crud:N (lang/source.ts)
function specWhere(specPath: string): (line: string) => string {
  const src = readSource(specPath);
  return (line) => (src.files.length === 1 ? `${basename(specPath)}:${line}` : at(src, Number(line)));
}
function specLines(src: string, where: (line: string) => string): string {
  const out: string[] = [];
  let mapped = false;
  for (const line of src.split("\n")) {
    const m = / \/\/ @spec (\d+)$/.exec(line);
    // line 0: the standard library's (lang/std), not in the app's files
    if (m && m[1] === "0") { out.push(line.slice(0, m.index)); continue; }
    if (m) {
      // the statement or element and what follows it, until the next one, are its spec line
      out.push(`//line ${where(m[1])}`, line.slice(0, m.index));
      mapped = true;
      continue;
    }
    // a new declaration is the generated file's own again
    if (mapped && /^(func|var|type|const) /.test(line)) { out.push(`//line app.go:${out.length + 2}`); mapped = false; }
    out.push(line);
  }
  return out.join("\n");
}

// a name made readable: not_found -> "Not found"
function readable(v: string): string { const s = v.replace(/_/g, " "); return s.charAt(0).toUpperCase() + s.slice(1); }
