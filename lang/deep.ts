// Deep checks: what the spec's connections imply, beyond names and types. Run by
// `node lang/cli.ts check <spec> --deep` (after the type pass) and by `cli build`. Every finding
// is a warning: each is a likely mistake, or a choice worth stating, not an error.
//   ENUM_VALUE_UNREACHABLE  an enum field can never hold a value: no default, create, set or
//                           migration gives it, or every transition into it starts from a value
//                           the field can never hold (transitions are read from the requires
//                           and ifs that guard each set)
//   WRITE_UNCHECKED         an action changes or deletes a row the caller chooses, and nothing
//                           before the write checks the actor
//   SIGNED_OUT_UNLIMITED    an action open to signed-out callers writes, with no rate limit
//   TRIGGER_CYCLE           triggers that can set each other off, round and round
//   DELETE_RESTRICTED       a delete that a restricting reference can refuse, with no check first
//   UNIQUE_UNGUARDED        a create of a uniquely keyed row from the caller's values, with no
//                           `ensure` and no check for an existing row first
import type { Decl, Expr, Spec, Stmt } from "./parser.ts";

export type DeepFinding = { severity: "warning"; code: string; line: number; message: string };

// every node under x (expressions and statements alike)
function nodes(x: any, out: any[] = []): any[] {
  if (!x || typeof x !== "object") return out;
  if (Array.isArray(x)) { for (const y of x) nodes(y, out); return out; }
  if (typeof x.kind === "string") out.push(x);
  for (const [k, v] of Object.entries(x)) if (k !== "pos") nodes(v, out);
  return out;
}

