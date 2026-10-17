// Reference interpreter for crudspec v2: the semantics the checker, the scenario runner and
// the runtime share. In-memory store; each action is a transaction; a virtual clock.
import type { Decl, Expr, Spec, Stmt } from "./parser.ts";
import { fieldSize, sizeProblem } from "./sizes.ts";

import { Store, type Ref, type Time, type Val, type Row } from "./rows.ts";
export { Store, type Ref, type Time, type Val, type Row };
export type Request = { ip: string; method: "get" | "write"; identity: string; user_agent?: string; session_token?: string; text?: string; cookies?: Record<string, string> };
export type RunResult = { outcome: string; cause?: string; detail?: string; result?: Val; rows?: Ref[]; events?: { event: string; args: Val[] }[]; effects?: Effect[] };
export type Effect = { extern: string; args: Val[] };

export class Outcome extends Error {
  outcome: string; cause: string;
  constructor(outcome: string, why = "", cause = "") { super(`${outcome}${why ? ": " + why : ""}`); this.outcome = outcome; this.cause = cause; }
}
export class InterpError extends Error {}

const isRef = (v: Val): v is Ref => typeof v === "object" && v !== null && "ref" in v && "id" in v;
const isTime = (v: Val): v is Time => typeof v === "object" && v !== null && "time" in v;
const isDur = (v: Val) => typeof v === "object" && v !== null && "ms" in v;
const isSet = (v: Val) => typeof v === "object" && v !== null && "set" in v;
const isRich = (v: Val) => typeof v === "object" && v !== null && "rich" in v;
const UNIT_MS: Record<string, number> = { ms: 1, s: 1000, min: 60000, h: 3600000, day: 86400000 };


type Ctx = { vars: Map<string, Val>; row?: { entity: string; row: Row }; actor: Ref | null; request: Request; events: { event: string; args: Val[] }[]; effects: Effect[]; inWorkflow?: boolean; noTriggers?: boolean; result?: Val };

export class Interpreter {
  spec: Spec;
  store = new Store();
  clock = Date.UTC(2026, 0, 1);
  decls = new Map<string, Decl>();
  entities = new Map<string, Decl>();
  enums = new Map<string, string[]>();
  enumOf = new Map<string, string>();
  triggers: Decl[] = [];
  workflows: Decl[] = [];
  gates: Decl[] = [];
  permissions = new Map<string, Expr>();
  externStubs: Record<string, (args: Val[]) => Val> = {};
  tokenCounter = 0;
  // Rate-limit counters count every request, whatever its outcome, so they live outside
  // the transactional store.
  counters = new Map<string, number[]>();
  // Deterministic by default, for scenarios; the runtime swaps in secure versions.
  hooks = {
    token: (n: number): string => `tok${String(++this.tokenCounter).padStart(Math.max(1, n - 3), "0")}`.slice(0, Math.max(n, 4)),
    sign: (r: Ref, purpose: string, expiresAt: number): string => `signed:${purpose}:${r.ref}:${r.id}:${expiresAt}`,
    unsign: (text: string): { purpose: string; ref: string; id: number; expiresAt: number } | null => {
      const m = text.match(/^signed:([^:]+):([^:]+):(\d+):(\d+)$/);
      return m ? { purpose: m[1], ref: m[2], id: Number(m[3]), expiresAt: Number(m[4]) } : null;
    },
    hash: (password: string): Val => ({ password }),
    file: (bytes: Val, name: string, contentType: string): Val => ({ file: name, content_type: contentType, size: 0 }),
    check: (stored: Val, given: string): boolean => stored !== null && typeof stored === "object" && stored.password === given,
  };
  baseUrl = "http://localhost";
  // The entity that signs in and acts (app { actor … }).
  get actorEntity(): string { const app = this.spec.decls.find((d) => d.kind === "app"); return app?.props.actor?.name ?? ""; }
  // The runtime defers workflows and runs them asynchronously, with real externs.
  deferWorkflows = false;

  constructor(spec: Spec) {
    this.spec = spec;
    for (const d of spec.decls) {
      if (d.kind === "entity" || d.kind === "data") this.entities.set(d.name, d);
      else if (d.kind === "enum") { this.enums.set(d.name, d.values); for (const v of d.values) this.enumOf.set(v, d.name); }
      else if (d.kind === "trigger") this.triggers.push(d);
      else if (d.kind === "workflow") this.workflows.push(d);
      else if (d.kind === "gate") this.gates.push(d);
      else if (d.kind === "permission") this.permissions.set(d.entity, d.cond);
      if (!["trigger", "workflow", "permission"].includes(d.kind)) this.decls.set(`${d.kind}:${d.name}`, d);
    }
    // Reference data.
    for (const d of spec.decls) if (d.kind === "data") {
      for (const assigns of d.rows) {
        const fields: Record<string, Val> = {};
        for (const f of d.fields) fields[f.name] = null;
        for (const a of assigns) fields[a.name] = this.eval(a.value, this.ctx(null));
        this.store.insert(d.name, fields, this.clock);
      }
    }
  }
  get(kind: string, name: string) { return this.decls.get(`${kind}:${name}`); }
  ctx(actor: Ref | null, request?: Request): Ctx {
    return { vars: new Map(), actor, request: request ?? { ip: "", method: "write", identity: "" }, events: [], effects: [] };
  }
  advance(ms: number) { this.clock += ms; }

