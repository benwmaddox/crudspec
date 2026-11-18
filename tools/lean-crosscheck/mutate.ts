// Mutation check for the Lean cross-check: does agreement mean anything?
//
//   node tools/lean-crosscheck/mutate.ts <spec> <workdir> [--samples N] [--kinds require,set]
//
// Each mutant is the spec with one single-line `require` (or `set`) of an action removed (the line
// left blank, so line numbers hold). For each: Z3 proves that action's invariants again, and the
// Lean checker replays each counterexample and searches on its own. A mutant Z3 calls broken and
// Lean replays is a real way to break an invariant both sides see; a replay that fails, or a break
// Lean finds that Z3 calls proven, is a disagreement to look at.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "../../lang/parser.ts";
import { readSpec } from "../../lang/source.ts";

const args = process.argv.slice(2);
const [specPath, work] = args.filter((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
const opt = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
if (!specPath || !work) { console.error("usage: node tools/lean-crosscheck/mutate.ts <spec> <workdir> [--samples N] [--kinds require,set]"); process.exit(64); }
const kinds = new Set((opt("--kinds") ?? "require,set").split(","));
const here = dirname(fileURLToPath(import.meta.url));
const exe = join(here, ".lake", "build", "bin", process.platform === "win32" ? "crosscheck.exe" : "crosscheck");
mkdirSync(work, { recursive: true });

const text = readSpec(specPath);
const lines = text.split("\n");
const spec = parse(text);
type Mutant = { action: string; line: number; what: string };
const mutants: Mutant[] = [];
const walk = (action: string, ss: any[]) => { for (const s of ss ?? []) {
  if (kinds.has(s.kind) && s.pos?.line) {
    const src = lines[s.pos.line - 1].trim();
    // only a statement that is the whole line (and closes there)
    const open = (src.match(/[({[]/g) ?? []).length, close = (src.match(/[)}\]]/g) ?? []).length;
    if (src.startsWith(`${s.kind} `) && open === close) mutants.push({ action, line: s.pos.line, what: src.replace(/\s*\/\/.*$/, "") });
  }
  if (s.kind === "if") { walk(action, s.then); walk(action, s.else); }
  if (s.kind === "foreach" || s.kind === "foreachList") walk(action, s.body);
} };
for (const d of spec.decls) if (d.kind === "action") walk(d.name, d.body);
console.log(`${mutants.length} mutants`);

const rows: any[] = [];
for (const [i, m] of mutants.entries()) {
  const ml = [...lines]; ml[m.line - 1] = "";
  // each mutant in a folder of its own: crudspec reads every .crud file of a folder as one app
  const dir = join(work, `m${i}`); mkdirSync(dir, { recursive: true });
  const mspec = join(dir, basename(specPath)), mout = join(work, `m${i}.json`), rep = join(work, `m${i}-lean.json`);
  writeFileSync(mspec, ml.join("\n"));
  let note = "";
  try { execFileSync(process.execPath, ["--no-warnings", join(here, "export.ts"), mspec, mout, "--only", m.action], { stdio: "pipe" }); }
  catch (e: any) { rows.push({ ...m, error: `export: ${String(e.stderr ?? e).split("\n")[0]}` }); console.log(`m${i} ${m.action}:${m.line} export failed`); continue; }
  try { execFileSync(exe, [mout, "--only", m.action, "--samples", opt("--samples") ?? "300", "--json", rep], { stdio: "pipe" }); }
  catch (e: any) { if (e.status !== 1) note = `lean exit ${e.status}`; }
  const z3 = JSON.parse(readFileSync(mout, "utf8")).results;
  let lean: any = { pairs: [], skipped: [] };
  try { lean = JSON.parse(readFileSync(rep, "utf8")); } catch { note ||= "no lean report"; }
  const z3broken = z3.filter((r: any) => r.status === "broken").map((r: any) => r.invariant);
  const z3unproven = z3.filter((r: any) => r.status === "unproven").map((r: any) => r.invariant);
  const replayed = lean.pairs.filter((p: any) => p.z3 === "broken" && p.agree).map((p: any) => p.invariant);
  const searchFound = lean.pairs.filter((p: any) => /search also found/.test(p.detail) || (p.z3 !== "broken" && p.lean === "breaks it")).map((p: any) => p.invariant);
  const disagree = lean.pairs.filter((p: any) => !p.agree);
  rows.push({ ...m, z3broken, z3unproven, replayed, searchFound, disagree, skipped: lean.skipped, note });
  console.log(`m${i} ${m.action}:${m.line} \`${m.what}\` → Z3 broken [${z3broken}]${z3unproven.length ? ` unproven [${z3unproven}]` : ""}; Lean replayed [${replayed}], search found [${searchFound}]${disagree.length ? `; ${disagree.length} DISAGREE` : ""}${lean.skipped.length ? "; skipped" : ""}${note ? ` (${note})` : ""}`);
}
writeFileSync(join(work, "summary.json"), JSON.stringify(rows, null, 1));
const killed = rows.filter((r) => r.z3broken?.length);
console.log(`\n${mutants.length} mutants: Z3 breaks an invariant in ${killed.length}; Lean replays all of them in ${killed.filter((r) => r.replayed.length === r.z3broken.length).length}; ${rows.filter((r) => r.disagree?.length).length} with a disagreement`);
