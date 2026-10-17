"""Scores H2 runs (docs/H2-PROTOCOL.md). Never trusts the agent's own tests.

  python h2/score.py [--runs r1,r2,...] [--pilot]

For each run in D:/code/crudspec-h2/meta/<run>.json:
  correct     the task's oracle.json scenario matches its Rails golden
  preserving  all 25 frozen slice scenarios match their goldens
  complete    the session finished (meta "usage.status" == "completed") and the result parses/builds
Spec arm: interpreter. Rust arm: the run's rust/ is synced into a scoring tree, then the
HTTP replay (oracle/rails/replay-rust.sh) runs the same scenarios.
Results go to meta/<run>.json under "score"; the summary to reports/h2/.
"""
import json
import random
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
H2 = Path("D:/code/crudspec-h2")
CORPUS = Path("D:/code/crudspec-corpus/v1/final/bugs")
CLI = ROOT / "tools" / "src" / "cli.ts"
SLICE = ROOT / "apps" / "campfire" / "oracle" / "scenarios" / "slice-v1"
SLICE_GOLDEN = ROOT / "apps" / "campfire" / "oracle" / "golden" / "slice-v1-e"
SCORE_TREE = "/home/ben/linuxbench/h2-score"


def wsl_path(p: Path) -> str:
    p = p.resolve()
    return f"/mnt/{p.drive[0].lower()}{p.as_posix()[2:]}"


def sh(args, **kw):
    return subprocess.run(args, capture_output=True, text=True, encoding="utf-8", errors="replace", **kw)


def wsl(user, script, env=None):
    pre = ["env"] + [f"{k}={v}" for k, v in (env or {}).items()] if env else []
    return sh(["wsl", "-d", "Ubuntu", "-u", user, "--"] + pre + ["bash", "-c", script])


def interp(spec: Path, scen: Path, golden: Path):
    r = sh(["node", str(CLI), "scenarios", str(spec), str(scen), str(golden)])
    last = (r.stdout.strip().splitlines() or [""])[-1]
    if "scenarios match the oracle" not in last:
        return None
    return r.returncode == 0


def replay(scen: Path, golden: Path, tag: str):
    out = H2 / "score-work" / tag
    run = f"h2s-{tag}-{time.strftime('%H%M%S')}"
    r = wsl("root", f"bash {wsl_path(ROOT / 'apps/campfire/oracle/rails/replay-rust.sh')} {run} {wsl_path(scen)} {SCORE_TREE}",
            {"ORACLE_OUT_DIR": wsl_path(out), "REPLAY_PORT": 13790})
    wsl("root", f"rm -rf /home/ben/linuxbench/crudspec-runs/replay-{run}")
    if r.returncode != 0 or not any(out.glob("*.json")):
        return None   # didn't build or didn't serve
    c = sh([sys.executable, str(ROOT / "apps" / "campfire" / "oracle" / "compare.py"), str(golden), str(out)])
    return c.returncode == 0


def score_run(meta: dict) -> dict:
    ws = H2 / "runs" / meta["run"]
    case = CORPUS / meta["task"]
    scen, golden = case / ".work" / "scenario", case / ".work" / "golden"
    finished = meta.get("usage", {}).get("status") == "completed"
    if meta["arm"] == "spec":
        spec = ws / "spec" / "campfire.crud"
        parses = sh(["node", str(CLI), "parse", str(spec)]).returncode == 0
        correct = interp(spec, scen, golden) if parses else False
        preserving = interp(spec, SLICE, SLICE_GOLDEN) if parses else False
        builds = parses
        diff = sh(["git", "diff", "--no-index", "--stat", str(ws.parent.parent / "starts" / meta["run"] / "campfire.crud"), str(spec)]).stdout
    else:
        sync = wsl("ben", f"set -e; test -d {SCORE_TREE} || cp -a /home/ben/linuxbench/crudspec-baseline/src {SCORE_TREE}; "
                          f"rsync -a --delete --exclude target --exclude reference --exclude .git {wsl_path(ws / 'rust')}/ {SCORE_TREE}/; "
                          f"cd {SCORE_TREE}; export PATH=$HOME/.cargo/bin:$PATH; cargo build -q -p campfire")
        builds = sync.returncode == 0
        correct = replay(scen, golden, f"{meta['run']}-task") if builds else False
        preserving = replay(SLICE, SLICE_GOLDEN, f"{meta['run']}-slice") if builds else False
        diff = sh(["git", "diff", "--no-index", "--stat", str(ws.parent.parent / "starts" / meta["run"] / "rust"), str(ws / "rust")]).stdout
    files_changed = max(0, len([l for l in diff.splitlines() if "|" in l]))
    complete = finished and builds
    return {"correct": bool(correct), "preserving": bool(preserving), "complete": complete, "builds": builds,
            "accepted": bool(correct and preserving and complete), "files_changed": files_changed,
            "correct_raw": correct, "preserving_raw": preserving}


