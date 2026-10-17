// The change report a reviewer of an agent's spec change needs, between two versions:
// - the migration plan's steps and the contract changes (schema.ts);
// - claims agents rely on that changed: callables added or removed, annotations, the
//   need for confirmation, new entities written, new externs reached (describe.ts);
// - behaviour, by bounded exploration over probe states (recorded from an app's
//   scenarios): every recorded call is replayed against both versions, by its own actor and
//   by every other actor in that state, and every row's read permission is evaluated for
//   every actor. A call or read refused before and allowed after is a *widening*; one
//   allowed before and refused after is a *narrowing*. Both are listed, with examples.
import type { Spec } from "./parser.ts";
import { Interpreter, Store, type Ref, type Request, type Row } from "./interp.ts";
import { diff, schemaOf, type Step, type Stored } from "./schema.ts";
import { describe, type Callable } from "./describe.ts";

export type Probe = { scenario: string; clock: number; state: { tables: [string, Row[]][]; nextId: [string, number][]; seq: number }; name: string; args: Record<string, unknown>; actor: Ref | null; request: Request; skips: string[] };
export type Finding = { kind: "call" | "view rows" | "read"; name: string; change: "widened" | "narrowed"; count: number; examples: string[] };
export type Report = { schema: Step[]; claims: string[]; behaviour: Finding[] | null; probes: number; runs: number; incomparable: number };

export const snapshot = (s: Store, clock: number) => ({ clock, state: { tables: [...s.tables].map(([k, rows]) => [k, rows.map((r) => ({ ...r, fields: { ...r.fields } }))] as [string, Row[]]), nextId: [...s.nextId], seq: s.seq } });
function restore(p: Probe["state"]): Store {
  const s = new Store();
  for (const [k, rows] of p.tables) s.tables.set(k, rows.map((r) => ({ ...r, fields: { ...r.fields } })));
  s.nextId = new Map(p.nextId); s.seq = p.seq;
  return s;
}

function claimsDiff(a: Callable[], b: Callable[]): string[] {
  const out: string[] = [];
  const A = new Map(a.map((c) => [c.name, c])), B = new Map(b.map((c) => [c.name, c]));
  for (const [n, c] of B) {
    const o = A.get(n);
    if (!o) { out.push(`new ${c.kind} ${n}: ${c.description}`); continue; }
    for (const k of Object.keys(c.annotations) as (keyof Callable["annotations"])[]) if (o.annotations[k] !== c.annotations[k]) out.push(`${n}: ${k} ${o.annotations[k]} -> ${c.annotations[k]}`);
    if (o.confirm !== c.confirm) out.push(`${n}: ${c.confirm ? "now needs confirmation (it deletes rows)" : "no longer needs confirmation"}`);
    const more = (x: string[], y: string[]) => y.filter((e) => !x.includes(e));
    for (const e of more(o.effects.deletes, c.effects.deletes)) out.push(`${n}: now deletes ${e}`);
    for (const e of more(o.effects.creates, c.effects.creates)) out.push(`${n}: now creates ${e}`);
    for (const [e, fs] of Object.entries(c.effects.updates)) for (const f of more(o.effects.updates[e] ?? [], fs)) out.push(`${n}: now updates ${e}.${f}`);
    for (const e of more(o.effects.externs, c.effects.externs)) out.push(`${n}: now calls ${e}`);
    if (!o.unavailable && c.unavailable) out.push(`${n}: no longer available to agents (${c.unavailable})`);
  }
  for (const [n, c] of A) if (!B.has(n)) out.push(`${c.kind} ${n} removed`);
  return out;
}

