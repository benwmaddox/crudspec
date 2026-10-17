// Static checks for crudspec v1: names and types, required fields, predicate recursion,
// view permissions, the trigger graph (cycles, order dependence) and workflow idempotence.
import type { ActionDecl, Decl, EntityDecl, Expr, Field, Pos, Spec, Stmt, TriggerDecl, TypeRef } from "../ast.ts";
import type { Finding } from "./finding.ts";

type T =
  | { k: "bool" } | { k: "int" } | { k: "text" } | { k: "ip" } | { k: "method" } | { k: "none" } | { k: "any" }
  | { k: "enum"; name: string } | { k: "enumlit"; value: string }
  | { k: "ref"; entity: string } | { k: "set"; entity: string }
  | { k: "singleton"; name: string } | { k: "old"; entity: string } | { k: "request" };

const BOOL: T = { k: "bool" }, INT: T = { k: "int" }, TEXT: T = { k: "text" }, ANY: T = { k: "any" }, NONE: T = { k: "none" };

type Env = { vars: Map<string, T>; row?: string; actor: "user" | "none" };

export class StaticChecker {
  findings: Finding[] = [];
  entities = new Map<string, EntityDecl>();
  enums = new Map<string, string[]>();
  enumOf = new Map<string, string[]>();
  predicates = new Map<string, Extract<Decl, { kind: "predicate" }>>();
  events = new Map<string, T[]>();    // emitted event -> argument types
  where = "";

  spec: Spec;

  constructor(spec: Spec) {
    this.spec = spec;
    for (const d of spec.decls) {
      if (d.kind === "entity") this.entities.set(d.name, d);
      if (d.kind === "enum") { this.enums.set(d.name, d.values); for (const v of d.values) this.enumOf.set(v, [...(this.enumOf.get(v) ?? []), d.name]); }
      if (d.kind === "predicate") this.predicates.set(d.name, d);
    }
  }

  err(code: string, pos: Pos | undefined, message: string) {
    this.findings.push({ severity: "error", code, where: this.where, message: pos ? `${message} (line ${pos.line})` : message });
  }
  warn(code: string, pos: Pos | undefined, message: string) {
    this.findings.push({ severity: "warning", code, where: this.where, message: pos ? `${message} (line ${pos.line})` : message });
  }

  // ---- types
  typeOf(t: TypeRef): T {
    if (t.kind === "set") return { k: "set", entity: t.of };
    switch (t.name) {
      case "Text": return TEXT;
      case "Int": return INT;
      case "Bool": return BOOL;
      case "Ip": return { k: "ip" };
    }
    if (this.enums.has(t.name)) return { k: "enum", name: t.name };
    if (this.entities.has(t.name)) return { k: "ref", entity: t.name };
    return ANY;
  }
  checkTypeRef(t: TypeRef, pos: Pos) {
    const name = t.kind === "set" ? t.of : t.name;
    if (!["Text", "Int", "Bool", "Ip"].includes(name) && !this.enums.has(name) && !this.entities.has(name)) this.err("UNKNOWN_TYPE", pos, `unknown type ${name}`);
    if (t.kind === "set" && !this.entities.has(t.of)) this.err("BAD_SET", pos, `set of ${t.of}: sets hold entity references`);
  }
  show(t: T): string {
    switch (t.k) {
      case "enum": return t.name;
      case "enumlit": return `enum value ${t.value}`;
      case "ref": return t.entity;
      case "set": return `set of ${t.entity}`;
      default: return t.k;
    }
  }
  compatible(a: T, b: T): boolean {
    if (a.k === "any" || b.k === "any" || a.k === "none" || b.k === "none") return true;
    if (a.k === "enumlit" && b.k === "enumlit") return (this.enumOf.get(a.value) ?? []).some((e) => (this.enumOf.get(b.value) ?? []).includes(e));
    if (a.k === "enumlit") return this.compatible(b, a);
    if (a.k === "enum" && b.k === "enumlit") return (this.enums.get(a.name) ?? []).includes(b.value);
    if (a.k === "enum" && b.k === "enum") return a.name === b.name;
    if ((a.k === "text" || a.k === "ip") && (b.k === "text" || b.k === "ip")) return true;
    if (a.k === "ref" && b.k === "ref") return a.entity === b.entity;
    return a.k === b.k;
  }
  fieldType(entity: string, name: string, pos: Pos): T {
    if (name === "created") return INT;
    const ent = this.entities.get(entity);
    if (!ent) return ANY;
    const f = ent.fields.find((x) => x.name === name);
    if (!f) { this.err("UNKNOWN_FIELD", pos, `${entity} has no field ${name}`); return ANY; }
    return this.typeOf(f.type);
  }
  bool(e: Expr, env: Env, what: string) {
    const t = this.expr(e, env);
    if (t.k !== "bool" && t.k !== "any") this.err("NOT_BOOL", e.pos, `${what} must be Bool, found ${this.show(t)}`);
  }

