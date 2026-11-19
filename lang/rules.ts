// Rules written once and woven into every place they apply (docs/RULES-DESIGN.md). After this pass the
// rest of the compiler sees ordinary declarations and requires, each require marked with where it came from.
//   - subset S = E where c: a query of S reads E where c; a parameter of type S is an E, and one outside c
//     is a row that doesn't exist (not_found) where the parameter is first used.
//   - policy p: c for rows of A, B / for rows in C: who may see rows, as one permission per entity (an
//     entity under several policies gets all of them, joined by and). For rows in C covers C and every
//     entity whose required references lead to a C, by the one shortest path the compiler finds.
//   - a parameter naming a row its policy hides is a row that doesn't exist: not_found where the
//     parameter is first used, unless the require there already says so (with its own outcome).
import type { Decl, Expr, Pos } from "./parser.ts";
import { SpecError } from "./parser.ts";
import { entityOf } from "./writerule.ts";

const snake = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
const keyOf = (e: any): string => JSON.stringify(e, (k, v) => (k === "pos" ? undefined : v));
const and = (a: Expr, b: Expr): Expr => ({ kind: "binary", op: "and", left: a, right: b, pos: a.pos });
const conjuncts = (e: any): any[] => (e?.kind === "binary" && e.op === "and" ? [...conjuncts(e.left), ...conjuncts(e.right)] : [e]);
const isTrue = (e: any) => e?.kind === "lit" && e.value === true;
// a node whose .f and it are its own rows' (a nested query)
const OWN_ROW = new Set(["query", "listq", "all"]);

// a copy that keeps the properties the parser hides (structuredClone drops them)
function copy(x: any): any {
  if (Array.isArray(x)) return x.map(copy);
  if (!x || typeof x !== "object") return x;
  const o: any = {};
  for (const k of Object.getOwnPropertyNames(x)) { const d = Object.getOwnPropertyDescriptor(x, k)!; Object.defineProperty(o, k, { ...d, value: k === "pos" ? d.value : copy(d.value) }); }
  return o;
}
// the outer row of a condition (.f and it) as an expression
function rowTo(e: any, by: Expr): any {
  if (Array.isArray(e)) return e.map((x) => rowTo(x, by));
  if (!e || typeof e !== "object") return e;
  if (e.kind === "rowfield") return { kind: "field", target: copy(by), name: e.name, pos: e.pos };
  if (e.kind === "it") return copy(by);
  if (OWN_ROW.has(e.kind)) return e;
  const o: any = {};
  for (const k of Object.getOwnPropertyNames(e)) { const d = Object.getOwnPropertyDescriptor(e, k)!; Object.defineProperty(o, k, { ...d, value: k === "pos" ? d.value : rowTo(d.value, by) }); }
  return o;
}
function hasOuterRow(e: any): boolean {
  if (Array.isArray(e)) return e.some(hasOuterRow);
  if (!e || typeof e !== "object") return false;
  if (e.kind === "rowfield" || e.kind === "it") return true;
  if (OWN_ROW.has(e.kind)) return false;
  return Object.entries(e).some(([k, v]) => k !== "pos" && hasOuterRow(v));
}
// a name replaced by an expression
function subst(x: any, name: string, by: Expr): any {
  if (Array.isArray(x)) return x.map((y) => subst(y, name, by));
  if (!x || typeof x !== "object") return x;
  if (x.kind === "name" && x.name === name) return copy(by);
  const o: any = {};
  for (const k of Object.getOwnPropertyNames(x)) { const d = Object.getOwnPropertyDescriptor(x, k)!; Object.defineProperty(o, k, { ...d, value: k === "pos" ? d.value : subst(d.value, name, by) }); }
  return o;
}
function mentions(x: any, name: string): boolean {
  if (Array.isArray(x)) return x.some((y) => mentions(y, name));
  if (!x || typeof x !== "object") return false;
  if (x.kind === "name" && x.name === name) return true;
  return Object.entries(x).some(([k, v]) => k !== "pos" && mentions(v, name));
}

type Subset = { name: string; entity: string; cond: Expr; pos: Pos };