export function review(oldSpec: Spec, newSpec: Spec, oldSrc: string, newSrc: string, probes?: Probe[]): Report {
  const oldSchema = schemaOf(oldSpec);
  const stored: Stored = Object.fromEntries(Object.entries(oldSchema.entities).map(([e, d]) => [e, new Set(["id", "seq", "created", "updated", ...Object.keys(d.fields)])]));
  const schema = diff(oldSchema, newSpec, stored).filter((s) => !(s.op === "create_entity" && oldSchema.entities[s.entity!]));
  const claims = claimsDiff(describe(oldSpec, oldSrc).callables, describe(newSpec, newSrc).callables);
  if (!probes?.length) return { schema, claims, behaviour: null, probes: 0, runs: 0, incomparable: 0 };

  const A = new Interpreter(oldSpec), B = new Interpreter(newSpec);
  const actorEntity = A.actorEntity || B.actorEntity;
  const found = new Map<string, Finding>();
  const note = (kind: Finding["kind"], name: string, change: Finding["change"], example: string) => {
    const k = `${kind}|${name}|${change}`; const f = found.get(k) ?? { kind, name, change, count: 0, examples: [] };
    f.count++; if (f.examples.length < 3 && !f.examples.includes(example)) f.examples.push(example); found.set(k, f);
  };
  const who = (it: Interpreter, a: Ref | null) => { if (!a) return "an anonymous caller"; const r = it.store.find(a); const role = r?.fields.role ? ` (${r.fields.role})` : ""; return `${a.ref} ${a.id}${role}`; };
  let runs = 0, incomparable = 0;
  const runOn = (it: Interpreter, p: Probe, actor: Ref | null) => {
    it.store = restore(p.state); it.counters = new Map(); it.clock = p.clock;
    const request = { ...p.request, session_token: actor && p.actor && actor.id === p.actor.id ? p.request.session_token : undefined };
    try { return it.run(p.name, p.args, actor, request, p.skips); } catch { return null; }
  };
  const seenStates = new Set<string>();
  for (const p of probes) {
    const exists = (it: Interpreter, kind: string) => !!it.get(kind, p.name);
    const isView = exists(A, "view");
    if (!(exists(A, "action") || isView) || !(exists(B, "action") || exists(B, "view"))) continue;
    A.store = restore(p.state);
    const actors: (Ref | null)[] = [null, ...A.store.rows(actorEntity).map((r) => ({ ref: actorEntity, id: r.id }))];
    for (const actor of actors) {
      const a = runOn(A, p, actor), b = runOn(B, p, actor); runs += 2;
      if (!a || !b) { incomparable++; continue; }
      const ex = `${who(A, actor)}: ${p.name}(${JSON.stringify(p.args).slice(0, 120)}) was ${a.outcome}, now ${b.outcome}  [${p.scenario}]`;
      if (a.outcome !== "ok" && b.outcome === "ok") note("call", p.name, "widened", ex);
      if (a.outcome === "ok" && b.outcome !== "ok") note("call", p.name, "narrowed", ex);
      if (isView && a.outcome === "ok" && b.outcome === "ok" && a.rows && b.rows) {
        const ids = (rs: Ref[]) => new Set(rs.map((r) => `${r.ref}:${r.id}`));
        const ia = ids(a.rows), ib = ids(b.rows);
        const plus = [...ib].filter((x) => !ia.has(x)), minus = [...ia].filter((x) => !ib.has(x));
        if (plus.length) note("view rows", p.name, "widened", `${who(A, actor)} now also sees ${plus.slice(0, 5).join(", ")}  [${p.scenario}]`);
        if (minus.length) note("view rows", p.name, "narrowed", `${who(A, actor)} no longer sees ${minus.slice(0, 5).join(", ")}  [${p.scenario}]`);
      }
    }
    // read permissions, once per distinct state
    const key = `${p.scenario}|${p.state.seq}`;
    if (seenStates.has(key)) continue;
    seenStates.add(key);
    A.store = restore(p.state); B.store = restore(p.state);
    for (const [entity, condA] of A.permissions) {
      const condB = B.permissions.get(entity);
      for (const row of A.store.rows(entity)) for (const actor of actors) {
        const ev = (it: Interpreter, cond: any) => { if (!cond) return true; try { return it.truthy(it.eval(cond, { vars: new Map([[entity.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase(), { ref: entity, id: row.id }]]), actor, request: p.request, events: [], effects: [] } as any)); } catch { return null; } };
        const ra = ev(A, condA), rb = ev(B, condB); runs += 2;
        if (ra === null || rb === null) { incomparable++; continue; }
        if (!ra && rb) note("read", entity, "widened", `${who(A, actor)} can now read ${entity} ${row.id}  [${p.scenario}]`);
        if (ra && !rb) note("read", entity, "narrowed", `${who(A, actor)} can no longer read ${entity} ${row.id}  [${p.scenario}]`);
      }
    }
  }
  return { schema, claims, behaviour: [...found.values()].sort((x, y) => (x.change === y.change ? y.count - x.count : x.change === "widened" ? -1 : 1)), probes: probes.length, runs, incomparable };
}
