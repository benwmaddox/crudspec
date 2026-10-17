// The query planner: a query's `where` becomes SQL against SQLite, where it can, and the
// rest (the residual) is evaluated on the fetched rows exactly as the interpreter would.
//   - each conjunct is compiled on its own; one that can't be is left to the residual;
//   - comparisons are null-safe (`IS`), as the interpreter's equality is;
//   - `x in s` uses json_each; one-hop field paths (`.room.type`) become subqueries;
//   - `exists(…)` and `count(…)` become correlated subqueries;
//   - predicates and fns are inlined, their arguments bound to columns or to values;
//   - a condition that doesn't depend on the row is evaluated once, as a parameter.
// Plans are compiled once per query in the spec; parameters are evaluated per call.
import type { Interpreter, Row, Val } from "../interp.ts";
import type { SqlStore } from "./store-sql.ts";

type P = (ctx: any) => unknown;
type Frag = { sql: string; params: P[] };
type Kind = { k: "id" | "ref" | "enum" | "text" | "bool" | "int" | "json" | "time" | "count"; entity?: string; nullable: boolean };
type Col = Frag & Kind;
type Bind = { kind: "row"; alias: string; entity: string } | { kind: "col"; col: Col } | { kind: "value"; fn: P };
type Scope = { alias: string; entity: string; env: Map<string, Bind>; depth: number };
type Plan = { sql: string; params: P[]; residual: any[] };

const isRef = (v: any) => v && typeof v === "object" && "ref" in v && "id" in v;
const isSet = (v: any) => v && typeof v === "object" && "set" in v;
const isRich = (v: any) => v && typeof v === "object" && "rich" in v;
const NOMATCH = "\u0000no match";

export class Planner {
  it: Interpreter; store: SqlStore;
  plans = new WeakMap<object, Map<string, Plan>>();
  aliases = 0;
  constructor(it: Interpreter, store: SqlStore) { this.it = it; this.store = store; }
  q(n: string) { return `"${n.replace(/"/g, '""')}"`; }
  stored(e: string) { return this.store.cols.has(e); }

  // ---- values: whether an expression depends on a row, and evaluating one that doesn't
  rowFree(e: any, env: Map<string, Bind>, top = true): boolean {
    if (!e || typeof e !== "object") return true;
    if (Array.isArray(e)) return e.every((x) => this.rowFree(x, env, top));
    if (top && (e.kind === "rowfield" || e.kind === "it")) return false;
    if (e.kind === "name") { const b = env.get(e.name); return !b || b.kind === "value"; }
    if (["query", "listq", "all"].includes(e.kind)) return this.rowFree(e.where, env, false) && this.rowFree(e.order, env, false) && this.rowFree(e.map ?? e.cond, env, false);
    for (const [k, v] of Object.entries(e)) if (k !== "pos" && !this.rowFree(v, env, top)) return false;
    return true;
  }
  valueFn(e: any, env: Map<string, Bind>): P {
    const vals = [...env].filter(([, b]) => b.kind === "value") as [string, { kind: "value"; fn: P }][];
    return (ctx) => {
      if (!vals.length) return this.it.eval(e, { ...ctx, row: undefined });
      const vars = new Map(ctx.vars); for (const [n, b] of vals) vars.set(n, b.fn(ctx));
      return this.it.eval(e, { ...ctx, vars, row: undefined });
    };
  }
  encode(kind: Kind, v: any): unknown {
    if (v === undefined) v = null;
    switch (kind.k) {
      case "id": case "ref": return v === null ? null : isRef(v) ? v.id : -1;
      case "enum": case "text": return v === null ? null : isRich(v) ? v.rich : typeof v === "string" ? v : NOMATCH;
      case "bool": return v === true ? 1 : v === false ? 0 : v === null ? null : -1;
      case "int": case "count": return v === null ? null : typeof v === "number" ? v : NOMATCH;
      default: return NOMATCH;
    }
  }