export function deepCheck(spec: Spec): DeepFinding[] {
  const found: DeepFinding[] = [];
  const warn = (code: string, line: number, message: string) => found.push({ severity: "warning", code, line, message });
  const decls = spec.decls;
  const of = (k: string) => decls.filter((d) => d.kind === k);
  const ents = new Map(decls.filter((d) => d.kind === "entity" || d.kind === "data").map((d) => [d.name, d]));
  const enums = new Map(of("enum").map((d) => [d.name, d.values as string[]]));
  const fnBodies = new Map([...of("fn"), ...of("predicate")].map((d) => [d.name, d.body]));
  const tname = (t: any) => (t?.kind === "named" ? t.name : undefined);
  // bodies that write: actions, triggers, workflows, migrations
  const bodies: { what: string; d: Decl; body: Stmt[]; params: Map<string, string> }[] = [
    ...of("action").map((d) => ({ what: `action ${d.name}`, d, body: d.body, params: new Map<string, string>(d.params.map((p: any) => [p.name, tname(p.type)])) })),
    ...of("trigger").map((d) => ({ what: `a trigger on ${d.on.kind} ${d.on.entity ?? d.on.event}`, d, body: d.body, params: new Map<string, string>([[d.bind, d.on.entity]]) })),
    ...of("workflow").flatMap((d) => (d.steps ?? [{ body: d.body }]).map((s: any) => ({ what: `workflow ${d.name}`, d, body: s.body ?? [], params: new Map<string, string>() }))),
    ...of("migration").map((d) => ({ what: `migration "${d.name}"`, d, body: d.body, params: new Map<string, string>() })),
  ];
  // the entity a name holds in a body: a parameter, a loop variable or a created row
  const entityNames = (b: (typeof bodies)[number]) => {
    const m = new Map(b.params);
    for (const n of nodes(b.body)) {
      if (n.kind === "foreach" && n.bind) m.set(n.bind, n.entity);
      if (n.kind === "create" && n.as) m.set(n.as, n.entity);
    }
    return m;
  };
  const entityOf = (e: Expr | undefined, names: Map<string, string>): string | undefined => {
    if (!e) return undefined;
    if (e.kind === "name") return names.get(e.name) ?? (ents.get(e.name)?.singleton ? e.name : undefined);
    if (e.kind === "field") { const t = entityOf(e.target, names); const f = t ? ents.get(t)?.fields.find((x: any) => x.name === e.name) : undefined; return f && ents.has(tname(f.type)) ? tname(f.type) : undefined; }
    return undefined;
  };
  // does a condition read the actor (directly, or through the functions and predicates it calls)?
  const readsActor = (x: any, seen = new Set<string>()): boolean => nodes(x).some((n) =>
    (n.kind === "name" && n.name === "actor") || n.kind === "actor" ||
    (n.kind === "call" && fnBodies.has(n.name) && !seen.has(n.name) && (seen.add(n.name), readsActor(fnBodies.get(n.name), seen))));
  // the statements before each statement in a body, with the conditions that guard it
  type At = { st: any; guards: Expr[] };
  const walk = (body: Stmt[], guards: Expr[] = [], out: At[] = []): At[] => {
    const gs = [...guards];
    for (const st of body as any[]) {
      out.push({ st, guards: [...gs] });
      if (st.kind === "require") gs.push(st.cond);
      if (st.kind === "if") { walk(st.then, [...gs, st.cond], out); if (st.else) walk(st.else, [...gs, { kind: "unary", op: "not", arg: st.cond } as any], out); }
      if (st.kind === "foreach" || st.kind === "foreachList") walk(st.body, [...gs, ...(st.where ? [st.where] : [])], out);
    }
    return out;
  };

  // ---- enum values a field can come to hold
  for (const [en, ent] of ents) {
    if (ent.kind !== "entity") continue;
    for (const f of ent.fields) {
      const values = enums.get(tname(f.type));
      if (!values) continue;
      const lit = (e: any): string | undefined => (e?.kind === "name" && values.includes(e.name) ? e.name : e?.kind === "lit" && values.includes(e.value) ? e.value : undefined);
      const start = new Set<string>(), edges: [string | "*", string][] = [];
      let any = false;
      if (f.default) { const v = lit(f.default); if (v) start.add(v); else any = true; }
      for (const b of bodies) {
        const names = entityNames(b);
        for (const { st, guards } of walk(b.body)) {
          if (st.kind === "create" && st.entity === en) {
            const a = st.fields.find((x: any) => x.name === f.name);
            if (a) { const v = lit(a.value); if (v) start.add(v); else any = true; }
          }
          if (st.kind === "set" && st.name === f.name && entityOf(st.target, names) === en) {
            const v = lit(st.value);
            if (!v) { any = true; continue; }
            // the values the guards allow it to come from: `x.f == v`, `x.f != v`, `x.f in [...]`
            let from: Set<string> | null = null;
            for (const g of guards) for (const n of nodes(g)) {
              if (n.kind !== "binary" || !["==", "!="].includes(n.op)) continue;
              const side = [n.left, n.right].find((s: any) => (s.kind === "field" || s.kind === "rowfield") && s.name === f.name);
              const val = lit(side === n.left ? n.right : n.left);
              if (!side || !val) continue;
              const allowed = n.op === "==" ? new Set([val]) : new Set(values.filter((x) => x !== val));
              from = from ? new Set([...from].filter((x) => allowed.has(x))) : allowed;
            }
            if (!from) edges.push(["*", v]); else for (const x of from) edges.push([x, v]);
          }
        }
      }
      if (any) continue;
      const reach = new Set(start);
      for (let changed = true; changed;) {
        changed = false;
        for (const [a, b] of edges) if ((a === "*" ? reach.size > 0 : reach.has(a)) && !reach.has(b)) { reach.add(b); changed = true; }
      }
      for (const v of values) if (!reach.has(v)) warn("ENUM_VALUE_UNREACHABLE", f.pos?.line ?? ent.pos.line, `${en}.${f.name} never holds ${v}: ${start.size ? `it starts as ${[...start].join(" or ")}` : "no create gives it a value"}${edges.some(([, b]) => b === v) ? `, and every set to ${v} is guarded by a value it never holds` : ` and nothing sets it to ${v}`}`);
    }
  }

  // ---- writes to rows the caller chooses, with no check of the actor first
  for (const a of of("action")) {
    if (a.internal) continue;
    const b = bodies.find((x) => x.d === a)!;
    const chosen = new Map(a.params.filter((p: any) => ents.get(tname(p.type))?.kind === "entity").map((p: any) => [p.name, tname(p.type)]));
    const reported = new Set<string>();
    for (const { st, guards } of walk(a.body)) {
      const target = st.kind === "set" || st.kind === "delete" || st.kind === "touch" ? st.target : undefined;
      if (!target) continue;
      // the row written: a parameter itself, or a row reached from one
      let root: any = target; while (root?.kind === "field") root = root.target;
      if (root?.kind !== "name" || !chosen.has(root.name)) continue;
      if (guards.some((g) => readsActor(g)) || reported.has(root.name)) continue;
      reported.add(root.name);
      warn("WRITE_UNCHECKED", st.pos?.line ?? a.pos.line, `${a.name} ${st.kind === "delete" ? "deletes" : "changes"} the ${chosen.get(root.name)} it is given (${root.name}) with no require on the actor before it: anyone who can call it can do this to any ${chosen.get(root.name)}`);
    }
  }

  // ---- signed-out callers, writing without a rate limit
  for (const a of of("action")) {
    if (a.internal || !(a.skips ?? []).includes("signed_in")) continue;
    const ns = nodes(a.body);
    if (ns.some((n) => n.kind === "rate_limit")) continue;
    if (!ns.some((n) => ["create", "set", "delete", "deleteWhere"].includes(n.kind))) continue;
    warn("SIGNED_OUT_UNLIMITED", a.pos.line, `${a.name} is open to signed-out callers and writes rows, but has no rate_limit`);
  }

  // ---- triggers setting each other off
  const triggers = of("trigger");
  const fires = (t: Decl): Set<number> => {
    const out = new Set<number>();
    const names = entityNames(bodies.find((x) => x.d === t)!);
    for (const n of nodes(t.body)) {
      const hit = (pred: (o: any) => boolean) => triggers.forEach((u, i) => { if (pred(u.on)) out.add(i); });
      if (n.kind === "create") hit((o) => o.kind === "create" && o.entity === n.entity);
      if (n.kind === "set") { const e = entityOf(n.target, names); hit((o) => o.kind === "update" && o.field === n.name && (!e || o.entity === e)); }
      if (n.kind === "delete") { const e = entityOf(n.target, names); hit((o) => o.kind === "delete" && (!e || o.entity === e)); }
      if (n.kind === "deleteWhere") hit((o) => o.kind === "delete" && o.entity === n.entity);
      if (n.kind === "emit") hit((o) => o.kind === "event" && o.event === n.event);
    }
    return out;
  };
  const edges = triggers.map(fires);
  const reported = new Set<string>();
  triggers.forEach((t, i) => {
    // a path back to i
    const prev = new Map<number, number>(), queue = [...edges[i]];
    for (const j of queue) if (!prev.has(j)) prev.set(j, i);
    for (let k = 0; k < queue.length; k++) {
      const j = queue[k];
      if (j === i) {
        const path = [i]; let x = prev.get(i)!; while (x !== i) { path.unshift(x); x = prev.get(x)!; } path.unshift(i);
        const key = [...new Set(path)].sort().join(",");
        if (!reported.has(key)) { reported.add(key); warn("TRIGGER_CYCLE", t.pos.line, `triggers can set each other off in a loop: ${path.map((p) => `line ${triggers[p].pos.line}`).join(" -> ")}; make sure a when condition stops it`); }
        break;
      }
      for (const n of edges[j]) if (!prev.has(n)) { prev.set(n, j); queue.push(n); }
    }
  });

  // ---- deletes a restricting reference can refuse
  const restricting = (e: string) => [...ents].filter(([, d]) => d.kind === "entity").flatMap(([n, d]) => d.fields.filter((f: any) => tname(f.type) === e && f.onDelete === "restrict").map((f: any) => `${n}.${f.name}`));
  for (const b of bodies) {
    const names = entityNames(b);
    for (const { st, guards } of walk(b.body)) {
      const e = st.kind === "delete" ? entityOf(st.target, names) : st.kind === "deleteWhere" ? st.entity : undefined;
      if (!e) continue;
      const refs = restricting(e);
      if (!refs.length) continue;
      const checked = refs.filter((r) => guards.some((g) => nodes(g).some((n) => (n.kind === "count" || n.kind === "exists" || n.kind === "listq" || n.kind === "query") && n.entity === r.split(".")[0])));
      // rows of the referring entity deleted first, in the same body, count as handled
      const cleared = refs.filter((r) => nodes(b.body).some((n) => n.kind === "deleteWhere" && n.entity === r.split(".")[0]));
      const open = refs.filter((r) => !checked.includes(r) && !cleared.includes(r));
      if (open.length) warn("DELETE_RESTRICTED", st.pos?.line ?? b.d.pos.line, `${b.what} deletes a ${e}, which ${open.join(", ")} restrict${open.length === 1 ? "s" : ""} (on delete restrict, the default): it is refused while such rows exist. Check first, or declare on delete cascade or nullify`);
    }
  }

  // ---- creates of uniquely keyed rows from the caller's values
  for (const a of of("action")) {
    const params = new Set(a.params.map((p: any) => p.name));
    for (const { st, guards } of walk(a.body)) {
      if (st.kind !== "create" || st.ensure) continue;
      const ent = ents.get(st.entity);
      for (const cols of ent?.uniques ?? []) {
        const given = cols.map((c: string) => st.fields.find((x: any) => x.name === c));
        if (given.some((g: any) => !g)) continue;
        if (!given.some((g: any) => nodes(g.value).some((n) => n.kind === "name" && params.has(n.name)))) continue;
        // handled: a check for existing rows first (of any entity: the spec may know that none
        // exist when another doesn't), or the old row deleted earlier in the body
        if (guards.some((g) => nodes(g).some((n) => n.kind === "count" || n.kind === "exists" || n.kind === "listq" || n.kind === "query" || (n.kind === "call" && (n.name === "exists" || n.name === "count"))))) continue;
        if (nodes(a.body).some((n) => n.kind === "deleteWhere" && n.entity === st.entity && (n.pos?.line ?? 0) <= (st.pos?.line ?? 0))) continue;
        warn("UNIQUE_UNGUARDED", st.pos?.line ?? a.pos.line, `${a.name} creates a ${st.entity} keyed (${cols.join(", ")}) from its arguments; a duplicate is refused as invalid. Use ensure, or check first if a duplicate should get its own outcome`);
      }
    }
  }
  return found;
}
