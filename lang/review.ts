// The change report a reviewer of an agent's spec change needs, between two versions:
// - the migration plan's steps and the contract changes (schema.ts);
// - claims agents rely on that changed: callables added or removed, annotations, the
//   need for confirmation, new entities written, new externs reached (describe.ts);
// - behaviour, by bounded exploration over probe states (recorded from an app's scenarios).
//   Each state is first moved to the new spec (renames, defaults), as an upgrade would.
//   * every recorded call is replayed against both versions, by its own actor and by every
//     other actor, and as an agent too when either version has agent tokens;
//   * every new or changed action, and every new or changed value view, is also called with
//     arguments synthesized from each state (ids of the right kind, enum values, sample text);
//   * every row's read permission is evaluated for every actor, anonymous included.
//   A call, view row or read refused before and allowed after is *widened*; the reverse is
//   *narrowed*. Both are listed, with examples. This is a bounded search, not a proof.
// The calls and reads run in the two versions' compiled apps (`app probe`, gogen/rt/probe.go),
// each call rolled back; nothing here evaluates the spec.
import type { Spec, Decl } from "./parser.ts";
import type { Ref, Row } from "./rows.ts";
import { diff, schemaOf, type Step, type Stored } from "./schema.ts";
import { describe, type Callable } from "./describe.ts";
import type { Program } from "./gogen/program.ts";
import { typecheck } from "./types.ts";
import { withGenerated } from "./scaffold.ts";
import { parse } from "./parser.ts";
import type { El } from "./parser.ts";

// Outcomes: what each action can now answer that it couldn't, and each form or button that
// calls it without an <on> for that outcome (it gets the default: the page again, with the error).
export function outcomesDiff(oldSpec: Spec, newSpec: Spec): string[] {
  const out: string[] = [];
  const A = new Map(describe(oldSpec).callables.map((c) => [c.name, c])), B = describe(newSpec).callables;
  const callers = new Map<string, { where: string; handled: Set<string> }[]>();
  const walk = (els: El[], where: string) => {
    for (const el of els ?? []) {
      if ((el.name === "form" || el.name === "button") && (el.head?.kind === "call" || el.head?.kind === "ref")) {
        const handled = new Set<string>((el.children ?? []).filter((c) => c.name === "on").map((c) => c.head.outcome));
        (callers.get(el.head.name) ?? callers.set(el.head.name, []).get(el.head.name)!).push({ where: `${where} (line ${el.pos.line})`, handled });
      }
      walk(el.children, where); if (el.else) walk(el.else, where);
    }
  };
  for (const d of newSpec.decls) if (d.kind === "screen" || d.kind === "component" || d.kind === "layout") walk(d.body, `${d.kind} ${d.name}`);
  for (const c of B) {
    const o = A.get(c.name);
    if (!o || c.kind !== "action") continue;
    const added = c.outcomes.filter((x) => !o.outcomes.includes(x)), gone = o.outcomes.filter((x) => !c.outcomes.includes(x));
    for (const x of added) {
      const bare = (callers.get(c.name) ?? []).filter((k) => !k.handled.has(x)).map((k) => k.where);
      out.push(`${c.name} can now answer ${x}${bare.length ? `; not handled by ${bare.join(", ")}` : ""}`);
    }
    for (const x of gone) out.push(`${c.name} no longer answers ${x}`);
  }
  return out;
}

// Exposure: the entity fields each screen and component reads, now and before; and the fields
// each view returns to agents and the API.
export function exposureDiff(oldSpec: Spec, newSpec: Spec): string[] {
  const reads = (sp: Spec) => typecheck(withGenerated(sp, parse)).reads;
  const ra = reads(oldSpec), rb = reads(newSpec);
  const out: string[] = [];
  for (const [d, fs] of rb) {
    const before = ra.get(d);
    if (!before) { if (fs.size) out.push(`new ${d} reads ${[...fs].sort().join(", ")}`); continue; }
    const plus = [...fs].filter((f) => !before.has(f)).sort(), minus = [...before].filter((f) => !fs.has(f)).sort();
    if (plus.length) out.push(`${d} now reads ${plus.join(", ")}`);
    if (minus.length) out.push(`${d} no longer reads ${minus.join(", ")}`);
  }
  const fieldsOf = (sp: Spec) => new Map(describe(sp).callables.filter((c) => c.returns && "fields" in c.returns).map((c) => [c.name, c.returns as { entity: string; fields: string[] }]));
  const va = fieldsOf(oldSpec), vb = fieldsOf(newSpec);
  for (const [n, r] of vb) {
    const o = va.get(n); if (!o) continue;
    const plus = r.fields.filter((f) => !o.fields.includes(f));
    if (plus.length) out.push(`view ${n} now returns ${plus.map((f) => `${r.entity}.${f}`).join(", ")} to agents and the API`);
  }
  return out;
}