  // ---- values
  resolve(v: Val): Val {
    if (typeof v === "object" && v !== null && "lazy" in v) {
      if (v.lazy === "ref") {
        if (v.id === null) { if (v.optional) return null; throw new Outcome("not_found", `missing ${v.entity}`, "param"); }
        const r = { ref: v.entity, id: v.id };
        if (!this.store.find(r)) throw new Outcome("not_found", `${v.entity} ${v.id} does not exist`, "param");
        return r;
      }
      if (v.lazy === "enum") {
        if (!(this.enums.get(v.enumName) ?? []).includes(v.value)) throw new Outcome("invalid", `'${v.value}' is not a ${v.enumName}`, "param");
        return v.value;
      }
    }
    return v;
  }
  equal(a: Val, b: Val): boolean {
    if (isRef(a) && isRef(b)) return a.ref === b.ref && a.id === b.id;
    if (isTime(a) && isTime(b)) return a.time === b.time && a.seq === b.seq;
    if (isRich(a) || isRich(b)) return this.plain(a) === this.plain(b);
    if (typeof a === "object" && a !== null && typeof b === "object" && b !== null) return JSON.stringify(a) === JSON.stringify(b);
    return a === b;
  }
  compare(a: Val, b: Val): number {
    if (isTime(a) && isTime(b)) return a.time - b.time || a.seq - b.seq;
    if (typeof a === "string" && typeof b === "string") return a < b ? -1 : a > b ? 1 : 0;
    if (a === null || b === null) return a === b ? 0 : a === null ? -1 : 1;
    return Number(a) - Number(b);
  }
  plain(v: Val): string { if (v === null || v === undefined) return ""; if (isRich(v)) return v.rich; return String(v); }
  rowTime(row: Row): Time { return { time: row.created, seq: row.seq }; }
  fieldOf(target: Val, name: string): Val {
    if (target === null || target === undefined) return null;
    if (typeof target === "object" && "old" in target) return target.old[name] ?? null;
    if (typeof target === "object" && "singleton" in target) {
      const row = this.store.first(target.singleton);
      if (!row) return null;
      return this.rowField(row, name);
    }
    if (isRef(target)) {
      const row = this.store.find(target);
      if (!row) throw new Outcome("not_found", `${target.ref} ${target.id} was deleted`, "missing");
      return this.rowField(row, name);
    }
    if (typeof target === "object" && name in target) return target[name];
    if (typeof target === "object" && "file" in target) return { filename: target.file, content_type: target.content_type, size: target.size ?? 0, kind: kindOf(target.content_type) }[name] ?? null;
    return null;
  }
  rowField(row: Row, name: string): Val {
    if (name === "id") return row.id;
    if (name === "created") return { time: row.created, seq: row.seq };
    if (name === "updated") return { time: row.updated, seq: row.seq };
    return name in row.fields ? row.fields[name] : null;
  }
  truthy(v: Val) { return v === true; }

  // ---- expressions
  eval(e: Expr, ctx: Ctx): Val {
    switch (e.kind) {
      case "lit": return e.value;
      case "duration": return { ms: e.amount * UNIT_MS[e.unit] };
      case "now": return { time: this.clock, seq: Number.MAX_SAFE_INTEGER };
      case "it": if (!ctx.row) throw new InterpError("'it' outside a where"); return { ref: ctx.row.entity, id: ctx.row.row.id };
      case "rowfield": if (!ctx.row) throw new InterpError(`.${e.name} outside a where`); return this.rowField(ctx.row.row, e.name);
      case "name": {
        if (ctx.vars.has(e.name)) return this.resolve(ctx.vars.get(e.name));
        if (e.name === "actor") return ctx.actor;
        if (e.name === "result") return ctx.result ?? null;
        if (e.name === "request") return { ...ctx.request };
        if (e.name === "get" || e.name === "write" || this.get("identity", e.name)) return e.name;   // request methods and identity names
        if (this.enumOf.has(e.name)) return e.name;
        const ent = this.entities.get(e.name);
        if (ent?.singleton) return { singleton: e.name };
        if (ent) return { entity: e.name };
        if (this.get("view", e.name) || this.get("action", e.name) || this.get("screen", e.name)) return { reference: e.name };
        // An order-by may name the row's fields bare.
        if (ctx.row && (["created", "updated", "id"].includes(e.name) || e.name in ctx.row.row.fields)) return this.rowField(ctx.row.row, e.name);
        throw new InterpError(`unknown name ${e.name} at ${e.pos.line}`);
      }
      case "field": {
        if (e.target.kind === "name" && this.enums.has(e.target.name)) return e.name;
        const t = this.eval(e.target, ctx);
        if (Array.isArray(t)) throw new InterpError(`.${e.name} of a list`);
        return this.fieldOf(t, e.name);
      }
      case "unary": { const v = this.eval(e.arg, ctx); return e.op === "not" ? !this.truthy(v) : -v; }
      case "binary": return this.binary(e, ctx);
      case "if": return this.truthy(this.eval(e.cond, ctx)) ? this.eval(e.then, ctx) : this.eval(e.else, ctx);
      case "listlit": return e.items.map((i: Expr) => this.eval(i, ctx));
      case "setlit": return e.items.map((i: Expr) => this.eval(i, ctx));
      case "json": return Object.fromEntries(Object.entries(e.fields).map(([k, v]) => [k, this.eval(v as Expr, ctx)]));
      case "query": {
        if ((e.op === "count" || e.op === "exists") && this.planner) {
          const n = this.planner.count(e, ctx);
          if (n !== null) return e.op === "count" ? n : n > 0;
        }
        const rows = this.select(e, ctx);
        switch (e.op) {
          case "exists": return rows.length > 0;
          case "count": return rows.length;
          case "the": if (rows.length !== 1) throw new Outcome("invalid", `the(${e.entity} …) matched ${rows.length} rows`, "the"); return this.ref(e.entity, rows[0]);
          case "the_or_none": return rows.length === 1 ? this.ref(e.entity, rows[0]) : null;
          case "first_or_none": return rows.length ? this.ref(e.entity, rows[0]) : null;
          case "set": return { set: rows.map((r) => r.id), entity: e.entity };
        }
        throw new InterpError(`query ${e.op}`);
      }
      case "all": { const rows = this.select(e, ctx); return rows.every((row) => this.truthy(this.eval(e.cond, { ...ctx, row: { entity: e.entity, row } }))); }
      case "listq": {
        const rows = this.select(e, ctx);
        return rows.map((row) => e.map ? this.eval(e.map, { ...ctx, row: { entity: e.entity, row } }) : this.ref(e.entity, row));
      }
      case "extern": {
        const args = [...e.args.map((a: Expr) => this.eval(a, ctx)), ...Object.values(e.named).map((a) => this.eval(a as Expr, ctx))];
        ctx.effects.push({ extern: e.name, args });
        const stub = this.externStubs[e.name];
        return stub ? stub(args) : null;
      }
      case "call": return this.call(e, ctx);
    }
    throw new InterpError(`unknown expression ${e.kind}`);
  }
  ref(entity: string, row: Row): Ref { return { ref: entity, id: row.id }; }

