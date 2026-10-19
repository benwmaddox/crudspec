// Serves an app fresh, with the harness's mail server, and runs the study's acceptance checks on
// it (docs/H10-STUDY-PROTOCOL.md).
//   node h10/study/run-accept.mjs <spec|rails> <app: spec file or Rails app dir, in WSL> <port> <task…> --out <dir>
// Each task gets a fresh database and an empty mail server.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, existsSync } from "node:fs";
const argv = process.argv.slice(2);
const outIx = argv.indexOf("--out"); const outDir = outIx >= 0 ? argv.splice(outIx, 2)[1] : "h10/study/baseline";
const [arm, app, port, ...tasks] = argv;
mkdirSync(outDir, { recursive: true });
const SMTP = Number(port) + 20000;
const wsl = (cmd) => spawnSync("wsl", ["-e", "bash", "-lc", cmd], { encoding: "utf8" });
const summary = [];
for (const task of tasks) {
  const sink = `/tmp/h10-sink-${port}-${task}.jsonl`;
  wsl(`bash /mnt/d/code/crudspec/h10/stop-port.sh ${SMTP}; bash /mnt/d/code/crudspec/h10/stop-port.sh ${port}`);   // by port: pkill -f would match its own shell
  const sinkProc = spawn("wsl", ["-e", "bash", "-lc", `cd /mnt/d/code/crudspec && exec node lang/test/smtp-sink.ts ${SMTP} ${sink}`], { stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 1200));
  const D = `$HOME/h10-accept/${arm}-${port}`;
  const serve = arm === "spec"
    ? `rm -rf ${D}; mkdir -p ${D}; SMTP_PORT=${SMTP} bash /mnt/d/code/crudspec/h10/study/spec-serve.sh ${app} ${D}/build ${D}/data ${port} fresh`
    : `rm -rf ${D}; mkdir -p ${D}; SMTP_PORT=${SMTP} bash /mnt/d/code/crudspec/h10/study/rails-serve.sh ${app} ${D}/data ${port} fresh`;
  const s = wsl(serve);
  if (s.status !== 0) { console.log(`${task}: serve failed\n${s.stdout}\n${s.stderr}`); summary.push({ task, error: "serve failed" }); sinkProc.kill(); continue; }
  const out = `${outDir}/${arm}-${task}.json`;
  const r = spawnSync(process.execPath, ["h10/study/accept.mjs", arm, `http://127.0.0.1:${port}`, task, out], { encoding: "utf8", env: { ...process.env, SINK_FILE: sink }, timeout: 15 * 60_000 });
  const res = existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) : { error: r.stderr?.slice(0, 500) };
  summary.push({ task, shared: res.sharedPass, pass: res.pass, passed: res.passed, of: res.checks?.length });
  console.log(`${arm} ${task}: shared ${res.sharedPass ? "ok" : "FAIL"}, checks ${res.passed}/${res.checks?.length}${res.pass ? " PASS" : ""}${res.error ? " " + res.error : ""}`);
  for (const c of [...(res.shared ?? []), ...(res.checks ?? [])].filter((c) => !c.pass && c.name === "crashed")) console.log(`   crashed: ${c.detail}`);
  sinkProc.kill(); wsl(`bash /mnt/d/code/crudspec/h10/stop-port.sh ${SMTP}`);
}
wsl(`bash /mnt/d/code/crudspec/h10/stop-port.sh ${port}; redis-cli -p ${Number(port) + 10000} shutdown nosave >/dev/null 2>&1 || true`);
console.log(JSON.stringify(summary));