// A new schedule with past_due fire runs at once, on deploy, for every row already due.
export function scheduleFirstRuns(oldSpec: Spec, newSpec: Spec, now: number, count: (sql: string) => number): string[] {
  const had = new Set(oldSpec.decls.filter((d) => d.kind === "schedule").map((d) => d.name));
  const out: string[] = [];
  for (const d of newSpec.decls as any[]) {
    if (d.kind !== "schedule" || had.has(d.name) || !d.entity) continue;
    let a = d.at, off = 0;
    if (a.kind === "binary" && (a.op === "+" || a.op === "-") && a.right.kind === "duration") { off = a.right.amount * ({ ms: 1, s: 1000, min: 60_000, h: 3_600_000, day: 86_400_000 } as any)[a.right.unit] * (a.op === "-" ? -1 : 1); a = a.left; }
    const col = a.name === "created" || a.name === "updated" ? `"${a.name}"` : `json_extract("${a.name}", '$.time')`;
    if (d.pastDue !== "fire") { out.push(`new schedule ${d.name}: past_due skip, so nothing runs on deploy`); continue; }
    try { out.push(`new schedule ${d.name}: runs at once for ${count(`SELECT count(*) FROM "${d.entity}" WHERE ${col} IS NOT NULL AND ${col} + ${off} <= ${now}`)} ${d.entity} row(s) already due (past_due fire)${d.where ? ", those its where admits" : ""}`); }
    catch { /* no table yet */ }
  }
  return out;
}

// Data at risk: for the steps that drop or check data, how many rows in a real database they touch.
export function dataAtRisk(steps: Step[], count: (sql: string) => number): string[] {
  const out: string[] = [];
  const q = (x: string) => `"${x.replace(/"/g, '""')}"`;
  for (const st of steps) {
    if (st.class === "safe" || !st.entity) continue;
    try {
      const n = st.field ? count(`SELECT count(*) FROM ${q(st.entity)} WHERE ${q(st.field)} IS NOT NULL AND ${q(st.field)} != ''`) : count(`SELECT count(*) FROM ${q(st.entity)}`);
      out.push(`${st.class} ${st.detail}: ${n} row(s) ${st.field ? `have ${st.entity}.${st.field} set` : `of ${st.entity}`}`);
    } catch { /* the table or column isn't there: nothing stored */ }
  }
  return out;
}

export type Request = { ip: string; method: "get" | "write"; identity: string; user_agent?: string; session_token?: string };
type State = { tables: [string, Row[]][]; nextId: [string, number][]; seq: number; counters?: [string, number[]][] };
export type Probe = { scenario: string; clock: number; state: State; name: string; args: Record<string, unknown>; actor: Ref | null; request: Request; skips: string[]; secret?: string };
export type Finding = { kind: "call" | "new call" | "view rows" | "read"; name: string; change: "widened" | "narrowed"; count: number; examples: string[] };
export type Report = { schema: Step[]; claims: string[]; outcomes: string[]; exposure: string[]; behaviour: Finding[] | null; probes: number; runs: number; incomparable: number };

const canon = (d: Decl | undefined) => (d ? JSON.stringify(d, (k, v) => (k === "pos" ? undefined : v)) : "");

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

