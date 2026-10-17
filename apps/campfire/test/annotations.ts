// Checks the descriptor's derived claims (lang/describe.ts) against the compiled app, on every
// action and view call in the oracle scenarios:
// - every row a call actually creates, updates or deletes is in its declared effects;
// - a read-only call changes nothing;
// - a non-destructive call never changes or deletes an existing row;
// - an idempotent call, run again at a later time, changes nothing more.
// Each call runs on the state the scenario had just before it (probes.ts) and is rolled back.
// usage: node apps/campfire/test/annotations.ts <spec>
import { readFileSync } from "node:fs";
import { parse } from "../../../lang/parser.ts";
import { describe } from "../../../lang/describe.ts";
import { compiledApp } from "../../../lang/gogen/program.ts";
import { collectProbes } from "./probes.ts";

const [specPath] = process.argv.slice(2);
const src = readFileSync(specPath, "utf8"), spec = parse(src);
const byName = new Map(describe(spec, src).callables.map((c) => [c.name, c]));

type Change = { created: string[]; updated: Record<string, string[]>; deleted: string[]; existing: boolean };
const empty = (c: Change) => !c.created.length && !Object.keys(c.updated).length && !c.deleted.length;
const describeChange = (c: Change) => JSON.stringify({ created: c.created, updated: c.updated, deleted: c.deleted });

const probes = await collectProbes(specPath);
const states: any[] = [], index = new Map<string, number>();
const calls = probes.map((p) => {
  const k = `${p.scenario}|${p.state.seq}|${p.clock}`;
  if (!index.has(k)) { index.set(k, states.length); states.push({ clock: p.clock, seq: p.state.seq, rows: Object.fromEntries(p.state.tables), defaults: [], counters: p.state.counters ?? [] }); }
  return { state: index.get(k)!, name: p.name, args: p.args, actor: p.actor, request: p.request, skips: p.skips, changes: true, again: byName.get(p.name)?.annotations.idempotentHint ? 60_000 : 0 };
});
const r = compiledApp(specPath).run(["probe"], JSON.stringify({ secret: probes.find((p) => p.secret)?.secret, states, calls, reads: [] }));
const results: any[] = JSON.parse(r.stdout).calls;

const stats = new Map<string, { calls: number; ok: number; problems: Set<string>; notes: Set<string> }>();
calls.forEach((call, i) => {
  const st = stats.get(call.name) ?? { calls: 0, ok: 0, problems: new Set<string>(), notes: new Set<string>() }; stats.set(call.name, st); st.calls++;
  const res = results[i], c = byName.get(call.name);
  if (!res || res.outcome !== "ok" || !c) return;
  st.ok++;
  const ch: Change = res.changes, fx = c.effects;
  const allowedUpdates = (e: string) => new Set([...(fx.updates[e] ?? []), ...(fx.later.updates[e] ?? [])]);
  for (const e of ch.created) if (!fx.creates.includes(e) && !fx.later.creates.includes(e)) st.problems.add(`created ${e}, not declared`);
  for (const [e, fs] of Object.entries(ch.updated)) for (const f of fs) if (!allowedUpdates(e).has(f)) st.problems.add(`updated ${e}.${f}, not declared`);
  for (const e of ch.deleted) if (!fx.deletes.includes(e) && !fx.later.deletes.includes(e)) st.problems.add(`deleted ${e}, not declared`);
  if (c.annotations.readOnlyHint && !empty(ch)) st.problems.add(`read-only, but changed ${describeChange(ch)}`);
  if (!c.annotations.destructiveHint && ch.existing) st.problems.add(`not destructive, but changed existing rows: ${describeChange(ch)}`);
  if (c.annotations.idempotentHint && res.again) {
    if (!empty(res.again)) st.problems.add(`idempotent, but a repeat changed ${describeChange(res.again)}`);
    else if (res.again.outcome !== "ok") st.notes.add(`a repeat changes nothing and returns ${res.again.outcome}`);
  }
});

let bad = 0;
const observed = [...stats].filter(([, s]) => s.ok);
for (const [name, s] of observed.sort()) {
  if (s.problems.size) bad++;
  console.log(`${s.problems.size ? "FAIL" : "ok  "} ${name.padEnd(28)} ${s.ok} successful call(s)${s.problems.size ? "\n       " + [...s.problems].join("\n       ") : ""}${s.notes.size ? `  (${[...s.notes].join("; ")})` : ""}`);
}
const unobserved = [...byName.keys()].filter((n) => !stats.get(n)?.ok);
console.log(`\n${new Set(probes.map((p) => p.scenario)).size} scenarios; ${observed.length - bad}/${observed.length} observed callables agree with their annotations`);
console.log(`not exercised by any scenario (claims unchecked): ${unobserved.join(", ") || "none"}`);
process.exit(bad ? 1 : 0);
