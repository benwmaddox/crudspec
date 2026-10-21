// crudspec's command line. Every command works without a terminal and never prompts;
// --json prints a machine-readable result. Exit codes: 0 done, 1 the spec has errors,
// 2 the upgrade is blocked, 64 bad usage.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { parse, SpecError } from "./parser.ts";
import { at, locate, readSource, readSpec, specFiles } from "./source.ts";
import { check } from "./check.ts";
import type { Plan } from "./runtime/upgrade.ts";

const USAGE = `usage:
  node lang/cli.ts bind <go package | app dir> [Func…]    the extern lines that bind a Go package's functions (or the app's ext.go), and why others can't be
  node lang/cli.ts reference [--json]                     everything in the language: UI elements and their attributes, field kinds, outcomes, builtins
  node lang/cli.ts parse <spec>
  node lang/cli.ts upgrade-syntax <spec> [--check]           rewrites a spec in the syntax before v3 (if … then, <if>, <let>, <each>, quoted names) in the current one; --check only says what
  node lang/cli.ts check <spec> [--deep] [--json]           --deep adds the type pass (types, what can be none) and the deep checks (lang/deep.ts)
  node lang/cli.ts plan <spec> --data <dir> [--json]      what upgrading the database would do, rehearsed on a copy
  node lang/cli.ts migrate <spec> --data <dir> [--json]   upgrade it (the original is kept under <dir>/backups)
  node lang/cli.ts build <spec> --out <dir> [--widgets <file.go>] [--timeout <ms>]  the app as a Go program (lang/gogen), then go build if Go
                                                          is installed; proves the invariants first (cached), a broken one stops it
  node lang/cli.ts scaffold <spec>                        the default screens the runtime generates for uncovered actions and views
  node lang/cli.ts verify <spec> [--against <old-spec>] [--data <dir>] [--probes <file>] [--timeout <ms>] [--strict] [--no-cache] [--cache <dir>] [--report <file>] [--json]
                                                          everything checked before release (CI, packaging): check --deep, the invariant
                                                          proofs, and the change review; exits 1 on errors or a broken invariant, 2 if the
                                                          review needs a person (--strict: or an invariant is unproven)
  node lang/cli.ts suggest-invariants <spec> --data <dir> [--min <rows>] [--json]   facts the data holds, proven against the actions
  node lang/cli.ts review <old-spec> <new-spec> [--probes <file>] [--data <dir>] [--matrix] [--json]   the change report; exits 2 if it widens access,
                                                          breaks callers or drops data
  node lang/cli.ts describe <app-url> [--overview] [--json] the actions and views an agent may call (--overview: and the app's records and rules)
  node lang/cli.ts call <app-url> <name> [param=value ...] [--file param=path] [--args '<json>'] [--dry-run] [--confirm <value>] [--key <idempotency key>] [--json]
the agent commands read the token from --token or CRUDSPEC_TOKEN; call exits 0 ok, 3 invalid, 4 forbidden,
5 not found, 6 unauthenticated, 7 blocked, 8 confirm required, 9 stale, 10 other`;

