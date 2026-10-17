// Scores the H7 migration corpus (docs/H7-PROTOCOL.md). Written before any case was read.
// usage: node h7/score.ts <cases-dir> <out.json>
// For each case: load seed.json into base.crud through the runtime's /_test/fixture, snapshot
// every stored value, run `cli migrate next.crud`, snapshot again, and judge:
//   silent data loss, caught before apply, destructive without drop, data correct.
process.removeAllListeners("warning");
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parse, type Spec } from "../lang/parser.ts";

const [casesDir, outPath] = process.argv.slice(2);
if (!casesDir || !outPath) { console.error("usage: node h7/score.ts <cases-dir> <out.json>"); process.exit(64); }
const PORT = 13870;
const META = /^(crudspec_|sqlite_)/;
type Snap = Record<string, { cols: string[]; rows: Map<number, Record<string, unknown>> }>;

function snap(path: string): Snap {
  const db = new DatabaseSync(path, { readOnly: true });
  const out: Snap = {};
  for (const t of db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as any[]) {
    if (META.test(t.name)) continue;
    const cols = (db.prepare(`PRAGMA table_info("${t.name}")`).all() as any[]).map((c) => c.name);
    const rows = new Map<number, Record<string, unknown>>();
    for (const r of db.prepare(`SELECT * FROM "${t.name}"`).all() as any[]) rows.set(Number(r.id), { ...r });
    out[t.name] = { cols, rows };
  }
  db.close();
  return out;
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

async function runtimeSeed(base: string, seed: string, data: string): Promise<string | null> {
  const p = spawn(process.execPath, ["lang/runtime/server.ts", base, "--data", data, "--assets", "apps/tasks/assets", "--port", String(PORT), "--test"], { stdio: "ignore" });
  try {
    let up = false;
    for (let i = 0; i < 60 && !up; i++) { try { up = (await fetch(`http://127.0.0.1:${PORT}/up`)).ok; } catch { await new Promise((r) => setTimeout(r, 200)); } }
    if (!up) return "the runtime didn't start on base.crud";
    const r = await fetch(`http://127.0.0.1:${PORT}/_test/fixture`, { method: "POST", headers: { "Content-Type": "application/json" }, body: readFileSync(seed, "utf8") });
    const j: any = await r.json();
    return r.ok ? null : `seed failed: ${j.error}`;
  } finally {
    p.kill();
    await new Promise((r) => p.once("exit", r));
  }
}

// what the next spec says about the change
function intent(next: Spec) {
  const entityWas = new Map<string, string>(), fieldWas = new Map<string, string>(), valueWas = new Map<string, Map<string, string>>();
  const drops = new Set<string>(), migrationSets = new Set<string>(), migrationDeletes = new Set<string>();
  const types = new Map<string, Map<string, any>>();
  for (const d of next.decls) {
    if (d.kind === "entity") {
      if (d.was) entityWas.set(d.was, d.name);
      types.set(d.name, new Map(d.fields.map((f: any) => [f.name, f.type])));
      for (const f of d.fields) if (f.was) fieldWas.set(`${d.name}.${f.was}`, f.name);
    }
    if (d.kind === "enum") valueWas.set(d.name, new Map(Object.entries(d.renames ?? {}).map(([to, from]) => [from as string, to])));
    if (d.kind === "drop") drops.add(d.field ? `${d.entity}.${d.field}` : d.entity);
    if (d.kind === "migration") {
      const walk = (x: any): void => { if (!x || typeof x !== "object") return; if (Array.isArray(x)) return x.forEach(walk);
        if (x.kind === "set") migrationSets.add(x.name);
        if (x.kind === "delete" || x.kind === "deleteWhere" || x.kind === "create") migrationDeletes.add(x.entity ?? "*");
        for (const [k, v] of Object.entries(x)) if (k !== "pos") walk(v); };
      walk(d.body);
    }
  }
  return { entityWas, fieldWas, valueWas, drops, migrationSets, migrationDeletes, types };
}

// a stored value, written as expect.json writes it
function present(v: unknown, type: any, after: Snap, keyOf: Record<string, string>, tableOf: (e: string) => string): unknown {
  if (v === null || v === undefined) return null;
  if (!type) return v;
  if (type.kind === "set") {
    const ids: number[] = (() => { try { return JSON.parse(String(v)).set ?? []; } catch { return []; } })();
    const t = after[tableOf(type.of)], k = keyOf[type.of];
    return ids.map((id) => (k && t?.rows.get(id) ? t.rows.get(id)![k] : id));
  }
  const n = type.name;
  if (after[tableOf(n)]) { const k = keyOf[n]; const row = after[tableOf(n)].rows.get(Number(v)); return k && row ? row[k] : Number(v); }
  if (n === "Bool") return v === 1 || v === 1n || v === true;
  if (n === "Int") return Number(v);
  if (["Time", "File", "Password"].includes(n)) return undefined;
  if (["RichText", "Json", "Duration"].includes(n)) { try { const j = JSON.parse(String(v)); return n === "RichText" ? j.rich ?? j : j; } catch { return v; } }
  return v;
}

type Result = { case: string; expected: string; got: string; caught: boolean | null; dataCorrect: boolean | null; silentLoss: string[]; destructiveWithoutDrop: string[]; problems: string[] };
const results: Result[] = [];
for (const name of readdirSync(casesDir).filter((n) => existsSync(join(casesDir, n, "expect.json"))).sort()) {
  const dir = join(casesDir, name);
  const res: Result = { case: name, expected: "", got: "", caught: null, dataCorrect: null, silentLoss: [], destructiveWithoutDrop: [], problems: [] };
  results.push(res);
  try {
    const expect = JSON.parse(readFileSync(join(dir, "expect.json"), "utf8"));
    res.expected = expect.status;
    const data = mkdtempSync(join(tmpdir(), "h7-"));
    const seedErr = await runtimeSeed(join(dir, "base.crud"), join(dir, "seed.json"), data);
    if (seedErr) { res.problems.push(`invalid case: ${seedErr}`); continue; }
    const before = snap(join(data, "app.sqlite"));
    const m = spawnSync(process.execPath, ["lang/cli.ts", "migrate", join(dir, "next.crud"), "--data", data, "--json"], { encoding: "utf8" });
    let plan: any = null; try { plan = JSON.parse(m.stdout); } catch { res.problems.push(`migrate printed no plan (exit ${m.status}): ${(m.stdout + m.stderr).slice(0, 300)}`); continue; }
    if (plan.errors !== undefined && !plan.status) { res.got = "spec errors"; res.problems.push(`next.crud doesn't pass check: ${plan.findings.filter((f: any) => f.severity === "error").map((f: any) => f.message).join("; ")}`); continue; }
    res.got = plan.status;
    const after = snap(join(data, "app.sqlite"));
    const it = intent(parse(readFileSync(join(dir, "next.crud"), "utf8")));
    const tableOf = (e: string) => e;   // after the upgrade, tables carry the next spec's names
    const keyOf: Record<string, string> = expect.key ?? {};

    if (expect.status === "blocked") {
      res.caught = plan.status === "blocked" && same([...Object.entries(before)].map(([t, s]) => [t, s.cols, [...s.rows]]), [...Object.entries(after)].map(([t, s]) => [t, s.cols, [...s.rows]]));
      if (!res.caught) res.problems.push(plan.status === "blocked" ? "refused, but the database changed" : `expected a refusal, got ${plan.status}`);
      continue;
    }
    if (plan.status !== "applied") res.problems.push(`expected applied, got ${plan.status}: ${JSON.stringify(plan.steps?.filter((s: any) => s.class === "blocked") ?? plan.notes).slice(0, 300)}`);

    // destructive without drop, and silent loss: follow every seeded value to where it should be
    const listed = new Map<string, any>();   // "<Entity>|<key value>" -> expected row
    for (const [e, rows] of Object.entries<any[]>(expect.data ?? {})) for (const r of rows) listed.set(`${e}|${r[keyOf[e]]}`, r);
    for (const [table, s] of Object.entries(before)) {
      const to = it.entityWas.get(table) ?? table;
      const a = after[to];
      if (!a) { if (!it.drops.has(table)) res.destructiveWithoutDrop.push(`table ${table} is gone`); continue; }
      for (const col of s.cols) {
        if (["id", "seq", "created", "updated"].includes(col)) continue;
        const c2 = it.fieldWas.get(`${to}.${col}`) ?? col;
        if (!a.cols.includes(c2) && !it.drops.has(`${table}.${col}`) && !it.drops.has(`${to}.${col}`)) res.destructiveWithoutDrop.push(`column ${table}.${col} is gone`);
      }
      for (const [id, row] of s.rows) {
        const r2 = a.rows.get(id);
        const keyField = keyOf[to], keyVal = keyField ? (row[it.fieldWas.has(`${to}.${keyField}`) ? keyField : keyField] ?? row[keyField]) : undefined;
        const exp = keyField ? listed.get(`${to}|${r2?.[keyField] ?? keyVal}`) : undefined;
        if (!r2) { if (!exp?._absent && !it.migrationDeletes.has(to) && !it.drops.has(table)) res.silentLoss.push(`${table} row ${id} is gone`); continue; }
        for (const col of s.cols) {
          if (["id", "seq", "created", "updated"].includes(col)) continue;
          const c2 = it.fieldWas.get(`${to}.${col}`) ?? col;
          if (!a.cols.includes(c2)) continue;   // counted above, or dropped on purpose
          let v1 = row[col]; const v2 = r2[c2];
          if (v1 === null || v1 === undefined || same(v1, v2)) continue;
          const t = it.types.get(to)?.get(c2);
          if (t?.kind === "named" && it.valueWas.get(t.name)?.get(String(v1)) === v2) continue;   // an enum value renamed
          if (t?.kind === "named" && ["Time", "Password", "File"].includes(t.name)) continue;
          if (exp && c2 in exp) continue;               // the case expects this value to change
          if (it.migrationSets.has(c2)) continue;        // a migration writes it
          res.silentLoss.push(`${table}.${col} of row ${id} changed from ${JSON.stringify(v1)} to ${JSON.stringify(v2)}`);
        }
      }
    }
    // the expected values
    let ok = plan.status === "applied";
    for (const [e, rows] of Object.entries<any[]>(expect.data ?? {})) {
      const t = after[e]; const k = keyOf[e];
      for (const r of rows) {
        const row = t && k ? [...t.rows.values()].find((x) => same(present(x[k], it.types.get(e)?.get(k), after, keyOf, tableOf), r[k])) : undefined;
        if (r._absent) { if (row) { ok = false; res.problems.push(`${e} ${r[k]} should be gone`); } continue; }
        if (!row) { ok = false; res.problems.push(`${e} ${r[k]} is missing`); continue; }
        for (const [f, want] of Object.entries(r)) {
          if (f === k) continue;
          const got = present(row[f], it.types.get(e)?.get(f), after, keyOf, tableOf);
          if (got === undefined) continue;
          if (!same(got, want)) { ok = false; res.problems.push(`${e} ${r[k]}.${f}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`); }
        }
      }
    }
    res.dataCorrect = ok;
  } catch (e) { res.problems.push(`scorer error: ${(e as Error).message}`); }
}

const blocked = results.filter((r) => r.expected === "blocked"), applied = results.filter((r) => r.expected === "applied");
const summary = {
  cases: results.length,
  invalid: results.filter((r) => r.problems.some((p) => p.startsWith("invalid case"))).length,
  silent_losses: results.reduce((n, r) => n + r.silentLoss.length, 0),
  cases_with_silent_loss: results.filter((r) => r.silentLoss.length).map((r) => r.case),
  blocked_expected: blocked.length, blocked_caught: blocked.filter((r) => r.caught).length,
  destructive_without_drop: results.reduce((n, r) => n + r.destructiveWithoutDrop.length, 0),
  applied_expected: applied.length, data_correct: applied.filter((r) => r.dataCorrect).length,
};
writeFileSync(outPath, JSON.stringify({ summary, results }, null, 2));
for (const r of results) console.log(`${r.problems.length || r.silentLoss.length || r.destructiveWithoutDrop.length ? "FAIL" : "ok  "} ${r.case}: expected ${r.expected}, got ${r.got || "-"}${[...r.silentLoss.map((x) => `\n       LOSS ${x}`), ...r.destructiveWithoutDrop.map((x) => `\n       DESTRUCTIVE ${x}`), ...r.problems.map((x) => `\n       ${x}`)].join("")}`);
console.log(JSON.stringify(summary, null, 2));
