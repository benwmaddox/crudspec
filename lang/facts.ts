// Facts: what each declaration of a spec reads, writes, creates, deletes, emits and uses, worked
// out once, as plain lists. The checks, the generator, the change review and the invariant prover
// ask questions of these lists instead of walking the spec themselves, so they agree on what a
// declaration reads, uses and sets off.
//   reads    by, field ("Room.name"), via     via: expr (the type pass's), export, api (every field)
//   writes   by, field, how                   how: create, set, set? (the row's entity not known:
//                                             each entity with a field of that name), touch,
//                                             runtime (id, created, updated)
//   creates  by, entity        deletes  by, entity ("" when the row's entity isn't known)
//   emits    by, event         uses     by, to (a fn, predicate, view, component or layout)
// A declaration is named by an id: "action post", "screen room", "trigger on update Room.type"
// (with " #2" and on for a second trigger on the same thing), "workflow on E: step",
// "default Room.name", "invariant on Room" (an entity's invariants, together). Ids hold no lines, so they read the same in two
// versions of a spec (the change review compares them).
import type { Decl, Expr, Spec } from "./parser.ts";
import { typecheck, type Typed } from "./types.ts";

export type Body = { id: string; what: string; d: Decl; body: any[]; params: Map<string, string> };
export type Facts = {
  spec: Spec;
  typed: Typed;
  decl: Map<string, any>;                   // id -> the declaration (or the field, or the invariant)
  idOf: (d: any) => string;
  readers: string[];                        // the ids the type pass records reads for
  reads: { by: string; field: string; via: string }[];
  writes: { by: string; field: string; how: string }[];
  creates: { by: string; entity: string }[];
  deletes: { by: string; entity: string }[];
  emits: { by: string; event: string }[];
  uses: { by: string; to: string }[];
  triggers: { id: string; on: { kind: string; entity?: string; field?: string; event?: string } }[];
  bodies: Body[];                           // the bodies that change rows: actions, triggers, workflow steps, migrations
  ents: Map<string, any>;
  // the entity a name holds in a body (a parameter, a loop variable, a created row), and an
  // expression's entity (as the type pass found it, else by those names)
  entityNames: (b: Body) => Map<string, string>;
  entityOf: (e: Expr | undefined, names: Map<string, string>) => string | undefined;
};

// every node under x (expressions, statements and elements alike)
export function nodes(x: any, out: any[] = []): any[] {
  if (!x || typeof x !== "object") return out;
  if (Array.isArray(x)) { for (const y of x) nodes(y, out); return out; }
  if (typeof x.kind === "string") out.push(x);
  for (const [k, v] of Object.entries(x)) if (k !== "pos") nodes(v, out);
  return out;
}

// a declaration's id (F.idOf numbers a second trigger on the same thing)
export function idOf(d: any): string {
  if (d.kind === "trigger") return `trigger on ${d.on.kind} ${d.on.entity ?? d.on.event}${d.on.field ? `.${d.on.field}` : ""}`;
  if (d.kind === "workflow") return `workflow on ${d.event}`;
  return `${d.kind} ${d.name}`;
}
export const stepId = (w: any, step: any) => `workflow on ${w.event}: ${step.name}`;

const USED = new Set(["fn", "predicate", "view", "component", "layout"]);