const [cmd, fileArg, ...rest] = process.argv.slice(2);
// an app is the .crud files of a directory: a directory names it by its first file (lang/source.ts)
const file = fileArg && !/^https?:/.test(fileArg) && existsSync(fileArg) && statSync(fileArg).isDirectory() ? specFiles(fileArg)[0] : fileArg;
// a line of the app's source as people find it: file.crud:12 when the app has several files
const L = (line: number) => { try { return at(readSource(file), line); } catch { return String(line); } };
// for --json, a finding's place for an editor: its file, and its line in that file
const placed = <T extends { line?: number }>(f: T) => { try { const w = locate(readSource(file), f.line ?? 0); return { ...f, file: w.path, fileLine: w.line }; } catch { return f; } };
// the source line a finding is on, as people read it, with a caret under its column when the
// checker knows it (NO_SNIPPET=1 leaves them out)
const sourceLines = (() => { try { return readSource(file).text.split("\n"); } catch { return [] as string[]; } })();
const snippet = (line: number, col?: number, indent = ""): string => {
  const text = sourceLines[line - 1];
  if (!line || text === undefined || process.env.NO_SNIPPET) return "";
  const n = String(line).length + 1, bar = `${indent}${" ".repeat(n)} |`;
  return `\n${indent}${String(line).padStart(n)} | ${text.replace(/\t/g, " ")}` + (col ? `\n${bar} ${" ".repeat(Math.max(0, col - 1))}^` : "");
};
// the theme classes an app's own widgets read: h.DC("…") in the Go files beside its spec
function widgetClasses(spec: string): string[] {
  const dir = join(spec, "..");
  return readdirSync(dir).filter((f) => f.endsWith(".go")).flatMap((f) => [...readFileSync(join(dir, f), "utf8").matchAll(/DC\("([a-z_]+)"\)/g)].map((m) => m[1]));
}
// the reference, generated from the parser's and checker's own tables (lang/reference.ts)
// the extern lines for a Go package's functions (lang/gogen/bind); Go runs in WSL on Windows
if (cmd === "bind") {
  const { spawnSync } = await import("node:child_process");
  const { dirname, resolve } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const { existsSync } = await import("node:fs");
  const gogen = resolve(dirname(fileURLToPath(import.meta.url)), "gogen");
  const win = process.platform === "win32";
  const wslPath = (x: string) => resolve(x).replace(/^([A-Za-z]):/, (_m, d) => `/mnt/${d.toLowerCase()}`).replace(/\\/g, "/");
  const target = file && existsSync(file) ? (win ? wslPath(file) : resolve(file)) : file;
  if (!target) { console.error("usage: node lang/cli.ts bind <go package | app dir> [Func…]"); process.exit(64); }
  const r = win
    ? spawnSync("wsl", ["-e", "bash", "-c", `cd ${wslPath(gogen)} && PATH=$PATH:/usr/local/go/bin go run ./bind "$@"`, "bind", target, ...rest], { stdio: "inherit" })
    : spawnSync("go", ["run", "./bind", target, ...rest], { cwd: gogen, stdio: "inherit" });
  process.exit(r.status ?? 1);
}
// a spec in the syntax before v3, rewritten in the current one (lang/syntax-upgrade.ts)
if (cmd === "upgrade-syntax") {
  if (!file) { console.error("usage: node lang/cli.ts upgrade-syntax <spec> [--check]"); process.exit(64); }
  const { upgradeSyntax } = await import("./syntax-upgrade.ts");
  const { writeFileSync } = await import("node:fs");
  // the app's files together (a component one declares, another uses), each after a marker line
  const files = specFiles(file);
  const MARK = "// @@crudspec-upgrade-file ";
  const texts = files.map((f) => readFileSync(f, "utf8"));
  const src = files.length === 1 ? texts[0] : files.map((f, i) => `${MARK}${i}\n${texts[i]}`).join("\n");
  try {
    const u = upgradeSyntax(src);
    const said = Object.entries(u.counts).map(([w, n]) => `${n} ${w}`).join(", ");
    const out = files.length === 1 ? [u.text] : u.text.split(new RegExp(`^${MARK}\\d+\\n`, "m")).slice(1).map((t, i) => (i < files.length - 1 ? t.slice(0, -1) : t));
    const changed = files.filter((_, i) => out[i] !== texts[i]);
    if (!changed.length) console.log(`${file}: already in the current syntax`);
    else if (rest.includes("--check")) { console.log(`${changed.join(", ")}: would rewrite ${said}`); process.exit(1); }
    else { files.forEach((f, i) => { if (out[i] !== texts[i]) writeFileSync(f, out[i]); }); console.log(`${changed.join(", ")}: rewrote ${said} (the same program, checked)`); }
    process.exit(0);
  } catch (e: any) { console.error(`${file}: ${e.message}`); process.exit(1); }
}
if (cmd === "reference") {
  const { reference, referenceData } = await import("./reference.ts");
  console.log(process.argv.includes("--json") ? JSON.stringify(referenceData(), null, 2) : reference());
  process.exit(0);
}
const json = rest.includes("--json");
// the type pass (lang/types.ts), the deep checks (lang/deep.ts), and what the queries cost as
// SQLite plans them on the app's schema (lang/cost.ts)
type Finding = ReturnType<typeof check>[number];
async function deepFindings(spec: ReturnType<typeof parse>, file: string, before: Finding[]): Promise<Finding[]> {
  const out: Finding[] = [];
  // a pass that fails on a spec with errors already is explained by them; on one without, the
  // failure is the checker's, and is reported as a finding (with the other passes' findings)
  const pass = async (where: string, run: () => Promise<void>) => {
    try { await run(); } catch (e) {
      if (![...before, ...out].some((f) => f.severity === "error"))
        out.push({ severity: "error", code: "CHECK_CRASHED", where, message: `the ${where} pass failed on this spec, which is a bug in crudspec: ${(e as Error).message.split("\n")[0]}`, line: 0 });
    }
  };
  await pass("types", async () => {
    const { typecheck } = await import("./types.ts");
    const { withGenerated } = await import("./scaffold.ts");
    for (const f of typecheck(withGenerated(parse(readSpec(file)), parse)).findings) out.push({ severity: f.severity, code: f.code, where: "types", message: f.message, line: f.line, col: f.col });
  });
  await pass("deep", async () => {
    const { deepCheck } = await import("./deep.ts");
    for (const f of deepCheck(spec)) out.push({ severity: f.severity, code: f.code, where: "deep", message: f.message, line: f.line });
  });
  // the costs need the app generated, which a spec with errors can't be
  if ([...before, ...out].some((f) => f.severity === "error")) return out;
  await pass("cost", async () => {
    const gen = await import("./gogen/gen.ts");
    const cost = await import("./cost.ts");
    gen.generate(file);
    const rep = gen.lastCost!;
    const lineOf = (decl: string) => { const [kind, name] = decl.split(" "); return spec.decls.find((d) => d.kind === kind && d.name === name)?.pos.line ?? 0; };
    for (const f of cost.findings(rep.planned, rep.indexes, rep.auto, lineOf, rep.declared)) out.push({ severity: f.severity, code: f.code, where: "cost", message: f.message, line: f.line });
  });
  return out;
}
const opt = (name: string) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined; };
if (!cmd || !file || !["parse", "check", "plan", "migrate", "describe", "call", "review", "scaffold", "build", "verify", "suggest-invariants"].includes(cmd)) { console.error(USAGE); process.exit(64); }

