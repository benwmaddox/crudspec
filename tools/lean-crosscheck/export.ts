// Exports a spec and its Z3 invariant verdicts for the Lean cross-check (tools/lean-crosscheck/CrudCheck).
//
//   node tools/lean-crosscheck/export.ts <spec> <out.json> [--timeout <ms>] [--only <action>]
//
// The JSON holds the declarations the checker interprets (entities, enums, functions, predicates,
// triggers, gates, identities, the app, invariants and actions), as the parser gives them without
// source positions, and each (invariant, writer) verdict of lang/invariants.ts with, for a bounded
// counterexample, the run as data (CRUDSPEC_INV_MODELS). The checker reads only this file: it runs
// the actions itself, from the parsed spec, with none of the Z3 encoding's code.
import { writeFileSync } from "node:fs";
import { parse } from "../../lang/parser.ts";
import { readSpec } from "../../lang/source.ts";

const [specPath, outPath] = process.argv.slice(2).filter((a, i, all) => !a.startsWith("--") && !all[i - 1]?.startsWith("--"));
if (!specPath || !outPath) { console.error("usage: node tools/lean-crosscheck/export.ts <spec> <out.json> [--timeout <ms>] [--only <action>]"); process.exit(64); }
const opt = (n: string) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : undefined; };

process.env.CRUDSPEC_INV_MODELS = "1";
const { proveAll, writerNames } = await import("../../lang/invariants.ts");
const spec = parse(readSpec(specPath));
const KINDS = new Set(["entity", "enum", "fn", "predicate", "trigger", "gate", "identity", "app", "invariant", "action", "workflow"]);
const strip = (k: string, v: any) => (k === "pos" ? undefined : v);
const decls = spec.decls.filter((d) => KINDS.has(d.kind)).map((d) => ({ ...JSON.parse(JSON.stringify(d, strip)), line: d.pos?.line }));
const t0 = Date.now();
const only = opt("--only");
const results = await proveAll(specPath, { timeoutMs: Number(opt("--timeout") ?? 6000), ...(only ? { only: [writerNames(spec).indexOf(`action ${only}`)] } : {}) });
// models as arrays of pairs (the Lean side reads arrays, not objects' keys)
const asPairs = (o: Record<string, unknown>) => Object.entries(o);
const out = results.map((r) => !r.model ? r : {
  ...r,
  model: {
    params: asPairs(r.model.params), actor: r.model.actor, now: r.model.now, today: r.model.today, inPlay: r.model.inPlay,
    rows: Object.entries(r.model.rows).map(([entity, rows]) => ({ entity, rows: rows.map((x) => ({ id: x.id, fields: asPairs(x.fields) })) })),
  },
});
writeFileSync(outPath, JSON.stringify({ spec: specPath, decls, results: out }));
const by = (s: string) => results.filter((r) => r.status === s).length;
console.log(`${results.length} verdicts (${by("proven")} proven, ${by("broken")} broken, ${by("unproven")} unproven) in ${Date.now() - t0} ms → ${outPath}`);
