// Checks the descriptor's derived claims (lang/describe.ts) against the interpreter, on every
// action and view call in the oracle scenarios:
// - every row a call actually creates, updates or deletes is in its declared effects;
// - a read-only call changes nothing;
// - a non-destructive call never changes or deletes an existing row;
// - an idempotent call, run again at a later time, changes nothing more.
// Each call is rerun on a copy; the scenario itself continues untouched.
// usage: node apps/campfire/test/annotations.ts <spec> <scenarios-root> <goldens-root> <set:goldens>...
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse } from "../../../lang/parser.ts";
import { describe, type Callable } from "../../../lang/describe.ts";
import type { Interpreter, Store } from "../../../lang/interp.ts";
import { runScenario } from "./scenario.ts";

const [specPath, scenRoot, goldRoot, ...sets] = process.argv.slice(2);
const src = readFileSync(specPath, "utf8"), spec = parse(src);
const byName = new Map(describe(spec, src).callables.map((c) => [c.name, c]));

type Change = { created: Set<string>; updated: Map<string, Set<string>>; deleted: Set<string>; existingTouched: boolean };
function changes(it: Interpreter, a: Store, b: Store): Change {
  const c: Change = { created: new Set(), updated: new Map(), deleted: new Set(), existingTouched: false };
  for (const [name, ent] of it.entities) {
    if (ent.kind !== "entity") continue;
    const before = new Map(a.rows(name).map((r) => [r.id, r]));
    const after = new Map(b.rows(name).map((r) => [r.id, r]));
    for (const [id, r] of after) {
      const o = before.get(id);
      if (!o) { c.created.add(name); continue; }
      for (const k of new Set([...Object.keys(o.fields), ...Object.keys(r.fields)])) if (JSON.stringify(o.fields[k]) !== JSON.stringify(r.fields[k])) { (c.updated.get(name) ?? c.updated.set(name, new Set()).get(name)!).add(k); c.existingTouched = true; }
    }
    for (const id of before.keys()) if (!after.has(id)) { c.deleted.add(name); c.existingTouched = true; }
  }
  return c;
}
const empty = (c: Change) => !c.created.size && !c.updated.size && !c.deleted.size;
const describeChange = (c: Change) => JSON.stringify({ created: [...c.created], updated: Object.fromEntries([...c.updated].map(([k, v]) => [k, [...v]])), deleted: [...c.deleted] });

const stats = new Map<string, { calls: number; ok: number; problems: Set<string>; notes: Set<string> }>();
const wrap = (it: Interpreter, name: string, run: () => any) => {
  const st = stats.get(name) ?? { calls: 0, ok: 0, problems: new Set<string>(), notes: new Set<string>() }; stats.set(name, st); st.calls++;
  const c: Callable | undefined = byName.get(name);
  const s0 = it.store.clone();
  const r1 = run();
  if (r1.outcome !== "ok" || !c) return r1;
  st.ok++;
  const s1 = it.store.clone(), counters = new Map([...it.counters].map(([k, v]) => [k, [...v]])), clock = it.clock;
  const ch = changes(it, s0, s1);
  const fx = c.effects;
  const allowedUpdates = (e: string) => new Set([...(fx.updates[e] ?? []), ...(fx.later.updates[e] ?? [])]);
  for (const e of ch.created) if (!fx.creates.includes(e) && !fx.later.creates.includes(e)) st.problems.add(`created ${e}, not declared`);
  for (const [e, fs] of ch.updated) for (const f of fs) if (!allowedUpdates(e).has(f)) st.problems.add(`updated ${e}.${f}, not declared`);
  for (const e of ch.deleted) if (!fx.deletes.includes(e) && !fx.later.deletes.includes(e)) st.problems.add(`deleted ${e}, not declared`);
  if (c.annotations.readOnlyHint && !empty(ch)) st.problems.add(`read-only, but changed ${describeChange(ch)}`);
  if (!c.annotations.destructiveHint && ch.existingTouched) st.problems.add(`not destructive, but changed existing rows: ${describeChange(ch)}`);
  if (c.annotations.idempotentHint) {
    it.advance(60_000);
    const r2 = run();
    const ch2 = changes(it, s1, it.store);
    if (!empty(ch2)) st.problems.add(`idempotent, but a repeat changed ${describeChange(ch2)}`);
    else if (r2.outcome !== "ok") st.notes.add(`a repeat changes nothing and returns ${r2.outcome}`);
    it.store = s1; it.counters = counters; it.clock = clock;
  }
  return r1;
};

let scenarios = 0;
for (const pair of sets) {
  const [set, golden] = pair.split(":");
  for (const f of readdirSync(join(goldRoot, golden)).filter((f) => f.endsWith(".json")).sort()) {
    runScenario(spec, JSON.parse(readFileSync(join(scenRoot, set, f), "utf8")), JSON.parse(readFileSync(join(goldRoot, golden, f), "utf8")), wrap);
    scenarios++;
  }
}
let bad = 0;
const observed = [...stats].filter(([, s]) => s.ok);
for (const [name, s] of observed.sort()) {
  if (s.problems.size) bad++;
  console.log(`${s.problems.size ? "FAIL" : "ok  "} ${name.padEnd(28)} ${s.ok} successful call(s)${s.problems.size ? "\n       " + [...s.problems].join("\n       ") : ""}${s.notes.size ? `  (${[...s.notes].join("; ")})` : ""}`);
}
const unobserved = [...byName.keys()].filter((n) => !stats.get(n)?.ok);
console.log(`\n${scenarios} scenarios; ${observed.length - bad}/${observed.length} observed callables agree with their annotations`);
console.log(`not exercised by any scenario (claims unchecked): ${unobserved.join(", ") || "none"}`);
process.exit(bad ? 1 : 0);