def bootstrap(per_task: dict, n=10000, seed=17):
    """per_task: task -> (spec_rates list, rust_rates list). CI for the difference in accepted share."""
    rng = random.Random(seed)
    tasks = list(per_task)
    diffs = []
    for _ in range(n):
        sample = [rng.choice(tasks) for _ in tasks]
        s = [x for t in sample for x in per_task[t][0]]
        r = [x for t in sample for x in per_task[t][1]]
        if s and r:
            diffs.append(sum(s) / len(s) - sum(r) / len(r))
    diffs.sort()
    return diffs[int(0.025 * len(diffs))], diffs[int(0.975 * len(diffs)) - 1]


def main():
    metas = sorted((H2 / "meta").glob("*.json"))
    only = set(sys.argv[sys.argv.index("--runs") + 1].split(",")) if "--runs" in sys.argv else None
    want_pilot = "--pilot" in sys.argv
    for p in metas:
        m = json.loads(p.read_text())
        if only and m["run"] not in only:
            continue
        if bool(m.get("pilot")) != want_pilot or "score" in m:
            continue
        m["score"] = score_run(m)
        p.write_text(json.dumps(m, indent=2) + "\n")
        print(m["run"], m["task"], m["arm"], m["score"], flush=True)
    rows = [json.loads(p.read_text()) for p in metas]
    rows = [m for m in rows if "score" in m and bool(m.get("pilot")) == want_pilot]
    summary = {}
    for arm in ("spec", "rust"):
        a = [m for m in rows if m["arm"] == arm]
        acc = [m["score"]["accepted"] for m in a]
        summary[arm] = {"runs": len(a), "accepted": sum(acc), "rate": round(sum(acc) / len(acc), 3) if acc else None,
                        "correct": sum(m["score"]["correct"] for m in a), "preserving": sum(m["score"]["preserving"] for m in a),
                        "complete": sum(m["score"]["complete"] for m in a)}
        for k in ("tokens", "tool_uses", "duration_ms"):
            vals = sorted(m.get("usage", {}).get(k) for m in a if m.get("usage", {}).get(k) is not None)
            summary[arm][f"median_{k}"] = vals[len(vals) // 2] if vals else None
    per_task = {}
    for m in rows:
        per_task.setdefault(m["task"], ([], []))[0 if m["arm"] == "spec" else 1].append(m["score"]["accepted"])
    if summary["spec"]["runs"] and summary["rust"]["runs"]:
        summary["difference"] = round(summary["spec"]["rate"] - summary["rust"]["rate"], 3)
        summary["ci95"] = [round(x, 3) for x in bootstrap(per_task)]
        for k in ("tokens", "tool_uses", "duration_ms"):
            s, r = summary["spec"][f"median_{k}"], summary["rust"][f"median_{k}"]
            summary[f"cost_ratio_{k}"] = round(s / r, 2) if s and r else None
    out = ROOT / "reports" / "h2"
    out.mkdir(parents=True, exist_ok=True)
    (out / ("pilot-summary.json" if want_pilot else "summary.json")).write_text(json.dumps(summary, indent=2) + "\n")
    print(json.dumps(summary, indent=2))


main()
