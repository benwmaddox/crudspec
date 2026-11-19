// Every cross-check, for each app: the prover's verdicts (export.ts), Lean replaying them
// (crosscheck), and the compiled Go app against Lean's outcomes (cases + diff-go.ts). Run it when
// the compiler, the runtime or the prover changes; an app's own build already proves its
// invariants. Fails (exit 1) on any disagreement or mismatch.
//   node tools/lean-crosscheck/all.ts [<spec or app folder> …] [--no-go] [--samples N]
// With no specs: apps/campfire, apps/freestore, apps/tasks, apps/todomvc. Needs Lean (elan); --no-go skips the
// Go diff (which needs Go; on Windows, in WSL). Files go to tools/lean-crosscheck/out/.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

const args = process.argv.slice(2);
const opt = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const specs = args.filter((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--samples"));
const apps = specs.length ? specs : ["apps/campfire", "apps/freestore", "apps/tasks", "apps/todomvc"];
const go = !args.includes("--no-go");
const samples = opt("--samples") ?? "40";
const here = "tools/lean-crosscheck", out = join(here, "out");
mkdirSync(out, { recursive: true });

const sh = (cmd: string, argv: string[], cwd = ".") => {
  const r = spawnSync(cmd, argv, { cwd, encoding: "utf8", maxBuffer: 1 << 28 });
  return { ok: r.status === 0, text: `${r.stdout ?? ""}${r.stderr ?? ""}` };
};
const node = (script: string, ...a: string[]) => sh(process.execPath, ["--no-warnings", script, ...a]);

// the Lean checker, built if it isn't
const exe = join(here, ".lake/build/bin", process.platform === "win32" ? "crosscheck.exe" : "crosscheck");
const lake = [join(homedir(), ".elan/bin", process.platform === "win32" ? "lake.exe" : "lake"), "lake"].find((p) => p === "lake" || existsSync(p))!;
const built = sh(lake, ["build"], here);
if (!built.ok || !existsSync(exe)) { console.error(`the Lean checker didn't build:\n${built.text}`); process.exit(2); }

type Row = { app: string; verdicts: string; lean: string; go: string; bad: boolean };
const rows: Row[] = [];
let port = 13940;
for (const app of apps) {
  const name = basename(app).replace(/\.crud$/, "");
  const ex = join(out, `${name}.json`), cases = join(out, `${name}-cases.json`);
  const row: Row = { app, verdicts: "", lean: "", go: go ? "" : "skipped", bad: false };
  rows.push(row);
  const e = node(join(here, "export.ts"), app, ex);
  row.verdicts = /\d+ verdicts \(([^)]*)\)/.exec(e.text)?.[1] ?? "export failed";
  if (!e.ok) { row.bad = true; console.error(e.text); continue; }
  const l = sh(exe, [ex, "--samples", "300"]);
  const lm = /(\d+) pairs checked, (\d+) agree, (\d+) disagree/.exec(l.text);
  row.lean = lm ? `${lm[2]}/${lm[1]} agree` : "replay failed";
  if (!lm || lm[3] !== "0") { row.bad = true; console.error(l.text.split("\n").filter((x) => /DISAGREE|Z3:/.test(x)).join("\n")); }
  if (!go) continue;
  const c = sh(exe, ["cases", ex, "--samples", samples, "--out", cases]);
  if (!c.ok) { row.go = "cases failed"; row.bad = true; console.error(c.text); continue; }
  const d = node(join(here, "diff-go.ts"), app, ex, cases, "--port", String(port++));
  const dm = /(\d+) cases: (\d+) match, (\d+) inconclusive, (\d+) mismatch/.exec(d.text);
  row.go = dm ? `${dm[2]}/${dm[1]} match${dm[3] !== "0" ? `, ${dm[3]} inconclusive` : ""}${dm[4] !== "0" ? `, ${dm[4]} MISMATCH` : ""}` : "diff failed";
  if (!dm || dm[4] !== "0") { row.bad = true; console.error(d.text.split("\n").filter((x) => /MISMATCH|isn't one Lean|refused it/.test(x)).slice(0, 10).join("\n")); }
}
const w = (k: keyof Row) => Math.max(k.length, ...rows.map((r) => String(r[k]).length));
const line = (r: Record<string, string>) => (["app", "verdicts", "lean", "go"] as const).map((k) => String(r[k]).padEnd(w(k))).join("  ");
console.log(line({ app: "app", verdicts: "prover", lean: "Lean replay", go: "Go vs Lean" }));
for (const r of rows) console.log(line(r as any) + (r.bad ? "  <- check" : ""));
process.exit(rows.some((r) => r.bad) ? 1 : 0);
