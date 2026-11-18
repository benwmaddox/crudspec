// Differential check of the compiled Go app against the Lean interpreter: for each case (a store,
// an action, its arguments, who acts, now), the app's outcome must be one of the outcomes Lean
// allows. Lean writes the cases with every outcome its choices allow (crosscheck cases); this
// loads each into the compiled app (/_test/load), runs the action (/_test/run) and compares the
// store after (/_test/dump).
//
//   node tools/lean-crosscheck/diff-go.ts <spec> <export.json> <cases.json> [--port N] [--json report.json]
//
// - The app's ok must match one of Lean's ok outcomes: the same rows of each entity, by id, with
//   the same field values. A value Lean didn't compute ({wild}), a file, a password, rich text,
//   and created/updated aren't compared.
// - The app's refusal (any outcome but ok) must match one of Lean's refusals.
// - No match: a mismatch when Lean tried every way of choosing (complete), else inconclusive.
// - Actions whose emits start a workflow after commit are left out (Lean doesn't run workflows).
// Needs Go (lang/test/go-app.ts builds and runs the app; on Windows, in WSL).
import { readFileSync, writeFileSync } from "node:fs";
import { startApp } from "../../lang/test/go-app.ts";

const args = process.argv.slice(2);
const pos = args.filter((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
const opt = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const [specPath, exportPath, casesPath] = pos;
if (!specPath || !exportPath || !casesPath) { console.error("usage: node tools/lean-crosscheck/diff-go.ts <spec> <export.json> <cases.json> [--port N] [--json report.json]"); process.exit(64); }

const ex = JSON.parse(readFileSync(exportPath, "utf8"));
const { cases, skipped } = JSON.parse(readFileSync(casesPath, "utf8"));
const decls: any[] = ex.decls;
const ents = new Map<string, any>(decls.filter((d) => d.kind === "entity").map((d) => [d.name, d]));
const typeOf = (e: string, f: string): string => ents.get(e)?.fields.find((x: any) => x.name === f)?.type?.name ?? "?";
const OPAQUE = new Set(["File", "Password", "RichText", "Json"]);

// actions whose emits start a workflow after commit (directly, or in a trigger anywhere: a trigger
// can fire from any write, so a trigger that emits one leaves out every action, conservatively)
const wfEvents = new Set(decls.filter((d) => d.kind === "workflow").map((d) => d.event));
const emitsWf = (x: any): boolean => !!x && typeof x === "object" && (Array.isArray(x) ? x.some(emitsWf) : (x.kind === "emit" && wfEvents.has(x.name ?? x.event)) || Object.values(x).some(emitsWf));
const triggerEmits = decls.filter((d) => d.kind === "trigger").some((t) => emitsWf(t.body));
const excluded = (action: string) => triggerEmits || emitsWf(decls.find((d) => d.kind === "action" && d.name === action)?.body);

// a Lean value as the app loads it, by the field's declared type
const toGo = (v: any, type: string): any => {
  if (v === null) return null;
  if (v?.wild) return type === "RichText" ? { rich: "x" } : type === "Password" ? { password: "pw" } : type === "Text" ? "x" : null;
  if (type === "Time" && typeof v === "number") return { time: v, seq: 0 };
  if (type === "Duration" && typeof v === "number") return { ms: v };
  return v;
};
// an app value as Lean writes it (null for what isn't compared)
const fromGo = (v: any, type: string): any => {
  if (v && typeof v === "object" && "time" in v) return v.time;
  if (v && typeof v === "object" && "ms" in v && Object.keys(v).length === 1) return v.ms;
  if (v && typeof v === "object" && "ref" in v) return { ref: v.ref, id: v.id };
  return v;
};
// equal values, whatever the order of an object's keys
const canon = (v: any): any => (Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
const same = (a: any, b: any) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));

// the differences between Lean's store and the app's (for the entities Lean knows)
const diffs = (lean: Record<string, any[]>, go: Record<string, any[]>): string[] => {
  const out: string[] = [];
  for (const [e, rows] of Object.entries(lean)) {
    const gs = new Map<number, any>((go[e] ?? []).map((r: any) => [r.id, r]));
    const ls = new Map<number, any>(rows.map((r: any) => [r.id, r]));
    for (const id of ls.keys()) if (!gs.has(id)) out.push(`${e}#${id}: Lean has it, the app doesn't`);
    for (const id of gs.keys()) if (!ls.has(id)) out.push(`${e}#${id}: the app has it, Lean doesn't`);
    for (const [id, lr] of ls) {
      const gr = gs.get(id); if (!gr) continue;
      for (const [f, lv] of Object.entries(lr.fields)) {
        const t = typeOf(e, f);
        if ((lv as any)?.wild || OPAQUE.has(t)) continue;
        const gv = fromGo(gr.fields[f], t);
        if (!same(lv, gv)) out.push(`${e}#${id}.${f}: Lean ${JSON.stringify(lv)}, the app ${JSON.stringify(gv)}`);
      }
    }
  }
  return out;
};

const app = await startApp(specPath, Number(opt("--port") ?? 13961));
type Tally = { cases: number; match: number; inconclusive: number; mismatch: number; excluded: boolean; examples: string[] };
const by = new Map<string, Tally>();
try {
  for (const c of cases) {
    const t = by.get(c.action) ?? { cases: 0, match: 0, inconclusive: 0, mismatch: 0, excluded: excluded(c.action), examples: [] };
    by.set(c.action, t);
    if (t.excluded) continue;
    t.cases++;
    const rows: Record<string, any[]> = {};
    let seq = 1;
    for (const [e, rs] of Object.entries(c.pre as Record<string, any[]>)) rows[e] = rs.map((r) => ({ id: r.id, seq: seq++, created: 0, updated: 0, fields: Object.fromEntries(Object.entries(r.fields).map(([f, v]) => [f, toGo(v, typeOf(e, f))])) }));
    await app.post("/_test/load", { clock: c.now, seq, rows });
    const actor = c.actor && !c.actor.wild ? c.actor : null;
    const params = Object.fromEntries(Object.entries(c.params).map(([k, v]: [string, any]) => [k, v?.set ? { set: v.set, entity: v.entity } : v?.wild ? null : v]));
    const run = await app.post("/_test/run", { call: c.action, args: params, actor, now: c.now });
    const dump = await app.post("/_test/dump", {});
    const goRows: Record<string, any[]> = {};
    for (const e of Object.keys(c.pre)) goRows[e] = dump.rows?.[e] ?? [];
    let matched = false, nearest: string[] | undefined;
    if (run.outcome === "ok") {
      for (const o of c.outcomes.filter((o: any) => o.ok)) {
        const d = diffs(o.post, goRows);
        if (!d.length) { matched = true; break; }
        if (!nearest || d.length < nearest.length) nearest = d;
      }
    } else matched = c.outcomes.some((o: any) => !o.ok);
    if (matched) { t.match++; continue; }
    const what = run.outcome === "ok"
      ? (c.outcomes.some((o: any) => o.ok) ? `the app's store isn't one Lean allows: ${(nearest ?? []).slice(0, 4).join("; ")}` : `the app ran it; Lean refuses it (${c.outcomes.map((o: any) => o.why).slice(0, 2).join("; ")})`)
      : `the app refused it (${run.outcome}: ${run.detail}); Lean always runs it`;
    if (c.complete) { t.mismatch++; if (t.examples.length < 3) t.examples.push(`${what} [actor ${JSON.stringify(actor)}, args ${JSON.stringify(params)}]`); }
    else t.inconclusive++;
  }
} finally { app.stop(); }

let total = 0, mism = 0, inc = 0;
for (const [a, t] of [...by].sort()) {
  if (t.excluded) { console.log(`${a}: left out (it starts a workflow after commit)`); continue; }
  total += t.cases; mism += t.mismatch; inc += t.inconclusive;
  console.log(`${a}: ${t.cases} cases, ${t.match} match${t.inconclusive ? `, ${t.inconclusive} inconclusive` : ""}${t.mismatch ? `, ${t.mismatch} MISMATCH` : ""}`);
  for (const x of t.examples) console.log(`    ${x}`);
}
for (const s of skipped) console.log(`${s.action}: skipped by Lean (${s.why})`);
console.log(`\n${total} cases: ${total - mism - inc} match, ${inc} inconclusive, ${mism} mismatch; ${[...by.values()].filter((t) => t.excluded).length} actions left out, ${skipped.length} skipped`);
if (opt("--json")) writeFileSync(opt("--json")!, JSON.stringify(Object.fromEntries(by), null, 1));
process.exit(mism ? 1 : 0);