  binary(e: Expr, ctx: Ctx): Val {
    if (e.op === "and") return this.truthy(this.eval(e.left, ctx)) && this.truthy(this.eval(e.right, ctx));
    if (e.op === "or") return this.truthy(this.eval(e.left, ctx)) || this.truthy(this.eval(e.right, ctx));
    if (e.op === "implies") return !this.truthy(this.eval(e.left, ctx)) || this.truthy(this.eval(e.right, ctx));
    const l = this.eval(e.left, ctx);
    if (e.op === "in") {
      const r = this.eval(e.right, ctx);
      if (isSet(r)) return isRef(l) && l.ref === r.entity && r.set.includes(l.id);
      if (Array.isArray(r)) return r.some((x) => this.equal(l, x));
      return false;
    }
    const r = this.eval(e.right, ctx);
    switch (e.op) {
      case "==": return this.equal(l, r);
      case "!=": return !this.equal(l, r);
      case "<": return this.compare(l, r) < 0;
      case "<=": return this.compare(l, r) <= 0;
      case ">": return this.compare(l, r) > 0;
      case ">=": return this.compare(l, r) >= 0;
      case "+":
        if (isTime(l) && isDur(r)) return { time: l.time + r.ms, seq: l.seq };
        if (isSet(l) && isSet(r)) return { set: [...new Set([...l.set, ...r.set])], entity: l.entity };
        if (Array.isArray(l)) return [...l, ...(Array.isArray(r) ? r : [r])];
        if (typeof l === "number" && typeof r === "number") return l + r;
        return this.plain(l) + this.plain(r);
      case "-":
        if (isTime(l) && isDur(r)) return { time: l.time - r.ms, seq: 0 };
        return Number(l) - Number(r);
      case "*": return Number(l) * Number(r);
      case "/": return Math.trunc(Number(l) / Number(r));
    }
    throw new InterpError(`unknown operator ${e.op}`);
  }

  // The compiled app plans queries as SQL (gogen); the in-memory store scans. Either way the
  // rows are the same.
  planner?: { select(q: any, ctx: any, permName?: string, perm?: any): { rows: Row[]; permDone: boolean } | null; count(q: any, ctx: any): number | null };
  select(q: any, ctx: Ctx, permName?: string, perm?: any): Row[] & { permDone?: boolean } {
    if (!this.entities.has(q.entity)) throw new InterpError(`unknown entity ${q.entity}`);
    const planned = this.planner?.select(q, ctx, permName, perm);
    let rows: Row[];
    let permDone = false;
    if (planned) { rows = planned.rows; permDone = planned.permDone; }
    else {
      rows = [...this.store.rows(q.entity)];
      if (q.where) rows = rows.filter((row) => this.truthy(this.eval(q.where, { ...ctx, row: { entity: q.entity, row } })));
    }
    rows.sort((a, b) => a.seq - b.seq);
    if (q.order) {
      const keyed = rows.map((row) => ({ row, k: this.eval(q.order, { ...ctx, row: { entity: q.entity, row } }) }));
      keyed.sort((a, b) => this.compare(a.k, b.k) || a.row.seq - b.row.seq);
      rows = keyed.map((x) => x.row);
      if (q.desc) rows.reverse();
    }
    if (q.limit) rows = rows.slice(0, Number(this.eval(q.limit, ctx)));
    return Object.assign(rows, { permDone });
  }