  expr(e: Expr, env: Env): T {
    switch (e.kind) {
      case "lit":
        return typeof e.value === "string" ? TEXT : typeof e.value === "number" ? INT : typeof e.value === "boolean" ? BOOL : NONE;
      case "it":
        if (!env.row) { this.err("IT_OUTSIDE_WHERE", e.pos, "'it' outside a where"); return ANY; }
        return { k: "ref", entity: env.row };
      case "rowfield":
        if (!env.row) { this.err("ROWFIELD_OUTSIDE_WHERE", e.pos, `.${e.name} outside a where`); return ANY; }
        return this.fieldType(env.row, e.name, e.pos);
      case "name": {
        if (e.name === "actor") {
          if (env.actor === "none") this.err("ACTOR_UNGATED", e.pos, "actor is used in an action that skips gate signed_in, where it is none");
          return { k: "ref", entity: "User" };
        }
        if (env.vars.has(e.name)) return env.vars.get(e.name)!;
        if (e.name === "request") return { k: "request" };
        if (e.name === "get" || e.name === "write") return { k: "method" };
        if (e.name === "none") return NONE;
        if (this.enumOf.has(e.name)) return { k: "enumlit", value: e.name };
        if (this.entities.get(e.name)?.singleton) return { k: "singleton", name: e.name };
        this.err("UNKNOWN_NAME", e.pos, `unknown name ${e.name}`);
        return ANY;
      }
      case "field": {
        if (e.target.kind === "name" && e.target.name === "request" && !env.vars.has("request")) {
          if (e.name === "ip") return { k: "ip" };
          if (e.name === "method") return { k: "method" };
          this.err("UNKNOWN_FIELD", e.pos, `request has no ${e.name}`); return ANY;
        }
        if (e.target.kind === "name" && this.enums.has(e.target.name)) {
          if (!this.enums.get(e.target.name)!.includes(e.name)) this.err("UNKNOWN_ENUM_VALUE", e.pos, `${e.target.name} has no value ${e.name}`);
          return { k: "enum", name: e.target.name };
        }
        const t = this.expr(e.target, env);
        if (t.k === "ref" || t.k === "old") return this.fieldType(t.entity, e.name, e.pos);
        if (t.k === "singleton") return this.fieldType(t.name, e.name, e.pos);
        if (t.k === "any" || t.k === "none") return ANY;
        this.err("FIELD_OF_NON_ROW", e.pos, `.${e.name} of a ${this.show(t)}`);
        return ANY;
      }
      case "unary": this.bool(e.arg, env, "the operand of not"); return BOOL;
      case "binary": {
        if (["and", "or", "implies"].includes(e.op)) { this.bool(e.left, env, `the left of ${e.op}`); this.bool(e.right, env, `the right of ${e.op}`); return BOOL; }
        const l = this.expr(e.left, env);
        if (e.op === "in") {
          if (e.right.kind === "setlit") {
            for (const i of e.right.items) { const it = this.expr(i, env); if (!this.compatible(l, it)) this.err("TYPE_MISMATCH", i.pos, `${this.show(l)} compared with ${this.show(it)}`); }
            return BOOL;
          }
          const r = this.expr(e.right, env);
          if (r.k === "set") { if (!this.compatible(l, { k: "ref", entity: r.entity })) this.err("TYPE_MISMATCH", e.pos, `${this.show(l)} tested for membership in ${this.show(r)}`); }
          else if (r.k !== "any") this.err("IN_NEEDS_SET", e.pos, `'in' needs a set, found ${this.show(r)}`);
          return BOOL;
        }
        const r = this.expr(e.right, env);
        if (["<", "<=", ">", ">="].includes(e.op)) {
          for (const [side, t] of [["left", l], ["right", r]] as const) if (t.k !== "int" && t.k !== "any") this.err("NOT_INT", e.pos, `the ${side} of ${e.op} must be Int, found ${this.show(t)}`);
          return BOOL;
        }
        if (!this.compatible(l, r)) this.err("TYPE_MISMATCH", e.pos, `${this.show(l)} ${e.op} ${this.show(r)}`);
        return BOOL;
      }
      case "setlit": this.err("SETLIT", e.pos, "a set literal is only valid on the right of 'in'"); return ANY;
      case "if": {
        this.bool(e.cond, env, "an if condition");
        const a = this.expr(e.then, env), b = this.expr(e.else, env);
        if (!this.compatible(a, b)) this.err("TYPE_MISMATCH", e.pos, `if branches have types ${this.show(a)} and ${this.show(b)}`);
        return a.k === "none" ? b : a;
      }
      case "call": {
        if (e.name === "public_ip") {
          if (e.args.length !== 1) this.err("ARITY", e.pos, "public_ip takes one argument");
          for (const a of e.args) { const t = this.expr(a, env); if (!this.compatible(t, TEXT)) this.err("TYPE_MISMATCH", a.pos, `public_ip of ${this.show(t)}`); }
          return BOOL;
        }
        const p = this.predicates.get(e.name);
        if (!p) { this.err("UNKNOWN_PREDICATE", e.pos, `unknown predicate ${e.name}`); for (const a of e.args) this.expr(a, env); return ANY; }
        if (p.params.length !== e.args.length) this.err("ARITY", e.pos, `${e.name} takes ${p.params.length} arguments, given ${e.args.length}`);
        e.args.forEach((a, i) => {
          const t = this.expr(a, env);
          const want = p.params[i] ? this.typeOf(p.params[i].type) : ANY;
          if (!this.compatible(t, want)) this.err("TYPE_MISMATCH", a.pos, `argument ${i + 1} of ${e.name} is ${this.show(t)}, expected ${this.show(want)}`);
        });
        return BOOL;
      }
      case "query": {
        if (!this.entities.has(e.entity)) { this.err("UNKNOWN_ENTITY", e.pos, `unknown entity ${e.entity}`); return ANY; }
        if (e.where) this.bool(e.where, { ...env, row: e.entity }, "a where");
        return e.op === "exists" ? BOOL : e.op === "count" ? INT : { k: "ref", entity: e.entity };
      }
      case "all": {
        if (!this.entities.has(e.entity)) { this.err("UNKNOWN_ENTITY", e.pos, `unknown entity ${e.entity}`); return BOOL; }
        if (e.where) this.bool(e.where, { ...env, row: e.entity }, "a where");
        this.bool(e.cond, { ...env, row: e.entity }, "an all condition");
        return BOOL;
      }
    }
  }