// ---- subsets
function applySubsets(decls: Decl[]): Map<string, Subset> {
  const subs = new Map(decls.filter((d) => d.kind === "subset").map((d) => [d.name, d as any]));
  const out = new Map<string, Subset>();
  if (!subs.size) return out;
  const ents = new Map(decls.filter((d) => ["entity", "singleton", "data"].includes(d.kind)).map((d) => [d.name, d]));
  for (const s of subs.values()) if (ents.has(s.name)) throw new SpecError("SUBSET_NAME", `subset ${s.name} has an entity's name`, s.pos);
  const resolve = (name: string, seen: string[]): Subset => {
    if (out.has(name)) return out.get(name)!;
    const d = subs.get(name)!;
    if (seen.includes(name)) throw new SpecError("SUBSET_CYCLE", `subsets defined by each other: ${[...seen, name].join(" = ")}`, d.pos);
    let r: Subset;
    if (subs.has(d.entity)) { const b = resolve(d.entity, [...seen, name]); r = { name, entity: b.entity, cond: and(copy(b.cond), d.cond), pos: d.pos }; }
    else if (ents.get(d.entity)?.kind === "entity") r = { name, entity: d.entity, cond: d.cond, pos: d.pos };
    else throw new SpecError("SUBSET_BASE", `subset ${name} = ${d.entity} where …: ${d.entity} ${ents.has(d.entity) ? "is not an entity (a subset is rows of one)" : "is no entity or subset"}`, d.pos);
    out.set(name, r);
    return r;
  };
  for (const n of subs.keys()) resolve(n, []);
  // a subset's condition is read where the subset is (in each query and parameter), so it is hidden here
  for (const s of subs.values()) Object.defineProperty(s, "cond", { value: s.cond, enumerable: false });

  // reads: every query of S is a query of E where c (and its own where)
  const reads = (x: any): void => {
    if (Array.isArray(x)) { x.forEach(reads); return; }
    if (!x || typeof x !== "object") return;
    if (typeof x.entity === "string" && out.has(x.entity) && x.kind !== "subset") {
      const s = out.get(x.entity)!;
      if (!Object.prototype.hasOwnProperty.call(x, "where")) throw new SpecError("SUBSET_NOT_ROWS", `${s.name} is a subset of ${s.entity}, rows to read; ${x.kind === "create" ? (x.ensure ? "ensure" : "create") : "this"} takes the entity: ${s.entity}`, x.pos ?? s.pos);
      x.subset = s.name; x.entity = s.entity; x.where = x.where ? and(copy(s.cond), x.where) : copy(s.cond);
    }
    for (const [k, v] of Object.entries(x)) if (k !== "pos") reads(v);
  };
  reads(decls.filter((d) => d.kind !== "subset"));

  // types: a parameter of a subset type is a row of its entity, checked where first used (applyParamGuards)
  for (const d of decls as any[]) {
    if (["entity", "singleton", "data"].includes(d.kind)) for (const f of d.fields ?? []) {
      const t = f.type; const n = t?.kind === "named" ? t.name : t?.kind === "set" ? t.of : undefined;
      if (n && out.has(n)) throw new SpecError("SUBSET_STORED", `${d.name}.${f.name}: a stored field can't have the subset ${n} as its type, as the row can leave the subset after it is stored; store a ${out.get(n)!.entity}, and say what must hold with an invariant`, f.pos ?? d.pos);
    }
    for (const p of d.params ?? []) {
      const t = p.type;
      if (t?.kind === "set" && out.has(t.of)) throw new SpecError("SUBSET_SET", `${p.name}: set of ${t.of} isn't a type; take set of ${out.get(t.of)!.entity} and read ${t.of} where it in ${p.name}`, p.pos);
      if (t?.kind !== "named" || !out.has(t.name)) continue;
      if (!["action", "view", "screen", "channel", "signal"].includes(d.kind)) throw new SpecError("SUBSET_FN_PARAM", `${d.kind} ${d.name}(${p.name}: ${t.name}): only an action, view, screen, channel or signal can refuse a row outside a subset; take a ${out.get(t.name)!.entity}`, p.pos);
      p.subset = t.name; p.type = { ...t, name: out.get(t.name)!.entity };
    }
  }
  return out;
}

