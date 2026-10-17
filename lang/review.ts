// The change report a reviewer of an agent's spec change needs, between two versions:
// - the migration plan's steps and the contract changes (schema.ts);
// - claims agents rely on that changed: callables added or removed, annotations, the
//   need for confirmation, new entities written, new externs reached (describe.ts);
// - behaviour, by bounded exploration over probe states (recorded from an app's scenarios).
//   Each state is first migrated to the new spec (renames, defaults), as an upgrade would.
//   * every recorded call is replayed against both versions, by its own actor and by every
//     other actor, and as an agent too when either version has agent tokens;
//   * every new or changed action, and every new or changed value view, is also called with
//     arguments synthesized from each state (ids of the right kind, enum values, sample text);
//   * every row's read permission is evaluated for every actor, anonymous included.
//   A call, view row or read refused before and allowed after is *widened*; the reverse is
//   *narrowed*. Both are listed, with examples. This is a bounded search, not a proof.
import type { Spec, Decl } from "./parser.ts";
import { Interpreter, Store, type Ref, type Request, type Row } from "./interp.ts";
import { diff, schemaOf, type Step, type Stored } from "./schema.ts";
import { describe, type Callable } from "./describe.ts";

type State = { tables: [string, Row[]][]; nextId: [string, number][]; seq: number };
export type Probe = { scenario: string; clock: number; state: State; name: string; args: Record<string, unknown>; actor: Ref | null; request: Request; skips: string[] };
export type Finding = { kind: "call" | "new call" | "view rows" | "read"; name: string; change: "widened" | "narrowed"; count: number; examples: string[] };
export type Report = { schema: Step[]; claims: string[]; behaviour: Finding[] | null; probes: number; runs: number; incomparable: number };

export const snapshot = (s: Store, clock: number) => ({ clock, state: toState(s) });
const toState = (s: Store): State => ({ tables: [...s.tables].map(([k, rows]) => [k, rows.map((r) => ({ ...r, fields: { ...r.fields } }))] as [string, Row[]]), nextId: [...s.nextId], seq: s.seq });
function restore(p: State): Store {
  const s = new Store();
  for (const [k, rows] of p.tables) s.tables.set(k, rows.map((r) => ({ ...r, fields: { ...r.fields } })));
  s.nextId = new Map(p.nextId); s.seq = p.seq;
  return s;
}
const canon = (d: Decl | undefined) => (d ? JSON.stringify(d, (k, v) => (k === "pos" ? undefined : v)) : "");
const snake = (s: string) => s.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();

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

// A probe state moved to the new spec in memory, as an upgrade would move the data.
function migrate(s: Store, steps: Step[], B: Interpreter, clock: number): Store {
  const renames = new Map(steps.filter((x) => x.op === "rename_entity").map((x) => [x.from!, x.to!]));
  if (renames.size) {
    const fix = (v: any): any => {
      if (Array.isArray(v)) return v.map(fix);
      if (!v || typeof v !== "object") return v;
      const o: any = {}; for (const [k, x] of Object.entries(v)) o[k] = (k === "entity" || k === "ref") && typeof x === "string" && renames.has(x) ? renames.get(x) : fix(x);
      return o;
    };
    for (const [from, to] of renames) { s.tables.set(to, s.rows(from)); s.tables.delete(from); s.nextId.set(to, s.nextId.get(from) ?? 1); s.nextId.delete(from); }
    for (const rows of s.tables.values()) for (const r of rows) for (const k of Object.keys(r.fields)) r.fields[k] = fix(r.fields[k]);
  }
  for (const x of steps) {
    if (x.op === "rename_field") for (const r of s.rows(x.entity!)) { r.fields[x.to!] = r.fields[x.from!]; delete r.fields[x.from!]; }
    if (x.op === "drop_field") for (const r of s.rows(x.entity!)) delete r.fields[x.field!];
    if (x.op === "drop_entity") s.tables.delete(x.entity!);
    if (x.op === "rename_value") for (const [ename, ent] of B.entities) if (ent.kind === "entity") for (const f of ent.fields) if (f.type.kind === "named" && f.type.name === x.entity) for (const r of s.rows(ename)) if (r.fields[f.name] === x.from) r.fields[f.name] = x.to;
  }
  B.store = s; B.clock = clock;
  for (const x of steps.filter((x) => x.op === "add_field")) {
    const f = B.entities.get(x.entity!)!.fields.find((y: any) => y.name === x.field);
    for (const r of s.rows(x.entity!)) {
      if (f.default) { try { r.fields[f.name] = B.eval(f.default, { vars: new Map([["self", { ref: x.entity, id: r.id }]]), actor: null, request: { ip: "", method: "write", identity: "" }, events: [], effects: [], row: { entity: x.entity, row: r } } as any); } catch { r.fields[f.name] = null; } }
      else r.fields[f.name] = f.type.kind === "named" && f.type.name === "Int" && !f.type.optional ? 0 : null;
    }
  }
  return s;
}

