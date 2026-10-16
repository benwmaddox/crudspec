// Reference interpreter for crudspec v1: the semantic ground truth for Phases 1-2.
// An in-memory relational store; every action runs as a transaction (all writes or none).
import type { ActionDecl, EntityDecl, Expr, Field, PredicateDecl, Spec, Stmt, TriggerDecl, ViewDecl, WorkflowDecl, GateDecl, Param } from "./ast.ts";

export type Ref = { ref: string; id: number };
type LazyRef = { lazy: "ref"; entity: string; id: number | null; optional: boolean };
type LazyEnum = { lazy: "enum"; enumName: string; value: string };
type SetVal = { set: Set<string>; entity: string };
type OldRow = { old: Record<string, Val> };
type SingletonVal = { singleton: string };
export type Val = string | number | boolean | null | Ref | LazyRef | LazyEnum | SetVal | OldRow | SingletonVal;

export type Row = { id: number; created: number; fields: Record<string, Val> };
export type Request = { ip: string; method: "get" | "write" };

export class Outcome extends Error {
  outcome: string;
  constructor(outcome: string, why = "") { super(`${outcome}${why ? ": " + why : ""}`); this.outcome = outcome; }
}
export class InterpError extends Error {}

const isRef = (v: Val): v is Ref => typeof v === "object" && v !== null && "ref" in v;
const refKey = (r: Ref) => `${r.ref}#${r.id}`;

type Ctx = {
  vars: Map<string, Val>;
  row?: { entity: string; row: Row };
  actor: Ref | null;
  request: Request;
  events: { event: string; args: Val[] }[];
};

export class Store {
  tables = new Map<string, Row[]>();
  nextId = new Map<string, number>();
  seq = 1;
  clone(): Store {
    const s = new Store();
    for (const [k, rows] of this.tables) s.tables.set(k, rows.map((r) => ({ id: r.id, created: r.created, fields: { ...r.fields } })));
    s.nextId = new Map(this.nextId);
    s.seq = this.seq;
    return s;
  }
  rows(entity: string): Row[] {
    let t = this.tables.get(entity);
    if (!t) { t = []; this.tables.set(entity, t); }
    return t;
  }
  find(r: Ref): Row | undefined { return this.rows(r.ref).find((x) => x.id === r.id); }
  insert(entity: string, fields: Record<string, Val>): Row {
    const id = this.nextId.get(entity) ?? 1;
    this.nextId.set(entity, id + 1);
    const row = { id, created: this.seq++, fields };
    this.rows(entity).push(row);
    return row;
  }
}

export class Interpreter {
  spec: Spec;
  store = new Store();
  entities = new Map<string, EntityDecl>();
  enumOf = new Map<string, string[]>();   // value -> enums that contain it
  enums = new Map<string, string[]>();
  predicates = new Map<string, PredicateDecl>();
  gates: GateDecl[] = [];
  actions = new Map<string, ActionDecl>();
  views = new Map<string, ViewDecl>();
  triggers: TriggerDecl[] = [];
  workflows: WorkflowDecl[] = [];

  constructor(spec: Spec) {
    this.spec = spec;
    for (const d of spec.decls) {
      switch (d.kind) {
        case "entity": this.entities.set(d.name, d); break;
        case "enum": this.enums.set(d.name, d.values); for (const v of d.values) this.enumOf.set(v, [...(this.enumOf.get(v) ?? []), d.name]); break;
        case "predicate": this.predicates.set(d.name, d); break;
        case "gate": this.gates.push(d); break;
        case "action": this.actions.set(d.name, d); break;
        case "view": this.views.set(d.name, d); break;
        case "trigger": this.triggers.push(d); break;
        case "workflow": this.workflows.push(d); break;
      }
    }
  }

