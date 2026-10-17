"""Exploratory (not pre-registered): the Rust baseline plus the same example scenarios.

  python tools/explore_rust_slice.py [v1-root]

For each final bug, applies baseline.patch to the slot-0 Rust tree and replays the frozen
slice scenarios over HTTP, then compares with the Rails goldens. This asks whether the
"spec plus example scenarios" arm's catches come from the DSL or from the scenarios.
Writes reports/h1/rust_with_examples.json.
"""
import json
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TREE = "/home/ben/linuxbench/crudspec-mutant-0"
OUT = ROOT / "reports" / "h1" / "rust_with_examples.json"


def wsl_path(p: Path) -> str:
    p = p.resolve()
    return f"/mnt/{p.drive[0].lower()}{p.as_posix()[2:]}"


def wsl(user, script, env=None):
    pre = ["env"] + [f"{k}={v}" for k, v in (env or {}).items()] if env else []
    return subprocess.run(["wsl", "-d", "Ubuntu", "-u", user, "--"] + pre + ["bash", "-c", script], capture_output=True, text=True, encoding="utf-8", errors="replace")


root = Path(sys.argv[1] if len(sys.argv) > 1 else "D:/code/crudspec-corpus/v1")
results = json.loads(OUT.read_text()) if OUT.exists() else {}
work = ROOT / ".scratch" / "rust-slice"
for c in sorted(p for p in (root / "final" / "bugs").iterdir() if p.is_dir()):
    if c.name in results:
        continue
    prep = wsl("ben", f"set -e; test -d {TREE} || cp -a /home/ben/linuxbench/crudspec-baseline/src {TREE}; cd {TREE}; git -c safe.directory='*' checkout -q -- .; "
                      f"git -c safe.directory='*' clean -qfd crates; git -c safe.directory='*' apply {wsl_path(c / 'baseline.patch')}")
    if prep.returncode:
        results[c.name] = None
        continue
    out = work / c.name
    run = f"xs-{c.name}-{time.strftime('%H%M%S')}"
    r = wsl("root", f"bash {wsl_path(ROOT / 'oracle/rails/replay-rust.sh')} {run} {wsl_path(ROOT / 'oracle/scenarios/slice-v1')} {TREE}",
            {"ORACLE_OUT_DIR": wsl_path(out), "REPLAY_PORT": 13780})
    wsl("root", f"rm -rf /home/ben/linuxbench/crudspec-runs/replay-{run}")
    cmp = subprocess.run([sys.executable, str(ROOT / "oracle" / "compare.py"), str(ROOT / "oracle/golden/slice-v1-e"), str(out)], capture_output=True, text=True)
    results[c.name] = cmp.returncode != 0 if r.returncode == 0 else None
    OUT.write_text(json.dumps(results, indent=2) + "\n")
    print(c.name, results[c.name], flush=True)
wsl("ben", f"cd {TREE} && git -c safe.directory='*' checkout -q -- . && git -c safe.directory='*' clean -qfd crates")
print(f"caught {sum(1 for v in results.values() if v)}/{len(results)}")