// A probe state's rows moved to the new spec, as an upgrade moves the data; the new fields'
// defaults are filled in by the new app when it loads the state.
function migrate(st: State, steps: Step[], next: Spec): State {
  const tables = new Map(st.tables.map(([k, rows]) => [k, rows.map((r) => ({ ...r, fields: { ...r.fields } }))]));
  const rows = (e: string) => tables.get(e) ?? [];
  const renames = new Map(steps.filter((x) => x.op === "rename_entity").map((x) => [x.from!, x.to!]));
  if (renames.size) {
    const fix = (v: any): any => {
      if (Array.isArray(v)) return v.map(fix);
      if (!v || typeof v !== "object") return v;
      const o: any = {}; for (const [k, x] of Object.entries(v)) o[k] = (k === "entity" || k === "ref") && typeof x === "string" && renames.has(x) ? renames.get(x) : fix(x);
      return o;
    };
    for (const [from, to] of renames) { tables.set(to, rows(from)); tables.delete(from); }
    for (const rs of tables.values()) for (const r of rs) for (const k of Object.keys(r.fields)) r.fields[k] = fix(r.fields[k]);
  }
  const ents = next.decls.filter((d) => d.kind === "entity");
  for (const x of steps) {
    if (x.op === "rename_field") for (const r of rows(x.entity!)) { r.fields[x.to!] = r.fields[x.from!]; delete r.fields[x.from!]; }
    if (x.op === "drop_field") for (const r of rows(x.entity!)) delete r.fields[x.field!];
    if (x.op === "drop_entity") tables.delete(x.entity!);
    if (x.op === "rename_value") for (const ent of ents) for (const f of ent.fields) if (f.type.kind === "named" && f.type.name === x.entity) for (const r of rows(ent.name)) if (r.fields[f.name] === x.from) r.fields[f.name] = x.to;
  }
  return { tables: [...tables], nextId: st.nextId, seq: st.seq };
}

type Call = { state: number; name: string; args: unknown; actor: Ref | null; request: Request; skips: string[] };
type Read = { state: number; entity: string; actors: (Ref | null)[]; request: Request };
type Outcome = { outcome: string; rows?: Ref[] } | null;
// one app's runs, in one go
function probe(app: Program, secret: string | undefined, states: { clock: number; seq: number; rows: Record<string, Row[]>; defaults: string[][] }[], calls: Call[], reads: Read[]): { calls: Outcome[]; reads: ({ ids: number[]; allowed: (boolean | null)[][] } | null)[] } {
  const r = app.run(["probe"], JSON.stringify({ secret, states, calls, reads }));
  try { return JSON.parse(r.stdout); } catch { throw new Error(`the app's probe failed: ${(r.stderr || r.stdout).trim()}`); }
}