  // ---- values
  resolve(v: Val): Val {
    if (typeof v === "object" && v !== null && "lazy" in v) {
      if (v.lazy === "ref") {
        if (v.id === null) { if (v.optional) return null; throw new Outcome("not_found", `missing ${v.entity}`); }
        const r = { ref: v.entity, id: v.id };
        if (!this.store.find(r)) throw new Outcome("not_found", `${v.entity} ${v.id} does not exist`);
        return r;
      }
      if (!(this.enums.get(v.enumName) ?? []).includes(v.value)) throw new Outcome("invalid", `'${v.value}' is not a ${v.enumName}`);
      return v.value;
    }
    return v;
  }
  equal(a: Val, b: Val): boolean {
    if (isRef(a) && isRef(b)) return a.ref === b.ref && a.id === b.id;
    if (isRef(a) || isRef(b)) return false;
    return a === b;
  }
  fieldOf(target: Val, name: string): Val {
    if (target === null) return null;
    if (typeof target === "object" && "old" in target) return target.old[name] ?? null;
    if (typeof target === "object" && "singleton" in target) {
      const row = this.store.rows(target.singleton)[0];
      if (!row) throw new InterpError(`singleton ${target.singleton} has no row`);
      return name === "created" ? row.created : (row.fields[name] ?? null);
    }
    if (!isRef(target)) throw new InterpError(`cannot read .${name} of ${JSON.stringify(target)}`);
    const row = this.store.find(target);
    if (!row) throw new Outcome("not_found", `${target.ref} ${target.id} was deleted`);
    if (name === "created") return row.created;
    if (!(name in row.fields)) throw new InterpError(`${target.ref} has no field ${name}`);
    return row.fields[name];
  }

  // ---- expressions
  eval(e: Expr, ctx: Ctx): Val {
    switch (e.kind) {
      case "lit": return e.value;
      case "it": if (!ctx.row) throw new InterpError("'it' outside a where"); return { ref: ctx.row.entity, id: ctx.row.row.id };
      case "rowfield": {
        if (!ctx.row) throw new InterpError(`.${e.name} outside a where`);
        return e.name === "created" ? ctx.row.row.created : (ctx.row.row.fields[e.name] ?? null);
      }
      case "name": {
        if (e.name === "actor") return ctx.actor;
        if (ctx.vars.has(e.name)) return this.resolve(ctx.vars.get(e.name)!);
        if (e.name === "request") return { singleton: "__request" };
        if (e.name === "get" || e.name === "write") return e.name;   // request.method values
        if (this.enumOf.has(e.name)) return e.name;
        if (this.entities.get(e.name)?.singleton) return { singleton: e.name };
        throw new InterpError(`unknown name ${e.name} at ${e.pos.line}:${e.pos.col}`);
      }
      case "field": {
        if (e.target.kind === "name" && e.target.name === "request") {
          if (e.name === "ip") return ctx.request.ip;
          if (e.name === "method") return ctx.request.method;
          throw new InterpError(`request has no ${e.name}`);
        }
        if (e.target.kind === "name" && this.enums.has(e.target.name)) return e.name;   // Enum.value
        return this.fieldOf(this.eval(e.target, ctx), e.name);
      }
      case "unary": return !this.truthy(this.eval(e.arg, ctx));
      case "binary": {
        if (e.op === "and") return this.truthy(this.eval(e.left, ctx)) && this.truthy(this.eval(e.right, ctx));
        if (e.op === "or") return this.truthy(this.eval(e.left, ctx)) || this.truthy(this.eval(e.right, ctx));
        if (e.op === "implies") return !this.truthy(this.eval(e.left, ctx)) || this.truthy(this.eval(e.right, ctx));
        const l = this.eval(e.left, ctx);
        if (e.op === "in") {
          if (e.right.kind === "setlit") return e.right.items.some((i) => this.equal(l, this.eval(i, ctx)));
          const s = this.eval(e.right, ctx);
          if (typeof s === "object" && s !== null && "set" in s) return isRef(l) && s.set.has(refKey(l));
          throw new InterpError("'in' needs a set");
        }
        const r = this.eval(e.right, ctx);
        switch (e.op) {
          case "==": return this.equal(l, r);
          case "!=": return !this.equal(l, r);
          case "<": return (l as number) < (r as number);
          case "<=": return (l as number) <= (r as number);
          case ">": return (l as number) > (r as number);
          case ">=": return (l as number) >= (r as number);
        }
        throw new InterpError(`unknown operator ${e.op}`);
      }
      case "setlit": throw new InterpError("a set literal is only valid on the right of 'in'");
      case "if": return this.truthy(this.eval(e.cond, ctx)) ? this.eval(e.then, ctx) : this.eval(e.else, ctx);
      case "call": {
        if (e.name === "public_ip") return publicIp(String(this.eval(e.args[0], ctx) ?? ""));
        const p = this.predicates.get(e.name);
        if (!p) throw new InterpError(`unknown predicate ${e.name}`);
        const vars = new Map<string, Val>();
        p.params.forEach((param, i) => vars.set(param.name, this.eval(e.args[i], ctx)));
        return this.truthy(this.eval(p.body, { ...ctx, vars, row: undefined }));
      }
      case "query": {
        const rows = this.select(e.entity, e.where, ctx);
        if (e.op === "exists") return rows.length > 0;
        if (e.op === "count") return rows.length;
        if (rows.length !== 1) throw new InterpError(`the(${e.entity} …) matched ${rows.length} rows`);
        return { ref: e.entity, id: rows[0].id };
      }
      case "all": {
        const rows = this.select(e.entity, e.where, ctx);
        return rows.every((row) => this.truthy(this.eval(e.cond, { ...ctx, row: { entity: e.entity, row } })));
      }
    }
  }
  truthy(v: Val): boolean { return v === true; }
  select(entity: string, where: Expr | undefined, ctx: Ctx): Row[] {
    if (!this.entities.has(entity)) throw new InterpError(`unknown entity ${entity}`);
    const rows = [...this.store.rows(entity)];
    return where ? rows.filter((row) => this.truthy(this.eval(where, { ...ctx, row: { entity, row } }))) : rows;
  }