export function review(oldSpec: Spec, newSpec: Spec, oldSrc: string, newSrc: string, probes?: Probe[]): Report {
  const oldSchema = schemaOf(oldSpec);
  const stored: Stored = Object.fromEntries(Object.entries(oldSchema.entities).map(([e, d]) => [e, new Set(["id", "seq", "created", "updated", ...Object.keys(d.fields)])]));
  const schema = diff(oldSchema, newSpec, stored).filter((s) => !(s.op === "create_entity" && oldSchema.entities[s.entity!]));
  const claims = claimsDiff(describe(oldSpec, oldSrc).callables, describe(newSpec, newSrc).callables);
  if (!probes?.length) return { schema, claims, behaviour: null, probes: 0, runs: 0, incomparable: 0 };

  const A = new Interpreter(oldSpec), B = new Interpreter(newSpec);
  const actorEntity = A.actorEntity || B.actorEntity;
  const entityTo = new Map(schema.filter((x) => x.op === "rename_entity").map((x) => [x.from!, x.to!]));
  const toNew = (e: string) => entityTo.get(e) ?? e;
  const agentIdentity = [...newSpec.decls, ...oldSpec.decls].find((d) => d.kind === "identity" && d.source === "token")?.name;
  const found = new Map<string, Finding>();
  const note = (kind: Finding["kind"], name: string, change: Finding["change"], example: string) => {
    const k = `${kind}|${name}|${change}`; const f = found.get(k) ?? { kind, name, change, count: 0, examples: [] };
    f.count++; if (f.examples.length < 3 && !f.examples.includes(example)) f.examples.push(example); found.set(k, f);
  };
  let runs = 0, incomparable = 0;

  // each distinct state, old and migrated
  const states = new Map<string, { old: State; next: State; clock: number; request: Request; scenario: string }>();
  const keyOf = (p: Probe) => `${p.scenario}|${p.state.seq}|${p.clock}`;
  for (const p of probes) {
    const k = keyOf(p); if (states.has(k)) continue;
    states.set(k, { old: p.state, next: toState(migrate(restore(p.state), schema, B, p.clock)), clock: p.clock, request: p.request, scenario: p.scenario });
  }
  const who = (st: State, a: Ref | null, identity: string) => {
    if (!a) return "an anonymous caller";
    const r = st.tables.find(([k]) => k === a.ref)?.[1].find((x) => x.id === a.id);
    return `${a.ref} ${a.id}${r?.fields.role ? ` (${r.fields.role})` : ""}${identity === agentIdentity ? " as an agent" : ""}`;
  };
  const run = (it: Interpreter, st: State, clock: number, name: string, args: any, actor: Ref | null, request: Request, skips: string[]) => {
    if (!it.get("action", name) && !it.get("view", name)) return { outcome: "absent" } as any;
    it.store = restore(st); it.counters = new Map(); it.clock = clock;
    try { return it.run(name, args, actor, request, skips); } catch { return null; }
  };
  const variants = (st: State, p: { actor: Ref | null; request: Request }) => {
    const actors: (Ref | null)[] = [null, ...(st.tables.find(([k]) => k === actorEntity)?.[1] ?? []).map((r) => ({ ref: actorEntity, id: r.id }))];
    const out: { actor: Ref | null; request: Request }[] = [];
    for (const actor of actors) {
      const own = !!actor && !!p.actor && actor.id === p.actor.id;
      out.push({ actor, request: { ...p.request, session_token: own ? p.request.session_token : undefined } });
      if (actor && agentIdentity && p.request.identity !== agentIdentity) out.push({ actor, request: { ...p.request, identity: agentIdentity, session_token: undefined } });
    }
    return out;
  };
  const compare = (kind: "call" | "new call", name: string, st: { old: State; next: State; clock: number; scenario: string }, args: any, v: { actor: Ref | null; request: Request }, skips: string[]) => {
    const a = run(A, st.old, st.clock, name, args, v.actor, v.request, skips);
    const b = run(B, st.next, st.clock, name, args, v.actor && { ref: toNew(v.actor.ref), id: v.actor.id }, v.request, skips); runs += 2;
    if (!a || !b) { incomparable++; return; }
    const ex = `${who(st.old, v.actor, v.request.identity)}: ${name}(${JSON.stringify(args).slice(0, 120)}) was ${a.outcome}, now ${b.outcome}  [${st.scenario}]`;
    if (a.outcome !== "ok" && b.outcome === "ok") note(kind, name, "widened", ex);
    if (a.outcome === "ok" && b.outcome !== "ok" && b.outcome !== "absent") note(kind, name, "narrowed", ex);
    if (a.outcome === "ok" && b.outcome === "ok" && a.rows && b.rows) {
      const ia = new Set(a.rows.map((r: Ref) => `${toNew(r.ref)}:${r.id}`)), ib = new Set(b.rows.map((r: Ref) => `${r.ref}:${r.id}`));
      const plus = [...ib].filter((x) => !ia.has(x)), minus = [...ia].filter((x) => !ib.has(x));
      if (plus.length) note("view rows", name, "widened", `${who(st.old, v.actor, v.request.identity)} now also sees ${plus.slice(0, 5).join(", ")}  [${st.scenario}]`);
      if (minus.length) note("view rows", name, "narrowed", `${who(st.old, v.actor, v.request.identity)} no longer sees ${minus.slice(0, 5).join(", ")}  [${st.scenario}]`);
    }
  };

  // 1. recorded calls, for every actor and identity
  for (const p of probes) {
    const st = states.get(keyOf(p))!;
    for (const v of variants(p.state, p)) compare("call", p.name, st, p.args, v, p.skips);
  }

  // 2. new or changed actions and value views, with synthesized arguments
  const changed = newSpec.decls.filter((d) => ((d.kind === "action" && !d.internal) || (d.kind === "view" && d.value)) && canon(d) !== canon(oldSpec.decls.find((o) => o.kind === d.kind && o.name === d.name)));
  const sample = [...states.values()].filter((_, i, all) => all.length <= 30 || i % Math.ceil(all.length / 30) === 0);
  for (const d of changed) {
    const isNew = !oldSpec.decls.some((o) => (o.kind === "action" || o.kind === "view") && o.name === d.name);
    for (const st of sample) {
      const next = restore(st.next);
      const choices = d.params.map((p: any): unknown[] => {
        const t = p.type, opt = t.kind === "named" && t.optional ? [null] : [];
        if (t.kind === "set") { const ids = next.rows(t.of).map((r) => r.id); return [ids.slice(0, 1), []]; }
        if (B.entities.has(t.name)) { const ids = next.rows(t.name).map((r) => r.id); const pick = [...new Set([ids[0], ids[Math.floor(ids.length / 2)], ids.at(-1)].filter((x) => x !== undefined))]; return pick.length ? pick : [...opt, 1]; }
        if (B.enums.has(t.name)) return B.enums.get(t.name)!.slice(0, 4);
        if (t.name === "Int") return [1];
        if (t.name === "Bool") return [true, false];
        if (t.name === "Email") return ["probe@example.test"];
        if (t.name === "Url") return ["https://example.com/"];
        if (t.name === "RichText") return [{ rich: "probe", mentions: [], embeds: [] }];
        if (t.name === "File") return [null];
        return ["probe", ...opt];
      });
      const combos: Record<string, unknown>[] = [];
      const total = choices.reduce((n: number, c: unknown[]) => n * Math.max(1, c.length), 1);
      for (let i = 0; i < Math.min(total, 12); i++) {
        let k = Math.floor((i * total) / Math.min(total, 12)); const args: Record<string, unknown> = {};
        d.params.forEach((p: any, j: number) => { const c = choices[j]; args[p.name] = c.length ? c[k % c.length] : null; k = Math.floor(k / Math.max(1, c.length)); });
        combos.push(args);
      }
      const base = { actor: null, request: { ...st.request, session_token: undefined } };
      for (const args of combos) for (const v of variants(st.old, base)) compare(isNew ? "new call" : "call", d.name, st, args, v, []);
    }
  }

  // 3. read permissions, row by row, for every actor
  for (const st of states.values()) {
    const actors: (Ref | null)[] = [null, ...(st.old.tables.find(([k]) => k === actorEntity)?.[1] ?? []).map((r) => ({ ref: actorEntity, id: r.id }))];
    A.store = restore(st.old); B.store = restore(st.next);
    for (const [entity, condA] of A.permissions) {
      const ne = toNew(entity), condB = B.permissions.get(ne);
      if (!B.entities.has(ne)) continue;
      for (const row of A.store.rows(entity)) for (const actor of actors) {
        const ev = (it: Interpreter, cond: any, e: string) => { if (!cond) return true; try { return it.truthy(it.eval(cond, { vars: new Map([[snake(e), { ref: e, id: row.id }]]), actor: actor && it === B ? { ref: toNew(actor.ref), id: actor.id } : actor, request: st.request, events: [], effects: [] } as any)); } catch { return null; } };
        const ra = ev(A, condA, entity), rb = ev(B, condB, ne); runs += 2;
        if (ra === null || rb === null) { incomparable++; continue; }
        if (!ra && rb) note("read", ne, "widened", `${who(st.old, actor, "")} can now read ${ne} ${row.id}  [${st.scenario}]`);
        if (ra && !rb) note("read", ne, "narrowed", `${who(st.old, actor, "")} can no longer read ${ne} ${row.id}  [${st.scenario}]`);
      }
    }
  }
  return { schema, claims, behaviour: [...found.values()].sort((x, y) => (x.change === y.change ? y.count - x.count : x.change === "widened" ? -1 : 1)), probes: probes.length, runs, incomparable };
}
