// Bounded exploration: breadth-first over every action, actor and argument combination from
// small seed states, then seeded random walks to reach deeper states. It runs the reference
// interpreter itself, so the checker and the semantics can't drift apart. Everything is
// deterministic: budgets count runs, not seconds.
import type { ActionDecl, Expr, Param, Spec, ViewDecl } from "../ast.ts";
import { Interpreter, InterpError, Outcome, Store, type Ref, type Val } from "../interp.ts";
import type { Finding } from "./finding.ts";

export type Scope = {
  seeds: { name: string; rows: Record<string, Record<string, unknown>[]> }[];
  bounds: Record<string, number>;      // max rows per entity in explored states
  walkBounds?: Record<string, number>; // looser bounds for random walks
  maxSetSize: number;
  values: { Text: string[]; Ip: string[]; Int: number[] };
  params?: Record<string, unknown[]>;  // "action.param" -> values, overriding values by type
  ips: string[];                       // request addresses for actions without a signed-in actor
  bfsRuns: number;                     // run budget for the breadth-first phase
  walks: number;
  walkLength: number;
  seed: number;
};

type Call = { name: string; args: Record<string, unknown>; actor: number | null; ip: string };
type Node = { store: Store; parent: string | null; call: Call | null; depth: number };

const SKIP_CAUSES = new Set(["gate", "require", "reject", "param"]);
const IMPLICIT: Record<string, string> = {
  invariant: "INVARIANT_VIOLATION",
  unique: "UNIQUE_VIOLATION",
  restrict: "RESTRICT_VIOLATION",
  the: "CARDINALITY",
  required: "MISSING_REQUIRED",
  missing: "STALE_ROW",
};

export class Explorer {
  it: Interpreter;
  findings = new Map<string, Finding>();
  nodes = new Map<string, Node>();
  runs = 0;
  requireFailed = new Set<number>();     // require lines that failed at least once
  succeeded = new Set<string>();         // actions and views that succeeded at least once
  storedValues = new Map<string, Set<string>>();   // "Entity.field" (enum) -> values seen
  permissions: Map<string, Expr>;
  callables: (ActionDecl | ViewDecl)[];

  spec: Spec;
  scope: Scope;

  constructor(spec: Spec, scope: Scope) {
    this.spec = spec;
    this.scope = scope;
    this.it = new Interpreter(spec);
    this.permissions = new Map(spec.decls.flatMap((d) => (d.kind === "permission" ? [[d.entity, d.cond] as [string, Expr]] : [])));
    this.callables = spec.decls.filter((d): d is ActionDecl | ViewDecl => d.kind === "action" || d.kind === "view");
  }

  // ---- states
  seedStore(rows: Record<string, Record<string, unknown>[]>): Store {
    const s = new Store();
    this.it.store = s;
    for (const [entity, list] of Object.entries(rows)) {
      const ent = this.it.entities.get(entity);
      if (!ent) throw new Error(`scope seed names unknown entity ${entity}`);
      for (const given of list) {
        const fields: Record<string, Val> = {};
        for (const f of ent.fields) {
          if (f.name in given) {
            const v = given[f.name];
            fields[f.name] = f.type.kind === "named" && this.it.entities.has(f.type.name) && v !== null ? { ref: f.type.name, id: Number(v) } : (v as Val);
          }
        }
        const draft = { id: 0, created: s.seq, fields };
        for (const f of ent.fields) {
          if (f.name in fields) continue;
          if (f.default) fields[f.name] = this.it.eval(f.default, { vars: new Map(), actor: null, request: { ip: "", method: "write" }, events: [], row: { entity, row: draft } });
          else fields[f.name] = null;
        }
        s.insert(entity, fields);
      }
    }
    return s;
  }
  key(s: Store): string {
    const names = [...s.tables.keys()].sort();
    return JSON.stringify(names.map((n) => [n, s.tables.get(n)!.map((r) => [r.id, r.fields])]));
  }
  withinBounds(s: Store, bounds: Record<string, number>): boolean {
    for (const [e, max] of Object.entries(bounds)) if (s.rows(e).length > max) return false;
    return true;
  }