  // ---- statements
  exec(stmts: Stmt[], ctx: Ctx): void { for (const s of stmts) this.stmt(s, ctx); }
  stmt(s: Stmt, ctx: Ctx): void {
    switch (s.kind) {
      case "require": if (!this.truthy(this.eval(s.cond, ctx))) throw new Outcome(s.outcome, "require failed"); return;
      case "reject": throw new Outcome(s.outcome, "rejected");
      case "create": {
        const ent = this.entities.get(s.entity); if (!ent) throw new InterpError(`unknown entity ${s.entity}`);
        const fields: Record<string, Val> = {};
        for (const a of s.fields) fields[a.name] = this.eval(a.value, ctx);
        const draft: Row = { id: 0, created: this.store.seq, fields };
        for (const f of ent.fields) {
          if (f.name in fields) continue;
          if (f.default) fields[f.name] = this.eval(f.default, { ...ctx, row: { entity: s.entity, row: draft } });
          else if (f.type.kind === "named" && f.type.optional) fields[f.name] = null;
          else throw new Outcome("invalid", `${s.entity}.${f.name} is required`);
        }
        for (const cols of ent.uniques) {
          const clash = this.store.rows(s.entity).find((r) => cols.every((c) => this.equal(r.fields[c], fields[c])));
          if (clash) { if (s.ensure) return; throw new Outcome("invalid", `unique (${cols.join(", ")})`); }
        }
        const row = this.store.insert(s.entity, fields);
        const ref = { ref: s.entity, id: row.id };
        if (s.as) ctx.vars.set(s.as, ref);
        this.fire({ kind: "create", entity: s.entity }, ref, null, ctx);
        return;
      }
      case "set": {
        const target = this.eval(s.target, ctx);
        if (!isRef(target)) throw new InterpError("set target is not a row");
        const row = this.store.find(target); if (!row) throw new Outcome("not_found", "set on a deleted row");
        const value = this.eval(s.value, ctx);
        const before = { ...row.fields };
        row.fields[s.name] = value;
        if (!this.equal(before[s.name], value)) this.fire({ kind: "update", entity: target.ref, field: s.name }, target, { old: before }, ctx);
        return;
      }
      case "delete": {
        const target = this.eval(s.target, ctx);
        if (!isRef(target)) throw new InterpError("delete target is not a row");
        this.deleteRow(target, ctx);
        return;
      }
      case "deleteWhere": {
        for (const row of this.select(s.entity, s.where, ctx)) {
          const ref = { ref: s.entity, id: row.id };
          if (this.store.find(ref)) this.deleteRow(ref, ctx);
        }
        return;
      }
      case "foreach": {
        const refs = this.select(s.entity, s.where, ctx).map((r) => ({ ref: s.entity, id: r.id }));
        for (const ref of refs) {
          if (!this.store.find(ref)) continue;
          const vars = new Map(ctx.vars); vars.set(s.bind, ref);
          this.exec(s.body, { ...ctx, vars });
        }
        return;
      }
      case "if": this.exec(this.truthy(this.eval(s.cond, ctx)) ? s.then : s.else, ctx); return;
      case "emit": {
        const args = s.args.map((a) => this.eval(a, ctx));
        ctx.events.push({ event: s.event, args });
        this.fire({ kind: "event", event: s.event }, args[0] as Ref, null, ctx);
        return;
      }
    }
  }
  deleteRow(target: Ref, ctx: Ctx): void {
    if (!this.store.find(target)) return;
    for (const [ename, ent] of this.entities) {
      for (const f of ent.fields) {
        if (f.type.kind !== "named" || f.type.name !== target.ref) continue;
        const dependents = this.store.rows(ename).filter((r) => this.equal(r.fields[f.name], target));
        if (dependents.length === 0) continue;
        if (f.onDelete === "restrict") throw new Outcome("invalid", `${ename}.${f.name} restricts deleting ${target.ref}`);
        for (const d of dependents) this.deleteRow({ ref: ename, id: d.id }, ctx);
      }
    }
    const rows = this.store.rows(target.ref);
    const i = rows.findIndex((r) => r.id === target.id);
    if (i >= 0) rows.splice(i, 1);
    this.fire({ kind: "delete", entity: target.ref }, target, null, ctx);
  }
  fire(ev: { kind: string; entity?: string; field?: string; event?: string }, subject: Ref, old: OldRow | null, ctx: Ctx): void {
    for (const t of this.triggers) {
      const on = t.on;
      const match =
        (on.kind === "create" && ev.kind === "create" && on.entity === ev.entity) ||
        (on.kind === "delete" && ev.kind === "delete" && on.entity === ev.entity) ||
        (on.kind === "update" && ev.kind === "update" && on.entity === ev.entity && on.field === ev.field) ||
        (on.kind === "event" && ev.kind === "event" && on.event === ev.event);
      if (!match) continue;
      const vars = new Map<string, Val>([[t.bind, subject]]);
      if (old) vars.set("old", old);
      const tctx: Ctx = { ...ctx, vars, row: undefined };
      if (t.when && !this.truthy(this.eval(t.when, tctx))) continue;
      this.exec(t.body, tctx);
    }
  }

