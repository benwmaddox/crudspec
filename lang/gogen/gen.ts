// The Go backend: compiles a spec to a Go program against the runtime in lang/gogen/rt.
// Expressions, statements and queries become Go code; each query's `where` is planned as SQL
// here, once, as lang/runtime/sqlplan.ts plans it at run time (the same rules, so the same
// rows); the UI becomes element trees with compiled expressions, which rt renders as
// lang/runtime/server.ts does. Nothing here is app-specific.
//
//   node lang/gogen/gen.ts <spec.crud> --out <dir> [--widgets <widgets.go>]
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync, rmSync, mkdtempSync } from "node:fs";
import { join, dirname, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { parse, type Decl, type El, type Expr, type Stmt, type Spec } from "../parser.ts";
import { withGenerated } from "../scaffold.ts";
import { schemaOf, schemaHash } from "../schema.ts";
import { upgrade } from "../runtime/upgrade.ts";
import { describe } from "../describe.ts";

class GenError extends Error {}
const q = (s: string) => JSON.stringify(s);
const TEXTLIKE = new Set(["Text", "Email", "Url", "Ip"]);
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
};
const scope = (o: Partial<CS> = {}): CS => ({ locals: new Map(), dyn: new Set(), ...o });

export function generate(specPath: string, widgetsPath?: string): Record<string, string> {
  const source = readFileSync(specPath, "utf8");
  const spec: Spec = parse(source);
  withGenerated(spec, parse);   // default screens under /_auto, as the runtime adds them
  const decls = spec.decls;
  const of = (k: string) => decls.filter((d) => d.kind === k);
  const byKind = new Map<string, Decl>();
  for (const d of decls) if (!["trigger", "workflow", "permission"].includes(d.kind)) byKind.set(`${d.kind}:${d.name}`, d);
  const get = (k: string, n: string) => byKind.get(`${k}:${n}`);
  const ents = new Map<string, Decl>();
  for (const d of decls) if (d.kind === "entity" || d.kind === "data") ents.set(d.name, d);
  const stored = (e: string) => ents.get(e)?.kind === "entity";
  const enums = new Map<string, string[]>(of("enum").map((d) => [d.name, d.values]));
  const enumOf = new Map<string, string>();
  for (const [n, vs] of enums) for (const v of vs) enumOf.set(v, n);
  const perms = new Map<string, Expr>(of("permission").map((d) => [d.entity, d.cond]));
  const appDecl = of("app")[0];
  const actorEntity: string = appDecl?.props.actor?.name ?? "";
  const fail = (msg: string, pos?: { line: number }): never => { throw new GenError(`${specPath}:${pos?.line ?? "?"}: ${msg}`); };

  const consts: string[] = [];   // SQL text
  let hoistN = 0;
  const sqlConst = (sql: string) => { const n = `sq${consts.length}`; consts.push(`const ${n} = ${q(sql)}`); return n; };
  const E = (name: string) => { if (!ents.has(name)) fail(`unknown entity ${name}`); return `E_${ident(name)}`; };

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
    if (s.row && (["created", "updated", "id"].includes(n) || ents.get(s.row)!.fields.some((f: any) => f.name === n))) return `c.RowField(${q(n)})`;
    return null;
  }
  function name(e: Expr, s: CS): string {
    const n = e.name;
    if (s.locals.has(n)) return s.locals.get(n)!;
    const st = staticName(n, s);
    if (s.dyn.has(n) || (s.dynAll && st === null)) return st === null ? `c.Var(${q(n)})` : `c.VarOr(${q(n)}, func() rt.Val { return ${st} })`;
    if (st === null) fail(`unknown name ${n}`, e.pos);
    return st!;
  }

  // ---- expressions: Go code of type rt.Val (ex) or bool (exB)
  function exB(e: Expr, s: CS): string {
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
  function ex(e: Expr, s: CS): string {
    switch (e.kind) {
      case "lit":
        if (e.value === null) return "rt.Val(nil)";
        if (typeof e.value === "string") return q(e.value);
        if (typeof e.value === "number") return `int64(${e.value})`;
        return `rt.Val(${e.value})`;
      case "duration": return `rt.Dur{MS: ${e.amount * UNIT_MS[e.unit]}}`;
      case "now": return "rt.Time{T: c.Now(), Seq: rt.MaxSeq}";
      case "it": if (!s.row) fail("'it' outside a where", e.pos); return "c.It()";
      case "rowfield": if (!s.row) fail(`.${e.name} outside a where`, e.pos); return `c.RowField(${q(e.name)})`;
      case "name": return name(e, s);
      case "field": {
        if (e.target.kind === "name" && enums.has(e.target.name) && !s.locals.has(e.target.name) && !s.dyn.has(e.target.name)) return q(e.name);
        if (e.target.kind === "name" && e.target.name === "request" && !s.locals.has("request") && !s.dyn.has("request")) return `c.ReqField(${q(e.name)})`;
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
          case "first_or_none": return `rt.FirstOrNone(${E(e.entity)}, ${rowsCode(e, s)})`;
          case "set": return `rt.SetOf(${E(e.entity)}, ${rowsCode(e, s)})`;
        }
        return fail(`query ${e.op}`, e.pos);
      case "all": return `rt.Val(${exB(e, s)})`;
      case "listq": return e.map
        ? `c.MapRows(${E(e.entity)}, ${rowsCode(e, s)}, func(c *rt.Ctx) rt.Val { return ${ex(e.map, { ...s, row: e.entity })} })`
        : `rt.RefsOf(${E(e.entity)}, ${rowsCode(e, s)})`;
      case "extern": return "rt.Val(nil)";   // outside a workflow's let or call, an extern is an effect that returns none
      case "call": return call(e, s);
      case "hoisted": return e.code;
    }
    return fail(`unknown expression ${e.kind}`, e.pos);
  }
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
  function callFn(e: Expr, s: CS, asBool: boolean): string {
    const pred = get("predicate", e.name);
    const d = pred ?? get("fn", e.name)!;
    const code = `${pred ? "P" : "F"}_${ident(e.name)}(${["c", ...callArgs(d.params, e, s)].join(", ")})`;
    return pred ? (asBool ? code : `rt.Val(${code})`) : (asBool ? `rt.Truthy(${code})` : code);
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
  function rowsCode(qy: any, s: CS, perm?: { name: string; cond: Expr }): string {
    const lit = queryLit(qy, s, perm);
    const call = `c.Rows(${lit.lit}${lit.args.map((a) => `, ${a}`).join("")})`;
    return lit.hoisted.length ? `func() []*rt.Row { ${lit.hoisted.join("; ")}; return ${call} }()` : call;
  }
  function countCode(qy: any, s: CS): string {
    const lit = queryLit(qy, s);
    const call = `c.Count(${lit.lit}${lit.args.map((a) => `, ${a}`).join("")})`;
    return lit.hoisted.length ? `func() int64 { ${lit.hoisted.join("; ")}; return ${call} }()` : call;
  }
  function queryLit(qy: any, s: CS, perm?: { name: string; cond: Expr }): { lit: string; args: string[]; permDone: boolean; hoisted: string[] } {
    if (!ents.has(qy.entity)) fail(`unknown entity ${qy.entity}`, qy.pos);
    const rs: CS = { ...s, row: qy.entity };
    let sql = "", args: string[] = [], residual: Expr[] = [], permDone = false;
    if (stored(qy.entity)) {
      const p = new Planner(s).plan(qy.entity, qy.where, perm?.name, perm?.cond);
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
    return { lit: `&rt.Query{${parts.join(", ")}}`, args, permDone, hoisted };
  }

  // The planner, as lang/runtime/sqlplan.ts, at compile time: SQL text, and Go code for each
  // parameter (evaluated where the query runs).
  type Kind = { k: "id" | "ref" | "enum" | "text" | "bool" | "int" | "json" | "time" | "count"; entity?: string; nullable: boolean };
  type Frag = { sql: string; params: string[] };
  type Col = Frag & Kind;
  type Bind = { kind: "row"; alias: string; entity: string } | { kind: "col"; col: Col } | { kind: "value"; code: string };
  type PS = { alias: string; entity: string; env: Map<string, Bind>; depth: number };
  const sq = (n: string) => `"${n.replace(/"/g, '""')}"`;
  class Planner {
    aliases = 0;
    cs: CS;
    constructor(cs: CS) { this.cs = cs; }
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
    value(e: any, env: Map<string, Bind>): string {
      const locals = new Map(this.cs.locals);
      for (const [n, b] of env) if (b.kind === "value") locals.set(n, b.code);
      return ex(e, { ...this.cs, locals, row: undefined });
    }
    encode(kind: Kind, code: string): string {
      const ch = { id: "d", ref: "r", enum: "t", text: "t", bool: "b", int: "i", count: "i", json: "x", time: "x" }[kind.k];
      return `rt.SQLParam('${ch}', ${code})`;
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
      return { sql, params: [], k: "json", nullable };
    }
    bool(e: any, s: PS): Frag | null {
      if (!e) return null;
      if (s.depth > 12) return null;
      if (this.rowFree(e, s.env)) { const v = this.value(e, s.env); return { sql: "(? = 1)", params: [`rt.B01(rt.Truthy(${v}))`] }; }
      if (e.kind === "binary" && (e.op === "and" || e.op === "or")) {
        const a = this.bool(e.left, s), b = a && this.bool(e.right, s);
        return a && b ? { sql: `(${a.sql} ${e.op === "and" ? "AND" : "OR"} ${b.sql})`, params: [...a.params, ...b.params] } : null;
      }
      if (e.kind === "binary" && e.op === "implies") {
        const a = this.bool(e.left, s), b = a && this.bool(e.right, s);
        return a && b ? { sql: `(NOT ${a.sql} OR ${b.sql})`, params: [...a.params, ...b.params] } : null;
      }
      if (e.kind === "unary" && e.op === "not") { const a = this.bool(e.arg, s); return a ? { sql: `(NOT ${a.sql})`, params: a.params } : null; }
      if (e.kind === "binary" && (e.op === "==" || e.op === "!=")) return this.equality(e, s);
      if (e.kind === "binary" && ["<", ">", "<=", ">="].includes(e.op)) return this.ordering(e, s);
      if (e.kind === "binary" && e.op === "in") {
        const l = this.column(e.left, s);
        if (!l || l.k === "json" || l.k === "time" || !this.rowFree(e.right, s.env)) return null;
        const v = this.value(e.right, s.env);
        const ch = { id: "d", ref: "r", enum: "t", text: "t", bool: "b", int: "i", count: "i" }[l.k as string] ?? "x";
        return { sql: `(${l.sql} IN (SELECT value FROM json_each(?)))`, params: [...l.params, `rt.ParamList('${ch}', ${q(l.entity ?? "")}, ${v})`] };
      }
      if (e.kind === "query" && e.op === "exists") {
        const sub = this.subquery(e, s); if (!sub) return null;
        return { sql: `(EXISTS (SELECT 1 FROM ${sub.from} WHERE ${sub.where}))`, params: sub.params };
      }
      if (e.kind === "call") return this.inline(e, s, (body, inner) => this.bool(body, inner));
      if (e.kind === "lit" && typeof e.value === "boolean") return { sql: e.value ? "(1 = 1)" : "(1 = 0)", params: [] };
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
        return wrap({ sql: `(${l.sql} IS ${r.sql})`, params: [...l.params, ...r.params] });
      }
      let valueSide = e.right;
      if (!l && r) { l = r; valueSide = e.left; }
      if (!l || l.k === "json" || l.k === "time" || !this.rowFree(valueSide, s.env)) return null;
      const col = l;
      return wrap({ sql: `(${col.sql} IS ?)`, params: [...col.params, this.encode(col, this.value(valueSide, s.env))] });
    }
    ordering(e: any, s: PS): Frag | null {
      const flip: Record<string, string> = { "<": ">", ">": "<", "<=": ">=", ">=": "<=" };
      let l = this.column(e.left, s), valueSide = e.right, op = e.op;
      if (!l) { l = this.column(e.right, s); valueSide = e.left; op = flip[op]; }
      if (!l || l.nullable || !["time", "int", "count", "id"].includes(l.k) || !this.rowFree(valueSide, s.env)) return null;
      const v = this.value(valueSide, s.env), col = l;
      const whenNone = op === ">" || op === ">=" ? "1" : "0";
      if (col.k === "time") {
        const seqCol = col.sql.replace(/\.(created|updated)$/, ".seq");
        return { sql: `(CASE WHEN ? IS NULL THEN ${whenNone} ELSE (${col.sql}, ${seqCol}) ${op} (?, ?) END)`, params: [`rt.TimeNull(${v})`, `rt.TimeT(${v})`, `rt.TimeSeq(${v})`] };
      }
      const enc = this.encode(col, v);
      return { sql: `(CASE WHEN ? IS NULL THEN ${whenNone} ELSE ${col.sql} ${op} ? END)`, params: [enc, ...col.params, enc] };
    }
    subquery(e: any, s: PS): { from: string; where: string; params: string[] } | null {
      if (!stored(e.entity) || e.order || e.limit) return null;
      const alias = `t${++this.aliases}`;
      const inner: PS = { alias, entity: e.entity, env: s.env, depth: s.depth + 1 };
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
        if (this.rowFree(a, s.env)) { env.set(p.name, { kind: "value", code: this.value(a, s.env) }); continue; }
        if (a.kind === "it") { env.set(p.name, { kind: "row", alias: s.alias, entity: s.entity }); continue; }
        if (a.kind === "name" && s.env.get(a.name)?.kind === "row") { env.set(p.name, s.env.get(a.name)!); continue; }
        const c = this.column(a, s); if (!c) return null;
        env.set(p.name, { kind: "col", col: c });
      }
      return compile(d.body, { ...s, env, depth: s.depth + 1 });
    }
    plan(entity: string, where: any, permName?: string, perm?: any): { sql: string; params: string[]; residual: Expr[]; permResidual: boolean } {
      const conj: any[] = [];
      const flat = (x: any) => { if (x?.kind === "binary" && x.op === "and") { flat(x.left); flat(x.right); } else if (x) conj.push(x); };
      flat(where);
      const s: PS = { alias: "t0", entity, env: new Map(), depth: 0 };
      const parts: string[] = [], params: string[] = [], residual: Expr[] = [];
      for (const c of conj) { const f = this.bool(c, s); if (f) { parts.push(f.sql); params.push(...f.params); } else residual.push(c); }
      let permResidual = false;
      if (perm) {
        const f = this.bool(perm, { ...s, env: new Map([[permName!, { kind: "row", alias: "t0", entity } as Bind]]) });
        if (f) { parts.push(f.sql); params.push(...f.params); } else permResidual = true;
      }
      return { sql: parts.join(" AND "), params, residual, permResidual };
    }
  }

  // ---- statements
  type Out = string[];
  function stmts(ss: Stmt[], s: CS, out: Out, ind: string) { for (const st of ss) stmt(st, s, out, ind); }
  function stmt(st: Stmt, s: CS, out: Out, ind: string) {
    const w = (line: string) => out.push(ind + line);
    switch (st.kind) {
      case "require": w(`if !(${exB(st.cond, s)}) { rt.Refuse(${q(st.outcome)}, ${q(`require failed at line ${st.pos.line}`)}, "require") }`); return;
      case "reject": w(`rt.Refuse(${q(st.outcome)}, "rejected", "reject")`); return;
      case "let": w(`c.Vars[${q(st.name)}] = ${s.wf && st.value.kind === "extern" ? externRun(st.value, s) : ex(st.value, s)}`); return;
      case "result": w(`c.SetResult(${ex(st.value, s)})`); return;
      case "callstmt": w(`_ = ${s.wf && st.call.kind === "extern" ? externRun(st.call, s) : ex(st.call, s)}`); return;
      case "rate_limit": w(`c.RateLimit(${st.pos.line}, ${ex(st.by, s)}, ${st.n}, rt.DurMS(${ex(st.per, s)}), ${q(st.outcome)})`); return;
      case "create": {
        const ent = ents.get(st.entity) ?? fail(`unknown entity ${st.entity}`, st.pos);
        const given = st.fields.map((a: any) => {
          const i = ent.fields.findIndex((f: any) => f.name === a.name);
          if (i < 0) fail(`${st.entity} has no field ${a.name}`, st.pos);
          return `${i}: ${ex(a.value, s)}`;
        });
        const call = `c.Create(${E(st.entity)}, map[int]rt.Val{${given.join(", ")}}, ${!!st.ensure})`;
        if (st.as) w(`{ ref, _ := ${call}; c.Vars[${q(st.as)}] = ref }`); else w(`c.Create(${E(st.entity)}, map[int]rt.Val{${given.join(", ")}}, ${!!st.ensure})`);
        return;
      }
      case "set": w(`c.Set(${ex(st.target, s)}, ${q(st.name)}, ${ex(st.value, s)})`); return;
      case "touch": w(`c.Touch(${ex(st.target, s)})`); return;
      case "delete": w(`c.Delete(${ex(st.target, s)})`); return;
      case "deleteWhere": w(`c.DeleteRows(${E(st.entity)}, ${rowsCode({ entity: st.entity, where: st.where }, s)})`); return;
      case "foreach": {
        w(`c.ForEach(${E(st.entity)}, ${rowsCode({ entity: st.entity, where: st.where }, s)}, ${q(st.bind)}, func(c *rt.Ctx) {`);
        stmts(st.body, { ...s, row: undefined }, out, ind + "\t");
        w("})");
        return;
      }
      case "foreachList": {
        w(`c.ForList(${ex(st.over, s)}, ${q(st.bind)}, func(c *rt.Ctx) {`);
        stmts(st.body, { ...s, row: undefined }, out, ind + "\t");
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
      case "emit": w(`c.Emit(${[q(st.event), ...st.args.map((a: Expr) => ex(a, s))].join(", ")})`); return;
    }
    fail(`unknown statement ${st.kind}`, st.pos);
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

  // ---- the program
  const go: string[] = [];
  const P = (line = "") => go.push(line);
  const goParam = (p: any) => `{Name: ${q(p.name)}, Type: ${q(p.type.kind === "set" ? "set" : p.type.kind === "list" ? "list" : p.type.name)}, Of: ${q(p.type.of && typeof p.type.of === "string" ? p.type.of : "")}, Optional: ${!!(p.type.kind === "named" && p.type.optional)}}`;
  const goParams = (ps: any[]) => `[]rt.Param{${ps.map(goParam).join(", ")}}`;

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
    const locals = new Map<string, string>(d.params.map((p: any) => [p.name, `l_${ident(p.name)}`]));
    const s = scope({ locals });
    const sig = d.params.map((p: any) => `l_${ident(p.name)} rt.Val`).join(", ");
    if (d.kind === "predicate") P(`func P_${ident(d.name)}(c *rt.Ctx${sig ? ", " + sig : ""}) bool { c = c.NoRow(); return ${exB(d.body, s)} }`);
    else P(`func F_${ident(d.name)}(c *rt.Ctx${sig ? ", " + sig : ""}) rt.Val { c = c.NoRow(); return ${ex(d.body, s)} }`);
  }
  P();
  // read permissions: whether the row (bound to the entity's snake-case name) may be read
  for (const [entity, cond] of perms) {
    const locals = new Map([[snake(entity), "row"]]);
    P(`func Perm_${ident(entity)}(c *rt.Ctx, row rt.Val) bool { c = c.NoRow(); return ${exB(cond, scope({ locals }))} }`);
  }
  P();

  // actions
  for (const a of of("action")) {
    const s = scope({ dyn: new Set([...a.params.map((p: any) => p.name), ...binders(a.body)]) });
    const out: Out = [];
    stmts(a.body, s, out, "\t");
    P(`func A_${ident(a.name)}(c *rt.Ctx) {`); go.push(...out); P("}");
    // the guards: the leading lets and requires, up to the first statement that writes
    P(`func G_${ident(a.name)}(c *rt.Ctx) (string, string) {`);
    for (const st of a.body) {
      if (st.kind === "let") P(`\tc.Vars[${q(st.name)}] = ${ex(st.value, s)}`);
      else if (st.kind === "require") P(`\tif !(${exB(st.cond, s)}) { return ${q(st.outcome)}, "require" }`);
      else if (st.kind === "rate_limit") continue;
      else break;
    }
    P(`\treturn "ok", ""`);
    P("}");
  }
  P();

  // views
  for (const v of of("view")) {
    const s = scope({ dyn: new Set(v.params.map((p: any) => p.name)) });
    P(`func VR_${ident(v.name)}(c *rt.Ctx) string {`);
    for (const r of v.requires) P(`\tif !(${exB(r.cond, s)}) { return ${q(r.outcome)} }`);
    P(`\treturn ""`);
    P("}");
    if (v.value) {
      P(`func VV_${ident(v.name)}(c *rt.Ctx) rt.Val { return ${v.value.kind === "extern" ? externRun(v.value, s) : ex(v.value, s)} }`);
      continue;
    }
    const entity = v.rows.entity;
    const perm = perms.get(entity);
    const lit = queryLit({ entity, where: v.rows.where, order: v.order, desc: v.desc }, s, perm ? { name: snake(entity), cond: perm } : undefined);
    P(`func VRows_${ident(v.name)}(c *rt.Ctx) []*rt.Row {`);
    for (const h of lit.hoisted) P(`\t${h}`);
    P(`\trows := c.Rows(${lit.lit}${lit.args.map((x) => `, ${x}`).join("")})`);
    if (perm && !lit.permDone) P(`\trows = rt.Filter(rows, func(r *rt.Row) bool { return Perm_${ident(entity)}(c, rt.Ref{E: ${q(entity)}, ID: r.ID}) })`);
    const win: string[] = [];
    if (v.around) win.push(`AroundAt: func(c *rt.Ctx) rt.Val { return ${ex(v.around.at, s)} }`, `AroundSize: ${v.around.size}`);
    if (v.window) {
      win.push(`Size: ${v.window.size}`, `End: ${q(v.window.end)}`);
      if (v.window.unless) win.push(`Unless: func(c *rt.Ctx) bool { return ${exB(v.window.unless, s)} }`);
    }
    if (v.limit) win.push(`Limit: func(c *rt.Ctx) rt.Val { return ${ex(v.limit, s)} }`);
    if (v.page) win.push(`Page: ${v.page}`);
    P(win.length ? `\treturn c.ViewWindow(rows, &rt.Window{${win.join(", ")}})` : "\treturn rows");
    P("}");
  }
  P();

  // triggers, dispatched by event
  const triggers = of("trigger");
  triggers.forEach((t, i) => {
    const s = scope({ dyn: new Set([t.bind, "old", ...binders(t.body)]) });
    const out: Out = [];
    stmts(t.body, s, out, "\t");
    P(`func T_${i}(c *rt.Ctx, subject, old rt.Val) {`);
    P(`\tc = c.Trigger(${q(t.bind)}, subject, old, ${q(t.on.kind)})`);
    if (t.when) P(`\tif !(${exB(t.when, s)}) { return }`);
    go.push(...out);
    P("}");
  });
  P("func fire(c *rt.Ctx, kind, entity, field string, subject, old rt.Val) {");
  P("\tswitch kind + \":\" + entity + \":\" + field {");
  const groups = new Map<string, number[]>();
  triggers.forEach((t, i) => {
    const key = t.on.kind === "event" ? `event:${t.on.event}:` : `${t.on.kind}:${t.on.entity}:${t.on.kind === "update" ? t.on.field : ""}`;
    groups.set(key, [...(groups.get(key) ?? []), i]);
  });
  for (const [k, is] of groups) P(`\tcase ${q(k)}: ${is.map((i) => `T_${i}(c, subject, old)`).join("; ")}`);
  P("\t}");
  P("}");
  P();

  // workflows: their steps, by event, in the spec's order
  const steps = new Map<string, string[]>();
  of("workflow").forEach((w, i) => {
    w.steps.forEach((step: any, j: number) => {
      const s = scope({ dyn: new Set([w.bind, ...binders(step.body)]), wf: true });
      const out: Out = [];
      stmts(step.body, s, out, "\t");
      P(`func W_${i}_${j}(c *rt.Ctx, arg rt.Val) { // ${w.event}: ${step.name}`);
      P(`\tc.Vars[${q(w.bind)}] = arg`);
      go.push(...out);
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
  const ui = scope({ dyn: uiNames });
  const fnc = (e: Expr | undefined, s: CS = ui) => (e ? `func(c *rt.Ctx) rt.Val { return ${ex(e, s)} }` : "nil");
  const target = (t: any, s: CS = ui): string => {
    if (t.kind === "url") return `&rt.Target{URL: ${fnc(t.value, s)}}`;
    const named = Object.entries(t.named ?? {}).map(([k, v]) => `{Name: ${q(k)}, E: ${fnc(v as Expr, s)}}`);
    return `&rt.Target{Name: ${q(t.name)}, Bare: ${!!t.bare}, Args: []rt.Expr{${(t.args ?? []).map((a: Expr) => fnc(a, s)).join(", ")}}, Named: []rt.NamedExpr{${named.join(", ")}}}`;
  };
  let elId = 0;
  const ids = new Map<El, number>();
  const number = (els: El[]) => { for (const el of els) { ids.set(el, ++elId); number(el.children); if (el.else) number(el.else); } };
  for (const d of decls) if (d.body && Array.isArray(d.body) && ["screen", "component", "layout"].includes(d.kind)) number(d.body);
  // What a POST or a picker needs to find again by id: handlers, and fields with pickers.
  const registry = new Map<number, string>();
  // Every screen and component compiles to a Go function that evaluates its expressions and
  // writes its markup in order: no element tree is walked at run time.
  const UE = (e: Expr | undefined) => (e ? `rc.Ev(func(c *rt.Ctx) rt.Val { return ${ex(e, ui)} })` : "rt.Val(nil)");
  const attr = (x: El, k: string) => (x.attrs[k] === true ? "rt.Val(true)" : x.attrs[k] ? UE(x.attrs[k] as Expr) : "rt.Val(nil)");
  const has = (x: El, k: string) => k in x.attrs;
  const cls = (x: El, base: string) => `sv.Cls(${base}, ${x.attrs.class ? UE(x.attrs.class as Expr) : "nil"}, ${has(x, "class")})`;
  const visibleLabel = (x: El) => !has(x, "icon") && !has(x, "text") && (["submit", "button", "link"].includes(x.name) ||
    (x.name === "field" && ["select", "choice", "users"].includes(x.head.kind) && !has(x, "placeholder")));
  const label = (x: El) => `sv.Label(${attr(x, "label")}, ${visibleLabel(x)})`;
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
    t.args.forEach((a: Expr, i: number) => { if (params[i]) out.push(`${ind}w.WriteString(rt.HiddenArg(${q(params[i].name)}, ${UE(a)}))`); });
    for (const [k, v] of Object.entries(t.named)) out.push(`${ind}w.WriteString(rt.HiddenArg(${q(k)}, ${UE(v as Expr)}))`);
  };
  const W = (s: string) => `w.WriteString(${s})`;
  const lit = (s: string) => q(s);

  function uiEls(xs: El[], out: string[], ind: string) {
    for (let i = 0; i < xs.length; i++) {
      const x = xs[i];
      if (x.name === "button") { const hs: El[] = []; while (xs[i + 1]?.name === "on") hs.push(xs[++i]); uiEl(x, out, ind, hs); }
      else if (x.name !== "on") uiEl(x, out, ind, []);
    }
  }
  function onEntry(x: El) {
    const h = x.head;
    const target = (t: any): string => {
      if (t.kind === "url") return `&rt.Target{URL: ${fnc(t.value)}}`;
      const named = Object.entries(t.named ?? {}).map(([k, v]) => `{Name: ${q(k)}, E: ${fnc(v as Expr)}}`);
      return `&rt.Target{Name: ${q(t.name)}, Bare: ${!!t.bare}, Args: []rt.Expr{${(t.args ?? []).map((a: Expr) => fnc(a)).join(", ")}}, Named: []rt.NamedExpr{${named.join(", ")}}}`;
    };
    const rs = h.reactions.map((r: any) => r.kind === "go" ? `{Kind: "go", Target: ${target(r.target)}}` : r.value ? `{Kind: ${q(r.kind)}, Value: ${fnc(r.value)}}` : `{Kind: ${q(r.kind)}}`);
    registry.set(ids.get(x)!, `${ids.get(x)}: {ID: ${ids.get(x)}, Name: "on", Outcome: ${q(h.outcome)}, Reactions: []rt.Reaction{${rs.join(", ")}}}`);
  }
  function uiEl(x: El, out: string[], ind: string, handlers: El[]) {
    const w = (s: string) => out.push(ind + s);
    const h = x.head;
    const kids = (more = "\t") => uiEls(x.children, out, ind + more);
    w(`{ // ${x.name} (line ${x.pos.line})`);
    const inner = ind + "\t";
    const v = (s: string) => out.push(inner + s);
    let close = "}";
    if (x.attrs.if) { v(`if rt.Truthy(${UE(x.attrs.if as Expr)}) {`); close = "}}"; }
    const I = (s: string) => out.push(inner + "\t" + s);
    const at = x.attrs.if ? I : v;
    const k2 = x.attrs.if ? "\t\t" : "\t";
    switch (x.name) {
      case "title": if (h) at(`rc.Title = rt.Plain(${UE(h)})`); break;
      case "heading": at(W(`"<h1 class=\\"" + rt.Esc(${cls(x, `sv.DC("heading")`)}) + "\\">" + rt.Esc(rt.Plain(${UE(h)})) + "</h1>"`)); break;
      case "text": at(`if v := ${UE(h)}; v != nil { ${W(`"<span class=\\"" + rt.Esc(${cls(x, `""`)}) + "\\">" + rt.Esc(sv.TextOf(rc, v)) + "</span>"`)} }`); break;
      case "strong": at(W(`"<strong class=\\"" + rt.Esc(${cls(x, `""`)}) + "\\" title=\\"" + rt.Esc(rt.Plain(${attr(x, "title")})) + "\\">" + rt.Esc(rt.Plain(${UE(h)})) + "</strong>"`)); break;
      case "richtext": at(W(`sv.RichHTML(${UE(h)}, ${attr(x, "id")}, ${cls(x, `""`)})`)); break;
      case "time": at(W(`rt.TimeHTML(${UE(h)}, ${q((x.attrs.as as any)?.name ?? "")}, func() string { return ${cls(x, `""`)} })`)); break;
      case "image": at(`if v := ${UE(h)}; rt.Present(v) { wd, ht := ${attr(x, "width")}, ${attr(x, "height")}; ${W(`sv.Image(${cls(x, `""`)}, v, wd, ht)`)} }`); break;
      case "icon": at(W(`sv.Icon(${UE(h)}, 20)`)); break;
      case "avatar": at(`{ u := ${UE(h)}; ${W(`sv.Avatar(${cls(x, `sv.DC("avatar")`)}, ${!!x.attrs.large}, u, ${attr(x, "label")})`)} }`); break;
      case "avatars": at(W(`rt.Avatars(${UE(h)})`)); break;
      case "separator": at(W(lit(`<hr class="separator">`))); break;
      case "field_display": at(`{ l := ${attr(x, "label")}; ${W(`rt.FieldDisplay(l, ${UE(h)})`)} }`); break;
      case "let": at(`rc.Let(${q(h.name)}, ${UE(h.value)})`); break;
      case "if":
        at(`if rt.Truthy(${UE(h)}) {`); kids(k2 + "\t".slice(1) + "\t");
        if (x.else) { at("} else {"); uiEls(x.else, out, inner + k2); }
        at("}");
        break;
      case "each":
        at(`for _, x := range rt.Items(${UE(h.over)}) {`); at(`\trc := rc.With1(${q(h.bind)}, x)`); kids(k2 + "\t"); at("}");
        break;
      case "list": {
        const src = h.source;
        if (src.kind === "query") at(`refs := sv.QueryRefs(rc, ${q(src.entity)}, func(c *rt.Ctx) []*rt.Row { return ${rowsCode(src, ui)} }(rc.Ctx()), ${perms.has(src.entity) ? `Perm_${ident(src.entity)}` : "nil"})`);
        else {
          const view = get("view", src.name) ?? fail(`unknown view ${src.name}`, x.pos);
          at(`refs := sv.ViewRefs(rc, ${q(src.name)}, []rt.Val{${view.params.map((p: any, i: number) => UE(src.args[i] ?? src.named[p.name])).join(", ")}})`);
        }
        at(W(`"<div class=\\"" + rt.Esc(${cls(x, `""`)}) + "\\" data-live-list>"`));
        const where = h.where ? `func(rc *rt.RCtx) bool { return rt.Truthy(${UE(h.where)}) }` : "nil";
        const order = h.order ? `func(rc *rt.RCtx) rt.Val { return ${UE(h.order)} }` : "nil";
        at(`for _, rc := range sv.ListItems(rc, refs, ${q(h.bind)}, ${where}, ${order}, ${!!h.desc}) {`); kids(k2 + "\t"); at("}");
        at(W(lit("</div>")));
        break;
      }
      case "use": {
        const comp = get("component", h.name) ?? fail(`unknown component ${h.name}`, x.pos);
        at(`UI_${ident(h.name)}(sv, rc.WithVars(map[string]rt.Val{${comp.params.map((p: any, i: number) => `${q(p.name)}: ${UE(h.args[i])}`).join(", ")}}), w)`);
        break;
      }
      case "widget": {
        const attrsSwitch = Object.keys(x.attrs).filter((k) => x.attrs[k] !== true).map((k) => `case ${q(k)}: return ${UE(x.attrs[k] as Expr)}`).join("; ");
        at(W(`sv.Widget(rc, ${q(h.name)}, []rt.Val{${h.args.map((a: Expr) => UE(a)).join(", ")}}, rt.WidgetVals{Label: ${attr(x, "label")}, Icon: ${attr(x, "icon")}, Class: ${cls(x, `""`)}, ArgName: ${q(h.args[0]?.kind === "name" ? h.args[0].name : "")}, Attr: func(n string) rt.Val { switch n { ${attrsSwitch} }; return nil }})`));
        break;
      }
      case "channel": at(`rc.Channel(${q(h.name)}, []rt.Val{${h.args.map((a: Expr) => UE(a)).join(", ")}})`); break;
      case "signal": at(W(`"<div class=\\"" + sv.DC("signal") + "\\"></div>"`)); break;
      case "link": {
        at(`icon := ${attr(x, "icon")}`);
        at(`href := ${urlOf(h)}`);
        at(`unread := ${x.attrs.unread ? `rt.IfStr(rt.Truthy(${UE(x.attrs.unread as Expr)}), " unread", "")` : `""`}`);
        at(W(`"<a href=\\"" + rt.Esc(href) + "\\" class=\\"" + rt.Esc(${cls(x, x.children.length ? `""` : `sv.DC("button")`)}) + unread + "\\">" + sv.Icon(icon, 20) + ${label(x)}`));
        kids(k2);
        at(W(lit("</a>")));
        break;
      }
      case "button": {
        const a = actionOf(x);
        for (const hd of handlers) onEntry(hd);
        at(`if sv.WouldPass(rc, ${q(a.name)}, ${argMap(h, a.params)}) {`);
        const b = (s: string) => out.push(inner + k2 + s);
        b(`confirm, text, icon := ${attr(x, "confirm")}, ${attr(x, "text")}, ${attr(x, "icon")}`);
        b(`hid := sv.HandlerID([]int{${handlers.map((e) => ids.get(e)).join(", ")}}, rc)`);
        b(`sel := ${x.attrs.selected ? `rt.IfStr(rt.Truthy(${UE(x.attrs.selected as Expr)}), " btn--reversed", "")` : `""`}`);
        b(W(`"<form method=\\"post\\" action=\\"/_do/${a.name}\\" class=\\"" + sv.DC("button_form") + "\\" " + rt.OnSubmit(confirm) + ">"`));
        hiddenArgs(h, a.params, out, inner + k2);
        b(W(`"<input type=\\"hidden\\" name=\\"__h\\" value=\\"" + hid + "\\"><button type=\\"submit\\" class=\\"" + rt.Esc(${cls(x, `sv.DC("button")`)}) + sel + "\\">" + sv.Icon(icon, 20) + rt.TextOrEmpty(text) + ${label(x)}`));
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
        at("var body strings.Builder");
        at("{");
        at("\tw := &body");
        uiEls(x.children, out, inner + k2);
        at("}");
        at(W(`"<form method=\\"post\\" action=\\"/_do/${a.name}\\" enctype=\\"multipart/form-data\\" class=\\"" + rt.Esc(${cls(x, `sv.DC("form")`)}) + "\\" id=\\"" + rt.Esc(rt.Plain(${attr(x, "id")})) + "\\"${x.attrs.auto_submit ? ` onchange=\\"this.requestSubmit()\\"` : ""}>"`));
        hiddenArgs(h, a.params, out, inner + k2.slice(1));
        at(W(`"<input type=\\"hidden\\" name=\\"__h\\" value=\\"" + hid + "\\"><fieldset " + dis + " class=\\"" + sv.DC("fieldset") + "\\">" + body.String() + "</fieldset></form>"`));
        break;
      }
      case "field": {
        const flags = Object.keys(x.attrs).map((k) => `${q(k)}: true`);
        const parts = [`ID: ${ids.get(x)}`, `Name: "field"`, `FieldName: ${q(h.name)}`, `FieldKind: ${q(h.kind)}`, `Flags: map[string]bool{${flags.join(", ")}}`];
        const pc: any = x.attrs.mentions ?? x.attrs.autocomplete;
        if (pc && pc !== true) {
          const view = pc.kind === "call" ? get("view", pc.name) : undefined;
          if (view) parts.push(`Pick: &rt.Pick{View: ${q(pc.name)}, Args: []rt.Expr{${view.params.map((p: any, i: number) => fnc(pc.args[i] ?? pc.named?.[p.name])).join(", ")}}}`);
        }
        const uf: any = x.attrs.unfurl;
        if (uf && uf !== true && uf.kind === "name" && get("view", uf.name)) parts.push(`Unfurl: ${q(uf.name)}`, `UnfurlParam: ${q(get("view", uf.name)!.params[0]?.name ?? "link")}`);
        registry.set(ids.get(x)!, `${ids.get(x)}: {${parts.join(", ")}}`);
        const kind = h.kind;
        const vals = [`Value: ${attr(x, "value")}`, `PH: ${attr(x, "placeholder")}`, `Max: ${attr(x, "maxlength")}`, `Icon: ${attr(x, "icon")}`];
        if (kind === "textarea" || kind === "code") vals.push(`Rows: ${attr(x, "rows")}`);
        if (["choice", "users", "select"].includes(kind)) vals.push(`From: ${attr(x, "from")}`, `HasFrom: ${has(x, "from")}`);
        if (kind === "file") vals.push(`Accept: ${attr(x, "accept")}`);
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
        out.push(inner + k2 + W(`"<fieldset class=\\"" + rt.Esc(${cls(x, `""`)}) + banned + "\\"><legend><strong>" + rt.Esc(rt.Plain(lg)) + "</strong></legend>"`));
        uiEls(x.children, out, inner + k2);
        out.push(inner + k2 + W(lit("</fieldset>")));
        at("} else {");
        out.push(inner + k2 + `banned := ${x.attrs.banned ? `rt.IfStr(rt.Present(${UE(x.attrs.banned as Expr)}), " banned", "")` : `""`}`);
        out.push(inner + k2 + W(`"<section class=\\"" + rt.Esc(${cls(x, `""`)}) + banned + "\\" id=\\"" + rt.Esc(rt.Plain(${attr(x, "id")})) + "\\">"`));
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
      case "menu":
        at(`icon := ${attr(x, "icon")}`);
        at(`if !rt.Present(icon) && ${!has(x, "label")} {`);
        out.push(inner + k2 + W(`"<menu class=\\"" + rt.Esc(${cls(x, `sv.DC("menu")`)}) + "\\">"`)); uiEls(x.children, out, inner + k2); out.push(inner + k2 + W(lit("</menu>")));
        at("} else {");
        out.push(inner + k2 + W(`"<details class=\\"" + sv.DC("dropdown") + "\\"><summary class=\\"" + sv.DC("button") + "\\">" + sv.Icon(icon, 20) + ${label(x)} + "</summary><menu class=\\"" + sv.DC("dropdown_panel") + "\\">"`));
        uiEls(x.children, out, inner + k2); out.push(inner + k2 + W(lit("</menu></details>")));
        at("}");
        break;
      case "popup":
        at(`icon, panel := ${attr(x, "icon")}, ${attr(x, "panel")}`);
        at(`pc := sv.DC("dropdown_panel"); if panel != nil { pc = rt.Plain(panel) }`);
        at(W(`"<details class=\\"" + sv.DC("dropdown") + "\\"><summary class=\\"" + rt.Esc(${cls(x, `sv.DC("button")`)}) + "\\">" + sv.Icon(icon, 20) + ${label(x)} + "</summary><div class=\\"" + rt.Esc(pc) + "\\">"`));
        kids(k2); at(W(lit("</div></details>")));
        break;
      case "dialog": case "frame": at(W(lit("<div>"))); kids(k2); at(W(lit("</div>"))); break;
      case "nav": case "main": case "footer": case "sidebar":
        at("var slot strings.Builder"); at("{"); at("\tw := &slot"); kids(k2 + "\t"); at("}"); at(`rc.AddSlot(${q(x.name)}, slot.String())`);
        break;
      case "go": case "slot": case "aside": case "flash": break;
      default: fail(`unknown UI element ${x.name}`, x.pos);
    }
    w(close);
  }
  // components and screens as functions
  const usesW = (fnBody: string[]) => fnBody.some((l) => /\bw\b/.test(l));
  for (const d of of("component")) {
    const body: string[] = [];
    uiEls(d.body, body, "\t");
    P(`func UI_${ident(d.name)}(sv *rt.Server, rc *rt.RCtx, w *strings.Builder) {`);
    if (!usesW(body)) P("\t_ = w");
    go.push(...body);
    P("}");
  }
  for (const d of of("screen")) {
    const body: string[] = [];
    for (const x of d.body) {
      if (["nav", "main", "footer", "sidebar", "title", "channel", "let"].includes(x.name)) uiEl(x, body, "\t", []);
      else if (x.name === "if") {
        const g = x.children.find((c) => c.name === "go");
        body.push(g ? `\tif rt.Truthy(${UE(x.head)}) { return ${urlOf(g.head)} }` : `\t_ = rt.Truthy(${UE(x.head)})`);
      } else {
        body.push("\t{", "\t\tvar main strings.Builder", "\t\tw := &main");
        uiEl(x, body, "\t\t", []);
        body.push("\t\trc.AddSlot(\"main\", main.String())", "\t}");
      }
    }
    P(`func S_${ident(d.name)}(sv *rt.Server, rc *rt.RCtx) string {`);
    go.push(...body);
    P("\treturn \"\"");
    P("}");
  }

  // ---- assembling the app
  P("func build() (*rt.App, *rt.UI) {");
  P(`\tapp := &rt.App{Name: ${q(appDecl?.name ?? "")}, ActorEntity: ${q(actorEntity)}}`);
  P(`\tapp.Ents = map[string]*rt.Entity{${[...ents.keys()].map((n) => `${q(n)}: E_${ident(n)}`).join(", ")}}`);
  P(`\tapp.EntityOrder = []string{${[...ents.keys()].map(q).join(", ")}}`);
  P(`\tfor _, e := range app.Ents { e.Prepare() }`);
  P(`\tapp.Enums = map[string][]string{${[...enums].map(([n, vs]) => `${q(n)}: {${vs.map(q).join(", ")}}`).join(", ")}}`);
  // field rules and invariants
  P("\tapp.Rules = map[string]*rt.Rules{}");
  for (const [n, d] of ents) {
    const rs = scope({ row: n, dynAll: true });
    const fr = d.fields.map((f: any) => {
      const parts: string[] = [];
      if (f.onDelete && f.onDelete !== "restrict") parts.push(`OnDelete: ${q(f.onDelete)}`);
      if (f.touches) parts.push("Touches: true");
      if (f.default) parts.push(`Default: ${fnc(f.default, rs)}`);
      return `{${parts.join(", ")}}`;
    });
    const invs = (d.invariants ?? []).map((inv: Expr) => {
      const deps = invariantDeps(n, inv);
      return `{Line: ${inv.pos.line}, Cond: func(c *rt.Ctx) bool { return ${exB(inv, scope({ row: n, dyn: new Set(["self"]) }))} }, Deps: map[string]string{${[...deps].map(([e, via]) => `${q(e)}: ${q(via)}`).join(", ")}}}`;
    });
    P(`\tapp.Rules[${q(n)}] = &rt.Rules{Fields: []rt.FieldRules{${fr.join(", ")}}, Invariants: []rt.Invariant{${invs.join(", ")}}}`);
  }
  // reference data
  P("\tic := app.InitCtx()");
  P("\t_ = ic");
  let dataSeq = 1;
  for (const d of of("data")) {
    d.rows.forEach((assigns: any[], i: number) => {
      const vals = d.fields.map((f: any) => { const a = assigns.find((x: any) => x.name === f.name); return a ? ex(a.value, scope()).replace(/\bc\./g, "ic.") : "nil"; });
      P(`\tE_${ident(d.name)}.Data = append(E_${ident(d.name)}.Data, &rt.Row{ID: ${i + 1}, Seq: ${dataSeq++}, Created: 1767225600000, Updated: 1767225600000, F: []rt.Val{${vals.join(", ")}}})`);
    });
  }
  P(`\tapp.Actions = map[string]*rt.Action{`);
  for (const a of of("action")) P(`\t\t${q(a.name)}: {Name: ${q(a.name)}, Params: ${goParams(a.params)}, Skips: []string{${a.skips.map(q).join(", ")}}, Internal: ${!!a.internal}, Body: A_${ident(a.name)}, Guards: G_${ident(a.name)}},`);
  P("\t}");
  P(`\tapp.Views = map[string]*rt.View{`);
  for (const v of of("view")) {
    const parts = [`Name: ${q(v.name)}`, `Params: ${goParams(v.params)}`, `Requires: VR_${ident(v.name)}`];
    if (v.value) { parts.push(`Value: VV_${ident(v.name)}`); if (v.value.kind === "extern" && get("extern", v.value.name)?.effect === "fetch") parts.push("Extern: true"); }
    else parts.push(`Entity: ${q(v.rows.entity)}`, `Rows: VRows_${ident(v.name)}`);
    P(`\t\t${q(v.name)}: {${parts.join(", ")}},`);
  }
  P("\t}");
  const fnDecls = [...of("fn"), ...of("predicate")];
  P(`\tapp.Fns = map[string]func(c *rt.Ctx, a []rt.Val) rt.Val{`);
  for (const d of fnDecls) P(`\t\t${q(d.name)}: func(c *rt.Ctx, a []rt.Val) rt.Val { return ${d.kind === "predicate" ? "rt.Val(" : ""}${d.kind === "predicate" ? "P" : "F"}_${ident(d.name)}(${["c", ...d.params.map((_: any, i: number) => `rt.Arg(a, ${i})`)].join(", ")})${d.kind === "predicate" ? ")" : ""} },`);
  P("\t}");
  P(`\tapp.FnArity = map[string]int{${fnDecls.map((d) => `${q(d.name)}: ${d.params.length}`).join(", ")}}`);
  P(`\tapp.Gates = []rt.Gate{${of("gate").map((g) => `{Name: ${q(g.name)}, Outcome: ${q(g.outcome)}, Cond: func(c *rt.Ctx) bool { return ${exB(g.cond, scope())} }}`).join(", ")}}`);
  P(`\tapp.Workflows = map[string][]func(c *rt.Ctx, arg rt.Val){${[...steps].map(([e, fs]) => `${q(e)}: {${fs.join(", ")}}`).join(", ")}}`);
  P("\tapp.Fire = fire");
  P(`\tapp.Screens = map[string]*rt.ScreenInfo{${of("screen").map((d) => `${q(d.name)}: {Route: ${q(d.route)}, Params: []string{${d.params.map((p: any) => q(p.name)).join(", ")}}}`).join(", ")}}`);
  P(`\tapp.APIRoutes = map[string]string{${of("api").map((d) => `${q(d.name)}: ${q(String(d.route))}`).join(", ")}}`);

  P("\tu := &rt.UI{}");
  P(`\tu.AppName = ${q(appDecl?.props.name ? String(appDecl.props.name.value) : "")}`);
  P(`\tu.SignIn = ${q(appDecl?.props.sign_in?.name ?? "")}`);
  P(`\tu.Setup = ${q(appDecl?.props.setup?.name ?? "")}`);
  if (appDecl?.props.setup_when) P(`\tu.SetupWhen = ${fnc(appDecl.props.setup_when, scope())}`);
  const theme = of("theme")[0];
  P(`\tu.Theme = map[string]rt.Expr{${theme ? Object.entries(theme.props).map(([k, v]) => `${q(k)}: ${fnc(v as Expr)}`).join(", ") : ""}}`);
  P(`\tu.Displays = map[string]func(c *rt.Ctx) rt.Val{${of("display").map((d) => `${q(d.entity)}: ${fnc(d.value, scope({ row: d.entity }))}`).join(", ")}}`);
  P(`\tu.Avatars = map[string]func(c *rt.Ctx) rt.Val{${of("avatar").map((d) => `${q(d.entity)}: ${fnc(d.value, scope({ row: d.entity }))}`).join(", ")}}`);
  P(`\tu.Identities = []*rt.Identity{${of("identity").map((d) => {
    const key = d.source === "cookie" ? String(d.key?.value ?? "") : d.source === "param" ? String(d.key?.name ?? d.key?.value ?? "") : "";
    const parts = [`Name: ${q(d.name)}`, `Entity: ${q(d.entity)}`, `Field: ${q(d.field ?? "")}`, `Source: ${q(d.source)}`, `Key: ${q(key)}`, `Format: ${q(d.format ? String(d.format.value) : "")}`];
    if (d.where) parts.push(`Where: func(c *rt.Ctx) bool { return ${exB(d.where, scope({ row: d.entity }))} }`);
    return `{${parts.join(", ")}}`;
  }).join(", ")}}`);
  P(`\tu.Channels = map[string]*rt.ChannelDecl{${of("channel").map((d) => `${q(d.name)}: {Name: ${q(d.name)}, Open: ${q(d.open?.name ?? "")}, Close: ${q(d.close?.name ?? "")}, Every: ${q(d.every?.target?.name ?? "")}}`).join(", ")}}`);
  P(`\tu.APIs = []*rt.APIDecl{`);
  for (const api of of("api")) {
    const names = new Set<string>([...ambient, "request", "query"]);
    const routes = api.routes.map((r: any) => {
      const full = String(api.route) + (r.path ? "/" + r.path : "");
      for (const m of full.matchAll(/:(\w+)/g)) names.add(m[1]);
      return r;
    });
    const s = scope({ dyn: names });
    const rs = routes.map((r: any) => {
      const t = r.target;
      const d = get("view", t.name) ?? get("action", t.name) ?? fail(`unknown API target ${t.name}`, r.pos);
      const args = d.params.map((p: any, i: number) => fnc(t.args[i] ?? t.named[p.name], s));
      const parts = [`Method: ${q(r.method)}`, `Path: ${q(r.path)}`, `Target: ${q(t.name)}`, `Args: []rt.Expr{${args.join(", ")}}`, `Status: ${r.status ?? 200}`];
      if (r.json) parts.push(`JSON: func(c *rt.Ctx, v rt.Val) rt.Val { return F_${ident(r.json)}(c, v) }`);
      return `{${parts.join(", ")}}`;
    });
    P(`\t\t{Name: ${q(api.name)}, Route: ${q(String(api.route))}, Identity: ${q(api.identity)}, Skips: []string{${(api.skips ?? []).map(q).join(", ")}}, Routes: []rt.APIRoute{${rs.join(", ")}}},`);
  }
  P("\t}");
  P(`\tu.Declared = map[string]bool{${of("widget").map((d) => `${q(d.name)}: true`).join(", ")}}`);
  P(`\tu.Permissions = map[string]func(c *rt.Ctx, row rt.Val) bool{${[...perms.keys()].map((e) => `${q(e)}: Perm_${ident(e)}`).join(", ")}}`);
  P(`\tu.Externs = map[string]string{${of("extern").map((d) => `${q(d.name)}: ${q(d.effect)}`).join(", ")}}`);
  P(`\tu.Screens = []*rt.Screen{`);
  for (const d of of("screen")) {
    const reqs = d.requires.map((r: any) => r.go ? `{Cond: ${fnc(r.cond)}, Go: ${target(r.go)}${r.flash ? `, Flash: ${fnc(r.flash)}` : ""}}` : `{Cond: ${fnc(r.cond)}, Outcome: ${q(r.outcome)}}`);
    P(`\t\t{Name: ${q(d.name)}, Route: ${q(d.route)}, Params: ${goParams(d.params)}, Public: ${!!d.public}, Remember: ${q(d.remember ?? "")}, Requires: []rt.ScreenReq{${reqs.join(", ")}}, Render: S_${ident(d.name)}},`);
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
  P(`\tu.Hidden = map[string]map[string]bool{${[...hidden].map(([e, fs]) => `${q(e)}: {${[...fs].map((f) => `${q(f)}: true`).join(", ")}}`).join(", ")}}`);
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
  const ddl = (db.prepare(`SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type DESC, rowid`).all() as any[])
    .filter((r) => !META.has(r.name) && !String(r.name).startsWith("sqlite_")).map((r) => String(r.sql));
  db.close();
  rmSync(tmp, { recursive: true, force: true });
  const schema = schemaOf(spec);

  const header = `// Code generated by lang/gogen/gen.ts from ${relative(process.cwd(), specPath).replace(/\\/g, "/")}. DO NOT EDIT.\npackage main\n\nimport (\n\t"strings"\n\n\t"crudspec/gogen/rt"\n)\n\nvar _ = rt.Val(nil)\nvar _ strings.Builder\n\n`;
  const buildInfo = `var buildInfo = &rt.Build{DDL: []string{${ddl.map(q).join(", ")}}, SchemaHash: ${q(schemaHash(schema))}, SchemaJSON: ${q(JSON.stringify(schema))}, Migrations: []string{${of("migration").map((m) => q(m.name)).join(", ")}}, Spec: ${q(relative(process.cwd(), specPath).replace(/\\/g, "/"))}}\n`;
  const files: Record<string, string> = {
    "app.go": header + consts.join("\n") + "\n\n" + go.join("\n") + "\n\n" + buildInfo + "\nfunc main() { app, ui := build(); rt.Main(app, ui, buildInfo, widgets) }\n",
  };
  const wpath = widgetsPath ?? join(dirname(specPath), "widgets.go");
  files["widgets.go"] = existsSync(wpath) ? readFileSync(wpath, "utf8") : `package main\n\nimport "crudspec/gogen/rt"\n\nvar widgets = map[string]func([]rt.Val, rt.WidgetHelpers) string{}\n`;
  return files;
}

const BUILTINS = new Set(["plain", "text", "html", "mentions", "rich", "blank", "present", "authenticates", "token", "signed", "verify", "join", "split", "chunks", "sentence", "any", "count", "first", "last", "distinct", "set", "words", "initials", "first_word", "after", "lower", "upper", "trim", "length", "contains", "starts_with", "replace", "public_ip", "scheme", "port", "host_within", "url", "host", "path", "with_host", "url_of", "download", "file", "request_file", "words_only", "max", "min", "cookie", "matches"]);

// writes the program, with a go.mod that uses lang/gogen
export function writeProgram(specPath: string, out: string, widgetsPath?: string) {
  const files = generate(specPath, widgetsPath);
  mkdirSync(out, { recursive: true });
  for (const [n, src] of Object.entries(files)) writeFileSync(join(out, n), src);
  const gogen = dirname(fileURLToPath(import.meta.url));
  const rel = relative(resolve(out), gogen).replace(/\\/g, "/");
  const mod = readFileSync(join(gogen, "go.mod"), "utf8");
  const requires = [...mod.matchAll(/^\s*([\w./-]+) (v[\w.+-]+)/gm)].map((m) => `\t${m[1]} ${m[2]}`);
  writeFileSync(join(out, "go.mod"), `module crudspecapp\n\ngo 1.27\n\nrequire (\n\tcrudspec/gogen v0.0.0\n${requires.join("\n")}\n)\n\nreplace crudspec/gogen => ${rel.startsWith(".") ? rel : "./" + rel}\n`);
  copyFileSync(join(gogen, "go.sum"), join(out, "go.sum"));
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
