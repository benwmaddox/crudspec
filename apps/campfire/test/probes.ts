// Probe states for `cli review`: every action and view call in the oracle scenarios, with
// the state just before it, recorded by replaying them against the compiled app.
// usage: node apps/campfire/test/probes.ts <spec> <out.json>
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Probe } from "../../../lang/review.ts";
import { startApp } from "../../../lang/test/go-app.ts";

const O = "apps/campfire/oracle";
const SETS = [["slice-v1", "slice-v1-e"], ["smoke", "smoke-10"], ["checker-findings", "findings-1"], ["v2-areas", "v2-areas-h"]];

export async function collectProbes(specPath: string, port = 13830): Promise<Probe[]> {
  const out = join(mkdtempSync(join(tmpdir(), "crudspec-probes-")), "probes.json");
  const app = await startApp(specPath, port);
  try {
    for (const [set, golden] of SETS) {
      const r = spawnSync(process.execPath, ["apps/campfire/test/replay-runtime.ts", specPath, app.base, join(O, "scenarios", set), join(O, "golden", golden)], { env: { ...process.env, REPLAY_PROBES: out }, encoding: "utf8" });
      // judged by its result line, declared departures counting: Node on Windows can fail an assertion as it exits
      const m = /(\d+)\/(\d+) scenarios match[^;\n]*(?:; (\d+) departs? from it as declared)?/.exec(r.stdout ?? "");
      if (!m || Number(m[1]) + Number(m[3] ?? 0) !== Number(m[2])) throw new Error(`replaying ${set} failed:\n${r.stdout}\n${r.stderr}`);
    }
  } finally { app.stop(); }
  // the links the states hold were signed with the app's secret: the probes carry it
  const secretPath = `${app.dir}/data/secret`;
  const secret = process.platform === "win32" ? spawnSync("wsl", ["-e", "cat", secretPath], { encoding: "utf8" }).stdout : readFileSync(secretPath, "utf8");
  const probes = JSON.parse(readFileSync(out, "utf8")).map((p: Probe) => ({ ...p, secret }));
  rmSync(out, { force: true });
  return probes;
}

if (import.meta.main) {
  const [specPath, outPath] = process.argv.slice(2);
  const probes = await collectProbes(specPath);
  writeFileSync(outPath, JSON.stringify(probes));
  console.log(`${probes.length} probes from the oracle scenarios -> ${outPath}`);
}