  // ---- argument domains
  domain(action: string, p: Param, s: Store): unknown[] {
    const override = this.scope.params?.[`${action}.${p.name}`];
    if (p.type.kind === "set") {
      const ids = s.rows(p.type.of).map((r) => r.id);
      const out: number[][] = [[]];
      const rec = (start: number, cur: number[]) => {
        for (let i = start; i < ids.length; i++) {
          const next = [...cur, ids[i]];
          out.push(next);
          if (next.length < this.scope.maxSetSize) rec(i + 1, next);
        }
      };
      rec(0, []);
      return out;
    }
    const t = p.type;
    let vals: unknown[];
    if (override) vals = [...override];
    else if (this.it.entities.has(t.name)) {
      const ids = s.rows(t.name).map((r) => r.id);
      vals = [...ids, (ids.length ? Math.max(...ids) : 0) + 1];   // every row, plus one that doesn't exist
    } else if (this.it.enums.has(t.name)) vals = [...this.it.enums.get(t.name)!, "not_a_value"];
    else if (t.name === "Bool") vals = [false, true];
    else if (t.name === "Int") vals = [...this.scope.values.Int];
    else if (t.name === "Ip") vals = [...this.scope.values.Ip];
    else vals = [...this.scope.values.Text];
    if (t.optional) vals.unshift(null);
    return vals;
  }
  calls(s: Store): Call[] {
    const out: Call[] = [];
    const users = s.rows("User").map((r) => r.id);
    const sessionIps = (u: number) => [...new Set(s.rows("Session").filter((r) => (r.fields.user as Ref)?.id === u).map((r) => String(r.fields.ip)))];
    const extraIps = [...new Set([...this.scope.ips, ...s.rows("Ban").map((r) => String(r.fields.ip))])];
    for (const d of this.callables) {
      const ungated = d.kind === "action" && d.skips.includes("signed_in");
      const domains = d.params.map((p) => this.domain(d.name, p, s));
      const combos: Record<string, unknown>[] = [{}];
      d.params.forEach((p, i) => {
        const next: Record<string, unknown>[] = [];
        for (const c of combos) for (const v of domains[i]) next.push({ ...c, [p.name]: v });
        combos.splice(0, combos.length, ...next);
      });
      const actors: [number | null, string[]][] = ungated ? [[null, extraIps]] : users.map((u) => [u, sessionIps(u).length ? sessionIps(u) : [this.scope.ips[0]]]);
      for (const [actor, ips] of actors) for (const ip of ips) for (const args of combos) out.push({ name: d.name, args, actor, ip });
    }
    return out;
  }

  // ---- one run
  report(code: string, where: string, message: string, trace: string[], severity: "error" | "warning" = "error") {
    const k = `${code}|${where}|${message}`;
    if (!this.findings.has(k)) this.findings.set(k, { severity, code, where, message, trace });
  }
  describe(c: Call): string {
    const args = Object.entries(c.args).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(", ");
    return `${c.actor === null ? "anonymous" : `User#${c.actor}`} @${c.ip}: ${c.name}(${args})`;
  }
  traceTo(key: string): string[] {
    const out: string[] = [];
    let k: string | null = key;
    while (k) { const n = this.nodes.get(k)!; if (n.call) out.unshift(this.describe(n.call)); else out.unshift(`seed ${(n as Node & { seedName?: string }).seedName ?? ""}`); k = n.parent; }
    return out;
  }
  // Runs a call on a copy of the store; returns the new store if the action succeeded and wrote.
  step(from: Store, c: Call, trace: () => string[]): Store | null {
    this.runs++;
    const it = this.it;
    it.store = from.clone();
    const isView = it.views.has(c.name);
    const actor = c.actor === null ? null : { ref: "User", id: c.actor };
    let r;
    try {
      r = it.run(c.name, c.args, actor, { ip: c.ip, method: isView ? "get" : "write" });
    } catch (err) {
      if (err instanceof Outcome) {
        // Thrown by a workflow step, after the action committed.
        this.report(IMPLICIT[err.cause] ?? "WORKFLOW_FAILED", c.name, `a workflow after ${c.name} failed: ${stripIds(err.message)}`, [...trace(), this.describe(c)]);
        return null;
      }
      if (err instanceof InterpError) { this.report("RUNTIME_ERROR", c.name, stripIds(err.message), [...trace(), this.describe(c)]); return null; }
      throw err;
    }
    if (r.outcome !== "ok") {
      if (r.cause === "require" && r.detail) { const m = r.detail.match(/line (\d+)/); if (m) this.requireFailed.add(Number(m[1])); }
      if (r.cause && !SKIP_CAUSES.has(r.cause)) {
        const code = IMPLICIT[r.cause] ?? "IMPLICIT_FAILURE";
        this.report(code, c.name, `${c.name} can end ${r.outcome} through no rule of its own: ${stripIds(r.detail ?? "")}`, [...trace(), this.describe(c)]);
      }
      return null;
    }
    this.succeeded.add(c.name);
    if (isView) {
      const v = it.views.get(c.name)!;
      const cond = this.permissions.get(v.rows.entity);
      if (cond) {
        it.store = from.clone();
        for (const row of r.rows ?? []) {
          let ok = false;
          try { ok = it.truthy(it.eval(cond, { vars: new Map([[v.rows.entity.toLowerCase(), row]]), actor, request: { ip: c.ip, method: "get" }, events: [] })); }
          catch { ok = false; }
          if (!ok) { this.report("PERMISSION_LEAK", c.name, `${c.name} returns a ${v.rows.entity} row its read permission doesn't allow`, [...trace(), this.describe(c)]); break; }
        }
      }
      return null;
    }
    // Workflows ran to completion inside run(); invariants must hold afterwards too.
    try { it.checkInvariants({ vars: new Map(), actor, request: { ip: c.ip, method: "write" }, events: [] }); }
    catch (err) {
      if (err instanceof Outcome) this.report("INVARIANT_AFTER_WORKFLOW", c.name, `after ${c.name} and its workflows, ${stripIds(err.message)}`, [...trace(), this.describe(c)]);
      else throw err;
    }
    // Unique keys must hold after workflows as well.
    for (const [name, ent] of it.entities) for (const cols of ent.uniques) {
      const seen = new Set<string>();
      for (const row of it.store.rows(name)) {
        const k = JSON.stringify(cols.map((col) => row.fields[col]));
        if (seen.has(k)) { this.report("UNIQUE_VIOLATION", c.name, `after ${c.name}, two ${name} rows share (${cols.join(", ")})`, [...trace(), this.describe(c)]); break; }
        seen.add(k);
      }
    }
    for (const [name, ent] of it.entities) for (const f of ent.fields) {
      if (f.type.kind !== "named" || !it.enums.has(f.type.name)) continue;
      const k = `${name}.${f.name}`;
      if (!this.storedValues.has(k)) this.storedValues.set(k, new Set());
      for (const row of it.store.rows(name)) this.storedValues.get(k)!.add(String(row.fields[f.name]));
    }
    return it.store;
  }

