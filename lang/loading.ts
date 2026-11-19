// What a row has loaded (docs/design/explicit-loading.md): there is no lazy loading, so reading a
// field of a row the spec didn't load is an error, NOT_LOADED. A row is loaded when it is:
//   - what an action, screen, view, api, workflow or trigger is given (the one load with no query
//     written: it's in the signature), and actor;
//   - a row of a query (for each, a list, the, first_or_none, a view's rows);
//   - created here (create … as x).
// A row's reference is only its id; the referenced row is loaded when the query (or parameter)
// says with .ref. A fn or component says what it needs of a row (m: Message with .creator), and a
// call must give it. Inside a query form (where, order, a list's value, all's condition) a
// reference is the query's own (SQL), and a query function reads the database by its declaration.
import type { Spec } from "./parser.ts";
import type { Typed } from "./types.ts";

export type LoadFinding = { severity: "error"; code: string; message: string; line: number; col?: number; where: string };
// a loaded row: the references loaded with it, each a loaded row itself
type Shape = { paths: Map<string, Shape> };
// what a name holds: a row (null: an id only, not loaded) or a list of rows (each elem)
type Held = { row: Shape | null } | { elem: Shape | null };
type Env = Map<string, Held>;
type WithPath = { path: string[] };

const EMPTY = (): Shape => ({ paths: new Map() });
function shapeOfWith(w: WithPath[] | undefined): Shape {
  const s = EMPTY();
  for (const p of w ?? []) { let n = s; for (const f of p.path) { if (!n.paths.has(f)) n.paths.set(f, EMPTY()); n = n.paths.get(f)!; } }
  return s;
}
// what both have (a value that is one or the other has only what both have)
function both(a: Shape | null, b: Shape | null): Shape | null {
  if (!a || !b) return null;
  const out = EMPTY();
  for (const [k, v] of a.paths) if (b.paths.has(k)) { const m = both(v, b.paths.get(k)!); if (m) out.paths.set(k, m); }
  return out;
}
// the first path need has that have lacks ("by.org"), or null
function lacking(have: Shape, need: Shape, pre = ""): string | null {
  for (const [k, v] of need.paths) {
    const h = have.paths.get(k);
    if (!h) return pre + k;
    const deeper = lacking(h, v, pre + k + ".");
    if (deeper) return deeper;
  }
  return null;
}
const show = (s: string) => s.split(".").map((x) => "." + x).join("");