  // ---- statements (vars is shared within a block, as in the interpreter; for each copies it)
  stmts(ss: Stmt[], env: Env, inWorkflow = false) { for (const s of ss) this.stmt(s, env, inWorkflow); }
  stmt(s: Stmt, env: Env, inWorkflow: boolean) {
    switch (s.kind) {
      case "require": this.bool(s.cond, env, "a require"); return;
      case "reject": return;
      case "create": {
        const ent = this.entities.get(s.entity);
        if (!ent) { this.err("UNKNOWN_ENTITY", s.pos, `unknown entity ${s.entity}`); return; }
        if (ent.singleton) this.err("CREATE_SINGLETON", s.pos, `${s.entity} is a singleton`);
        if (inWorkflow && !s.ensure) this.err("WORKFLOW_NOT_IDEMPOTENT", s.pos, `a workflow step creates ${s.entity}; a retried step would create it twice (use ensure on a unique key)`);
        if (inWorkflow && s.ensure && ent.uniques.length === 0) this.err("WORKFLOW_NOT_IDEMPOTENT", s.pos, `ensure ${s.entity} in a workflow step, but ${s.entity} has no unique key`);
        const given = new Set<string>();
        for (const a of s.fields) {
          if (given.has(a.name)) this.err("DUPLICATE_FIELD", s.pos, `${a.name} given twice`);
          given.add(a.name);
          const f = ent.fields.find((x) => x.name === a.name);
          const t = this.expr(a.value, env);
          if (!f) { this.err("UNKNOWN_FIELD", s.pos, `${s.entity} has no field ${a.name}`); continue; }
          if (!this.compatible(this.typeOf(f.type), t)) this.err("TYPE_MISMATCH", a.value.pos, `${s.entity}.${a.name} is ${this.show(this.typeOf(f.type))}, given ${this.show(t)}`);
          if (t.k === "none" && f.type.kind === "named" && !f.type.optional) this.err("NONE_FOR_REQUIRED", a.value.pos, `${s.entity}.${a.name} is required, given none`);
        }
        for (const f of ent.fields) {
          if (!given.has(f.name) && !f.default && !(f.type.kind === "named" && f.type.optional)) this.err("MISSING_FIELD", s.pos, `create ${s.entity} without required field ${f.name}`);
        }
        if (s.ensure && ent.uniques.length === 0) this.warn("ENSURE_WITHOUT_UNIQUE", s.pos, `ensure ${s.entity}, which has no unique key, always creates`);
        if (s.as) env.vars.set(s.as, { k: "ref", entity: s.entity });
        return;
      }
      case "set": {
        const t = this.expr(s.target, env);
        if (t.k !== "ref" && t.k !== "any") { this.err("SET_NON_ROW", s.pos, `set on a ${this.show(t)}`); this.expr(s.value, env); return; }
        const v = this.expr(s.value, env);
        if (t.k === "ref") {
          const ft = this.fieldType(t.entity, s.name, s.pos);
          if (!this.compatible(ft, v)) this.err("TYPE_MISMATCH", s.value.pos, `${t.entity}.${s.name} is ${this.show(ft)}, given ${this.show(v)}`);
          const f = this.entities.get(t.entity)?.fields.find((x) => x.name === s.name);
          if (v.k === "none" && f && f.type.kind === "named" && !f.type.optional) this.err("NONE_FOR_REQUIRED", s.value.pos, `${t.entity}.${s.name} is required, set to none`);
        }
        return;
      }
      case "delete": {
        const t = this.expr(s.target, env);
        if (t.k !== "ref" && t.k !== "any") this.err("DELETE_NON_ROW", s.pos, `delete of a ${this.show(t)}`);
        return;
      }
      case "deleteWhere":
        if (!this.entities.has(s.entity)) { this.err("UNKNOWN_ENTITY", s.pos, `unknown entity ${s.entity}`); return; }
        if (s.where) this.bool(s.where, { ...env, row: s.entity }, "a where");
        return;
      case "foreach": {
        if (!this.entities.has(s.entity)) { this.err("UNKNOWN_ENTITY", s.pos, `unknown entity ${s.entity}`); return; }
        if (s.where) this.bool(s.where, { ...env, row: s.entity }, "a where");
        const vars = new Map(env.vars); vars.set(s.bind, { k: "ref", entity: s.entity });
        this.stmts(s.body, { ...env, vars, row: undefined }, inWorkflow);
        return;
      }
      case "if":
        this.bool(s.cond, env, "an if condition");
        this.stmts(s.then, env, inWorkflow); this.stmts(s.else, env, inWorkflow);
        return;
      case "emit": {
        if (inWorkflow) this.err("WORKFLOW_NOT_IDEMPOTENT", s.pos, `a workflow step emits ${s.event}; a retried step would emit it twice`);
        const ts = s.args.map((a) => this.expr(a, env));
        const prev = this.events.get(s.event);
        if (prev && (prev.length !== ts.length || prev.some((p, i) => !this.compatible(p, ts[i])))) this.err("EVENT_ARGS", s.pos, `${s.event} is emitted with different argument types`);
        if (!prev) this.events.set(s.event, ts);
        return;
      }
    }
  }