  // ---- entry points
  bindParams(params: Param[], args: Record<string, unknown>): Map<string, Val> {
    const vars = new Map<string, Val>();
    for (const p of params) {
      const raw = args[p.name];
      if (p.type.kind === "set") {
        const ids = (Array.isArray(raw) ? raw : []) as number[];
        vars.set(p.name, { set: new Set(ids.map((id) => `${(p.type as { of: string }).of}#${id}`)), entity: p.type.of });
        continue;
      }
      const t = p.type.name;
      if (this.entities.has(t)) vars.set(p.name, { lazy: "ref", entity: t, id: raw == null ? null : Number(raw), optional: p.type.optional });
      else if (this.enums.has(t)) vars.set(p.name, raw == null ? null : { lazy: "enum", enumName: t, value: String(raw) });
      else vars.set(p.name, raw == null ? null : (raw as Val));
    }
    return vars;
  }
  // Drops set members that don't name existing rows ("unknown references are dropped").
  pruneSets(vars: Map<string, Val>): void {
    for (const [k, v] of vars) {
      if (typeof v === "object" && v !== null && "set" in v) {
        vars.set(k, { set: new Set([...v.set].filter((key) => { const [e, id] = key.split("#"); return !!this.store.find({ ref: e, id: Number(id) }); })), entity: v.entity });
      }
    }
  }

