// Summarises a fair run (bench/fair-run.sh): for each server and cache mode, the peak req/s over
// the connection sweep in each pass (only clean windows: no errors, every response valid), CPU per
// request and the load generator's use at that peak, and memory (PSS) after the load; the two
// passes averaged; and each as a multiple of Rails in the same mode (Rails has no response cache,
// so its fragment-cached run is the baseline for "full").
//   node bench/fair-summary.ts <tag>
import { existsSync, readFileSync } from "node:fs";

const tag = process.argv[2];
type Cell = { conns: number; ok: number; errors: number | null; invalid: number | null; rps: number; cpu_ms_per_req: number; server_util: number; client_util: number };
const peak = (run: string) => {
  const dir = `bench/runs/${run}`;
  if (!existsSync(`${dir}/pss.txt`)) return null;   // not run, or still running
  // req/s and use over the time the load generator actually ran (its own "secs"): a slow server
  // keeps it waiting past the window for queued requests, and dividing by the window flatters it
  const cells: Cell[] = readFileSync(`${dir}/summary.jsonl`, "utf8").trim().split("\n").map((l) => {
    const c = JSON.parse(l), lg = JSON.parse(readFileSync(`${dir}/cell-${c.conns}.json`, "utf8"));
    const window = c.ok / c.rps, secs = lg.secs ?? window;
    return { ...c, rps: +(c.ok / secs).toFixed(1), server_util: +(c.server_util * window / secs).toFixed(2), client_util: +(c.client_util * window / secs).toFixed(2) };
  });
  const clean = cells.filter((c) => !c.errors && !c.invalid && c.ok > 0);
  const best = clean.reduce((a, b) => (b.rps > a.rps ? b : a), clean[0]);
  const pss = Number(/TOTAL_PSS_MB=([\d.]+)/.exec(readFileSync(`${dir}/pss.txt`, "utf8"))?.[1]);
  return { ...best, pss, dirty: cells.length - clean.length };
};
const rows: Record<string, any> = {};
for (const app of ["crudspec", "rails", "rust"]) for (const mode of ["off", "frag", "full"]) {
  const ps = ["a", "b"].map((p) => peak(`fair-${tag}-${app}-${mode}-${p}`)).filter(Boolean) as any[];
  if (!ps.length) continue;
  const avg = (k: string) => ps.reduce((s, p) => s + p[k], 0) / ps.length;
  rows[`${app} ${mode}`] = { app, mode, passes: ps.map((p) => `${p.rps}@${p.conns}`).join(" / "), rps: avg("rps"), cpu: avg("cpu_ms_per_req"), lg: Math.max(...ps.map((p) => p.client_util)), srv: Math.min(...ps.map((p) => p.server_util)), pss: avg("pss"), dirty: ps.reduce((s, p) => s + p.dirty, 0) };
}
const base = (mode: string) => rows[`rails ${mode === "full" ? "frag" : mode}`];
console.log("| Server | Cache | req/s (pass a / b, at conns) | × Rails | CPU ms/req | Memory (PSS) | × Rails memory | server use | loadgen use |");
console.log("| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |");
for (const r of Object.values(rows)) {
  const b = base(r.mode);
  console.log(`| ${r.app} | ${r.mode} | ${Math.round(r.rps).toLocaleString("en-US")} (${r.passes}) | ${b ? (r.rps / b.rps).toFixed(1) : "-"} | ${r.cpu.toFixed(3)} | ${r.pss.toFixed(0)} MB | ${b ? (r.pss / b.pss).toFixed(2) : "-"} | ${r.srv.toFixed(2)} | ${r.lg.toFixed(2)}${r.dirty ? ` (${r.dirty} unclean windows)` : ""} |`);
}
