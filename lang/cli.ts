// crudspec's command line. Every command works without a terminal and never prompts;
// --json prints a machine-readable result. Exit codes: 0 done, 1 the spec has errors,
// 2 the upgrade is blocked, 64 bad usage.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse, SpecError } from "./parser.ts";
import { check } from "./check.ts";
import type { Plan } from "./runtime/upgrade.ts";

const USAGE = `usage:
  node lang/cli.ts parse <spec>
  node lang/cli.ts check <spec> [--deep] [--json]           --deep adds the type pass: types, and what can be none
  node lang/cli.ts plan <spec> --data <dir> [--json]      what upgrading the database would do, rehearsed on a copy
  node lang/cli.ts migrate <spec> --data <dir> [--json]   upgrade it (the original is kept under <dir>/backups)
  node lang/cli.ts build <spec> --out <dir> [--widgets <file.go>]  the app as a Go program (lang/gogen), then go build if Go is installed
  node lang/cli.ts scaffold <spec>                        the default screens the runtime generates for uncovered actions and views
  node lang/cli.ts review <old-spec> <new-spec> [--probes <file>] [--json]   the change report; exits 2 if it widens access,
                                                          breaks callers or drops data
  node lang/cli.ts describe <app-url> [--json]            the actions and views an agent may call
  node lang/cli.ts call <app-url> <name> [param=value ...] [--args '<json>'] [--dry-run] [--confirm <value>] [--key <idempotency key>] [--json]
the agent commands read the token from --token or CRUDSPEC_TOKEN; call exits 0 ok, 3 invalid, 4 forbidden,
5 not found, 6 unauthenticated, 7 blocked, 8 confirm required, 9 stale, 10 other`;

const [cmd, file, ...rest] = process.argv.slice(2);
const json = rest.includes("--json");
const opt = (name: string) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined; };
if (!cmd || !file || !["parse", "check", "plan", "migrate", "describe", "call", "review", "scaffold", "build"].includes(cmd)) { console.error(USAGE); process.exit(64); }

if (cmd === "build") {
  const out = opt("--out");
  if (!out) { console.error(USAGE); process.exit(64); }
  // validated first, names and types: a spec with errors is never compiled
  const { typecheck } = await import("./types.ts");
  const { withGenerated } = await import("./scaffold.ts");
  const findings = [...check(parse(readFileSync(file, "utf8"))), ...typecheck(withGenerated(parse(readFileSync(file, "utf8")), parse)).findings];
  for (const f of findings) console.log(`${f.severity} ${f.code} line ${f.line}: ${f.message}`);
  if (findings.some((f) => f.severity === "error")) process.exit(1);
  const { writeProgram } = await import("./gogen/gen.ts");
  try { writeProgram(file, out, opt("--widgets")); }
  catch (e) { console.log(`error ${(e as Error).message}`); process.exit(1); }
  const { spawnSync } = await import("node:child_process");
  const t0 = Date.now();
  const r = spawnSync("go", ["build", "-buildvcs=false", "-o", "app" + (process.platform === "win32" ? ".exe" : ""), "."], { cwd: out, stdio: "inherit" });
  if (r.error) { console.log(`wrote ${out}; build it with: cd ${out} && go build -o app .`); process.exit(0); }
  if (r.status !== 0) process.exit(1);
  console.log(`built ${join(out, "app")} in ${Date.now() - t0} ms`);
  process.exit(0);
}

if (cmd === "scaffold") {
  const { scaffold } = await import("./scaffold.ts");
  const out = scaffold(parse(readFileSync(file, "utf8")));
  console.log(out || "// every action and view already has a screen");
  process.exit(0);
}