  run(name: string, args: Record<string, unknown>, actor: Ref | null, request: Request): { outcome: string; rows?: Ref[]; detail?: string } {
    const action = this.actions.get(name);
    const view = this.views.get(name);
    if (!action && !view) throw new InterpError(`unknown action ${name}`);
    const saved = this.store.clone();
    const params = (action ?? view)!.params;
    const vars = this.bindParams(params, args);
    this.pruneSets(vars);
    const ctx: Ctx = { vars, actor, request, events: [] };
    try {
      const skips = action?.skips ?? [];
      for (const g of this.gates) {
        if (skips.includes(g.name)) continue;
        if (this.truthy(this.eval(g.cond, ctx))) throw new Outcome(g.outcome, `gate ${g.name}`);
      }
      if (action) {
        this.exec(action.body, ctx);
        this.checkInvariants(ctx);
      } else {
        const v = view!;
        for (const r of v.requires) if (!this.truthy(this.eval(r.cond, ctx))) throw new Outcome(r.outcome, "require failed");
        let rows = this.select(v.rows.entity, v.rows.where, ctx).sort((a, b) => a.created - b.created);
        if (v.window) {
          const useOther = v.window.unless ? this.truthy(this.eval(v.window.unless, ctx)) : false;
          const end = useOther ? (v.window.end === "last" ? "first" : "last") : v.window.end;
          rows = end === "last" ? rows.slice(-v.window.size) : rows.slice(0, v.window.size);
        }
        this.store = saved;   // views write nothing
        return { outcome: "ok", rows: rows.map((r) => ({ ref: v.rows.entity, id: r.id })) };
      }
    } catch (err) {
      if (err instanceof Outcome) { this.store = saved; return { outcome: err.outcome, detail: err.message }; }
      throw err;
    }
    // After commit: workflows for emitted events run to completion.
    for (const ev of ctx.events) {
      for (const w of this.workflows) {
        if (w.event !== ev.event) continue;
        for (const step of w.steps) this.exec(step.body, { vars: new Map([[w.bind, ev.args[0]]]), actor, request, events: [] });
      }
    }
    return { outcome: "ok" };
  }
  checkInvariants(ctx: Ctx): void {
    for (const [name, ent] of this.entities) {
      for (const inv of ent.invariants) {
        for (const row of this.store.rows(name)) {
          const vars = new Map<string, Val>([["self", { ref: name, id: row.id }]]);
          if (!this.truthy(this.eval(inv, { ...ctx, vars, row: { entity: name, row } }))) throw new Outcome("invalid", `invariant of ${name}`);
        }
      }
    }
  }
}

function publicIp(ip: string): boolean {
  const v4 = ip.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if ([v4[1], v4[2], v4[3], v4[4]].some((x) => Number(x) > 255)) return false;
    if (a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)) return false;
    return true;
  }
  if (/^[0-9a-f:]+$/i.test(ip) && ip.includes(":")) {
    const l = ip.toLowerCase();
    if (l === "::1" || l.startsWith("fe80") || l.startsWith("fc") || l.startsWith("fd")) return false;
    return true;
  }
  return false;
}
