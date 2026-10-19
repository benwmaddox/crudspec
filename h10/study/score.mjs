// Scores one H10 study run (docs/H10-STUDY-PROTOCOL.md): hand work; acceptance on a fresh
// database with the harness's mail server and clock; preservation (the 42 oracle scenarios);
// the upgrade on production data; for the spec arm, the cache self-check. Writes
// h10/study/results/<run>/ and prints one line.
//   node h10/study/score.mjs <spec|rails> <run> <task> <port>
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
const [arm, run, task, port] = process.argv.slice(2);
const REPO = "/mnt/d/code/crudspec", WS = `/mnt/d/code/h10-study-runs/${run}`;
const OUT = `h10/study/results/${run}`; mkdirSync(OUT, { recursive: true });
const wsl = (cmd, user) => spawnSync("wsl", [...(user ? ["-u", user] : []), "-e", "bash", "-lc", cmd], { encoding: "utf8", maxBuffer: 64 << 20, env: { ...process.env, MSYS_NO_PATHCONV: "1" } });
const save = (name, text) => writeFileSync(`${OUT}/${name}`, text ?? "");
const t0 = Date.now();

// ---- hand work
if (arm === "spec") {
  const spec = wsl(`diff ${REPO}/apps/campfire/campfire.crud ${WS}/campfire.crud | grep -c '^[<>]'`).stdout.trim();
  const go = wsl(`{ diff ${REPO}/apps/campfire/widgets.go ${WS}/widgets.go; [ -f ${WS}/ext.go ] && cat ${WS}/ext.go | sed 's/^/> /'; } | grep -c '^[<>]'`).stdout.trim();
  const lang = wsl(`cd ${REPO}/lang && find . -type f -not -path '*/node_modules/*' -not -path './browser/*' -not -path './test/*' | while read f; do [ -f "${WS}/lang/$f" ] && ! cmp -s "$f" "${WS}/lang/$f" && echo "$f"; done`).stdout.trim();
  save("handwork.txt", `spec lines changed: ${spec}\nGo lines (widgets.go, ext.go): ${go}\n${lang ? "lang/ changed (doesn't reach the deployed app):\n" + lang + "\n" : ""}`);
  save("change.diff", wsl(`diff -u ${REPO}/apps/campfire/campfire.crud ${WS}/campfire.crud; [ -f ${WS}/ext.go ] && cat ${WS}/ext.go; diff -u ${REPO}/apps/campfire/widgets.go ${WS}/widgets.go`).stdout);
} else {
  const files = wsl(`diff -r -q $HOME/linuxbench/rails/app ${WS}/app -x storage -x log -x tmp 2>/dev/null | grep -v -e 'config/puma.rb' -e 'h10_harness.rb'`).stdout.trim();
  save("handwork.txt", `files changed: ${files ? files.split("\n").length : 0}\n${files}\n`);
  save("change.diff", wsl(`diff -r -u $HOME/linuxbench/rails/app ${WS}/app -x storage -x log -x tmp -x h10_harness.rb -x puma.rb 2>/dev/null`).stdout);
}

// ---- acceptance, on a fresh database (the Rails app from a copy, as served)
let app = `${WS}/campfire.crud`;
if (arm === "rails") { wsl(`rm -rf $HOME/h10-study-score/${run} && mkdir -p $HOME/h10-study-score/${run} && cp -a ${WS}/app $HOME/h10-study-score/${run}/app`); app = `$HOME/h10-study-score/${run}/app`.replace("$HOME", wsl("echo $HOME").stdout.trim()); }
const acc = spawnSync(process.execPath, ["h10/study/run-accept.mjs", arm, app, port, task, "--out", OUT], { encoding: "utf8", env: { ...process.env, MSYS_NO_PATHCONV: "1" } });
save("accept.log", acc.stdout + acc.stderr);
const accept = existsSync(`${OUT}/${arm}-${task}.json`) ? JSON.parse(readFileSync(`${OUT}/${arm}-${task}.json`, "utf8")) : null;
let cacheMismatches = 0;
if (arm === "spec") cacheMismatches += Number(wsl(`grep -c '^cache check:' $HOME/h10-accept/spec-${port}/data/server.log 2>/dev/null || true`).stdout.trim() || 0);

// ---- preservation
const pres = arm === "spec"
  ? wsl(`bash ${REPO}/h10/spec-preserve.sh ${WS}/campfire.crud ${port}`)
  : wsl(`bash ${REPO}/h10/rails-preserve.sh $(eval echo ~ben)/h10-study-score/${run}/app ${run}`, "root");
save("preserve.txt", pres.stdout + pres.stderr);
const preserved = /preserved: (\d+)\/(\d+)/.exec(pres.stdout);
if (arm === "spec") cacheMismatches += Number(/cache check: (\d+) mismatches/.exec(pres.stdout)?.[1] ?? 0);

// ---- the upgrade on production data
const up = wsl(`bash ${REPO}/h10/study/upgrade.sh ${arm} ${WS} ${task} ${port}`);
save("upgrade.txt", up.stdout + up.stderr);
const data = (() => { try { return JSON.parse(up.stdout.trim().split("\n").filter((l) => l.startsWith("{")).pop()); } catch { return null; } })();
const time = /serving on \d+ after (\d+) ms/.exec(up.stdout)?.[1];

const summary = {
  run, arm, task,
  accepted: !!accept?.pass, checksPassed: accept ? `${accept.passed}/${accept.checks.length}` : "none", sharedPass: accept?.sharedPass ?? false,
  preserved: preserved ? `${preserved[1]}/${preserved[2]}` : "none", dataKept: !!data?.survived, lost: data?.lost ?? null,
  timeToLiveMs: time ? Number(time) : null, cacheMismatches: arm === "spec" ? cacheMismatches : null,
  scoredInS: Math.round((Date.now() - t0) / 1000),
};
summary.right = summary.accepted && summary.preserved === "42/42" && summary.dataKept && (arm !== "spec" || cacheMismatches === 0);
save("summary.json", JSON.stringify(summary, null, 1));
console.log(JSON.stringify(summary));