export function facts(spec: Spec, typed: Typed = typecheck(spec)): Facts {
  const decls = spec.decls;
  const of = (k: string) => decls.filter((d) => d.kind === k);
  const ents = new Map(decls.filter((d) => d.kind === "entity" || d.kind === "data").map((d) => [d.name, d]));
  const tname = (t: any) => (t?.kind === "named" ? t.name : undefined);
  const ids = new Map<any, string>(), count = new Map<string, number>();
  for (const d of decls) { const id = idOf(d), n = (count.get(id) ?? 0) + 1; count.set(id, n); ids.set(d, n > 1 ? `${id} #${n}` : id); }
  const F: Facts = {
    spec, typed, decl: new Map(), idOf: (d) => ids.get(d) ?? idOf(d), readers: [], reads: [], writes: [], creates: [], deletes: [], emits: [], uses: [], triggers: [], bodies: [], ents,
    entityNames: (b) => {
      const m = new Map(b.params);
      for (const n of nodes(b.body)) {
        if (n.kind === "foreach" && n.bind) m.set(n.bind, n.entity);
        if (n.kind === "create" && n.as) m.set(n.as, n.entity);
      }
      return m;
    },
    entityOf: (e, names) => {
      if (!e) return undefined;
      const t: any = typed.types.get(e);
      if (t?.k === "ref") return t.e;
      if (e.kind === "name") return names.get(e.name) ?? (ents.get(e.name)?.singleton ? e.name : undefined);
      if (e.kind === "field") { const en = F.entityOf(e.target, names); const f = en ? ents.get(en)?.fields.find((x: any) => x.name === e.name) : undefined; return f && ents.has(tname(f.type)) ? tname(f.type) : undefined; }
      return undefined;
    },
  };
  for (const d of decls) F.decl.set(F.idOf(d), d);

  // ---- reads: the type pass's, by what makes them
  for (const [en, e] of ents) for (const f of e.fields ?? []) if (typed.byDecl.has(f)) F.decl.set(`default ${en}.${f.name}`, f);
  for (const [id, d] of F.decl) if (typed.byDecl.has(d)) { F.readers.push(id); for (const field of typed.byDecl.get(d)!) F.reads.push({ by: id, field, via: "expr" }); }
  // an entity's invariants, as one (so taking one out doesn't make the others look changed)
  for (const [en, e] of ents) if (e.invariants?.length) {
    F.readers.push(`invariant on ${en}`);
    for (const inv of e.invariants) for (const field of typed.byDecl.get(inv) ?? []) F.reads.push({ by: `invariant on ${en}`, field, via: "expr" });
  }
  // exports and APIs hand every field of their entity on
  for (const d of [...of("export"), ...of("api")]) if (d.entity)
    for (const f of ents.get(d.entity)?.fields ?? []) F.reads.push({ by: F.idOf(d), field: `${d.entity}.${f.name}`, via: d.kind });

  // ---- writes, creates, deletes, emits: the bodies that change rows
  F.bodies = [
    ...of("action").map((d) => ({ id: F.idOf(d), what: `action ${d.name}`, d, body: d.body, params: new Map<string, string>(d.params.map((p: any) => [p.name, tname(p.type)])) })),
    ...of("trigger").map((d) => ({ id: F.idOf(d), what: `a trigger on ${d.on.kind} ${d.on.entity ?? d.on.event}`, d, body: d.body, params: new Map<string, string>([[d.bind, d.on.entity]]) })),
    ...of("workflow").flatMap((d) => d.steps.map((s: any) => ({ id: stepId(d, s), what: `workflow ${d.name}`, d, body: s.body ?? [], params: new Map<string, string>() }))),
    ...of("migration").map((d) => ({ id: F.idOf(d), what: `migration "${d.name}"`, d, body: d.body, params: new Map<string, string>() })),
  ];
  for (const b of F.bodies) if (!F.decl.has(b.id)) F.decl.set(b.id, b.d);
  for (const [en] of ents) for (const f of ["id", "created", "updated"]) F.writes.push({ by: "runtime", field: `${en}.${f}`, how: "runtime" });
  for (const b of F.bodies) {
    const names = F.entityNames(b);
    for (const n of nodes(b.body)) {
      if (n.kind === "create") {
        F.creates.push({ by: b.id, entity: n.entity });
        for (const f of n.fields ?? []) F.writes.push({ by: b.id, field: `${n.entity}.${f.name}`, how: "create" });
      }
      if (n.kind === "set" && n.target) {
        const en = F.entityOf(n.target, names);
        // an entity not known here: every entity with a field of that name may be the one
        for (const e of en ? [en] : [...ents.keys()].filter((x) => ents.get(x).fields?.some((f: any) => f.name === n.name))) {
          F.writes.push({ by: b.id, field: `${e}.${n.name}`, how: en ? "set" : "set?" });
          F.writes.push({ by: b.id, field: `${e}.updated`, how: en ? "set" : "set?" });
        }
      }
      if (n.kind === "touch") { const en = F.entityOf(n.target, names); if (en) F.writes.push({ by: b.id, field: `${en}.updated`, how: "touch" }); }
      if (n.kind === "delete") F.deletes.push({ by: b.id, entity: F.entityOf(n.target, names) ?? "" });
      if (n.kind === "deleteWhere") F.deletes.push({ by: b.id, entity: n.entity });
      if (n.kind === "emit") F.emits.push({ by: b.id, event: n.event });
    }
  }
  for (const t of of("trigger")) F.triggers.push({ id: F.idOf(t), on: t.on });

  // ---- uses: the functions, predicates, views, components and layouts a declaration uses, by
  // the kind of node that names them: a call (a function, predicate or view), a ref or a list's
  // source (a view), a name the type pass found is a view, an element's head (a component), and
  // its layout. Any other name is something else: a variable, an enum value, an identity
  const named = new Map<string, Decl[]>();
  for (const d of decls) if (USED.has(d.kind)) (named.get(d.name) ?? named.set(d.name, []).get(d.name)!).push(d);
  const use = (from: string, self: any, name: string, kinds: string[]) => { for (const x of named.get(name) ?? []) if (x !== self && kinds.includes(x.kind)) F.uses.push({ by: from, to: F.idOf(x) }); };
  const usesIn = (id: string, d: any, top: any) => {
    const walk = (x: any, key: string): void => {
      if (!x || typeof x !== "object") return;
      if (Array.isArray(x)) { for (const y of x) walk(y, key); return; }
      if (x !== d && typeof x.name === "string") {
        if (x.kind === "call") use(id, d, x.name, ["fn", "predicate", "view"]);
        else if (x.kind === "ref" || x.kind === "view") use(id, d, x.name, ["view"]);
        else if (x.kind === "name" && (typed.types.get(x) as any)?.k === "reference") use(id, d, x.name, ["view"]);
        else if (x.kind === undefined && key === "head") use(id, d, x.name, ["component"]);
      }
      for (const [k, v] of Object.entries(x)) if (k !== "pos") walk(v, k);
    };
    walk(top, "");
  };
  for (const d of decls) {
    if (d.layout) use(F.idOf(d), d, d.layout, ["layout"]);
    usesIn(F.idOf(d), d, d);
    if (d.kind === "entity" || d.kind === "data") for (const inv of d.invariants ?? []) usesIn(`invariant on ${d.name}`, d, inv);
  }
  return F;
}

