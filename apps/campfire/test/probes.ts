// Probe states for `cli review`: every action and view call in the oracle scenarios, with
// the state just before it.
// usage: node apps/campfire/test/probes.ts <spec> <out.json>
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse, type Spec } from "../../../lang/parser.ts";
import { snapshot, type Probe } from "../../../lang/review.ts";
import { runScenario } from "./scenario.ts";

const O = "apps/campfire/oracle";
const SETS = [["slice-v1", "slice-v1-e"], ["smoke", "smoke-10"], ["checker-findings", "findings-1"], ["v2-areas", "v2-areas-h"]];

export function collectProbes(spec: Spec): Probe[] {
  const probes: Probe[] = [];
  for (const [set, golden] of SETS) for (const f of readdirSync(join(O, "golden", golden)).filter((f) => f.endsWith(".json")).sort()) {
    const scenario = JSON.parse(readFileSync(join(O, "scenarios", set, f), "utf8"));
    runScenario(spec, scenario, JSON.parse(readFileSync(join(O, "golden", golden, f), "utf8")), (it, _name, run) => {
      const before = snapshot(it.store, it.clock);
      // capture the call's inputs as the scenario runner makes it
      const orig = it.run.bind(it);
      let rec: any = null;
      it.run = (n: string, args: any, actor: any, request: any, skips: string[] = []) => { rec = { name: n, args, actor, request, skips }; return orig(n, args, actor, request, skips); };
      const r = run();
      it.run = orig;
      if (rec) probes.push({ scenario: scenario.id, ...before, ...rec });
      return r;
    });
  }
  return probes;
}

if (import.meta.main) {
  const [specPath, outPath] = process.argv.slice(2);
  const probes = collectProbes(parse(readFileSync(specPath, "utf8")));
  writeFileSync(outPath, JSON.stringify(probes));
  console.log(`${probes.length} probes from the oracle scenarios -> ${outPath}`);
}
