// A table of benchmark runs whose names start with a prefix: each run's best window (requests a
// second), its CPU per request, and memory (PSS) after the load; then the mean by group, the run
// name without its pass (-p1, -1A, …).   node bench/runs-summary.ts <prefix>
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const prefix = process.argv[2] ?? "";
const dir = join(import.meta.dirname, "runs");
const rows: { run: string; group: string; rps: number; cpu: number; pss: number; invalid: number }[] = [];
for (const run of readdirSync(dir).filter((r) => r.startsWith(prefix)).sort()) {
  const sum = join(dir, run, "summary.jsonl");
  if (!existsSync(sum)) continue;
  const cells = readFileSync(sum, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  if (!cells.length) continue;
  const best = cells.reduce((a, b) => (b.rps > a.rps ? b : a));
  const pssText = existsSync(join(dir, run, "pss.txt")) ? readFileSync(join(dir, run, "pss.txt"), "utf8") : "";
  const pss = Number(/TOTAL_PSS_MB=([\d.]+)/.exec(pssText)?.[1] ?? NaN);
  const group = run.replace(/-p\d+$/, "").replace(/-\d+([AB])$/, "-$1");   // ABBA runs: by build
  rows.push({ run, group, rps: best.rps, cpu: best.cpu_ms_per_req, pss, invalid: cells.reduce((n, c) => n + (c.invalid ?? 0) + (c.errors ?? 0), 0) });
}
const pad = (s: string | number, n: number) => String(s).padStart(n);
console.log(`${"run".padEnd(36)} ${pad("req/s", 9)} ${pad("CPU ms", 7)} ${pad("PSS MB", 7)} bad`);
for (const r of rows) console.log(`${r.run.padEnd(36)} ${pad(r.rps.toFixed(0), 9)} ${pad(r.cpu.toFixed(3), 7)} ${pad(r.pss.toFixed(1), 7)} ${r.invalid}`);
console.log("\nmeans by group");
for (const g of [...new Set(rows.map((r) => r.group))]) {
  const rs = rows.filter((r) => r.group === g), m = (f: (r: typeof rs[0]) => number) => rs.reduce((a, r) => a + f(r), 0) / rs.length;
  console.log(`${g.padEnd(36)} ${pad(m((r) => r.rps).toFixed(0), 9)} ${pad(m((r) => r.cpu).toFixed(3), 7)} ${pad(m((r) => r.pss).toFixed(1), 7)}  (${rs.length} runs)`);
}