  // ---- declarations
  run(): Finding[] {
    const seen = new Map<string, string>();
    for (const d of this.spec.decls) {
      if (!("name" in d)) continue;
      const key = `${d.kind === "enum" || d.kind === "entity" ? "type" : d.kind === "predicate" ? "pred" : d.kind === "action" || d.kind === "view" ? "action" : d.kind}:${d.name}`;
      if (seen.has(key)) { this.where = d.name; this.err("DUPLICATE", d.pos, `${d.name} is declared twice`); }
      seen.set(key, d.name);
    }
    // Emits first, so workflows know their argument types.
    for (const d of this.spec.decls) {
      if (d.kind === "action") { this.where = `action ${d.name}`; this.stmts(d.body, this.actionEnv(d)); }
      if (d.kind === "trigger") { this.where = `trigger line ${d.pos.line}`; this.trigger(d); }
    }
    for (const d of this.spec.decls) {
      switch (d.kind) {
        case "entity": this.where = `entity ${d.name}`; this.entity(d); break;
        case "predicate": {
          this.where = `predicate ${d.name}`;
          const vars = new Map<string, T>();
          for (const p of d.params) { this.checkTypeRef(p.type, p.pos); vars.set(p.name, this.typeOf(p.type)); }
          this.bool(d.body, { vars, actor: "user" }, "a predicate body");
          break;
        }
        case "gate": this.where = `gate ${d.name}`; this.bool(d.cond, { vars: new Map(), actor: "user" }, "a gate condition"); break;
        case "workflow": {
          this.where = `workflow on ${d.event}`;
          const args = this.events.get(d.event);
          if (!args) this.warn("WORKFLOW_NEVER_RUNS", d.pos, `nothing emits ${d.event}`);
          const vars = new Map<string, T>([[d.bind, args?.[0] ?? ANY]]);
          for (const st of d.steps) this.stmts(st.body, { vars: new Map(vars), actor: "none" }, true);
          break;
        }
        case "permission": {
          this.where = `permission read ${d.entity}`;
          if (!this.entities.has(d.entity)) { this.err("UNKNOWN_ENTITY", d.pos, `unknown entity ${d.entity}`); break; }
          this.bool(d.cond, { vars: new Map([[d.entity.toLowerCase(), { k: "ref", entity: d.entity } as T]]), actor: "user" }, "a permission");
          break;
        }
        case "view": {
          this.where = `view ${d.name}`;
          const env: Env = { vars: this.params(d.params), actor: "user" };
          for (const r of d.requires) this.bool(r.cond, env, "a require");
          if (!this.entities.has(d.rows.entity)) { this.err("UNKNOWN_ENTITY", d.pos, `unknown entity ${d.rows.entity}`); break; }
          if (d.rows.where) this.bool(d.rows.where, { ...env, row: d.rows.entity }, "a rows where");
          if (d.orderBy !== "created") this.fieldType(d.rows.entity, d.orderBy, d.pos);
          if (d.window?.unless) this.bool(d.window.unless, env, "a window condition");
          if (!this.spec.decls.some((p) => p.kind === "permission" && p.entity === d.rows.entity)) this.err("VIEW_WITHOUT_PERMISSION", d.pos, `${d.name} returns ${d.rows.entity} rows, which have no read permission`);
          break;
        }
      }
    }
    for (const d of this.spec.decls) if (d.kind === "action") { this.where = `action ${d.name}`; this.permissionCoverage(d); }
    this.where = "predicates";
    this.recursion();
    this.where = "triggers";
    this.triggerGraph();
    return this.findings;
  }
  params(ps: { name: string; type: TypeRef; pos: Pos }[]): Map<string, T> {
    const vars = new Map<string, T>();
    for (const p of ps) { this.checkTypeRef(p.type, p.pos); vars.set(p.name, this.typeOf(p.type)); }
    return vars;
  }
  actionEnv(d: ActionDecl): Env {
    for (const g of d.skips) if (!this.spec.decls.some((x) => x.kind === "gate" && x.name === g)) this.err("UNKNOWN_GATE", d.pos, `skip of unknown gate ${g}`);
    return { vars: this.params(d.params), actor: d.skips.includes("signed_in") ? "none" : "user" };
  }
  entity(d: EntityDecl) {
    for (const f of d.fields) {
      this.checkTypeRef(f.type, f.pos);
      if (f.default) {
        const t = this.expr(f.default, { vars: new Map(), row: d.name, actor: "none" });
        if (!this.compatible(this.typeOf(f.type), t)) this.err("TYPE_MISMATCH", f.pos, `default of ${d.name}.${f.name} is ${this.show(t)}`);
      }
    }
    for (const u of d.uniques) for (const c of u) if (!d.fields.some((f) => f.name === c)) this.err("UNKNOWN_FIELD", d.pos, `unique on unknown field ${c}`);
    for (const inv of d.invariants) this.bool(inv, { vars: new Map([["self", { k: "ref", entity: d.name } as T]]), row: d.name, actor: "none" }, "an invariant");
  }
  trigger(d: TriggerDecl) {
    const on = d.on;
    const vars = new Map<string, T>();
    if (on.kind === "event") vars.set(d.bind, ANY);
    else {
      if (!this.entities.has(on.entity)) { this.err("UNKNOWN_ENTITY", d.pos, `trigger on unknown entity ${on.entity}`); return; }
      vars.set(d.bind, { k: "ref", entity: on.entity });
      if (on.kind === "update") { this.fieldType(on.entity, on.field, d.pos); vars.set("old", { k: "old", entity: on.entity }); }
    }
    const env: Env = { vars, actor: "user" };
    if (d.when) this.bool(d.when, env, "a trigger condition");
    this.stmts(d.body, env);
  }