  // ---- the search
  run(): Finding[] {
    const queue: string[] = [];
    for (const seed of this.scope.seeds) {
      const s = this.seedStore(seed.rows);
      const k = this.key(s);
      if (!this.nodes.has(k)) { const n = { store: s, parent: null, call: null, depth: 0, seedName: seed.name }; this.nodes.set(k, n); queue.push(k); }
    }
    const seeds = [...queue];
    // Breadth first, until the run budget is spent.
    while (queue.length && this.runs < this.scope.bfsRuns) {
      const k = queue.shift()!;
      const node = this.nodes.get(k)!;
      for (const c of this.calls(node.store)) {
        const next = this.step(node.store, c, () => this.traceTo(k));
        if (!next || !this.withinBounds(next, this.scope.bounds)) continue;
        const nk = this.key(next);
        if (!this.nodes.has(nk)) { this.nodes.set(nk, { store: next, parent: k, call: c, depth: node.depth + 1 }); queue.push(nk); }
      }
    }
    // Random walks from the seeds, with looser bounds.
    const rand = mulberry32(this.scope.seed);
    const bounds = this.scope.walkBounds ?? this.scope.bounds;
    for (let w = 0; w < this.scope.walks; w++) {
      let k = seeds[w % seeds.length];
      let s = this.nodes.get(k)!.store;
      const path: string[] = this.traceTo(k);
      for (let step = 0; step < this.scope.walkLength; step++) {
        const calls = this.calls(s);
        let moved = false;
        for (let attempt = 0; attempt < 30 && !moved; attempt++) {
          const c = calls[Math.floor(rand() * calls.length)];
          const next = this.step(s, c, () => path);
          if (next && this.withinBounds(next, bounds)) { s = next; path.push(this.describe(c)); moved = true; }
        }
        if (!moved) break;
      }
    }
    // Warnings: guards that never failed, actions that never succeeded, enum values never stored.
    for (const d of this.callables) {
      if (!this.succeeded.has(d.name)) this.report("NEVER_SUCCEEDS", d.name, `${d.name} never succeeded in the explored states`, [], "warning");
      const reqs = d.kind === "action" ? collectRequires(d.body) : d.requires.map((r) => ({ line: r.cond.pos.line }));
      for (const r of reqs) if (!this.requireFailed.has(r.line)) this.report("REQUIRE_NEVER_FAILS", d.name, `the require at line ${r.line} never failed in the explored states`, [], "warning");
    }
    for (const [k, seen] of this.storedValues) {
      const [ent, field] = k.split(".");
      const f = this.it.entities.get(ent)!.fields.find((x) => x.name === field)!;
      const all = this.it.enums.get((f.type as { name: string }).name) ?? [];
      const missing = all.filter((v) => !seen.has(v));
      if (missing.length) this.report("ENUM_VALUE_UNREACHED", k, `${k} never held ${missing.join(", ")} in the explored states`, [], "warning");
    }
    return [...this.findings.values()];
  }
}

function collectRequires(ss: import("../ast.ts").Stmt[]): { line: number }[] {
  const out: { line: number }[] = [];
  for (const s of ss) {
    if (s.kind === "require") out.push({ line: s.pos.line });
    if (s.kind === "if") out.push(...collectRequires(s.then), ...collectRequires(s.else));
    if (s.kind === "foreach") out.push(...collectRequires(s.body));
  }
  return out;
}

// Row ids differ between traces of the same problem; drop them so findings group.
function stripIds(m: string): string { return m.replace(/\b([A-Z]\w*) \d+\b/g, "$1").replace(/#\d+/g, ""); }

function mulberry32(a: number) {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