if (cmd === "build") {
  const out = opt("--out");
  if (!out) { console.error(USAGE); process.exit(64); }
  // validated first, names and types: a spec with errors is never compiled
  const { typecheck } = await import("./types.ts");
  const { withGenerated } = await import("./scaffold.ts");
  const { deepCheck } = await import("./deep.ts");
  const findings = [...check(parse(readSpec(file)), { widgetClasses: widgetClasses(file) }), ...typecheck(withGenerated(parse(readSpec(file)), parse)).findings, ...deepCheck(parse(readSpec(file)))]
    .filter((f, i, all) => all.findIndex((g) => g.line === f.line && g.message === f.message) === i);   // one pass saying what another did is one finding
  for (const f of findings) console.log(`${f.severity} ${f.code} line ${L(f.line)}: ${f.message}${snippet(f.line, (f as any).col)}`);
  if (findings.some((f) => f.severity === "error")) process.exit(1);
  // the invariants, proven with a shorter limit than verify's (each writer from the cache when
  // nothing it depends on changed): a broken one is an error, as a type error is
  const tp = Date.now();
  const { invariants, cachedCount } = await provedWithCache(parse(readSpec(file)), Number(opt("--timeout") ?? 6000));
  if (invariants.length) {
    const broken = invariants.filter((r) => r.status === "broken"), unproven = invariants.filter((r) => r.status === "unproven");
    for (const r of broken) console.log(`error INVARIANT_BROKEN line ${L(r.line)}: ${r.invariant} is broken by ${r.where}${r.whereLine ? ` (line ${L(r.whereLine)})` : ""}: ${r.counterexample}`);
    const writers = new Set(invariants.map((r) => r.where)).size;
    console.log(`invariants: ${invariants.length - broken.length - unproven.length} proven, ${broken.length} broken, ${unproven.length} unproven${unproven.length ? " (checked when those writers run)" : ""}, in ${Date.now() - tp} ms (${cachedCount} of ${writers} writers from the cache)`);
    if (broken.length) process.exit(1);
  }
  const { writeProgram, setBackstops } = await import("./gogen/gen.ts");
  // what the proofs couldn't settle, the app checks as it runs: an action refuses, a step reports
  setBackstops(new Set(invariants.filter((r) => r.status === "unproven").map((r) => `${r.where}|${r.invariant}`)));
  try { writeProgram(file, out, opt("--widgets")); }
  catch (e) { console.log(`error ${(e as Error).message}`); process.exit(1); }
  const { spawnSync } = await import("node:child_process");
  const t0 = Date.now();
  // the spec's pinned Go modules: fetched at their versions, their checksums kept in the app's
  // go.sum beside the spec (commit it; a later build checks every module against it)
  const imports = [...readSpec(file).matchAll(/^\s*import\s+go\s+"([^"]+@[^"]+)"/gm)].map((m) => m[1]);
  if (imports.length) {
    const g = spawnSync("go", ["get", ...imports], { cwd: out, stdio: "inherit" });
    if (g.error || g.status !== 0) { console.log(`error fetching the Go modules ${imports.join(", ")}`); process.exit(1); }
    const { dirname: dn } = await import("node:path");
    const { writeFileSync: wf, existsSync: ex } = await import("node:fs");
    const base = new Set(readFileSync(new URL("./gogen/go.sum", import.meta.url), "utf8").split("\n"));
    const appSum = join(dn(file), "go.sum");
    const lines = new Set([...(ex(appSum) ? readFileSync(appSum, "utf8").split("\n") : []), ...readFileSync(join(out, "go.sum"), "utf8").split("\n")].filter((l) => l && !base.has(l)));
    wf(appSum, [...lines].sort().join("\n") + "\n");
  }
  const r = spawnSync("go", ["build", "-buildvcs=false", "-o", "app" + (process.platform === "win32" ? ".exe" : ""), "."], { cwd: out, stdio: "inherit" });
  if (r.error) { console.log(`wrote ${out}; build it with: cd ${out} && go build -o app .`); process.exit(0); }
  if (r.status !== 0) process.exit(1);
  console.log(`built ${join(out, "app")} in ${Date.now() - t0} ms`);
  process.exit(0);
}