  // Permission coverage: an action that writes, behind the signed_in gate, should check
  // something about its actor in a require. v1 has no way to say "any signed-in user", so a
  // missing check is a warning, not an error.
  permissionCoverage(d: ActionDecl) {
    if (d.skips.includes("signed_in")) return;
    let writes = false, checksActor = false;
    const visit = (ss: Stmt[]) => {
      for (const s of ss) {
        if (["create", "set", "delete", "deleteWhere", "emit"].includes(s.kind)) writes = true;
        if (s.kind === "require") walkExpr(s.cond, (x) => { if (x.kind === "name" && x.name === "actor") checksActor = true; });
        if (s.kind === "if") { visit(s.then); visit(s.else); }
        if (s.kind === "foreach") visit(s.body);
      }
    };
    visit(d.body);
    if (writes && !checksActor) this.warn("PERMISSION_COVERAGE", d.pos, `${d.name} writes, but no require checks its actor`);
  }

  recursion() {
    const calls = new Map<string, Set<string>>();
    const collect = (e: Expr, out: Set<string>) => walkExpr(e, (x) => { if (x.kind === "call" && this.predicates.has(x.name)) out.add(x.name); });
    for (const [name, p] of this.predicates) { const s = new Set<string>(); collect(p.body, s); calls.set(name, s); }
    for (const start of calls.keys()) {
      const stack = [...calls.get(start)!], seen = new Set<string>();
      while (stack.length) {
        const n = stack.pop()!;
        if (n === start) { this.err("PREDICATE_RECURSION", this.predicates.get(start)!.pos, `predicate ${start} calls itself`); break; }
        if (seen.has(n)) continue;
        seen.add(n); stack.push(...(calls.get(n) ?? []));
      }
    }
  }