// ---- questions: each one a few lines over the lists

const group = <T,>(xs: T[], key: (x: T) => string): Map<string, T[]> => {
  const m = new Map<string, T[]>();
  for (const x of xs) (m.get(key(x)) ?? m.set(key(x), []).get(key(x))!).push(x);
  return m;
};

// everything a declaration uses, following the chain (a screen uses a component, which calls a
// function, which calls another): itself included. With kinds, only uses of those kinds are followed
export function reach(F: Facts, from: string, kinds?: string[]): Set<string> {
  const by = group(F.uses, (n) => n.by), out = new Set([from]), todo = [from];
  const follows = (to: string) => !kinds || kinds.includes(to.slice(0, to.indexOf(" ")));
  while (todo.length) for (const n of by.get(todo.pop()!) ?? []) if (!out.has(n.to) && follows(n.to)) { out.add(n.to); todo.push(n.to); }
  return out;
}

// the fields read by a declaration and by what it uses (of those kinds, as reach)
export function readsWithin(F: Facts, from: string, kinds?: string[]): Set<string> {
  const ids = reach(F, from, kinds);
  return new Set(F.reads.filter((r) => ids.has(r.by)).map((r) => r.field));
}

// the entities whose rows a delete of an entity's row also deletes (on delete cascade), and it
export function cascade(F: Facts, entity: string): Set<string> {
  const out = new Set([entity]), todo = [entity];
  while (todo.length) {
    const e = todo.pop()!;
    for (const [n, d] of F.ents) for (const f of d.fields ?? []) if (f.onDelete === "cascade" && f.type?.kind === "named" && f.type.name === e && !out.has(n)) { out.add(n); todo.push(n); }
  }
  return out;
}