// ---- the change report between two versions of a spec
if (cmd === "review") {
  const next = rest[0];
  if (!next) { console.error(USAGE); process.exit(64); }
  const { review } = await import("./review.ts");
  const oldSrc = readFileSync(file, "utf8"), newSrc = readFileSync(next, "utf8");
  let oldSpec, newSpec;
  try { oldSpec = parse(oldSrc); newSpec = parse(newSrc); } catch (e) { console.log(`error ${(e as Error).message}`); process.exit(1); }
  const errs = check(newSpec).filter((f) => f.severity === "error");
  if (errs.length) { for (const x of errs) console.log(`error ${x.code} line ${x.line}: ${x.message}`); process.exit(1); }
  const probes = opt("--probes") ? JSON.parse(readFileSync(opt("--probes")!, "utf8")) : undefined;
  const r = review(oldSpec, newSpec, oldSrc, newSrc, probes);
  const attention = (r.behaviour ?? []).some((f) => f.change === "widened") || r.schema.some((s) => s.class === "contract" || s.class === "destructive" || s.class === "blocked");
  if (json) console.log(JSON.stringify(r, null, 2));
  else {
    console.log("Schema and data:"); for (const s of r.schema) console.log(`  ${s.class.padEnd(11)} ${s.detail}`); if (!r.schema.length) console.log("  no change");
    console.log("What agents are told:"); for (const c of r.claims) console.log(`  ${c}`); if (!r.claims.length) console.log("  no change");
    if (!r.behaviour) console.log("Behaviour: not explored (pass --probes <file>; an app's test tools record them)");
    else {
      console.log(`Behaviour: ${r.probes} recorded calls replayed for every actor, ${r.runs} runs${r.incomparable ? `, ${r.incomparable} couldn't be compared` : ""}`);
      for (const f of r.behaviour) { console.log(`  ${f.change === "widened" ? "WIDENED " : "narrowed"} ${f.kind} ${f.name}: ${f.count} case(s)`); for (const e of f.examples) console.log(`             ${e}`); }
      if (!r.behaviour.length) console.log("  no access changed");
    }
  }
  process.exit(attention ? 2 : 0);
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
      for (const c of d.callables) {
        const a = c.annotations, tags = [a.readOnlyHint ? "read-only" : a.destructiveHint ? "destructive" : "additive", a.idempotentHint && !a.readOnlyHint ? "idempotent" : "", a.openWorldHint ? "external" : "", c.confirm ? "needs confirm" : ""].filter(Boolean).join(", ");
        console.log(`  ${c.name}(${c.params.map((p: any) => `${p.name}${p.optional ? "?" : ""}: ${p.type}`).join(", ")})  [${tags}]
      ${c.description}`);
      }
    }
    process.exit(d.outcome ? EXIT[d.outcome] ?? 10 : 0);
  }
  const name = rest[0];
  if (!name) { console.error(USAGE); process.exit(64); }
  const args: Record<string, unknown> = opt("--args") ? JSON.parse(opt("--args")!) : {};
  for (const kv of rest.slice(1)) {
    const m = kv.match(/^([A-Za-z_]\w*)=(.*)$/s); if (!m) continue;
    try { args[m[1]] = JSON.parse(m[2]); } catch { args[m[1]] = m[2]; }
  }
  const body = { args, dry_run: rest.includes("--dry-run"), confirm: opt("--confirm"), idempotency_key: opt("--key") };
  const r = await fetch(`${base}/_agent/call/${name}`, { method: "POST", headers, body: JSON.stringify(body) });
  const out: any = await r.json();
  console.log(JSON.stringify(out, null, json ? 2 : 0));
  process.exit(EXIT[out.outcome] ?? 10);
}

function printPlan(p: Plan) {
  if (json) { console.log(JSON.stringify(p, null, 2)); return; }
  console.log(`${p.status}: version ${p.from?.version ?? "none"} -> ${p.to.version}${p.backup ? ` (backup ${p.backup})` : ""}`);
  for (const s of p.steps) console.log(`  ${s.class.padEnd(11)} ${s.detail}${s.hint ? `\n              fix: ${s.hint}` : ""}`);
  for (const m of p.migrations) console.log(`  migration   "${m.name}" ${m.error ? `failed: ${m.error}` : JSON.stringify(m.changed)}`);
  for (const c of p.checks) console.log(`  violation   ${c.detail}: ${c.count} row(s), e.g. ids ${c.sample.join(", ")}`);
  for (const n of p.notes) console.log(`  note        ${n}`);
}

try {
  const spec = parse(readFileSync(file, "utf8"));
  if (cmd === "parse") {
    const counts: Record<string, number> = {};
    for (const d of spec.decls) counts[d.kind] = (counts[d.kind] ?? 0) + 1;
    console.log(JSON.stringify(counts));
    process.exit(0);
  }
  const findings = check(spec);
  // --deep adds the type pass (lang/types.ts): types, and what can be none
  if (cmd === "check" && rest.includes("--deep")) {
    const { typecheck } = await import("./types.ts");
    const { withGenerated } = await import("./scaffold.ts");
    for (const f of typecheck(withGenerated(parse(readFileSync(file, "utf8")), parse)).findings) findings.push({ severity: f.severity, code: f.code, where: "types", message: f.message, line: f.line });
  }
  const errors = findings.filter((x) => x.severity === "error").length;
  if (cmd === "check" || errors) {
    if (json) console.log(JSON.stringify({ errors, findings }, null, 2));
    else { for (const x of findings) console.log(`${x.severity} ${x.code} line ${x.line} [${x.where}]: ${x.message}`); console.log(`${errors} errors, ${findings.length - errors} warnings`); }
    process.exit(errors ? 1 : 0);
  }
  const data = opt("--data");
  if (!data) { console.error(`${cmd} needs --data <dir>\n${USAGE}`); process.exit(64); }
  // node:sqlite is still marked experimental; its one-time warning is noise here
  process.removeAllListeners("warning");
  const { upgrade } = await import("./runtime/upgrade.ts");
  const plan = upgrade(join(data, "app.sqlite"), spec, { apply: cmd === "migrate" });
  printPlan(plan);
  process.exit(plan.status === "blocked" ? 2 : 0);
} catch (e) {
  if (e instanceof SpecError) { console.log(json ? JSON.stringify({ errors: 1, findings: [{ severity: "error", message: e.message }] }) : `error ${e.message}`); process.exit(1); }
  throw e;
}