  // ---- the trigger graph
  // The events a statement list can cause directly: create E, update E.f, delete E (with cascades), emit Ev.
  effects(ss: Stmt[], vars: Map<string, T>, out: Set<string>, writes: Set<string>) {
    for (const s of ss) {
      switch (s.kind) {
        case "create": {
          out.add(`create ${s.entity}`); writes.add(`rows ${s.entity}`);
          if (s.as) vars.set(s.as, { k: "ref", entity: s.entity });
          break;
        }
        case "set": {
          const t = this.quietType(s.target, vars);
          if (t.k === "ref") { out.add(`update ${t.entity}.${s.name}`); writes.add(`field ${t.entity}.${s.name}`); }
          break;
        }
        case "delete": { const t = this.quietType(s.target, vars); if (t.k === "ref") this.deleteEffects(t.entity, out, writes); break; }
        case "deleteWhere": this.deleteEffects(s.entity, out, writes); break;
        case "foreach": { const v = new Map(vars); v.set(s.bind, { k: "ref", entity: s.entity }); this.effects(s.body, v, out, writes); break; }
        case "if": this.effects(s.then, vars, out, writes); this.effects(s.else, vars, out, writes); break;
        case "emit": out.add(`event ${s.event}`); break;
      }
    }
  }
  deleteEffects(entity: string, out: Set<string>, writes: Set<string>, seen = new Set<string>()) {
    if (seen.has(entity)) return;
    seen.add(entity);
    out.add(`delete ${entity}`); writes.add(`rows ${entity}`);
    for (const [name, ent] of this.entities) for (const f of ent.fields) {
      if (f.type.kind === "named" && f.type.name === entity && f.onDelete === "cascade") this.deleteEffects(name, out, writes, seen);
    }
  }
  quietType(e: Expr, vars: Map<string, T>): T {
    const saved = this.findings.length;
    const t = this.expr(e, { vars, actor: "user" });
    this.findings.length = saved;
    return t;
  }
  triggerGraph() {
    const triggers = this.spec.decls.filter((d): d is TriggerDecl => d.kind === "trigger");
    const key = (t: TriggerDecl) => t.on.kind === "event" ? `event ${t.on.event}` : t.on.kind === "update" ? `update ${t.on.entity}.${t.on.field}` : `${t.on.kind} ${t.on.entity}`;
    const info = triggers.map((t) => {
      const vars = new Map<string, T>();
      if (t.on.kind !== "event") vars.set(t.bind, { k: "ref", entity: t.on.entity });
      const out = new Set<string>(), writes = new Set<string>();
      this.effects(t.body, vars, out, writes);
      return { t, on: key(t), out, writes, label: `trigger line ${t.pos.line} (on ${key(t)})` };
    });
    // Cycles: trigger A -> trigger B when A's effects fire B.
    const next = (i: number) => info.map((_, j) => j).filter((j) => info[i].out.has(info[j].on));
    const reported = new Set<string>();
    for (let s = 0; s < info.length; s++) {
      const stack: [number, number[]][] = next(s).map((j) => [j, [s, j]]);
      const seen = new Set<number>();
      while (stack.length) {
        const [n, path] = stack.pop()!;
        if (n === s) {
          const cyc = path.map((i) => info[i].label).join(" -> ");
          const k = [...new Set(path)].sort().join(",");
          if (!reported.has(k)) { reported.add(k); this.err("TRIGGER_CYCLE", info[s].t.pos, `trigger cycle: ${cyc}`); }
          break;
        }
        if (seen.has(n)) continue;
        seen.add(n);
        for (const j of next(n)) stack.push([j, [...path, j]]);
      }
    }
    // Order dependence: two triggers on the same event that write the same field, or where one
    // deletes rows of an entity the other creates or updates.
    for (let i = 0; i < info.length; i++) for (let j = i + 1; j < info.length; j++) {
      if (info[i].on !== info[j].on) continue;
      const a = info[i].writes, b = info[j].writes;
      const fieldClash = [...a].find((w) => w.startsWith("field ") && b.has(w));
      const rowsOf = (w: Set<string>, e: string) => w.has(`rows ${e}`) || [...w].some((x) => x.startsWith(`field ${e}.`));
      const delA = [...info[i].out].filter((x) => x.startsWith("delete ")).map((x) => x.slice(7));
      const delB = [...info[j].out].filter((x) => x.startsWith("delete ")).map((x) => x.slice(7));
      const delClash = delA.find((e) => rowsOf(b, e)) ?? delB.find((e) => rowsOf(a, e));
      if (fieldClash || delClash) this.err("TRIGGER_ORDER", info[j].t.pos, `${info[i].label} and ${info[j].label} both react to ${info[i].on} and ${fieldClash ? `both write ${fieldClash.slice(6)}` : `one deletes ${delClash} rows the other writes`}; their order changes the result`);
    }
  }
}

export function walkExpr(e: Expr, f: (e: Expr) => void) {
  f(e);
  switch (e.kind) {
    case "field": walkExpr(e.target, f); break;
    case "unary": walkExpr(e.arg, f); break;
    case "binary": walkExpr(e.left, f); walkExpr(e.right, f); break;
    case "setlit": e.items.forEach((i) => walkExpr(i, f)); break;
    case "if": walkExpr(e.cond, f); walkExpr(e.then, f); walkExpr(e.else, f); break;
    case "call": e.args.forEach((a) => walkExpr(a, f)); break;
    case "query": if (e.where) walkExpr(e.where, f); break;
    case "all": if (e.where) walkExpr(e.where, f); walkExpr(e.cond, f); break;
  }
}

export type { Field };
