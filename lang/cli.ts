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
  node lang/cli.ts check <spec> [--json]
  node lang/cli.ts plan <spec> --data <dir> [--json]      what upgrading the database would do, rehearsed on a copy
  node lang/cli.ts migrate <spec> --data <dir> [--json]   upgrade it (the original is kept under <dir>/backups)`;

const [cmd, file, ...rest] = process.argv.slice(2);
const json = rest.includes("--json");
const opt = (name: string) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined; };
if (!cmd || !file || !["parse", "check", "plan", "migrate"].includes(cmd)) { console.error(USAGE); process.exit(64); }

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
