// Deep checks: what the spec's connections imply, beyond names and types. Run by
// `node lang/cli.ts check <spec> --deep` (after the type pass) and by `cli build`. Every finding
// is a warning: each is a likely mistake, or a choice worth stating, not an error.
//   ENUM_VALUE_UNREACHABLE  an enum field can never hold a value: no default, create, set or
//                           migration gives it, or every transition into it starts from a value
//                           the field can never hold (transitions are read from the requires
//                           and ifs that guard each set)
//   WRITE_UNCHECKED         an action changes or deletes a row the caller chooses, and nothing
//                           before the write checks the actor
//   GUARD_MISSING           an action leaves out a check on who acts that every other action
//                           doing the same to a row of that entity (three or more) makes
//   SIGNED_OUT_UNLIMITED    an action open to signed-out callers writes, with no rate limit
//   TRIGGER_CYCLE           triggers that can set each other off, round and round
//   DELETE_RESTRICTED       a delete that a restricting reference can refuse, with no check first
//   UNIQUE_UNGUARDED        a create of a uniquely keyed row from the caller's values, with no
//                           `ensure` and no check for an existing row first
//   THE_NOT_UNIQUE          `the()` or `the_or_none()` query whose condition doesn't guarantee
//                           a unique key match: can fail at runtime with more than one row
//   FIELD_NEVER_READ        a field is written in creates/sets but never read in any expression
//   FIELD_READ_NEVER_SET    a field is read, but nothing sets it: it always holds its default, or none
//   FIELD_NEVER_WRITTEN     a field nothing reads or sets
//   WRITE_ONLY_READ         (an error) a field declared write_only is read somewhere: remove write_only, or the read
//   WORKFLOW_STALE_CHECK    a workflow step acts on a row whose field the emitting action set, without
//                           reading it again, though another body can change it meanwhile
//   LINK_NOT_ALLOWED        a link to a screen whose require on the viewer isn't known where the link is
//   SCREEN_UNREACHABLE      a screen no chain of links reaches from home, sign-in, setup, or mail and the like
//   OUTCOME_UNHANDLED       a form or button handles some outcomes with <on>, but not one that what
//                           is entered can bring about (a require on a field, a unique key unchecked)
import type { Decl, Expr, Spec, Stmt } from "./parser.ts";
import { typecheck } from "./types.ts";

export type DeepFinding = { severity: "warning" | "error"; code: string; line: number; message: string };