// the triggers a body sets off directly: a create of the trigger's entity, a set of its field, a
// delete of its entity (or of a row that cascades to it), an emit of its event. A delete or a set
// whose entity isn't known may be of any entity
export function firesDirect(F: Facts, by: string): string[] {
  const made = new Set(F.creates.filter((c) => c.by === by).map((c) => c.entity));
  const sets = new Set(F.writes.filter((w) => w.by === by && (w.how === "set" || w.how === "set?")).map((w) => w.field));
  const dels = F.deletes.filter((d) => d.by === by);
  const deleted = new Set(dels.flatMap((d) => (d.entity ? [...cascade(F, d.entity)] : [])));
  const anyDelete = dels.some((d) => !d.entity);
  const events = new Set(F.emits.filter((e) => e.by === by).map((e) => e.event));
  return F.triggers.filter(({ on }) =>
    (on.kind === "create" && made.has(on.entity!)) ||
    (on.kind === "update" && sets.has(`${on.entity}.${on.field}`)) ||
    (on.kind === "delete" && (anyDelete || deleted.has(on.entity!))) ||
    (on.kind === "event" && events.has(on.event!))).map((t) => t.id);
}

// the triggers some bodies set off, and those they set off, and so on
export function fires(F: Facts, ...by: string[]): Set<string> {
  const out = new Set<string>(), todo = [...by];
  while (todo.length) for (const t of firesDirect(F, todo.pop()!)) if (!out.has(t)) { out.add(t); todo.push(t); }
  return out;
}

// trigger loops: a trigger that sets off, by a chain of triggers, itself. Each loop once, as the
// triggers in it, the first one again at the end
export function triggerLoops(F: Facts): string[][] {
  const out: string[][] = [], seen = new Set<string>();
  for (const { id } of F.triggers) {
    // the shortest chain from id back to id
    const prev = new Map<string, string>(), queue = [...firesDirect(F, id)];
    for (const t of queue) prev.set(t, id);
    for (let k = 0; k < queue.length; k++) {
      const t = queue[k];
      if (t === id) {
        const path = [id]; let x = prev.get(id)!; while (x !== id) { path.unshift(x); x = prev.get(x)!; } path.unshift(id);
        const key = [...new Set(path)].sort().join(",");
        if (!seen.has(key)) { seen.add(key); out.push(path); }
        break;
      }
      for (const n of firesDirect(F, t)) if (!prev.has(n)) { prev.set(n, t); queue.push(n); }
    }
  }
  return out;
}

// how each field is used: read and written, read only, written only, neither
export type FieldUse = { field: string; read: boolean; written: boolean; readers: string[] };
export function fieldUse(F: Facts): FieldUse[] {
  const readers = group(F.reads, (r) => r.field), writers = group(F.writes, (w) => w.field);
  const out: FieldUse[] = [];
  for (const [en, e] of F.ents) for (const f of e.fields ?? []) {
    const k = `${en}.${f.name}`;
    out.push({ field: k, read: readers.has(k), written: writers.has(k), readers: [...new Set((readers.get(k) ?? []).map((r) => r.by))] });
  }
  return out;
}

// the fields a screen's page reads: its own reads, and those of what it uses (and what that uses),
// and what every page reads (displays, avatars, read permissions, gates, identities, the theme,
// and what they use: a read permission that runs in Go reads the row as the page loaded it), and
// the name-like field an entity with no display shows. Entities a widget is given are read whole
// (its Go may read any field): they are in `whole`
export function screenReads(F: Facts, screen: string): { fields: Set<string>; whole: Set<string> } {
  const always = [...F.decl.keys()].filter((k) => /^(display|avatar|permission|gate|identity|theme) /.test(k));
  const ids = new Set<string>();
  for (const a of [screen, ...always]) for (const x of reach(F, a)) ids.add(x);
  const fields = new Set(F.reads.filter((r) => ids.has(r.by)).map((r) => r.field));
  const displayed = new Set(F.spec.decls.filter((d) => d.kind === "display").map((d) => d.entity));
  for (const [n, e] of F.ents) if (!displayed.has(n)) for (const f of ["name", "title", "label", "subject"]) if (e.fields.some((x: any) => x.name === f)) fields.add(`${n}.${f}`);
  const whole = new Set<string>();
  for (const id of reach(F, screen)) for (const n of nodes(F.decl.get(id))) if (n.kind === "el" && n.name === "widget")
    for (const a of [...(n.head?.args ?? []), ...Object.values(n.head?.named ?? {})]) { const t: any = F.typed.types.get(a as object); if (t?.k === "ref") whole.add(t.e); }
  return { fields, whole };
}