// ---- row policies: one permission per entity
function applyRowPolicies(decls: Decl[]): void {
  const rps = decls.filter((d) => d.kind === "rowpolicy") as any[];
  if (!rps.length) return;
  const ents = new Map(decls.filter((d) => ["entity", "singleton", "data"].includes(d.kind)).map((d) => [d.name, d as any]));
  const parts = new Map<string, { policy: string; cond: Expr; pos: Pos }[]>();
  const add = (e: string, policy: string, cond: Expr, pos: Pos) => { if (!parts.has(e)) parts.set(e, []); parts.get(e)!.push({ policy, cond, pos }); };
  for (const rp of rps) {
    if (rp.container) {
      const c = rp.container as string;
      if (ents.get(c)?.kind !== "entity") throw new SpecError("UNKNOWN_ENTITY", `policy ${rp.name}: for rows in ${c}: ${ents.has(c) ? `${c} isn't an entity` : `unknown entity ${c}`}`, rp.pos);
      if (hasOuterRow(rp.cond)) throw new SpecError("ROWS_IN_ROW", `policy ${rp.name} is for rows in ${c}: the condition names the ${c} as ${snake(c)} (.f and it would be different rows for each entity in it)`, rp.pos);
      const paths = inside(c, ents, rp);
      rp.covers = [...paths.keys()];
      for (const [e, path] of paths) {
        const by = path.reduce((t: Expr, f) => ({ kind: "field", target: t, name: f, pos: rp.pos }), { kind: "name", name: snake(e), pos: rp.pos } as Expr);
        add(e, rp.name, e === c ? copy(rp.cond) : subst(rp.cond, snake(c), by), rp.pos);
      }
    } else {
      rp.covers = rp.entities;
      for (const e of rp.entities) add(e, rp.name, rowTo(copy(rp.cond), { kind: "name", name: snake(e), pos: rp.pos }), rp.pos);
    }
  }
  // the policies themselves stay, for their names (skip policy) and what they cover; their conditions live on in
  // the permissions, so they are hidden from the passes that walk every expression
  for (const rp of rps) Object.defineProperty(rp, "cond", { value: rp.cond, enumerable: false });
  for (const [e, ps] of parts) {
    const cond = ps.map((p) => p.cond).filter((c, i, all) => !isTrue(c) || all.every(isTrue) && i === 0).reduce(and);
    decls.push({ kind: "permission", name: e, entity: e, cond, pos: ps[0].pos, parts: ps, policies: ps.map((p) => p.policy) } as any);
  }
}

// the entities whose required references lead to c, each with its one shortest path (c itself: none)
function inside(c: string, ents: Map<string, any>, rp: any): Map<string, string[]> {
  const out = new Map<string, string[]>([[c, []]]);
  const refs = (e: string): [string, string][] => (ents.get(e)?.fields ?? []).filter((f: any) => f.type?.kind === "named" && !f.type.optional && ents.get(f.type.name)?.kind === "entity").map((f: any) => [f.name, f.type.name]);
  for (const [e, d] of ents) {
    if (e === c || d.kind !== "entity") continue;
    // breadth first: every path of the shortest length that reaches c
    let level: { at: string; path: string[] }[] = [{ at: e, path: [] }];
    const seen = new Set([e]);
    let found: string[][] = [];
    for (let depth = 0; depth < 6 && level.length && !found.length; depth++) {
      const nextLevel: { at: string; path: string[] }[] = [];
      const reached = new Set<string>();
      for (const { at, path } of level) for (const [f, t] of refs(at)) {
        if (t === c) found.push([...path, f]);
        else if (!seen.has(t)) { nextLevel.push({ at: t, path: [...path, f] }); reached.add(t); }
      }
      reached.forEach((t) => seen.add(t));
      level = nextLevel;
    }
    if (found.length > 1) throw new SpecError("ROWS_IN_AMBIGUOUS", `policy ${rp.name} is for rows in ${c}, and ${e} reaches a ${c} two ways: ${found.map((p) => `.${p.join(".")}`).join(" and ")}. Make one of the references optional, or give ${e} a policy of its own and leave it out of ${c} by making the path optional`, rp.pos);
    if (found.length) out.set(e, found[0]);
  }
  return out;
}

// ---- a parameter naming a row it may not: not_found where first used
function applyParamGuards(decls: Decl[], subsets: Map<string, Subset>): void {
  const perms = new Map(decls.filter((d) => d.kind === "permission").map((d) => [d.entity as string, d as any]));
  const rowPolicyNames = new Set(decls.filter((d) => d.kind === "rowpolicy").map((d) => d.name));
  if (!perms.size && !subsets.size) return;
  inlineFns = new Map(decls.filter((d) => d.kind === "fn" || d.kind === "predicate").map((d) => [d.name, d]));
  for (const site of decls as any[]) {
    if (!["action", "view", "screen", "channel", "signal"].includes(site.kind) || site.scheduled) continue;
    const skips: string[] = site.skips ?? [];
    const used = new Set<string>();
    const guards: { name: string; cond: Expr; from: string[]; pos: Pos }[] = [];
    for (const p of site.params ?? []) {
      if (p.type?.kind !== "named") continue;
      const by: Expr = { kind: "name", name: p.name, pos: p.pos };
      const conds: Expr[] = [], from: string[] = [];
      for (const part of perms.get(p.type.name)?.parts ?? []) {
        if (skips.includes(part.policy)) { used.add(part.policy); continue; }
        if (isTrue(part.cond)) continue;
        conds.push(subst(part.cond, snake(p.type.name), by)); from.push(`policy ${part.policy}`);
      }
      if (p.subset) { conds.push(rowTo(copy(subsets.get(p.subset)!.cond), by)); from.push(`subset ${p.subset}`); }
      if (!conds.length) continue;
      let cond = conds.reduce(and);
      if (p.type.optional) cond = { kind: "binary", op: "or", left: { kind: "binary", op: "==", left: by, right: { kind: "lit", value: null, pos: p.pos }, pos: p.pos }, right: cond, pos: p.pos };
      guards.push({ name: p.name, cond, from, pos: p.pos });
    }
    for (const s of skips) if (rowPolicyNames.has(s) && !used.has(s)) throw new SpecError("SKIP_UNNEEDED", `${site.kind} ${site.name} skips policy ${s}, but takes no row it covers`, site.pos);
    for (const g of guards) weave(site, g);
  }
}

// does a require's condition already say the guard (all of its parts among the require's)? Calls of the
// spec's own functions are read as their bodies first, so require mine(t) says t.board == actor when
// mine(t) is t.board == actor and actor != none
let inlineFns = new Map<string, any>();
export { subst as substName };
function inline(e: any, depth = 0): any {
  if (Array.isArray(e)) return e.map((x) => inline(x, depth));
  if (!e || typeof e !== "object") return e;
  const f = e.kind === "call" ? inlineFns.get(e.name) : undefined;
  if (f && depth < 6 && (f.params ?? []).length === (e.args ?? []).length && !Object.keys(e.named ?? {}).length) {
    let body = copy(f.body);
    // the arguments in for the parameters, all at once (a parameter named like another's argument stays apart)
    const tmp = f.params.map((_: any, i: number) => `\u0000${i}`);
    f.params.forEach((p: any, i: number) => { body = subst(body, p.name, { kind: "name", name: tmp[i], pos: e.pos }); });
    f.params.forEach((_: any, i: number) => { body = subst(body, tmp[i], inline(e.args[i], depth)); });
    return inline(body, depth + 1);
  }
  const o: any = {};
  for (const [k, v] of Object.entries(e)) o[k] = k === "pos" ? v : inline(v, depth);
  return o;
}
// (for the deep checks: does one condition say another, with the spec's functions read as their bodies)
export function impliesIn(decls: Decl[], cond: Expr, other: Expr): boolean {
  const keep = inlineFns;
  inlineFns = new Map(decls.filter((d) => d.kind === "fn" || d.kind === "predicate").map((d) => [d.name, d]));
  try { return isTrue(other) || says(cond, other); } finally { inlineFns = keep; }
}
const says = (cond: Expr, guard: Expr) => {
  const have = new Set([...conjuncts(cond), ...conjuncts(inline(cond))].map(keyOf));
  return have.has(keyOf(guard)) || have.has(keyOf(inline(guard))) || conjuncts(inline(guard)).every((g) => have.has(keyOf(g)));
};

function weave(site: any, g: { name: string; cond: Expr; from: string[]; pos: Pos }): void {
  const req = { kind: "require", cond: g.cond, outcome: "not_found", reason: undefined, pos: g.pos, fromPolicy: g.from.join(", ") };
  if (site.kind === "action") {
    const i = (site.body ?? []).findIndex((st: any) => mentions(st, g.name));
    if (i < 0) return;   // never used, so never resolved
    if (site.body[i].kind === "require" && says(site.body[i].cond, g.cond)) return;
    site.body.splice(i, 0, req);
    return;
  }
  if (site.kind === "view" || site.kind === "screen") {
    const rs: any[] = site.requires ?? (site.requires = []);
    const i = rs.findIndex((r) => mentions(r.cond, g.name));
    if (i >= 0 && says(rs[i].cond, g.cond)) return;
    const rest = { ...site, requires: undefined, params: undefined };
    if (i < 0 && !mentions(rest, g.name)) return;
    const { kind: _k, ...r } = req;
    rs.splice(i < 0 ? rs.length : i, 0, r);
    return;
  }
  // a channel's or signal's require: one condition, refused when false
  if (site.requires && says(site.requires, g.cond)) return;
  site.requires = site.requires ? and(g.cond, site.requires) : g.cond;
}

// ---- stamps: a field set by the compiler on each create (on create), or each create and change (on change)
type StampOf = { name: string; value: Expr; on: "create" | "change"; decl: any };
export function stampsByEntity(decls: Decl[]): Map<string, StampOf[]> {
  const out = new Map<string, StampOf[]>();
  const ents = decls.filter((d) => d.kind === "entity").map((d) => d.name);
  for (const s of decls.filter((d) => d.kind === "stamp") as any[]) for (const e of s.every ? ents : s.entities) {
    if (!out.has(e)) out.set(e, []);
    out.get(e)!.push({ name: s.name, value: s.value, on: s.on, decl: s });
  }
  return out;
}
function applyStamps(decls: Decl[]): void {
  const stamps = decls.filter((d) => d.kind === "stamp") as any[];
  if (!stamps.length) return;
  const ents = new Map(decls.filter((d) => ["entity", "singleton", "data"].includes(d.kind)).map((d) => [d.name, d as any]));
  for (const s of stamps) {
    if (!s.type.optional) throw new SpecError("STAMP_NOT_OPTIONAL", `stamp ${s.name}: ${s.type.name ?? "its type"} must be optional (${s.type.name}?): rows stored before the stamp, and writes with no one acting, have none`, s.pos);
    for (const e of s.entities) if (ents.get(e)?.kind !== "entity") throw new SpecError("UNKNOWN_ENTITY", `stamp ${s.name}: ${ents.has(e) ? `${e} isn't an entity` : `unknown entity ${e}`}`, s.pos);
  }
  const by = stampsByEntity(decls);
  for (const [e, ss] of by) {
    const d = ents.get(e)!;
    for (const [i, s] of ss.entries()) {
      if (ss.findIndex((t) => t.name === s.name) < i) throw new SpecError("STAMP_TWICE", `${e}.${s.name} is stamped twice (stamp ${s.name} at line ${ss.find((t) => t.name === s.name)!.decl.pos.line} and line ${s.decl.pos.line})`, s.decl.pos);
      if (d.fields.some((f: any) => f.name === s.name)) throw new SpecError("STAMP_FIELD_CLASH", `stamp ${s.name} is a field of ${e} the stamp adds, but ${e} declares ${s.name} already: leave it out of ${e}, or give the stamp another name`, s.decl.pos);
      const t = s.decl.type;
      d.fields.push({ name: s.name, type: copy(t), onDelete: t.kind === "named" && ents.get(t.name)?.kind === "entity" ? "nullify" : "restrict", touches: false, searchable: false, private: false, writeOnly: false, default: undefined, was: undefined, max: undefined, min: undefined, pos: s.decl.pos, stamped: true });
    }
  }
  weaveStamps(decls, by, ents);
}
// each create and change of a stamped entity's row sets its stamps; a statement of the spec's that sets one is refused
export function weaveStamps(decls: Decl[], by: Map<string, StampOf[]>, ents: Map<string, any>): void {
  const none: Expr = { kind: "lit", value: null, pos: { line: 0, col: 0 } };
  const keyOfT = (e: any) => JSON.stringify(e, (k, v) => (k === "pos" ? undefined : v));
  const valueFor = (s: StampOf, noActor: boolean) => (noActor ? subst(copy(s.value), "actor", none) : copy(s.value));
  const walk = (stmts: any[], env: Map<string, string>, noActor: boolean): any[] => {
    const out: any[] = [];
    for (let i = 0; i < (stmts ?? []).length; i++) {
      const st = stmts[i];
      out.push(st);
      if (st.kind === "create") {
        const ss = by.get(st.entity) ?? [];
        for (const s of ss) {
          if ((st.fields ?? []).some((f: any) => f.name === s.name)) throw new SpecError("STAMPED_SET", `${st.entity}.${s.name} is set by stamp ${s.name}, on every ${s.on === "create" ? "create" : "create and change"}, and by nothing else`, st.pos);
          st.fields.push({ name: s.name, value: valueFor(s, noActor), pos: st.pos });
        }
        if (ss.length) st.fromStamp = ss.map((s) => `stamp ${s.name}`).join(", ");
        if (st.as) env.set(st.as, st.entity);
      }
      if (st.kind === "let") { const en = entityOf(st.value, env, ents); if (en) env.set(st.name, en); }
      if (st.kind === "set" || st.kind === "touch") {
        const en = entityOf(st.target, env, ents);
        const ss = en ? by.get(en) ?? [] : [];
        if (st.kind === "set" && !st.fromStamp && ss.some((s) => s.name === st.name)) throw new SpecError("STAMPED_SET", `${en}.${st.name} is set by stamp ${st.name}, and by nothing else`, st.pos);
        const change = ss.filter((s) => s.on === "change");
        // once after a run of changes to the same row
        const nx = stmts[i + 1];
        const sameNext = nx && (nx.kind === "set" || nx.kind === "touch") && keyOfT(nx.target) === keyOfT(st.target);
        if (change.length && !sameNext) for (const s of change) out.push({ kind: "set", target: copy(st.target), name: s.name, value: valueFor(s, noActor), pos: st.pos, fromStamp: `stamp ${s.name}` });
      }
      if (st.kind === "foreach") { const e2 = new Map(env); if (st.bind) e2.set(st.bind, st.entity); st.body = walk(st.body, e2, noActor); }
      if (st.kind === "foreachList") st.body = walk(st.body, new Map(env), noActor);
      if (st.kind === "if") { st.then = walk(st.then, new Map(env), noActor); st.else = walk(st.else, new Map(env), noActor); }
    }
    return out;
  };
  const params = (ps: any[]) => new Map<string, string>((ps ?? []).filter((q) => q.type?.kind === "named" && ents.has(q.type.name)).map((q) => [q.name, q.type.name]));
  // a workflow's row: the entity of what the actions that start it emit (emit Pinged(n), n a Note)
  const emitted = new Map<string, string>();
  const findEmits = (stmts: any[], env: Map<string, string>) => { for (const st of stmts ?? []) {
    if (st.kind === "create" && st.as) env.set(st.as, st.entity);
    if (st.kind === "emit" && st.args?.[0]) { const en = entityOf(st.args[0], env, ents); if (en && !emitted.has(st.event)) emitted.set(st.event, en); }
    for (const k of ["then", "else", "body"]) if (Array.isArray(st[k])) findEmits(st[k], new Map(st.kind === "foreach" && st.bind ? [...env, [st.bind, st.entity]] : env));
  } };
  for (const d of decls as any[]) if (d.kind === "action" || d.kind === "trigger") findEmits(d.body, d.kind === "action" ? params(d.params) : new Map(d.on?.entity ? [[d.bind, d.on.entity]] : []));
  for (const d of decls as any[]) {
    if (d.kind === "action" && Array.isArray(d.body)) d.body = walk(d.body, params(d.params), !!d.scheduled);
    if (d.kind === "trigger" && Array.isArray(d.body)) d.body = walk(d.body, new Map(d.on?.entity ? [[d.bind, d.on.entity]] : []), false);
    if (d.kind === "workflow") for (const step of d.steps ?? []) if (Array.isArray(step.body)) step.body = walk(step.body, new Map(emitted.has(d.event) && d.bind ? [[d.bind, emitted.get(d.event)!]] : []), true);
  }
}

export function applyRules(decls: Decl[]): void {
  applyStamps(decls);
  const subsets = applySubsets(decls);
  applyRowPolicies(decls);
  // a policy for writes to an entity names its row .f and it, as a policy for rows does; the writes it is
  // woven into (writerule.ts) name it like the entity
  for (const w of decls as any[]) if (w.kind === "writepolicy") w.cond = rowTo(w.cond, { kind: "name", name: snake(w.entity), pos: w.pos });
  applyParamGuards(decls, subsets);
}