// every form and button that calls an action, with the outcomes its <on> handlers take: a form's
// are its children, a button's the <on>s right after it (as the generator reads them)
export type CallSite = { action: string; where: string; line: number; handled: Set<string>; bound: Set<string> };
export function callSites(spec: Spec): CallSite[] {
  const out: CallSite[] = [];
  const walk = (els: any[], where: string) => {
    if (!Array.isArray(els)) return;
    for (let i = 0; i < els.length; i++) {
      const el = els[i];
      if (!el || typeof el !== "object") continue;
      if ((el.name === "form" || el.name === "button") && (el.head?.kind === "call" || el.head?.kind === "ref")) {
        const hs: any[] = el.name === "form" ? (el.children ?? []).filter((c: any) => c?.name === "on") : [];
        if (el.name === "button") for (let j = i + 1; els[j]?.name === "on"; j++) hs.push(els[j]);
        // the parameters the call gives (in order, or by name): the rest are the form's fields
        const act = spec.decls.find((x) => x.kind === "action" && x.name === el.head.name);
        const bound = new Set<string>([...(act?.params ?? []).slice(0, el.head.args?.length ?? 0).map((p: any) => p.name), ...Object.keys(el.head.named ?? {})]);
        out.push({ action: el.head.name, where: `${where} (line ${el.pos.line})`, line: el.pos.line, handled: new Set(hs.map((h) => h.head?.outcome)), bound });
      }
      walk(el.children, where); walk(el.else, where);
    }
  };
  for (const d of spec.decls) if (d.kind === "screen" || d.kind === "component" || d.kind === "layout") walk(d.body, `${d.kind} ${d.name}`);
  return out;
}
// the outcomes a call site's fields can bring about: a require or reject that depends on what the
// person entered, and invalid from a create or set that puts it in a unique key with no check for
// an existing row first (as UNIQUE_UNGUARDED). Outcomes about the row or who acts come from the
// screen's context, which shows the form only where it applies; sizes are kept by the form itself;
// a gate's apply to every action alike
const LOOKS = new Set(["count", "exists", "listq", "query"]);
export function inputOutcomes(spec: Spec, d: Decl, bound: Set<string>): string[] {
  const out = new Set<string>();
  const input = new Set<string>(d.params.map((p: any) => p.name).filter((n: string) => !bound.has(n)));
  const reads = (x: any) => nodes(x).some((n) => n.kind === "name" && input.has(n.name));
  const keyed = (en: string, f: string) => spec.decls.some((e) => e.kind === "entity" && e.name === en && (e.uniques ?? []).some((u: string[]) => u.includes(f)));
  const looked = (guards: any[]) => guards.some((g) => nodes(g).some((n) => LOOKS.has(n.kind) || (n.kind === "call" && (n.name === "exists" || n.name === "count"))));
  const walk = (ss: any[], inputGuard: boolean, guards: any[]) => {
    guards = [...guards];
    for (const x of ss ?? []) {
      if (!x || typeof x !== "object") continue;
      if (x.kind === "let" && reads(x.value)) input.add(x.name);
      if (x.kind === "require") { if (reads(x.cond)) out.add(x.outcome); guards.push(x.cond); }
      if (x.kind === "reject" && inputGuard) out.add(x.outcome);
      if (x.kind === "create" && !x.ensure && !looked(guards)) for (const f of x.fields ?? []) if (reads(f.value) && keyed(x.entity, f.name)) out.add("invalid");
      if (x.kind === "set" && reads(x.value) && !looked(guards) && spec.decls.some((e) => e.kind === "entity" && keyed(e.name, x.name))) out.add("invalid");
      if (x.kind === "if") { const g = inputGuard || reads(x.cond); walk(x.then, g, [...guards, x.cond]); walk(x.else, g, [...guards, x.cond]); }
      if (x.kind === "foreach" || x.kind === "foreachList") walk(x.body, inputGuard || reads(x.where ?? x.over), guards);
    }
  };
  walk(d.body, false, []);
  return [...out];
}

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

  // fields declared `write_only`: the spec says nothing reads them; WRITE_ONLY_READ below verifies it
  const writeOnlyFields = new Set<string>();
  for (const [en, ent] of ents) {
    if (ent.kind === "entity") {
      for (const f of ent.fields) {
        if (f.writeOnly) {
          writeOnlyFields.add(`${en}.${f.name}`);
        }
      }
    }
  }
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

  // ---- the() and the_or_none() queries that don't pin a unique key
  const pinsKey = (whereExpr: any, entityName: string, uniqueKeys: string[][]): boolean => {
    if (!whereExpr) return false;
    // Collect all equality comparisons
    const equals = new Map<string, boolean>(); // field -> is pinned
    for (const n of nodes(whereExpr)) {
      if (n.kind === "binary" && n.op === "==") {
        const fieldNode = (n.left?.kind === "rowfield" || n.left?.kind === "field") ? n.left : (n.right?.kind === "rowfield" || n.right?.kind === "field") ? n.right : null;
        if (fieldNode && fieldNode.name) {
          equals.set(fieldNode.name, true);
        }
      }
    }
    // Check if all columns of any unique key are pinned
    for (const cols of uniqueKeys) {
      if (cols.every((c) => equals.has(c))) return true;
    }
    // Check if id is pinned
    if (equals.has("id")) return true;
    return false;
  };

  for (const b of bodies) {
    for (const n of nodes(b.body)) {
      if (n.kind === "query" && ["the", "the_or_none"].includes(n.op)) {
        const ent = ents.get(n.entity);
        if (!ent || ent.singleton) continue; // Singletons always have exactly one row
        if (!pinsKey(n.where, n.entity, ent.uniques ?? [])) {
          warn("THE_NOT_UNIQUE", n.pos?.line, `${n.op}(${n.entity} where …) condition doesn't pin a unique key or id: can fail at runtime with more than one match`);
        }
      }
    }
  }

  // Note: identity where clauses don't need to pin a unique key, because identities are keyed
  // by their source (param, cookie, token, etc.), not by the where clause alone.

  // ---- Comprehensive field use table: reads and writes from all sources
  const typed = typecheck(spec);  // Get reads from types.ts (screens, components, actions, permissions, views, functions, predicates, etc.)
  const allReads = new Map<string, boolean>(typed.reads.get("__all__") ? Array.from(typed.reads.entries()).flatMap(([, fields]) => Array.from(fields).map((f) => [f, true] as [string, boolean])) : []);

  // Flatten all reads from all sources
  for (const [source, fields] of typed.reads) {
    for (const field of fields) {
      allReads.set(field, true);
    }
  }

  // Track writes: defaults, creates, sets, migrations, and implicit runtime writes
  const allWrites = new Map<string, boolean>();

  // Runtime fields are implicitly written
  for (const [en] of ents) {
    allWrites.set(`${en}.id`, true);
    allWrites.set(`${en}.created`, true);
    allWrites.set(`${en}.updated`, true);
  }


  // Creates write their fields
  for (const b of bodies) {
    for (const n of nodes(b.body)) {
      if (n.kind === "create") {
        for (const f of n.fields ?? []) {
          allWrites.set(`${n.entity}.${f.name}`, true);
        }
      }
      if (n.kind === "set") {
        // the target's entity as the type pass found it (actor, a parameter, a let); else by name
        const t: any = typed.types.get(n.target);
        const ent = t?.k === "ref" ? t.e : entityOf(n.target, entityNames(b));
        if (ent) {
          allWrites.set(`${ent}.${n.name}`, true);
          allWrites.set(`${ent}.updated`, true);  // set implies updated
        }
      }
      if (n.kind === "touch") {
        // the target's entity as the type pass found it (actor, a parameter, a let); else by name
        const t: any = typed.types.get(n.target);
        const ent = t?.k === "ref" ? t.e : entityOf(n.target, entityNames(b));
        if (ent) {
          allWrites.set(`${ent}.updated`, true);
        }
      }
    }
  }

  // Exports and APIs read all fields
  for (const exp of of("export")) {
    if (exp.entity) {
      for (const f of ents.get(exp.entity)?.fields ?? []) {
        allReads.set(`${exp.entity}.${f.name}`, true);
      }
    }
  }
  for (const api of of("api")) {
    if (api.entity) {
      for (const f of ents.get(api.entity)?.fields ?? []) {
        allReads.set(`${api.entity}.${f.name}`, true);
      }
    }
  }

  // ---- FIELD_NEVER_READ: written but never read
  for (const [en, ent] of ents) {
    if (ent.kind !== "entity") continue;
    for (const f of ent.fields) {
      const key = `${en}.${f.name}`;
      const hasWrite = allWrites.has(key);
      const hasRead = allReads.has(key);
      // the runtime's own fields, and fields the spec declares write_only (verified below)
      const isWriteOnly = ["id", "created", "updated"].includes(f.name) ||
                          writeOnlyFields.has(key);
      if (hasWrite && !hasRead && !isWriteOnly) {
        warn("FIELD_NEVER_READ", f.pos?.line ?? ent.pos.line, `${en}.${f.name} is written but never read: dead data or incomplete feature`);
      }
    }
  }

  // ---- WRITE_ONLY_READ (an error): `write_only` says the app writes a field and never reads it; a read
  // makes that claim false, so the marker would hide what the field is used for
  for (const [en, ent] of ents) {
    for (const f of ent.fields ?? []) {
      const key = `${en}.${f.name}`;
      if (!writeOnlyFields.has(key) || !allReads.has(key)) continue;
      const where = [...typed.reads].filter(([, fs]) => fs.has(key)).map(([src]) => src);
      found.push({ severity: "error", code: "WRITE_ONLY_READ", line: f.pos?.line ?? ent.pos.line, message: `${key} is marked write_only, but ${where.length ? where.slice(0, 3).join(", ") + (where.length > 3 ? ` and ${where.length - 3} more` : "") : "the app"} read${where.length === 1 ? "s" : ""} it: remove write_only, or the read` });
    }
  }

  // ---- FIELD_READ_NEVER_SET and FIELD_NEVER_WRITTEN: nothing sets the field (no create gives it,
  // no set, touch or migration writes it), so it always holds its default, or none. Read, that is
  // a check or a display that can never change: a missing write, or a field not needed
  const readers = (key: string) => [...typed.reads].filter(([src, fs]) => src !== "__all__" && fs.has(key)).map(([src]) => src);
  for (const [en, ent] of ents) {
    if (ent.kind !== "entity") continue;
    for (const f of ent.fields) {
      const key = `${en}.${f.name}`;
      if (["id", "created", "updated"].includes(f.name) || allWrites.has(key)) continue;
      const optional = f.type.kind === "named" && f.type.optional;
      if (!f.default && !optional) continue;   // a required field nothing gives: the type pass's to report
      // a default worked out for each row (token(24), now) gives each row its own value
      if (f.default && nodes(f.default).some((n) => n.kind === "now" || n.kind === "call")) continue;
      const always = f.default ? "it always holds its default" : "it is always none";
      const line = f.pos?.line ?? ent.pos.line;
      if (allReads.has(key)) {
        const where = readers(key);
        warn("FIELD_READ_NEVER_SET", line, `${key} is read${where.length ? ` by ${where.slice(0, 3).join(", ")}${where.length > 3 ? ` and ${where.length - 3} more` : ""}` : ""}, but nothing sets it: ${always}. Set it somewhere, or drop the field and its reads`);
      } else warn("FIELD_NEVER_WRITTEN", line, `${key} is never written${f.default ? " after its default" : ""}: ${always}`);
    }
  }

  // ---- OUTCOME_UNHANDLED: a form or button that handles some of its action's outcomes with <on>
  // but not one its fields can bring about (inputOutcomes); that one gets the default (back, with the outcome's text)
  // while the others get what the author wrote. One with no <on> at all leaves them all to the default
  const actionDecls = new Map(of("action").map((d) => [d.name, d]));
  for (const c of callSites(spec)) {
    const d = actionDecls.get(c.action);
    if (!d || ![...c.handled].some((o) => o !== "ok")) continue;
    const missing = inputOutcomes(spec, d, c.bound).filter((o) => o !== "ok" && !c.handled.has(o));
    if (missing.length) warn("OUTCOME_UNHANDLED", c.line, `${c.where} calls ${c.action} and handles ${[...c.handled].join(", ")}, but not ${missing.join(", ")}, which what is entered can bring about: ${missing.length > 1 ? "those get" : "it gets"} the default (back, with the outcome's text)`);
  }

  // ---- WORKFLOW_STALE_CHECK: an action makes a fact about a row (sets its field), then emits an
  // event with the row: the event says it happened. (A require on the row before is often a guard
  // the workflow doesn't rely on, so only what the action set counts); the workflow runs later, in its own
  // transaction. A step that acts (writes, mails, calls out) without reading that field again
  // acts on what was true then: another body can have changed the field in between
  const externEffect = new Map(of("extern").map((d) => [d.name, d.effect]));
  const acts = (ss: any[]) => nodes(ss).some((n) => ["create", "set", "delete", "deleteWhere", "sendmail"].includes(n.kind) || (n.kind === "extern" && !["pure", "fetch"].includes(externEffect.get(n.name) ?? "")));
  const setsOf = (b: (typeof bodies)[number]) => {
    const names = entityNames(b), out = new Set<string>();
    for (const n of nodes(b.body)) if (n.kind === "set") { const t: any = typed.types.get(n.target); const e = t?.k === "ref" ? t.e : entityOf(n.target, names); if (e) out.add(`${e}.${n.name}`); }
    return out;
  };
  const bodySets = bodies.map((b) => ({ b, sets: setsOf(b) }));
  const fieldsOn = (x: any, v: string) => nodes(x).filter((n) => n.kind === "field" && n.target?.kind === "name" && n.target.name === v).map((n) => n.name as string);
  for (const b of bodies) {
    if (b.d.kind === "workflow") continue;
    const names = entityNames(b);
    for (const { st, guards } of walk(b.body)) {
      if (st.kind !== "emit" || st.args?.[0]?.kind !== "name") continue;
      const v = st.args[0].name, ent = names.get(v);
      if (!ent) continue;
      // what the body knows of the row when it emits: the fields its checks read, and the ones it set
      const facts = new Map<string, string>();
      for (const { st: x } of walk(b.body)) { if (x === st) break; if (x.kind === "set" && x.target?.kind === "name" && x.target.name === v) facts.set(x.name, `set to ${x.value?.kind === "name" ? x.value.name : "a value"}`); }
      for (const w of of("workflow").filter((w) => w.event === st.event)) {
        for (const step of w.steps ?? []) {
          if (!acts(step.body)) continue;
          const reread = new Set(fieldsOn(step.body, w.bind));
          for (const [f, how] of facts) {
            if (reread.has(f)) continue;
            const others = bodySets.filter((o) => o.b !== b && o.b.d !== w && o.sets.has(`${ent}.${f}`)).map((o) => o.b.what);
            if (!others.length) continue;
            warn("WORKFLOW_STALE_CHECK", step.body[0]?.pos?.line ?? w.pos.line, `${w.name}, step ${step.name}, acts on ${w.bind} later, after ${b.what} ${how === "checked" ? `checked ${v}.${f}` : `set ${v}.${f} ${how.replace("set ", "")}`} and emitted ${st.event}; ${others.slice(0, 2).join(" or ")}${others.length > 2 ? ` (and ${others.length - 2} more)` : ""} can change ${f} before the step runs. Read ${w.bind}.${f} in the step to check it still holds`);
          }
        }
      }
    }
  }

  // ---- LINK_NOT_ALLOWED: a link to a screen that refuses whoever follows it. A screen's require on
  // who views it (it reads the actor, and none of the screen's parameters), with an outcome (not a
  // go elsewhere), must be known where the link is: in the linking screen's own requires, an if
  // around the link, or, in a component or layout, the requires of every screen that shows it
  const screens = new Map(of("screen").map((d) => [d.name, d]));
  const canon = (x: any) => JSON.stringify(x, (k, v) => (k === "pos" ? undefined : v));
  const conj = (x: any): any[] => (x?.kind === "binary" && x.op === "and" ? [...conj(x.left), ...conj(x.right)] : x ? [x] : []);
  const paramNames = (d: Decl) => new Set<string>((d.params ?? []).map((p: any) => p.name));
  const needs = (t: Decl) => (t.requires ?? []).filter((r: any) => r.outcome && readsActor(r.cond)).flatMap((r: any) => conj(r.cond).filter((c) => readsActor(c) && !nodes(c).some((n) => n.kind === "name" && paramNames(t).has(n.name))).map((c) => ({ c, outcome: r.outcome })));
  const ownFacts = (d: Decl) => new Map<string, any>((d.requires ?? []).flatMap((r: any) => conj(r.cond)).map((c: any) => [canon(c), c]));
  // the facts every screen that shows a component or layout knows (none known: no screen shows it)
  const shows = (body: any, name: string) => nodes(body).some((n) => n.kind === "el" && (n.name === name || (n.name === "use" && n.head?.name === name)));
  const users = (name: string) => of("screen").filter((sc) => sc.layout === name || shows(sc.body, name));
  const declFacts = (d: Decl, seen = new Set<string>()): Map<string, any> => {
    if (d.kind === "screen") return ownFacts(d);
    if (seen.has(d.name)) return new Map();
    seen.add(d.name);
    const us = [...users(d.name), ...of("component").filter((c) => c !== d && shows(c.body, d.name))];
    if (!us.length) return new Map([["__unshown", true]]);
    const sets = us.map((u) => declFacts(u, seen));
    return new Map([...sets[0]].filter(([k]) => sets.every((x) => x.has(k))));
  };
  // a predicate or function call, as its body with the arguments put in (a few levels deep)
  const preds = new Map([...of("predicate"), ...of("fn")].map((d) => [d.name, d]));
  const inline = (x: any, depth = 0): any => {
    if (!x || typeof x !== "object") return x;
    if (Array.isArray(x)) return x.map((y) => inline(y, depth));
    if (x.kind === "call" && preds.has(x.name) && depth < 4) {
      const d: any = preds.get(x.name);
      const env = new Map<string, any>(d.params.map((p: any, i: number) => [p.name, x.args?.[i] ?? x.named?.[p.name] ?? { kind: "lit", value: null }]));
      const sub = (y: any): any => (!y || typeof y !== "object" ? y : Array.isArray(y) ? y.map(sub) : y.kind === "name" && env.has(y.name) ? env.get(y.name) : Object.fromEntries(Object.entries(y).map(([k, v]) => [k, k === "pos" ? v : sub(v)])));
      return inline(sub(d.body), depth + 1);
    }
    return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, k === "pos" ? v : inline(v, depth)]));
  };
  const disj = (x: any): any[] => (x?.kind === "binary" && x.op === "or" ? [...disj(x.left), ...disj(x.right)] : [x]);
  // a fact known where the link is covers a need: the same condition, or one of the need's or-branches
  const covers = (facts: any[], need: any) => {
    const n = inline(need), alts = new Set(disj(n).map(canon));
    return facts.some((f) => { const g = inline(f); return canon(g) === canon(n) || alts.has(canon(g)) || conj(g).some((h) => canon(h) === canon(n) || alts.has(canon(h))); });
  };
  const show = (x: any): string => {
    if (!x) return "?";
    switch (x.kind) {
      case "name": return x.name;
      case "lit": return x.value === null ? "none" : typeof x.value === "string" ? JSON.stringify(x.value) : String(x.value);
      case "field": return `${show(x.target)}.${x.name}`;
      case "rowfield": return `.${x.name}`;
      case "call": return `${x.name}(${(x.args ?? []).map(show).join(", ")})`;
      case "unary": return `${x.op} ${show(x.arg)}`;
      case "binary": return `${show(x.left)} ${x.op} ${show(x.right)}`;
      case "none": return "none";
      default: return x.kind;
    }
  };
  for (const d of [...of("screen"), ...of("component"), ...of("layout")]) {
    const base = declFacts(d);
    if (base.has("__unshown")) continue;   // no screen shows it: no one follows its links
    const visit = (els: any[], facts: Map<string, any>) => {
      for (const el of els ?? []) {
        if (!el || typeof el !== "object") continue;
        if (el.name === "if") {
          visit(el.children, new Map([...facts, ...conj(el.head).map((c: any) => [canon(c), c] as [string, any])]));
          visit(el.else, facts);
          continue;
        }
        // a link's target: its head (<Link to={…}> is read into it), or a to= or go= attribute
        const targets: any[] = [...(el.head?.kind === "ref" ? [el.head] : []), ...Object.entries(el.attrs ?? {}).filter(([k]) => ["to", "go"].includes(k)).map(([, v]) => v)];
        for (const tgt of targets) {
          const t = (tgt?.kind === "call" || tgt?.kind === "name" || tgt?.kind === "ref") ? screens.get(tgt.name) : undefined;
          if (!t || t === d) continue;
          const missing = needs(t).filter(({ c }) => !covers([...facts.values()], c));
          if (missing.length) warn("LINK_NOT_ALLOWED", el.pos?.line ?? d.pos.line, `${d.kind} ${d.name} links to screen ${t.name}, which needs ${missing.map(({ c, outcome }) => `${show(c)} (else ${outcome})`).join(" and ")}, but shows the link to anyone who can see ${d.kind === "screen" ? "it" : "where it is used"}: put it in if ${missing.map(({ c }) => show(c)).join(" and ")} { … }, or require it of the ${d.kind}`);
        }
        visit(el.children, facts); visit(el.else, facts);
      }
    };
    visit(d.body, base);
  }

  // ---- SCREEN_UNREACHABLE: a screen no chain of links reaches. It starts from the screen at "/"
  // (home), the app's sign_in and setup screens, and every screen named outside the UI (a mail, a
  // push's url_of, an action, a view); a screen reaches what it, its layout and the components it
  // shows name. One nothing reaches is opened only by its address typed in: dead, or a missing link
  const uiKinds = new Set(["screen", "component", "layout"]);
  const named = (x: any) => new Set(nodes(x).filter((n) => (n.kind === "ref" || n.kind === "call" || n.kind === "name") && screens.has(n.name)).map((n) => n.name as string));
  const comps = new Map([...of("component"), ...of("layout")].map((d) => [d.name, d]));
  const shown = (body: any) => nodes(body).filter((n) => n.kind === "el").map((n) => (n.name === "use" ? n.head?.name : n.name)).filter((n) => comps.has(n));
  const reachFrom = (d: Decl, seen = new Set<string>()): Set<string> => {
    const out = named([d.body, d.requires]);
    const inner = [...shown(d.body), ...(d.layout ? [d.layout] : [])];
    for (const c of inner) if (!seen.has(c) && comps.has(c)) { seen.add(c); for (const n of reachFrom(comps.get(c)!, seen)) out.add(n); }
    return out;
  };
  const appDecl = decls.find((d) => d.kind === "app");
  const roots = new Set<string>([
    ...of("screen").filter((sc) => sc.route === "/").map((sc) => sc.name),
    ...["sign_in", "setup"].map((k) => appDecl?.props?.[k]?.name).filter((n): n is string => !!n && screens.has(n)),
    ...decls.filter((d) => !uiKinds.has(d.kind)).flatMap((d) => [...named(d)]),
  ]);
  // home (go={home}) is the screen at "/"
  const reached = new Set<string>(), queue = [...roots];
  while (queue.length) {
    const n = queue.pop()!;
    if (reached.has(n)) continue;
    reached.add(n);
    for (const m of reachFrom(screens.get(n)!)) if (!reached.has(m)) queue.push(m);
  }
  // (the scaffold's screens, under /_auto, are opened by their address: that is what they are for)
  for (const sc of of("screen")) if (!reached.has(sc.name) && !sc.file && !String(sc.route ?? "").startsWith("/_auto")) warn("SCREEN_UNREACHABLE", sc.pos.line, `screen ${sc.name} (${sc.route}) is linked from no screen that can be reached (from ${[...roots].length ? "home, sign-in, setup and what mail, actions and workflows name" : "home"}): only its address typed in opens it. Link to it, or remove it`);

  // ---- GUARD_MISSING: actions that do the same to a row they're given (change or delete it; or
  // add rows to it, rows that point to it) check the same things about who acts, on it
  // (member(actor, room), can_administer(actor, room.creator)). With three or more such actions,
  // one that leaves out a check every other one makes is likely missing it, unless it says it is
  // a case of its own, with a condition on the row no other makes (room.type == direct)
  {
    const SAME = "\u0000row";   // the row the action is given, whatever its parameter is called
    const keyOf = (c: any, p: string) => JSON.stringify(c, (k, v) => (k === "pos" ? undefined : v?.kind === "name" && v.name === p ? { kind: "name", name: SAME } : v));
    const rootName = (t: any) => { while (t?.kind === "field") t = t.target; return t?.kind === "name" ? t.name : undefined; };
    // what an action does to the row a parameter names: changes it, or adds to it
    // (a write only under an if on who acts, if actor.role == customer { … }, is checked there: a
    // case of its own, so it doesn't count)
    const does = (a: Decl, p: string): string[] => {
      const out = new Set<string>();
      const visit = (ss: any[]) => { for (const n of ss ?? []) {
        if ((n.kind === "set" || n.kind === "delete" || n.kind === "touch") && rootName(n.target) === p) out.add("changes");
        if (n.kind === "create" && n.fields.some((f: any) => f.value?.kind === "name" && f.value.name === p)) out.add("adds to");
        if (n.kind === "if" && !readsActor(n.cond)) { visit(n.then); visit(n.else); }
        if (n.kind === "foreach" || n.kind === "foreachList") visit(n.body);
      } };
      visit(a.body);
      return [...out];
    };
    const groups = new Map<string, { a: Decl; p: string; checks: Map<string, any>; conds: Set<string> }[]>();
    for (const a of of("action")) {
      if (a.internal) continue;
      for (const p of a.params) {
        const e = tname(p.type);
        if (ents.get(e)?.kind !== "entity") continue;
        // the checks on who acts: on the row (member(actor, room)), or on the actor alone
        // (actor.role == staff), which no parameter is in
        const checks = new Map<string, any>(), conds = new Set<string>(), names = new Set(a.params.map((q: any) => q.name));
        for (const st of nodes(a.body)) if (st.kind === "require")
          for (const c of conj(st.cond)) {
            const onRow = nodes(c).some((n) => n.kind === "name" && n.name === p.name);
            if (onRow) conds.add(keyOf(c, p.name));
            if (readsActor(c) && (onRow || !nodes(c).some((n) => n.kind === "name" && names.has(n.name)))) checks.set(keyOf(c, p.name), c);
          }
        for (const what of does(a, p.name)) groups.set(`${what} ${e}`, [...(groups.get(`${what} ${e}`) ?? []), { a, p: p.name, checks, conds }]);
      }
    }
    for (const [g, all] of groups) {
      // a case of its own is left out of the comparison, both ways
      const own = (x: (typeof all)[number]) => [...x.conds].some((k) => !all.some((y) => y !== x && y.conds.has(k)));
      const list = all.filter((x) => !own(x));
      if (list.length < 3) continue;
      const [what, e] = [g.slice(0, g.lastIndexOf(" ")), g.slice(g.lastIndexOf(" ") + 1)];
      for (const x of list) {
        const others = list.filter((y) => y !== x);
        for (const k of others[0].checks.keys()) {
          if (x.checks.has(k) || !others.every((y) => y.checks.has(k))) continue;
          const c = JSON.parse(k.split(JSON.stringify(SAME)).join(JSON.stringify(x.p)));
          warn("GUARD_MISSING", x.a.pos.line, `${x.a.name} ${what === "changes" ? "changes" : "adds to"} the ${e} it is given (${x.p}) without checking ${show(c)}, which the ${others.length} other actions that ${what === "changes" ? "change" : "add to"} a ${e} check (${others.slice(0, 3).map((y) => y.a.name).join(", ")}${others.length > 3 ? ", …" : ""}): add require ${show(c)} else …, if it applies here too`);
        }
      }
    }
  }

  return found;
}