if (cmd === "scaffold") {
  const { scaffold } = await import("./scaffold.ts");
  const out = scaffold(parse(readSpec(file)));
  console.log(out || "// every action and view already has a screen");
  process.exit(0);
}

// ---- the change report between two versions of a spec
// the change report from one spec to the next (lang/review.ts); attention: it widens access,
// breaks callers or drops data
async function changeReview(oldArg: string, newArg: string) {
  const { review } = await import("./review.ts");
  // each version is an app: a directory of .crud files, or one of them
  const first = (p: string) => (statSync(p).isDirectory() ? specFiles(p)[0] : p);
  const oldFile = first(oldArg), newFile = first(newArg);
  const oldSrc = readSpec(oldFile), newSrc = readSpec(newFile);
  const oldSpec = parse(oldSrc), newSpec = parse(newSrc);
  const probes = opt("--probes") ? JSON.parse(readFileSync(opt("--probes")!, "utf8")) : undefined;
  const { compiledApp } = await import("./gogen/program.ts");
  const r = review(oldSpec, newSpec, oldSrc, newSrc, probes, probes ? { old: compiledApp(oldFile), new: compiledApp(newFile) } : undefined);
  // the rows a real database has that the upgrade's checked and destructive steps touch
  let atRisk: string[] | undefined;
  if (opt("--data")) {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(join(opt("--data")!, "app.sqlite"), { readOnly: true });
    const { dataAtRisk, scheduleFirstRuns } = await import("./review.ts");
    const count = (sql: string) => Number(Object.values(db.prepare(sql).get() as object)[0]);
    atRisk = [...dataAtRisk(r.schema, count), ...scheduleFirstRuns(oldSpec, newSpec, Date.now(), count)];
    db.close();
  }
  // what a person or an agent is shown: a screen's, a component's, a view's or an export's reads
  // (an action's, a function's, a trigger's or a workflow's are its working, not shown)
  const exposed = r.exposure.some((x) => / now (reads|returns|writes) |^new |now writes something else/.test(x) && !/^(new )?(action|fn|predicate|trigger|workflow|internal) /.test(x));
  const attention = exposed || (r.behaviour ?? []).some((f) => f.change === "widened") || r.schema.some((s) => s.class === "contract" || s.class === "destructive" || s.class === "blocked");
  // what each version's queries cost, as SQLite plans them (a spec the generator refuses has none)
  const { costReview } = await import("./review.ts");
  let queries: { slower: string[]; faster: string[] } | undefined;
  try { queries = await costReview(oldFile, newFile); } catch { queries = undefined; }
  // who can see and change each field, before and after; a new reader or writer widens access
  const { accessMatrix, accessDiff } = await import("./review.ts");
  const access = accessDiff(accessMatrix(oldSpec), accessMatrix(newSpec));
  const widened = access.some((x) => / can now be (seen|changed|deleted|called) by /.test(x));
  return { ...r, atRisk, queries, access, attention: attention || widened };
}
function printReview(r: Awaited<ReturnType<typeof changeReview>>) {
  console.log("Schema and data:"); for (const s of r.schema) console.log(`  ${s.class.padEnd(11)} ${s.detail}`); if (!r.schema.length) console.log("  no change");
  if (r.atRisk) { console.log("Rows at risk (--data):"); for (const x of r.atRisk) console.log(`  ${x}`); if (!r.atRisk.length) console.log("  none"); }
  console.log("Outcomes:"); for (const x of r.outcomes) console.log(`  ${x}`); if (!r.outcomes.length) console.log("  no change");
  console.log("What screens show and views return:"); for (const x of r.exposure) console.log(`  ${x}`); if (!r.exposure.length) console.log("  no change");
  console.log("Who can see and change each field, delete each entity's rows, and call each extern:"); for (const x of r.access) console.log(`  ${x}`); if (!r.access.length) console.log("  no change");
  if (r.queries) { console.log("Query costs:"); for (const x of r.queries.slower) console.log(`  slower  ${x}`); for (const x of r.queries.faster) console.log(`  faster  ${x}`); if (!r.queries.slower.length && !r.queries.faster.length) console.log("  no change"); }
  console.log("What agents are told:"); for (const c of r.claims) console.log(`  ${c}`); if (!r.claims.length) console.log("  no change");
  if (!r.behaviour) console.log("Behaviour: not explored (pass --probes <file>; an app's test tools record them)");
  else {
    console.log(`Behaviour: ${r.probes} recorded calls replayed for every actor, ${r.runs} runs${r.incomparable ? `, ${r.incomparable} couldn't be compared` : ""}`);
    for (const f of r.behaviour) { console.log(`  ${f.change === "widened" ? "WIDENED " : "narrowed"} ${f.kind} ${f.name}: ${f.count} case(s)`); for (const e of f.examples) console.log(`             ${e}`); }
    if (!r.behaviour.length) console.log("  no access changed");
  }
}
if (cmd === "review") {
  const next = rest[0];
  if (!next) { console.error(USAGE); process.exit(64); }
  try { parse(readSpec(file)); const errs = check(parse(readSpec(next))).filter((f) => f.severity === "error"); if (errs.length) { for (const x of errs) console.log(`error ${x.code} line ${at(readSource(next), x.line)}: ${x.message}`); process.exit(1); } }
  catch (e) { console.log(`error ${(e as Error).message}`); process.exit(1); }
  const r = await changeReview(file, next);
  // the whole matrix, of the new version
  if (rest.includes("--matrix")) {
    const { accessMatrix, showEntry } = await import("./review.ts");
    const m = accessMatrix(parse(readSpec(next)));
    console.log("Who can see and change each field (the new version):");
    for (const k of [...m.keys()].sort()) { const x = m.get(k)!; console.log(`  ${k}`); for (const w of x.see) console.log(`    sees     ${showEntry(w)}`); for (const w of x.change) console.log(`    changes  ${showEntry(w)}`); for (const w of x.remove) console.log(`    deletes  ${showEntry(w)}`); for (const w of x.call) console.log(`    calls    ${showEntry(w)}`); }
  }
  if (json) { const { attention: _, ...out } = r; console.log(JSON.stringify(out, null, 2)); } else printReview(r);
  process.exit(r.attention ? 2 : 0);
}

// candidate invariants: facts the data holds (the compiled app mines them: rt/suggest.go), proven
// against the spec's actions. They are proven together and the ones not proven dropped, again until
// none is, so each kept one holds given the others (each proof assumes every invariant before)
if (cmd === "suggest-invariants") {
  const data = opt("--data");
  if (!data) { console.error("usage: node lang/cli.ts suggest-invariants <spec> --data <dir> [--min <rows>] [--timeout <ms>] [--json]"); process.exit(64); }
  const { mkdirSync, mkdtempSync, copyFileSync, writeFileSync, existsSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { compiledApp } = await import("./gogen/program.ts");
  const { proveAll } = await import("./invariants.ts");
  const src = readSpec(file);
  const spec = parse(src);
  const tmp = mkdtempSync(join(tmpdir(), "suggest-"));
  const db = join(tmp, "app.sqlite");
  copyFileSync(join(data, "app.sqlite"), db);
  for (const ext of ["-wal", "-shm"]) if (existsSync(join(data, "app.sqlite" + ext))) copyFileSync(join(data, "app.sqlite" + ext), db + ext);
  const app = compiledApp(file);
  const r = app.run(["suggest-invariants", "--db", app.path(db), "--min", opt("--min") ?? "5"], "");
  let found: { kind: string; entity: string; invariant: string; needs?: string[]; rows: number }[];
  try { found = JSON.parse(r.stdout); } catch { console.error(`the app's suggest-invariants failed: ${(r.stderr || r.stdout).trim()}`); process.exit(1); }
  // the ones the spec already states, as written, aren't put forward again
  const stated = new Set(spec.decls.filter((d) => d.kind === "invariant").map((d) => src.split("\n")[d.pos.line - 1].replace(/^invariant \w+:\s*/, "").trim()));
  let cands = found.filter((c) => !stated.has(c.invariant)).map((c, i) => ({ ...c, name: `suggested_${i + 1}` }));
  const declared = new Set(spec.decls.map((d) => d.name));
  const specWith = (cs: typeof cands) => {
    const needs = [...new Set(cs.flatMap((c) => c.needs ?? []))].filter((n) => !declared.has(n.match(/^predicate (\w+)/)?.[1] ?? ""));
    return `${src}\n\n${needs.join("\n")}\n${cs.map((c) => `invariant ${c.name}: ${c.invariant}`).join("\n")}\n`;
  };
  // a candidate the checks refuse (its types don't fit the spec as written) is dropped first
  cands = cands.filter((c) => { try { return !check(parse(specWith([c]))).some((f) => f.severity === "error"); } catch { return false; } });
  const dropped: { c: (typeof cands)[number]; why: string }[] = [];
  const timeoutMs = Number(opt("--timeout") ?? 6000);
  for (let round = 1; cands.length; round++) {
    // each round an app of its own (an app is a directory's .crud files)
    const f = join(tmp, `round${round}`, "app.crud");
    mkdirSync(join(tmp, `round${round}`));
    writeFileSync(f, specWith(cands));
    const rs = await proveAll(f, { timeoutMs });
    const bad = new Map<string, string>();
    for (const x of rs) if (x.status !== "proven" && x.invariant.startsWith("suggested_") && !bad.has(x.invariant)) bad.set(x.invariant, x.status === "broken" ? `${x.where} breaks it: ${x.counterexample}` : `unproven in ${x.where}: ${x.reason}`);
    if (!json) console.error(`round ${round}: ${cands.length} candidates, ${bad.size} dropped`);
    if (!bad.size) break;
    for (const c of cands) if (bad.has(c.name)) dropped.push({ c, why: bad.get(c.name)! });
    cands = cands.filter((c) => !bad.has(c.name));
  }
  if (json) console.log(JSON.stringify({ proven: cands, dropped: dropped.map((d) => ({ ...d.c, why: d.why })) }, null, 2));
  else {
    const seen: Record<string, number> = {};
    console.log(`Facts the data holds that no action can break (${cands.length}):`);
    for (const c of cands) { for (const n of c.needs ?? []) if (!declared.has(n.match(/^predicate (\w+)/)?.[1] ?? "")) console.log(`  ${n}`); console.log(`  invariant ${c.entity.toLowerCase()}_${c.kind.replace(/ /g, "_")}_${(seen[c.entity + c.kind] = (seen[c.entity + c.kind] ?? 0) + 1)}: ${c.invariant}    // ${c.rows} rows`); }
    console.log(`Facts the data holds that an action can break (${dropped.filter((d) => /breaks it/.test(d.why)).length}): a case the data hasn't met yet, or a fact to enforce`);
    for (const d of dropped.filter((x) => /breaks it/.test(x.why))) console.log(`  ${d.c.invariant}    // ${d.c.rows} rows; ${d.why}`);
    const un = dropped.filter((d) => !/breaks it/.test(d.why)).length;
    if (un) console.log(`(${un} more the proof couldn't settle; --json lists them)`);
  }
  process.exit(0);
}

// ---- agent commands, against a running app
if (cmd === "describe" || cmd === "call") {
  const token = opt("--token") ?? process.env.CRUDSPEC_TOKEN;
  if (!token) { console.error(`${cmd} needs a token: --token <t> or CRUDSPEC_TOKEN (a person issues one at <app>/_agents)`); process.exit(64); }
  const base = file.replace(/\/$/, "");
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const EXIT: Record<string, number> = { ok: 0, invalid: 3, forbidden: 4, not_found: 5, unknown: 5, unauthenticated: 6, blocked: 7, confirm_required: 8, stale: 9 };
  if (cmd === "describe") {
    const r = await fetch(`${base}/_agent/describe`, { headers });
    const d: any = await r.json();
    if (json || d.outcome) console.log(JSON.stringify(d, null, 2));
    else {
      console.log(`${d.app}, acting as ${d.actor} (${d.scope} access)`);
      if (d.overview && rest.includes("--overview")) console.log("\n" + d.overview + "\n");
      // what a call does to existing rows, said plainly: MCP's destructiveHint covers any update
      const what = (c: any) => c.kind === "view" || c.annotations.readOnlyHint ? "read-only" : c.effects.deletes.length ? "deletes rows" : Object.keys(c.effects.updates).length ? "updates rows" : "adds rows";
      for (const c of d.callables) {
        const a = c.annotations, tags = [what(c), a.idempotentHint && !a.readOnlyHint ? "idempotent" : "", a.openWorldHint ? "external" : "", c.confirm ? "needs confirm" : ""].filter(Boolean).join(", ");
        console.log(`  ${c.name}(${c.params.map((p: any) => `${p.name}${p.optional ? "?" : ""}: ${p.type}`).join(", ")})  [${tags}]
      ${c.description}`);
      }
      if (d.overview && !rest.includes("--overview")) console.log("\n(--overview prints the app's records, rules and how calls work)");
    }
    process.exitCode = d.outcome ? EXIT[d.outcome] ?? 10 : 0;
  } else {
    const name = rest[0];
    if (!name) { console.error(USAGE); process.exit(64); }
    const args: Record<string, unknown> = opt("--args") ? JSON.parse(opt("--args")!) : {};
    for (const kv of rest.slice(1)) {
      const m = kv.match(/^([A-Za-z_]\w*)=(.*)$/s); if (!m) continue;
      try { args[m[1]] = JSON.parse(m[2]); } catch { args[m[1]] = m[2]; }
    }
    // --file name=path: a File argument, read and sent inline
    rest.forEach((x, i) => {
      const m = x === "--file" ? rest[i + 1]?.match(/^([A-Za-z_]\w*)=(.+)$/s) : null;
      if (m) args[m[1]] = { filename: basename(m[2]), data: readFileSync(m[2]).toString("base64") };
    });
    const body = { args, dry_run: rest.includes("--dry-run"), confirm: opt("--confirm"), idempotency_key: opt("--key") };
    const r = await fetch(`${base}/_agent/call/${name}`, { method: "POST", headers, body: JSON.stringify(body) });
    const out: any = await r.json();
    console.log(JSON.stringify(out, null, json ? 2 : 0));
    process.exitCode = EXIT[out.outcome] ?? 10;
  }
}

// the invariant proofs, each writer's taken from the cache when nothing its proofs depend on
// changed (lang/invariants.ts proofKeys). The cache is .crudspec-cache/invariants.json beside
// the spec (--cache <dir>, --no-cache); an entry no build or verify used for 30 days is let go
type Proved = import("./invariants.ts").InvResult & { cached?: boolean };
async function provedWithCache(spec: ReturnType<typeof parse>, timeoutMs: number): Promise<{ invariants: Proved[]; cachedCount: number }> {
  const { dirname } = await import("node:path");
  const { existsSync, mkdirSync, writeFileSync } = await import("node:fs");
  const inv = await import("./invariants.ts");
  const lineOf = new Map(spec.decls.filter((d) => d.kind === "invariant").map((d) => [d.name, d.pos.line]));
  // a writer's line, as the spec is now (a cached result's could have moved)
  const writerLine = new Map<string, number>([...spec.decls.filter((d) => d.kind === "action").map((d) => [`action ${d.name}`, d.pos.line] as [string, number]), ...spec.decls.filter((d) => d.kind === "workflow").flatMap((w: any) => w.steps.map((st: any) => [`${w.name}: ${st.name}`, st.pos?.line ?? w.pos.line] as [string, number]))]);
  if (!lineOf.size) return { invariants: [], cachedCount: 0 };
  const useCache = !rest.includes("--no-cache");
  const cacheFile = join(opt("--cache") ?? join(dirname(file), ".crudspec-cache"), "invariants.json");
  type Entry = { used: number; results: Omit<import("./invariants.ts").InvResult, "line">[] };
  let cache: Record<string, Entry> = {};
  if (useCache && existsSync(cacheFile)) { try { const c = JSON.parse(readFileSync(cacheFile, "utf8")); if (c.format === 2) cache = c.entries; } catch { /* a damaged cache: proved again */ } }
  const keys = await inv.proofKeys(spec, timeoutMs), names = inv.writerNames(spec);
  const todo = keys.flatMap((k, i) => (cache[k] ? [] : [i]));
  const proved = todo.length ? await inv.proveAll(file, { timeoutMs, only: todo }) : [];
  const fresh = new Map<string, import("./invariants.ts").InvResult[]>();
  for (const r of proved) { const k = keys[names.indexOf(r.where)]; fresh.set(k, [...(fresh.get(k) ?? []), r]); }
  const invariants: Proved[] = [];
  let cachedCount = 0;
  const now = Date.now();
  for (const k of keys) {
    const got = fresh.get(k);
    if (got) invariants.push(...got);
    else if (cache[k]) { cachedCount++; cache[k].used = now; invariants.push(...cache[k].results.map((r) => ({ ...r, line: lineOf.get(r.invariant) ?? 0, whereLine: writerLine.get(r.where), cached: true }))); }
  }
  // a time limit reached or Z3 out of memory comes again on the same inputs, so it is kept too
  // (the limit is in the key); a process that stopped some other way may not, and isn't
  for (const [k, rs] of fresh) if (rs.every((r) => r.status !== "unproven" || !/the proof stopped/.test(r.reason ?? "")))     cache[k] = { used: now, results: rs.map(({ line: _, whereLine: __, ...r }) => r) };
  if (useCache) {
    for (const [k, e] of Object.entries(cache)) if (now - e.used > 30 * 86400e3) delete cache[k];
    mkdirSync(dirname(cacheFile), { recursive: true }); writeFileSync(cacheFile, JSON.stringify({ format: 2, entries: cache }));
  }
  return { invariants, cachedCount };
}
// everything that can be checked before release, for CI or packaging: the checks, the deep
// checks and query costs, the invariant proofs (with longer limits; a writer whose proofs depend
// on nothing that changed is taken from the cache), and with --against <old spec> the change
// review. Exits 1 on an error or a broken invariant, 2 if the review needs a person (or, with
// --strict, an invariant is unproven), else 0. --report <file> writes the JSON too
async function verify(spec: ReturnType<typeof parse>, findings: Finding[]): Promise<never> {
  const { writeFileSync } = await import("node:fs");
  const errors = findings.filter((x) => x.severity === "error");
  // proofs are only worth something for a spec that checks
  const { invariants, cachedCount } = errors.length ? { invariants: [], cachedCount: 0 } : await provedWithCache(spec, Number(opt("--timeout") ?? 20000));
  const broken = invariants.filter((r) => r.status === "broken"), unproven = invariants.filter((r) => r.status === "unproven");
  const against = opt("--against");
  let review: Awaited<ReturnType<typeof changeReview>> | undefined;
  if (against && !errors.length) review = await changeReview(against, file);
  const failed = errors.length > 0 || broken.length > 0;
  const attention = !failed && (!!review?.attention || (rest.includes("--strict") && unproven.length > 0));
  const result = failed ? "failed" : attention ? "needs review" : "passed";
  const report = { result, errors: errors.length, findings, invariants: { proven: invariants.length - broken.length - unproven.length, broken: broken.length, unproven: unproven.length, fromCache: cachedCount, results: invariants }, review };
  if (opt("--report")) writeFileSync(opt("--report")!, JSON.stringify(report, null, 2));
  if (json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`Checks: ${errors.length} errors, ${findings.length - errors.length} warnings`);
    for (const x of findings) console.log(`  ${x.severity} ${x.code} line ${L(x.line)} [${x.where}]: ${x.message}${snippet(x.line, x.col, "  ")}`);
    if (errors.length) console.log("Invariants: not proven (the spec has errors)");
    else if (!invariants.length) console.log("Invariants: none declared");
    else {
      console.log(`Invariants: ${report.invariants.proven} proven, ${broken.length} broken, ${unproven.length} unproven (${invariants.length} checks${cachedCount ? `, ${cachedCount} writers from the cache` : ""})`);
      for (const r of broken) console.log(`  BROKEN   ${r.invariant} (line ${L(r.line)}) by ${r.where}${r.whereLine ? ` (line ${L(r.whereLine)})` : ""}: ${r.counterexample}`);
      for (const r of unproven) console.log(`  unproven ${r.invariant} (line ${L(r.line)}) in ${r.where}: ${r.reason}`);
    }
    if (review) { console.log(`Change review against ${against}:`); printReview(review); }
    console.log(`verify: ${result}`);
  }
  process.exit(failed ? 1 : attention ? 2 : 0);
}
function printPlan(p: Plan) {
  if (json) { console.log(JSON.stringify(p, null, 2)); return; }
  console.log(`${p.status}: version ${p.from?.version ?? "none"} -> ${p.to.version}${p.backup ? ` (backup ${p.backup})` : ""}`);
  for (const s of p.steps) console.log(`  ${s.class.padEnd(11)} ${s.detail}${s.hint ? `\n              fix: ${s.hint}` : ""}`);
  for (const m of p.migrations) console.log(`  migration   "${m.name}" ${m.error ? `failed: ${m.error}` : JSON.stringify(m.changed)}`);
  for (const c of p.checks) console.log(`  violation   ${c.detail}: ${c.count} row(s), e.g. ids ${c.sample.join(", ")}`);
  for (const n of p.notes) console.log(`  note        ${n}`);
}

// (the agent commands above end by setting the exit code: process.exit after a fetch trips a libuv
// assertion on Windows)
if (cmd !== "describe" && cmd !== "call") try {
  const spec = parse(readSpec(file));
  if (cmd === "parse") {
    const counts: Record<string, number> = {};
    for (const d of spec.decls) counts[d.kind] = (counts[d.kind] ?? 0) + 1;
    console.log(JSON.stringify(counts));
    process.exit(0);
  }
  const findings = check(spec, { widgetClasses: widgetClasses(file), source: readSpec(file) });
  // --deep adds the type pass (lang/types.ts): types, and what can be none
  // a later pass saying what an earlier one said, at the same line, is one finding
  if ((cmd === "check" && rest.includes("--deep")) || cmd === "verify") for (const f of await deepFindings(spec, file, findings))
    if (!findings.some((g) => g.line === f.line && g.message === f.message)) findings.push(f);
  const errors = findings.filter((x) => x.severity === "error").length;
  if (cmd === "verify") await verify(spec, findings);
  if (cmd === "check" || errors) {
    if (json) console.log(JSON.stringify({ errors, findings: findings.map(placed) }, null, 2));
    else { for (const x of [...findings].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "error" ? -1 : 1) || (a.line ?? 0) - (b.line ?? 0))) console.log(`${x.severity} ${x.code} line ${L(x.line)} [${x.where}]: ${x.message}${snippet(x.line, x.col)}`); console.log(`${errors} errors, ${findings.length - errors} warnings`); }
    process.exit(errors ? 1 : 0);
  }
  const data = opt("--data");
  if (!data) { console.error(`${cmd} needs --data <dir>\n${USAGE}`); process.exit(64); }
  // node:sqlite is still marked experimental; its one-time warning is noise here
  process.removeAllListeners("warning");
  const { upgrade } = await import("./runtime/upgrade.ts");
  const { compiledApp } = await import("./gogen/program.ts");
  const plan = upgrade(join(data, "app.sqlite"), spec, { apply: cmd === "migrate", app: compiledApp(file) });
  printPlan(plan);
  process.exit(plan.status === "blocked" ? 2 : 0);
} catch (e) {
  if (e instanceof SpecError && cmd === "verify" && opt("--report")) (await import("node:fs")).writeFileSync(opt("--report")!, JSON.stringify({ result: "failed", errors: 1, findings: [{ severity: "error", message: e.message }] }, null, 2));
  if (e instanceof SpecError) { console.log(json ? JSON.stringify({ errors: 1, findings: [placed({ severity: "error", code: e.code, where: "parse", message: e.message.replace(/^\d+:\d+ [A-Z_]+: /, ""), line: e.pos.line, col: e.pos.col })] }) : `error ${e.message.replace(/^(\d+):(\d+)/, (_m: string, l: string, c: string) => `${L(Number(l))}:${c}`)}${snippet(e.pos.line, e.pos.col)}`); process.exit(1); }
  throw e;
}