export function loadingFindings(spec: Spec, typed: Typed): LoadFinding[] {
  const out: LoadFinding[] = [];
  const decls = spec.decls as any[];
  const ents = new Map(decls.filter((d) => d.kind === "entity" || d.kind === "data").map((d) => [d.name, d]));
  const singletons = new Set(decls.filter((d) => d.kind === "singleton" || d.singleton).map((d) => d.name));
  // a subset's rows are its entity's (a parameter of a subset's type is a row of it)
  for (const d of decls.filter((d) => d.kind === "subset")) ents.set(d.name, d);
  const fns = new Map<string, any[]>();
  for (const d of decls) if (d.kind === "fn" || d.kind === "predicate") fns.set(d.name, [...(fns.get(d.name) ?? []), d]);
  const comps = new Map(decls.filter((d) => d.kind === "component").map((d) => [d.name, d]));
  const views = new Map(decls.filter((d) => d.kind === "view").map((d) => [d.name, d]));
  const isEnt = (t: any) => t?.kind === "named" && ents.has(t.name) && !singletons.has(t.name);
  // a data table's rows are the app's own, always there
  const inMemory = new Set(decls.filter((d) => d.kind === "data").map((d) => d.name));
  const refOf = (e: any): string | null => { const t: any = typed.types.get(e); return t?.k === "ref" && t.e && !singletons.has(t.e) && !inMemory.has(t.e) ? t.e : null; };
  let where = "";
  const err = (pos: any, message: string) => out.push({ severity: "error", code: "NOT_LOADED", message, line: pos?.line ?? 0, col: pos?.col, where });

  // what an expression's row has loaded (null: only its id)
  const fnResult = new Map<any, Shape | null>();
  function rowOf(e: any, env: Env): Shape | null {
    if (!e) return null;
    switch (e.kind) {
      case "name": { const h = env.get(e.name); return h && "row" in h ? h.row : null; }
      case "field": { const s = rowOf(e.target, env); return s?.paths.get(e.name) ?? null; }
      case "query": return ["the", "the_or_none", "first_or_none"].includes(e.op) ? shapeOfWith(e.with) : null;
      case "if": return both(rowOf(e.then, env), rowOf(e.else, env));
      case "call": {
        if (e.name === "default" && e.args?.length === 2) return both(rowOf(e.args[0], env), rowOf(e.args[1], env));
        if (e.name === "in_app" && e.args?.length === 1) return rowOf(e.args[0], env);
        // verify(User, token, …): the row the signed token names, looked up
        if (e.name === "verify" && e.args?.[0]?.kind === "name" && ents.has(e.args[0].name)) return EMPTY();
        const ds = fns.get(e.name);
        if (!ds || ds.length !== 1) return null;
        const d = ds[0];
        if (d.queries && !(d.body?.kind === "name" || d.body?.kind === "field")) return EMPTY();   // a query's row: loaded by it (only the row)
        // a fn's row is one of its arguments (or what they refer to): what the body gives, from
        // what its parameters declare
        if (fnResult.has(d)) return fnResult.get(d)!;
        fnResult.set(d, null);
        const penv: Env = new Map(d.params.map((p: any) => [p.name, { row: isEnt(p.type) ? shapeOfWith(p.with) : null }]));
        const r = rowOf(d.body, penv);
        fnResult.set(d, r);
        return r;
      }
    }
    return null;
  }
  // what each row of a list has loaded
  function elemOf(e: any, env: Env): Shape | null {
    if (!e) return null;
    if (e.kind === "listq" && (!e.map || e.map.kind === "it")) return shapeOfWith(e.with);
    // list(.user for Membership … with .user): each a user, loaded by the with
    if (e.kind === "listq" && e.map?.kind === "rowfield") return shapeOfWith(e.with).paths.get(e.map.name) ?? null;
    if (e.kind === "name") { const h = env.get(e.name); return h && "elem" in h ? h.elem : null; }
    if ((e.kind === "call" || e.kind === "ref") && views.get(e.name)?.rows) return shapeOfWith(views.get(e.name).rows.with);
    if (e.kind === "query" && !e.op) return shapeOfWith(e.with);   // <List of={Message where …}>
    if (e.entity && e.kind === "query" && e.op === "set") return null;
    return null;
  }
  // a call's arguments against what its parameters need of their rows
  function checkArgs(params: any[], args: any[], named: Record<string, any> | undefined, env: Env, callee: string) {
    params.forEach((p: any, i: number) => {
      if (!isEnt(p.type)) return;
      const a = i < args.length ? args[i] : named?.[p.name];
      if (!a || a.kind === "none" || (a.kind === "lit" && a.value === null)) return;
      const need = shapeOfWith(p.with), have = rowOf(a, env);
      if (!have) { if (p.with?.length || usesFields(callee)) err(a.pos, `${callee} reads ${p.name}'s fields, and the row given isn't loaded: pass a row a query loaded (or a parameter's), not a reference's id`); return; }
      const miss = lacking(have, need);
      if (miss) err(a.pos, `${callee} needs ${p.name} with ${show(miss)}, which the row given hasn't loaded: add with ${show(miss)} where it is loaded`);
    });
  }
  // whether a fn or component reads a field of a row parameter (else an id is enough)
  const reads = new Map<string, boolean>();
  function usesFields(name: string): boolean {
    if (reads.has(name)) return reads.get(name)!;
    reads.set(name, true);
    const d = comps.get(name) ?? fns.get(name)?.[0];
    const ps = new Set((d?.params ?? []).filter((p: any) => isEnt(p.type)).map((p: any) => p.name));
    let found = false;
    const look = (x: any) => { if (found || !x || typeof x !== "object") return; if (Array.isArray(x)) { x.forEach(look); return; } if (x.kind === "field" && x.target?.kind === "name" && ps.has(x.target.name) && x.name !== "id") { found = true; return; } for (const [k, v] of Object.entries(x)) if (k !== "pos") look(v); };
    look(d?.body);
    reads.set(name, found);
    return found;
  }

  function walk(x: any, env: Env): void {
    if (!x || typeof x !== "object") return;
    if (Array.isArray(x)) {
      const local: Env = new Map(env);
      for (const y of x) { walk(y, local); bind(y, local); }
      return;
    }
    switch (x.kind) {
      // inside a query form: the query's own (SQL); only its row-free arguments are the app's
      case "query": case "listq": case "all": return;
      case "field": {
        // .room.type: a field of the query's own row's reference, in a query's where (SQL)
        if (x.target?.kind === "rowfield" || x.target?.kind === "it") return;
        const ent = refOf(x.target);
        if (ent && x.name !== "id" && !rowOf(x.target, env)) {
          const tgt = x.target;
          const via = tgt.kind === "field" ? `${describe(tgt.target)}.${tgt.name}` : describe(tgt);
          err(x.pos, tgt.kind === "field"
            ? `${via}.${x.name} reads ${tgt.name}, which isn't loaded: add with .${tgt.name} where ${describe(tgt.target)} is loaded (its query, or its parameter)`
            : `${via}.${x.name} reads a row that isn't loaded (${via} is only an id here): load it with a query, or a with where it comes from`);
        }
        walk(x.target, env);
        return;
      }
      case "call": {
        const ds = fns.get(x.name);
        if (ds?.length === 1) checkArgs(ds[0].params, x.args ?? [], x.named, env, x.name);
        walk(x.args, env); walk(x.named, env);
        return;
      }
      case "foreach": walk(x.body, new Map(env).set(x.bind, { row: shapeOfWith(x.with) })); return;
      case "foreachList": walk(x.over, env); walk(x.body, new Map(env).set(x.bind, { row: elemOf(x.over, env) })); return;
      case "el": {
        if (x.name === "list" && x.head?.bind) {
          walk(x.head.source?.args, env); walk(x.head.source?.named, env);
          const src = x.head.source;
          const elem = src?.kind === "ref" ? elemOf({ kind: "call", name: src.name }, env) : src?.kind === "query" ? shapeOfWith(src.with) : elemOf(src, env);
          walk(x.attrs, env);
          walk(x.children, new Map(env).set(x.head.bind, { row: elem }));
          walk(x.else, env);
          return;
        }
        // {for each u in list(…) { … }} in markup
        if (x.name === "each" && x.head?.bind) { walk(x.head.over, env); walk(x.attrs, env); walk(x.children, new Map(env).set(x.head.bind, { row: elemOf(x.head.over, env) })); walk(x.else, env); return; }
        if (x.name === "use" && comps.has(x.head?.name)) { const c = comps.get(x.head.name); checkArgs(c.params, x.head.args ?? [], x.head.named, env, x.head.name); }
        break;
      }
    }
    // a where or an order (delete … where, set … where, a view's): SQL
    for (const [k, v] of Object.entries(x)) if (k !== "pos" && !(x.kind && (k === "where" || k === "order"))) walk(v, env);
  }
  // a block's names, for what comes after them
  function bind(st: any, env: Env) {
    if (!st || typeof st !== "object") return;
    if (st.kind === "let" && typeof st.name === "string") {
      const r = rowOf(st.value, env), el = elemOf(st.value, env);
      env.set(st.name, el ? { elem: el } : { row: r });
    }
    if (st.kind === "create" && st.as) env.set(st.as, { row: EMPTY() });
  }
  const describe = (e: any): string => (e?.kind === "name" ? e.name : e?.kind === "field" ? `${describe(e.target)}.${e.name}` : "the row");

  // each with names references: .room.owner is Message's room, then that room's owner
  const entOf = (n: string) => { const d = ents.get(n); return d?.kind === "subset" ? d.entity : n; };
  const checkWith = (ent: string | undefined, ws: any[] | undefined, at: string) => {
    for (const w of ws ?? []) {
      let e = ent ? entOf(ent) : undefined;
      for (const f of w.path) {
        const fd = e ? ents.get(e)?.fields?.find((x: any) => x.name === f) : undefined;
        const next = fd?.type?.kind === "named" && ents.has(fd.type.name) ? entOf(fd.type.name) : undefined;
        if (!next) { out.push({ severity: "error", code: "WITH_UNKNOWN", message: `with ${show(w.path.join("."))}: ${e ?? "it"} has no reference ${f}${at}`, line: w.pos?.line ?? 0, col: w.pos?.col, where: at.trim() }); break; }
        e = next;
      }
    }
  };
  const visitWith = (x: any, ctxEnt?: string): void => {
    if (!x || typeof x !== "object") return;
    if (Array.isArray(x)) { x.forEach((y) => visitWith(y, ctxEnt)); return; }
    if (x.with && (x.entity || x.kind === "foreach")) checkWith(x.entity, x.with, "");
    if (x.params) for (const p of x.params) if (p.with) checkWith(p.type?.name, p.with, ` (parameter ${p.name})`);
    for (const [k, v] of Object.entries(x)) if (k !== "pos" && k !== "with") visitWith(v);
  };
  visitWith(decls);
  for (const w of decls.filter((d) => d.kind === "workflow" && d.bindWith)) {
    const ev = decls.find((d) => (d.kind === "signal" || d.kind === "channel") && d.name === w.event);
    const t = ev?.params?.[0]?.type?.name;
    if (t) checkWith(t, w.bindWith, ` (${w.name})`);
  }
  if (out.some((f) => f.code === "WITH_UNKNOWN")) return out;

  // each declaration, with what it is given loaded
  for (const d of decls) {
    if (!["action", "screen", "view", "component", "layout", "fn", "predicate", "api", "workflow", "trigger"].includes(d.kind)) continue;
    where = `${d.kind} ${d.name ?? ""}`.trim();
    const env: Env = new Map();
    env.set("actor", { row: EMPTY() });
    for (const p of d.params ?? []) if (isEnt(p.type)) env.set(p.name, { row: shapeOfWith(p.with) });
    // a trigger's row (on create Room as r), a workflow's (after commit on E(x)): given, so loaded
    if (d.bind) env.set(d.bind, { row: shapeOfWith(d.bindWith) });
    const { rows: _rows, ...rest } = d;   // a view's rows are its query
    walk(rest, env);
  }
  return out;
}