export function review(oldSpec: Spec, newSpec: Spec, oldSrc: string, newSrc: string, probes?: Probe[], apps?: { old: Program; new: Program }): Report {
  const oldSchema = schemaOf(oldSpec);
  const stored: Stored = Object.fromEntries(Object.entries(oldSchema.entities).map(([e, d]) => [e, new Set(["id", "seq", "created", "updated", ...Object.keys(d.fields)])]));
  const schema = diff(oldSchema, newSpec, stored).filter((s) => !(s.op === "create_entity" && oldSchema.entities[s.entity!]));
  const claims = claimsDiff(describe(oldSpec, oldSrc).callables, describe(newSpec, newSrc).callables);
  const outcomes = outcomesDiff(oldSpec, newSpec), exposure = exposureDiff(oldSpec, newSpec);
  if (!probes?.length) return { schema, claims, outcomes, exposure, behaviour: null, probes: 0, runs: 0, incomparable: 0 };
  if (!apps) throw new Error("exploring behaviour needs both versions' compiled apps");

  const decl = (s: Spec, kind: string, name: string) => s.decls.find((d) => d.kind === kind && d.name === name);
  const actorOf = (s: Spec) => s.decls.find((d) => d.kind === "app")?.props.actor?.name ?? "";
  const actorEntity = actorOf(oldSpec) || actorOf(newSpec);
  const entityTo = new Map(schema.filter((x) => x.op === "rename_entity").map((x) => [x.from!, x.to!]));
  const toNew = (e: string) => entityTo.get(e) ?? e;
  const agentIdentity = [...newSpec.decls, ...oldSpec.decls].find((d) => d.kind === "identity" && d.source === "token")?.name;
  const newEntities = new Set(newSpec.decls.filter((d) => d.kind === "entity" || d.kind === "data").map((d) => d.name));
  const newEnums = new Map(newSpec.decls.filter((d) => d.kind === "enum").map((d) => [d.name, d.values as string[]]));
  const found = new Map<string, Finding>();
  const note = (kind: Finding["kind"], name: string, change: Finding["change"], example: string) => {
    const k = `${kind}|${name}|${change}`; const f = found.get(k) ?? { kind, name, change, count: 0, examples: [] };
    f.count++; if (f.examples.length < 3 && !f.examples.includes(example)) f.examples.push(example); found.set(k, f);
  };
  let runs = 0, incomparable = 0;

  // each distinct state, old and migrated
  type St = { index: number; old: State; next: State; clock: number; request: Request; scenario: string };
  const states = new Map<string, St>();
  const keyOf = (p: Probe) => `${p.scenario}|${p.state.seq}|${p.clock}`;
  for (const p of probes) {
    const k = keyOf(p); if (states.has(k)) continue;
    states.set(k, { index: states.size, old: p.state, next: migrate(p.state, schema, newSpec), clock: p.clock, request: p.request, scenario: p.scenario });
  }
  const tableOf = (st: State, e: string) => st.tables.find(([k]) => k === e)?.[1] ?? [];
  const who = (st: State, a: Ref | null, identity: string) => {
    if (!a) return "an anonymous caller";
    const r = tableOf(st, a.ref).find((x) => x.id === a.id);
    return `${a.ref} ${a.id}${r?.fields.role ? ` (${r.fields.role})` : ""}${identity === agentIdentity ? " as an agent" : ""}`;
  };
  const variants = (st: State, p: { actor: Ref | null; request: Request }) => {
    const actors: (Ref | null)[] = [null, ...tableOf(st, actorEntity).map((r) => ({ ref: actorEntity, id: r.id }))];
    const out: { actor: Ref | null; request: Request }[] = [];
    for (const actor of actors) {
      const own = !!actor && !!p.actor && actor.id === p.actor.id;
      out.push({ actor, request: { ...p.request, session_token: own ? p.request.session_token : undefined } });
      if (actor && agentIdentity && p.request.identity !== agentIdentity) out.push({ actor, request: { ...p.request, identity: agentIdentity, session_token: undefined } });
    }
    return out;
  };

  // the runs: collected, then made in each app at once
  const jobs: { kind: "call" | "new call"; name: string; st: St; args: any; v: { actor: Ref | null; request: Request }; a: number; b: number }[] = [];
  const oldCalls: Call[] = [], newCalls: Call[] = [];
  const compare = (kind: "call" | "new call", name: string, st: St, args: any, v: { actor: Ref | null; request: Request }, skips: string[]) => {
    const has = (s: Spec) => !!(decl(s, "action", name) || decl(s, "view", name));
    const a = has(oldSpec) ? oldCalls.push({ state: st.index, name, args, actor: v.actor, request: v.request, skips }) - 1 : -1;
    const b = has(newSpec) ? newCalls.push({ state: st.index, name, args, actor: v.actor && { ref: toNew(v.actor.ref), id: v.actor.id }, request: v.request, skips }) - 1 : -1;
    jobs.push({ kind, name, st, args, v, a, b });
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
      const choices = d.params.map((p: any): unknown[] => {
        const t = p.type, opt = t.kind === "named" && t.optional ? [null] : [];
        if (t.kind === "set") { const ids = tableOf(st.next, t.of).map((r) => r.id); return [ids.slice(0, 1), []]; }
        if (newEntities.has(t.name)) { const ids = tableOf(st.next, t.name).map((r) => r.id); const pick = [...new Set([ids[0], ids[Math.floor(ids.length / 2)], ids.at(-1)].filter((x) => x !== undefined))]; return pick.length ? pick : [...opt, 1]; }
        if (newEnums.has(t.name)) return newEnums.get(t.name)!.slice(0, 4);
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
  const oldPerms = oldSpec.decls.filter((d) => d.kind === "permission").map((d) => d.entity as string);
  const readJobs: { st: St; entity: string; actors: (Ref | null)[]; a: number; b: number }[] = [];
  const oldReads: Read[] = [], newReads: Read[] = [];
  for (const st of states.values()) {
    const actors: (Ref | null)[] = [null, ...tableOf(st.old, actorEntity).map((r) => ({ ref: actorEntity, id: r.id }))];
    for (const entity of oldPerms) {
      const ne = toNew(entity);
      if (!newEntities.has(ne)) continue;
      const a = oldReads.push({ state: st.index, entity, actors, request: st.request }) - 1;
      const b = newReads.push({ state: st.index, entity: ne, actors: actors.map((x) => x && { ref: toNew(x.ref), id: x.id }), request: st.request }) - 1;
      readJobs.push({ st, entity: ne, actors, a, b });
    }
  }

  const all = [...states.values()];
  const loads = (pick: (s: St) => State, defaults: string[][]) => all.map((s) => ({ clock: s.clock, seq: pick(s).seq, rows: Object.fromEntries(pick(s).tables), defaults }));
  const newDefaults = schema.filter((x) => x.op === "add_field").map((x) => [x.entity!, x.field!]);
  const secret = probes.find((p) => p.secret)?.secret;
  const A = probe(apps.old, secret, loads((s) => s.old, []), oldCalls, oldReads);
  const B = probe(apps.new, secret, loads((s) => s.next, newDefaults), newCalls, newReads);

  for (const j of jobs) {
    const a: Outcome = j.a < 0 ? { outcome: "absent" } : A.calls[j.a], b: Outcome = j.b < 0 ? { outcome: "absent" } : B.calls[j.b];
    runs += 2;
    if (!a || !b) { incomparable++; continue; }
    const ex = `${who(j.st.old, j.v.actor, j.v.request.identity)}: ${j.name}(${JSON.stringify(j.args).slice(0, 120)}) was ${a.outcome}, now ${b.outcome}  [${j.st.scenario}]`;
    if (a.outcome !== "ok" && b.outcome === "ok") note(j.kind, j.name, "widened", ex);
    if (a.outcome === "ok" && b.outcome !== "ok" && b.outcome !== "absent") note(j.kind, j.name, "narrowed", ex);
    if (a.outcome === "ok" && b.outcome === "ok" && a.rows && b.rows) {
      const ia = new Set(a.rows.map((r) => `${toNew(r.ref)}:${r.id}`)), ib = new Set(b.rows.map((r) => `${r.ref}:${r.id}`));
      const plus = [...ib].filter((x) => !ia.has(x)), minus = [...ia].filter((x) => !ib.has(x));
      if (plus.length) note("view rows", j.name, "widened", `${who(j.st.old, j.v.actor, j.v.request.identity)} now also sees ${plus.slice(0, 5).join(", ")}  [${j.st.scenario}]`);
      if (minus.length) note("view rows", j.name, "narrowed", `${who(j.st.old, j.v.actor, j.v.request.identity)} no longer sees ${minus.slice(0, 5).join(", ")}  [${j.st.scenario}]`);
    }
  }
  for (const j of readJobs) {
    const ra = A.reads[j.a], rb = B.reads[j.b];
    if (!ra || !rb) continue;
    const byId = new Map(rb.ids.map((id, i) => [id, rb.allowed[i]]));
    ra.ids.forEach((id, i) => {
      const nb = byId.get(id);
      j.actors.forEach((actor, k) => {
        const x = ra.allowed[i][k], y = nb ? nb[k] : null; runs += 2;
        if (x === null || y === null) { incomparable++; return; }
        if (!x && y) note("read", j.entity, "widened", `${who(j.st.old, actor, "")} can now read ${j.entity} ${id}  [${j.st.scenario}]`);
        if (x && !y) note("read", j.entity, "narrowed", `${who(j.st.old, actor, "")} can no longer read ${j.entity} ${id}  [${j.st.scenario}]`);
      });
    });
  }
  return { schema, claims, outcomes, exposure, behaviour: [...found.values()].sort((x, y) => (x.change === y.change ? y.count - x.count : x.change === "widened" ? -1 : 1)), probes: probes.length, runs, incomparable };
}