  call(e: Expr, ctx: Ctx): Val {
    const pred = this.get("predicate", e.name) ?? this.get("fn", e.name);
    const args = () => e.args.map((a: Expr) => this.eval(a, ctx));
    if (pred) {
      const vars = new Map<string, Val>();
      const vals = args();
      pred.params.forEach((p: any, i: number) => vars.set(p.name, vals[i] ?? (e.named[p.name] ? this.eval(e.named[p.name], ctx) : null)));
      const v = this.eval(pred.body, { ...ctx, vars, row: undefined });
      return pred.kind === "predicate" ? this.truthy(v) : v;
    }
    const screen = this.get("screen", e.name);
    if (screen) return { screen: e.name, args: args() };
    // A view used as a value is the list of its rows, permissions applied.
    const view = this.get("view", e.name);
    if (view && view.rows) {
      const vals = args();
      const vars = new Map<string, Val>();
      view.params.forEach((p: any, i: number) => vars.set(p.name, i < vals.length ? vals[i] : e.named[p.name] ? this.eval(e.named[p.name], ctx) : null));
      const vctx = { ...ctx, vars, row: undefined };
      for (const r of view.requires) if (!this.truthy(this.eval(r.cond, vctx))) return [];
      return this.viewRows(view, vctx).map((row) => this.ref(view.rows.entity, row));
    }
    const api = this.spec.decls.find((d) => d.kind === "api" && d.name === e.name);
    if (api) return { api: e.name, args: args() };
    const a = args();
    switch (e.name) {
      case "plain": return this.plain(a[0]);
      case "mentions": return isRich(a[0]) ? { set: a[0].mentions ?? [], entity: a[0].entity ?? this.actorEntity } : { set: [], entity: this.actorEntity };
      case "rich": return { rich: this.plain(a[0]), mentions: [] };
      case "html": return this.plain(a[0]);
      case "blank": return a[0] === null || this.plain(a[0]).trim() === "";
      case "present": return !(a[0] === null || this.plain(a[0]).trim() === "");
      case "authenticates": return this.hooks.check(a[0], this.plain(a[1]));
      case "token": return this.hooks.token(Number(a[0]));
      case "signed": return this.hooks.sign(a[0] as Ref, this.plain(a[1]), this.clock + (a[2]?.ms ?? 0));
      case "verify": {
        const v = this.hooks.unsign(this.plain(a[1]));
        if (!v || v.purpose !== a[2] || v.ref !== a[0].entity || v.expiresAt < this.clock) return null;
        const r = { ref: v.ref, id: v.id }; return this.store.find(r) ? r : null;
      }
      case "join": if (!Array.isArray(a[0])) throw new InterpError(`join takes a list first, given ${JSON.stringify(a[0])}`); return a[0].map((x) => this.plain(x)).join(a[1]);
      // split(text) is its words; split(text, sep) splits on sep
      case "split": { const s = this.plain(a[0]); return a.length > 1 ? s.split(this.plain(a[1])) : s.trim().split(/\s+/).filter(Boolean); }
      case "chunks": { const s = this.plain(a[0]), n = Number(a[1]); const out: string[] = []; for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n)); return out; }
      case "sentence": { const l = (a[0] as Val[]).map((x) => this.plain(x)); return l.length <= 1 ? (l[0] ?? "") : l.length === 2 ? `${l[0]} and ${l[1]}` : `${l.slice(0, -1).join(", ")}, and ${l.at(-1)}`; }
      case "any": return Array.isArray(a[0]) ? a[0].length > 0 : isSet(a[0]) ? a[0].set.length > 0 : false;
      case "count": return Array.isArray(a[0]) ? a[0].length : isSet(a[0]) ? a[0].set.length : 0;
      case "first": return Array.isArray(a[0]) ? (a.length > 1 ? a[0].slice(0, a[1]) : a[0][0] ?? null) : null;
      case "last": return Array.isArray(a[0]) ? (a.length > 1 ? a[0].slice(-a[1]) : a[0].at(-1) ?? null) : null;
      case "distinct": { const out: Val[] = []; for (const x of a[0] as Val[]) if (!out.some((y) => this.equal(x, y))) out.push(x); return out; }
      case "set": { const v = a[0]; if (isSet(v)) return v; if (isRef(v)) return { set: [v.id], entity: v.ref }; if (Array.isArray(v)) return { set: v.filter(isRef).map((r: Ref) => r.id), entity: v.find(isRef)?.ref ?? this.actorEntity }; return { set: [], entity: this.actorEntity }; }
      case "words": return this.plain(a[0]).trim().split(/\s+/).filter(Boolean).length;
      case "initials": return (this.plain(a[0]).match(/\b\w/g) ?? []).join("");
      case "first_word": return this.plain(a[0]).split(" ")[0];
      case "after": { const s = this.plain(a[0]), p = this.plain(a[1]); return s.startsWith(p) ? s.slice(p.length) : ""; }
      case "lower": return this.plain(a[0]).toLowerCase();
      case "upper": return this.plain(a[0]).toUpperCase();
      case "trim": return this.plain(a[0]).trim();
      case "length": return this.plain(a[0]).length;
      case "contains": return this.plain(a[0]).includes(this.plain(a[1]));
      case "starts_with": return this.plain(a[0]).startsWith(this.plain(a[1]));
      case "replace": return this.plain(a[0]).split(this.plain(a[1])).join(this.plain(a[2]));
      case "public_ip": return publicIp(this.plain(a[0]));
      case "scheme": try { return new URL(this.plain(a[0])).protocol.replace(":", ""); } catch { return ""; }
      case "port": try { const u = new URL(this.plain(a[0])); return Number(u.port || (u.protocol === "https:" ? 443 : 80)); } catch { return 0; }
      case "host_within": try { const h = new URL(this.plain(a[0])).hostname.toLowerCase(); return (a[1] as string[]).some((p) => h === p || h.endsWith("." + p)); } catch { return false; }
      case "url": return this.baseUrl + this.plain(a[0]);
      case "host": try { return new URL(this.plain(a[0])).hostname.toLowerCase(); } catch { return ""; }
      case "path": try { return new URL(this.plain(a[0])).pathname; } catch { return ""; }
      case "with_host": try { const u = new URL(this.plain(a[0])); u.hostname = this.plain(a[1]); return u.toString(); } catch { return this.plain(a[0]); }
      case "url_of": return this.urlOf(a[0]);
      case "text": return this.plain(a[0]);
      case "file": return this.hooks.file(a[0], this.plain(a[1]), this.plain(a[2]));
      case "request_file": return null;
      case "words_only": return this.plain(a[0]).replace(/[^\p{L}\p{N}_]/gu, " ");
      case "max": return Math.max(Number(a[0]), Number(a[1]));
      case "min": return Math.min(Number(a[0]), Number(a[1]));
      case "cookie": return ctx.request.cookies?.[this.plain(a[0])] ?? null;
      case "download": return this.urlOf(a[0]);
      case "matches": { const hay = this.plain(a[0]).toLowerCase(); const words = this.plain(a[1]).toLowerCase().split(/\s+/).filter(Boolean); return words.length > 0 && words.every((w) => new RegExp(`\\b${escapeRe(w)}`, "u").test(hay)); }
    }
    throw new InterpError(`unknown function ${e.name}`);
  }
  urlOf(v: Val): string {
    if (v && typeof v === "object" && "screen" in v) {
      const d = this.get("screen", v.screen)!;
      let route: string = d.route;
      d.params.forEach((p: any, i: number) => { const a = v.args[i]; route = route.replace(`:${p.name}`, String(isRef(a) ? a.id : a ?? "")); });
      return this.baseUrl + route;
    }
    if (v && typeof v === "object" && "api" in v) {
      const d = this.spec.decls.find((x) => x.kind === "api" && x.name === v.api)!;
      const names = [...String(d.route).matchAll(/:(\w+)/g)].map((m) => m[1]);
      let route: string = d.route;
      names.forEach((n, i) => { const a = v.args[i]; route = route.replace(`:${n}`, String(isRef(a) ? a.id : a ?? "")); });
      return this.baseUrl + route;
    }
    if (v && typeof v === "object" && "file" in v) return `${this.baseUrl}/files/${v.file}`;
    return this.plain(v);
  }

  // ---- statements
  exec(ss: Stmt[], ctx: Ctx) { for (const s of ss) this.stmt(s, ctx); }
  stmt(s: Stmt, ctx: Ctx) {
    switch (s.kind) {
      case "require": if (!this.truthy(this.eval(s.cond, ctx))) throw new Outcome(s.outcome, `require failed at line ${s.pos.line}`, "require"); return;
      case "reject": throw new Outcome(s.outcome, "rejected", "reject");
      case "let": ctx.vars.set(s.name, this.eval(s.value, ctx)); return;
      case "result": ctx.result = this.eval(s.value, ctx); return;
      case "callstmt": this.eval(s.call, ctx); return;
      case "rate_limit": {
        const key = `${s.pos.line}:${this.plain(this.eval(s.by, ctx))}`;
        const per = this.eval(s.per, ctx).ms;
        const hits = (this.counters.get(key) ?? []).filter((t) => t > this.clock - per);
        hits.push(this.clock); this.counters.set(key, hits);
        if (hits.length > s.n) throw new Outcome(s.outcome, "rate limited", "require");
        return;
      }
      case "create": {
        const ent = this.entities.get(s.entity)!;
        if (!ent) throw new InterpError(`unknown entity ${s.entity}`);
        const fields: Record<string, Val> = {};
        const given: Record<string, Val> = {};
        for (const a of s.fields) { given[a.name] = this.eval(a.value, ctx); fields[a.name] = this.store_value(ent, a.name, given[a.name]); }
        this.checkSizes(ent, s.entity, given, s.fields.map((a: any) => a.name));
        const draft: Row = { id: 0, seq: this.store.seq, created: this.clock, updated: this.clock, fields };
        for (const f of ent.fields) {
          if (f.name in fields) continue;
          if (f.default) fields[f.name] = this.eval(f.default, { ...ctx, row: { entity: s.entity, row: draft } });
          else if (f.type.kind === "named" && f.type.optional) fields[f.name] = null;
          else if (f.type.name === "Int") fields[f.name] = 0;
          else throw new Outcome("invalid", `${s.entity}.${f.name} is required`, "required");
        }
        for (const cols of ent.uniques) {
          // As in SQL, a key containing a missing value never clashes.
          const clash = this.store.clash(s.entity, cols, fields, 0, (a, b) => this.equal(a, b));
          if (clash) { if (s.ensure) { if (s.as) ctx.vars.set(s.as, this.ref(s.entity, clash)); return; } throw new Outcome("invalid", `unique (${s.entity}: ${cols.join(", ")})`, "unique"); }
        }
        if (ent.singleton && this.store.first(s.entity)) throw new Outcome("invalid", `${s.entity} exists`, "unique");
        const row = this.store.insert(s.entity, fields, this.clock);
        const ref = this.ref(s.entity, row);
        if (s.as) ctx.vars.set(s.as, ref);
        this.touchParents(ent, row);
        this.fire({ kind: "create", entity: s.entity }, ref, null, ctx);
        return;
      }
      case "set": {
        const target = this.eval(s.target, ctx);
        const row = target && typeof target === "object" && "singleton" in target ? this.store.first(target.singleton) : isRef(target) ? this.store.find(target) : undefined;
        if (!row) { if (isRef(target)) throw new Outcome("not_found", "set on a deleted row", "missing"); throw new InterpError(`set target is not a row (line ${s.pos.line})`); }
        const entity = isRef(target) ? target.ref : target.singleton;
        const ent = this.entities.get(entity)!;
        const raw = this.eval(s.value, ctx);
        this.checkSizes(ent, entity, { [s.name]: raw }, [s.name]);
        const value = this.store_value(ent, s.name, raw);
        const before = { ...row.fields };
        row.fields[s.name] = value;
        for (const cols of ent.uniques ?? []) if (cols.includes(s.name)) {
          const clash = this.store.clash(entity, cols, row.fields, row.id, (a, b) => this.equal(a, b));
          if (clash) throw new Outcome("invalid", `unique (${entity}: ${cols.join(", ")})`, "unique");
        }
        if (!this.equal(before[s.name], value)) {
          row.updated = this.clock;
          this.store.save(entity, row, [s.name]);
          this.touchParents(ent, row);
          this.fire({ kind: "update", entity, field: s.name }, this.ref(entity, row), { old: before }, ctx);
        }
        return;
      }
      case "touch": { const t = this.eval(s.target, ctx); const row = isRef(t) ? this.store.find(t) : undefined; if (row) { row.updated = this.clock; this.store.save(t.ref, row); this.touchParents(this.entities.get(t.ref)!, row); } return; }
      case "delete": { const t = this.eval(s.target, ctx); if (isRef(t)) this.deleteRow(t, ctx); return; }
      case "deleteWhere": for (const row of this.select({ entity: s.entity, where: s.where }, ctx)) { const r = this.ref(s.entity, row); if (this.store.find(r)) this.deleteRow(r, ctx); } return;
      case "foreach": {
        const refs = this.select({ entity: s.entity, where: s.where }, ctx).map((r) => this.ref(s.entity, r));
        for (const ref of refs) { if (!this.store.find(ref)) continue; const vars = new Map(ctx.vars); vars.set(s.bind, ref); this.exec(s.body, { ...ctx, vars, row: undefined }); }
        return;
      }
      case "foreachList": {
        let over = this.eval(s.over, ctx);
        if (isSet(over)) over = over.set.map((id: number) => ({ ref: over.entity, id }));
        for (const x of over as Val[]) { const vars = new Map(ctx.vars); vars.set(s.bind, x); this.exec(s.body, { ...ctx, vars, row: undefined }); }
        return;
      }
      case "if": this.exec(this.truthy(this.eval(s.cond, ctx)) ? s.then : s.else, ctx); return;
      case "emit": {
        const args = s.args.map((a: Expr) => this.eval(a, ctx));
        ctx.events.push({ event: s.event, args });
        this.fire({ kind: "event", event: s.event }, args[0], null, ctx);
        return;
      }
    }
    throw new InterpError(`unknown statement ${s.kind}`);
  }
  // A value longer (or shorter) than its field allows is refused (sizes.ts).
  checkSizes(ent: Decl, entity: string, values: Record<string, Val>, names: string[]) {
    for (const n of names) {
      const f = ent.fields.find((x: any) => x.name === n);
      const p = f ? sizeProblem(values[n], fieldSize(f), `${entity}.${n}`) : null;
      if (p) throw new Outcome("invalid", p, "size");
    }
  }
  // Passwords are stored so they can be checked but never read back as text.
  store_value(ent: Decl, field: string, v: Val): Val {
    const f = ent.fields.find((x: any) => x.name === field);
    if (f?.type.kind === "named" && f.type.name === "Password" && typeof v === "string") return this.hooks.hash(v);
    if (f?.type.kind === "named" && f.type.name === "RichText" && typeof v === "string") return { rich: v, mentions: [] };
    return v;
  }
  touchParents(ent: Decl, row: Row) {
    for (const f of ent.fields) if (f.touches && isRef(row.fields[f.name])) {
      const p = this.store.find(row.fields[f.name]); if (p) { p.updated = this.clock; this.store.save(f.type.name, p); this.touchParents(this.entities.get(f.type.name)!, p); }
    }
  }
  deleteRow(target: Ref, ctx: Ctx) {
    const row = this.store.find(target);
    if (!row) return;
    for (const [ename, ent] of this.entities) for (const f of ent.fields) {
      if (f.type.kind !== "named" || f.type.name !== target.ref) continue;
      const dependents = this.store.where(ename, f.name, target, (a, b) => this.equal(a, b));
      if (!dependents.length) continue;
      if (f.onDelete === "restrict") throw new Outcome("invalid", `${ename}.${f.name} restricts deleting ${target.ref}`, "restrict");
      for (const d of dependents) this.deleteRow(this.ref(ename, d), ctx);
    }
    const old = { ...row.fields };
    this.store.remove(target.ref, target.id);
    this.touchParents(this.entities.get(target.ref)!, { ...row, fields: old });
    this.fire({ kind: "delete", entity: target.ref }, target, { old }, ctx);
  }
  fire(ev: { kind: string; entity?: string; field?: string; event?: string }, subject: Val, old: Val, ctx: Ctx) {
    if (ctx.noTriggers) return;   // data migrations change rows as written
    for (const t of this.triggers) {
      const on = t.on;
      const match = on.kind === ev.kind && (on.kind === "event" ? on.event === ev.event : on.entity === ev.entity && (on.kind !== "update" || on.field === ev.field));
      if (!match) continue;
      const vars = new Map<string, Val>([[t.bind, subject]]);
      if (old) vars.set("old", old);
      // A deleted row's trigger sees its last field values.
      const tctx: Ctx = { ...ctx, vars, row: undefined };
      if (ev.kind === "delete") vars.set(t.bind, { old: old.old });
      if (t.when && !this.truthy(this.eval(t.when, tctx))) continue;
      this.exec(t.body, tctx);
    }
  }

  // ---- entry points
  bind(params: any[], args: Record<string, unknown>): Map<string, Val> {
    const vars = new Map<string, Val>();
    for (const p of params) {
      const raw = args[p.name];
      if (p.type.kind === "set") { vars.set(p.name, { set: (Array.isArray(raw) ? raw : []).map(Number), entity: p.type.of }); continue; }
      const t = p.type.name;
      if (this.entities.has(t)) vars.set(p.name, { lazy: "ref", entity: t, id: raw == null ? null : Number(raw), optional: p.type.optional });
      else if (this.enums.has(t)) vars.set(p.name, raw == null ? null : { lazy: "enum", enumName: t, value: String(raw) });
      else if (t === "RichText") vars.set(p.name, raw == null ? null : typeof raw === "string" ? { rich: raw, mentions: [] } : raw);
      else vars.set(p.name, raw === undefined ? null : raw);
    }
    // unknown set members are dropped
    for (const [k, v] of vars) if (isSet(v)) vars.set(k, { set: v.set.filter((id: number) => this.store.find({ ref: v.entity, id })), entity: v.entity });
    return vars;
  }

  // Whether an action would get past its guards, without running it: the gates, then the
  // action's leading lets and requires, up to the first statement that writes. Nothing is
  // changed, so nothing is copied or rechecked. Used to decide whether to offer a button.
  guards(name: string, args: Record<string, unknown>, actor: Ref | null, request: Request, skipGates: string[] = []): { outcome: string; cause?: string } {
    const action = this.get("action", name);
    if (!action) throw new InterpError(`unknown action ${name}`);
    const ctx: Ctx = { vars: this.bind(action.params, args), actor, request, events: [], effects: [] };
    try {
      const skips = [...(action.skips ?? []), ...skipGates];
      for (const g of this.gates) if (!skips.includes(g.name) && this.truthy(this.eval(g.cond, ctx))) return { outcome: g.outcome, cause: "gate" };
      for (const s of action.body) {
        if (s.kind === "let") ctx.vars.set(s.name, this.eval(s.value, ctx));
        else if (s.kind === "require") { if (!this.truthy(this.eval(s.cond, ctx))) return { outcome: s.outcome, cause: "require" }; }
        else if (s.kind === "rate_limit") continue;   // counting is the action's business, not the button's
        else break;
      }
    } catch (err) {
      if (err instanceof Outcome) return { outcome: err.outcome, cause: err.cause };
      return { outcome: "ok" };   // a guard that can't be evaluated here doesn't hide the button
    }
    return { outcome: "ok" };
  }

  run(name: string, args: Record<string, unknown>, actor: Ref | null, request: Request, skipGates: string[] = []): RunResult {
    const action = this.get("action", name);
    const view = this.get("view", name);
    if (!action && !view) throw new InterpError(`unknown action ${name}`);
    const d = (action ?? view)!;
    if (action) this.store.begin();
    const ctx: Ctx = { vars: this.bind(d.params, args), actor, request, events: [], effects: [] };
    try {
      const skips: string[] = [...(action?.skips ?? []), ...skipGates];
      for (const g of this.gates) {
        if (skips.includes(g.name)) continue;
        if (this.truthy(this.eval(g.cond, ctx))) throw new Outcome(g.outcome, `gate ${g.name}`, "gate");
      }
      if (action) {
        for (const p of action.params) if (p.max !== undefined || p.min !== undefined) {
          const pr = sizeProblem(this.resolve(ctx.vars.get(p.name)), { max: p.max, min: p.min }, p.name);
          if (pr) throw new Outcome("invalid", pr, "size");
        }
        this.exec(action.body, ctx);
        this.checkInvariants(ctx);
        this.store.commit();
      } else {
        for (const r of view.requires) if (!this.truthy(this.eval(r.cond, ctx))) throw new Outcome(r.outcome, `require failed at line ${r.cond.pos.line}`, "require");
        if (view.value) { const v = this.eval(view.value, ctx); return { outcome: "ok", result: v, effects: ctx.effects }; }
        const rows = this.viewRows(view, ctx);
        return { outcome: "ok", rows: rows.map((r) => this.ref(view.rows.entity, r)) };
      }
    } catch (err) {
      if (action) this.store.rollback();
      if (err instanceof Outcome) return { outcome: err.outcome, detail: err.message, cause: err.cause };
      throw err;
    }
    // After commit: workflows for emitted events run to completion (or later, when deferred).
    if (this.deferWorkflows) return { outcome: "ok", result: ctx.result, events: ctx.events, effects: ctx.effects };
    for (const ev of ctx.events) for (const w of this.workflows) {
      if (w.event !== ev.event) continue;
      for (const step of w.steps) this.exec(step.body, { vars: new Map([[w.bind, ev.args[0]]]), actor: null, request, events: [], effects: ctx.effects, inWorkflow: true });
    }
    return { outcome: "ok", result: ctx.result, events: ctx.events, effects: ctx.effects };
  }
  // Runs the workflows for these events, awaiting extern calls (a let or call whose value
  // is an extern). Each step's writes apply directly: a workflow is outside the action's
  // transaction, as a background job is.
  async runWorkflows(events: { event: string; args: Val[] }[], request: Request, externs: Record<string, (args: Val[]) => Promise<Val>>) {
    for (const ev of events) for (const w of this.workflows) {
      if (w.event !== ev.event) continue;
      for (const step of w.steps) {
        const ctx: Ctx = { vars: new Map([[w.bind, ev.args[0]]]), actor: null, request, events: [], effects: [], inWorkflow: true };
        try { await this.execAsync(step.body, ctx, externs); }
        catch (err) { if (!(err instanceof Outcome)) throw err; }
      }
    }
  }
  // An extern call's arguments in its declared parameter order, named ones placed by name.
  externArgs(e: Expr, ctx: Ctx): Val[] {
    const d = this.get("extern", e.name);
    if (!d) return [...e.args.map((a: Expr) => this.eval(a, ctx)), ...Object.values(e.named).map((a) => this.eval(a as Expr, ctx))];
    return d.params.map((p: any, i: number) => i < e.args.length ? this.eval(e.args[i], ctx) : e.named[p.name] ? this.eval(e.named[p.name] as Expr, ctx) : null);
  }
  async execAsync(ss: Stmt[], ctx: Ctx, externs: Record<string, (args: Val[]) => Promise<Val>>): Promise<void> {
    const callExtern = async (e: Expr) => {
      const args = this.externArgs(e, ctx);
      ctx.effects.push({ extern: e.name, args });
      const f = externs[e.name];
      return f ? await f(args) : null;
    };
    for (const s of ss) {
      if (s.kind === "let" && s.value.kind === "extern") ctx.vars.set(s.name, await callExtern(s.value));
      else if (s.kind === "callstmt" && s.call.kind === "extern") await callExtern(s.call);
      else if (s.kind === "foreach") {
        const refs = this.select({ entity: s.entity, where: s.where }, ctx).map((r) => this.ref(s.entity, r));
        for (const ref of refs) { if (!this.store.find(ref)) continue; const vars = new Map(ctx.vars); vars.set(s.bind, ref); await this.execAsync(s.body, { ...ctx, vars, row: undefined }, externs); }
      } else if (s.kind === "foreachList") {
        let over = this.eval(s.over, ctx);
        if (isSet(over)) over = over.set.map((id: number) => ({ ref: over.entity, id }));
        for (const x of over as Val[]) { const vars = new Map(ctx.vars); vars.set(s.bind, x); await this.execAsync(s.body, { ...ctx, vars, row: undefined }, externs); }
      } else if (s.kind === "if") await this.execAsync(this.truthy(this.eval(s.cond, ctx)) ? s.then : s.else, ctx, externs);
      else this.stmt(s, ctx);
    }
  }

  viewRows(view: Decl, ctx: Ctx): Row[] {
    const entity = view.rows.entity;
    const perm = this.permissions.get(entity);
    const selected = this.select({ entity, where: view.rows.where, order: view.order, desc: view.desc }, ctx, perm ? snake(entity) : undefined, perm);
    let rows: Row[] = selected;
    if (perm && !selected.permDone) rows = rows.filter((row) => this.truthy(this.eval(perm, { ...ctx, vars: new Map([[snake(entity), this.ref(entity, row)]]), row: undefined })));
    if (view.around) {
      const at = this.eval(view.around.at, ctx);
      if (isRef(at)) {
        const i = rows.findIndex((r) => r.id === at.id);
        if (i >= 0) return rows.slice(Math.max(0, i - view.around.size), i + 1 + view.around.size);
      }
    }
    if (view.window) {
      const flip = view.window.unless ? this.truthy(this.eval(view.window.unless, ctx)) : false;
      const end = flip ? (view.window.end === "last" ? "first" : "last") : view.window.end;
      rows = end === "last" ? rows.slice(-view.window.size) : rows.slice(0, view.window.size);
    }
    if (view.limit) rows = rows.slice(0, Math.max(0, Number(this.eval(view.limit, ctx))));
    if (view.page) rows = rows.slice(0, view.page);
    return rows;
  }
  checkInvariants(ctx: Ctx) {
    for (const [name, ent] of this.entities) for (const inv of ent.invariants ?? []) for (const row of this.store.rows(name)) {
      const vars = new Map<string, Val>([["self", this.ref(name, row)]]);
      if (!this.truthy(this.eval(inv, { ...ctx, vars, row: { entity: name, row } }))) throw new Outcome("invalid", `invariant of ${name} at ${inv.pos.line}`, "invariant");
    }
  }
}

function snake(s: string) { return s.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase(); }
function escapeRe(s: string) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function kindOf(ct: string | null) { return !ct ? "other" : ct.startsWith("image/") ? "image" : ct.startsWith("video/") ? "video" : ct.startsWith("audio/") ? "audio" : "other"; }
export function publicIp(ip: string): boolean {
  const v4 = ip.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if ([v4[1], v4[2], v4[3], v4[4]].some((x) => Number(x) > 255)) return false;
    return !(a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254));
  }
  if (/^[0-9a-f:]+$/i.test(ip) && ip.includes(":")) { const l = ip.toLowerCase(); return !(l === "::1" || l.startsWith("fe80") || l.startsWith("fc") || l.startsWith("fd")); }
  return false;
}