  // ---- columns: SQL scalars for row-dependent expressions
  column(e: any, s: Scope): Col | null {
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
      if (!t || !(t.k === "ref" || t.k === "id") || !t.entity || !this.stored(t.entity)) return null;
      const inner = this.field("x", t.entity, e.name);
      if (!inner) return null;
      return { ...inner, sql: `(SELECT ${inner.sql.replace(/^x\./, "")} FROM ${this.q(t.entity)} x WHERE x.id = ${t.sql})`, params: [...t.params], nullable: true };
    }
    if (e.kind === "query" && e.op === "count") {
      const sub = this.subquery(e, s); if (!sub) return null;
      return { sql: `(SELECT count(*) FROM ${sub.from} WHERE ${sub.where})`, params: sub.params, k: "count", nullable: false };
    }
    return null;
  }
  field(alias: string, entity: string, name: string): Col | null {
    if (name === "id") return { sql: `${alias}.id`, params: [], k: "id", entity, nullable: false };
    if (name === "created" || name === "updated") return { sql: `${alias}.${name}`, params: [], k: "time", nullable: false };
    const ent = this.it.entities.get(entity);
    const f = ent?.fields.find((x: any) => x.name === name);
    if (!f || f.type.kind !== "named") return null;
    const t = f.type.name, nullable = !!f.type.optional, sql = `${alias}.${this.q(name)}`;
    if (this.it.entities.has(t)) return { sql, params: [], k: "ref", entity: t, nullable };
    if (this.it.enums.has(t)) return { sql, params: [], k: "enum", nullable };
    if (["Text", "Email", "Url", "Ip"].includes(t)) return { sql, params: [], k: "text", nullable };
    if (t === "Int") return { sql, params: [], k: "int", nullable };
    if (t === "Bool") return { sql, params: [], k: "bool", nullable };
    return { sql, params: [], k: "json", nullable };
  }

  // ---- conditions
  bool(e: any, s: Scope): Frag | null {
    if (!e) return null;
    if (s.depth > 12) return null;
    if (this.rowFree(e, s.env)) { const fn = this.valueFn(e, s.env); return { sql: "(? = 1)", params: [(ctx) => (this.it.truthy(fn(ctx)) ? 1 : 0)] }; }
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
      const fn = this.valueFn(e.right, s.env);
      return { sql: `(${l.sql} IN (SELECT value FROM json_each(?)))`, params: [...l.params, (ctx) => {
        const r = fn(ctx);
        if (isSet(r)) return JSON.stringify((l.k === "ref" || l.k === "id") && l.entity === r.entity ? r.set : []);
        if (Array.isArray(r)) return JSON.stringify(r.map((x) => this.encode(l, x)).filter((x) => x !== null && x !== NOMATCH && x !== -1));
        return "[]";
      }] };
    }
    if (e.kind === "query" && e.op === "exists") {
      const sub = this.subquery(e, s); if (!sub) return null;
      return { sql: `(EXISTS (SELECT 1 FROM ${sub.from} WHERE ${sub.where}))`, params: sub.params };
    }
    if (e.kind === "call") return this.inline(e, s, (body, inner) => this.bool(body, inner));
    if (e.kind === "lit" && typeof e.value === "boolean") return { sql: e.value ? "(1 = 1)" : "(1 = 0)", params: [] };
    return null;
  }
  equality(e: any, s: Scope): Frag | null {
    const neg = e.op === "!=";
    const wrap = (f: Frag) => (neg ? { sql: `(NOT ${f.sql})`, params: f.params } : f);
    let l = this.column(e.left, s), r = this.column(e.right, s);
    if (l && r) {
      if (l.k === "json" || r.k === "json" || l.k === "time" || r.k === "time") return null;
      const sameKind = (l.k === r.k) || ((l.k === "ref" || l.k === "id") && (r.k === "ref" || r.k === "id") && l.entity === r.entity);
      if (!sameKind) return null;
      return wrap({ sql: `(${l.sql} IS ${r.sql})`, params: [...l.params, ...r.params] });
    }
    let valueSide = e.right;
    if (!l && r) { l = r; valueSide = e.left; }
    if (!l || l.k === "json" || l.k === "time" || !this.rowFree(valueSide, s.env)) return null;
    const fn = this.valueFn(valueSide, s.env), col = l;
    return wrap({ sql: `(${col.sql} IS ?)`, params: [...col.params, (ctx) => this.encode(col, fn(ctx))] });
  }
  ordering(e: any, s: Scope): Frag | null {
    const ops: Record<string, string> = { "<": ">", ">": "<", "<=": ">=", ">=": "<=" };
    let l = this.column(e.left, s), valueSide = e.right, op = e.op;
    if (!l) { l = this.column(e.right, s); valueSide = e.left; op = ops[op]; }
    if (!l || l.nullable || !["time", "int", "count", "id"].includes(l.k) || !this.rowFree(valueSide, s.env)) return null;
    const fn = this.valueFn(valueSide, s.env), col = l;
    // the interpreter orders an empty value below everything: col > none holds, col < none doesn't
    const whenNone = op === ">" || op === ">=" ? "1" : "0";
    if (col.k === "time") {
      const seqCol = col.sql.replace(/\.(created|updated)$/, ".seq");
      return { sql: `(CASE WHEN ? IS NULL THEN ${whenNone} ELSE (${col.sql}, ${seqCol}) ${op} (?, ?) END)`,
        params: [(ctx) => { const v: any = fn(ctx); return v && typeof v === "object" && "time" in v ? 0 : null; },
          (ctx) => (fn(ctx) as any)?.time ?? null, (ctx) => (fn(ctx) as any)?.seq ?? 0] };
    }
    const v: P = (ctx) => this.encode(col, fn(ctx));
    return { sql: `(CASE WHEN ? IS NULL THEN ${whenNone} ELSE ${col.sql} ${op} ? END)`, params: [v, ...col.params, v] };
  }
  // a nested query: its own alias, the same bindings
  subquery(e: any, s: Scope): { from: string; where: string; params: P[] } | null {
    if (!this.stored(e.entity) || e.order || e.limit) return e.order || e.limit ? null : null;
    const alias = `t${++this.aliases}`;
    const inner: Scope = { alias, entity: e.entity, env: s.env, depth: s.depth + 1 };
    if (!e.where) return { from: `${this.q(e.entity)} ${alias}`, where: "1", params: [] };
    const w = this.bool(e.where, inner);
    return w ? { from: `${this.q(e.entity)} ${alias}`, where: w.sql, params: w.params } : null;
  }
  // predicates and fns: the body with its parameters bound to the call's arguments
  inline(e: any, s: Scope, compile: (body: any, inner: Scope) => Frag | null): Frag | null {
    const d = this.it.get("predicate", e.name) ?? this.it.get("fn", e.name);
    if (!d || d.params.length !== e.args.length || Object.keys(e.named ?? {}).length) return null;
    // the body sees only its parameters, as when the interpreter calls it
    const env = new Map<string, Bind>();
    for (const [i, p] of d.params.entries()) {
      const a = e.args[i];
      if (this.rowFree(a, s.env)) { env.set(p.name, { kind: "value", fn: this.valueFn(a, s.env) }); continue; }
      if (a.kind === "it") { env.set(p.name, { kind: "row", alias: s.alias, entity: s.entity }); continue; }
      if (a.kind === "name" && s.env.get(a.name)?.kind === "row") { env.set(p.name, s.env.get(a.name)!); continue; }
      const c = this.column(a, s); if (!c) return null;
      env.set(p.name, { kind: "col", col: c });
    }
    return compile(d.body, { ...s, env, depth: s.depth + 1 });
  }

  // ---- entry points
  plan(entity: string, where: any, permName?: string, perm?: any): Plan {
    const key = `${entity}|${permName ?? ""}`;
    let byKey = this.plans.get(where ?? this.plans) ; if (!byKey) { byKey = new Map(); this.plans.set(where ?? this.plans, byKey); }
    const have = byKey.get(key); if (have) return have;
    const conj: any[] = [];
    const flat = (x: any) => { if (x?.kind === "binary" && x.op === "and") { flat(x.left); flat(x.right); } else if (x) conj.push(x); };
    flat(where);
    const s: Scope = { alias: "t0", entity, env: new Map(), depth: 0 };
    const parts: string[] = [], params: P[] = [], residual: any[] = [];
    for (const c of conj) { const f = this.bool(c, s); if (f) { parts.push(f.sql); params.push(...f.params); } else residual.push(c); }
    if (perm) {
      const ps: Scope = { ...s, env: new Map([[permName!, { kind: "row", alias: "t0", entity } as Bind]]) };
      const f = this.bool(perm, ps);
      if (f) { parts.push(f.sql); params.push(...f.params); } else residual.push({ kind: "__perm" });
    }
    const p: Plan = { sql: parts.join(" AND "), params, residual };
    byKey.set(key, p);
    return p;
  }
  // rows of a query, with its where (and a read permission, if given) applied
  select(q: any, ctx: any, permName?: string, perm?: any): { rows: Row[]; permDone: boolean } | null {
    if (!this.stored(q.entity)) return null;
    const p = this.plan(q.entity, q.where, permName, perm);
    let rows = this.store.select(q.entity, p.sql, p.params.map((f) => f(ctx)));
    const residual = p.residual.filter((x) => x.kind !== "__perm");
    if (residual.length) rows = rows.filter((row) => residual.every((c) => this.it.truthy(this.it.eval(c, { ...ctx, row: { entity: q.entity, row } }))));
    return { rows, permDone: !p.residual.some((x) => x.kind === "__perm") };
  }
  count(q: any, ctx: any): number | null {
    if (!this.stored(q.entity)) return null;
    const p = this.plan(q.entity, q.where);
    if (p.residual.length) return null;
    return this.store.count(q.entity, p.sql, p.params.map((f) => f(ctx)));
  }
}
