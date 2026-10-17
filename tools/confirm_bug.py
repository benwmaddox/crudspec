"""Confirms a seeded bug (or control) against the Rails oracle, in both forms.

  python tools/confirm_bug.py <case-dir> --slot N [--control]

<case-dir> holds bug.md, spec.patch, baseline.patch and oracle.json (one scenario,
in the oracle's scenario format). --slot N gives this author a private Rust tree
(~/linuxbench/crudspec-mutant-N) and app port (13780 + 2N), so authors can run in
parallel.

A bug is confirmed when:
  1. Rails runs the scenario (this writes the golden file);
  2. the reference spec and the unpatched Rust baseline both match that golden;
  3. the spec with spec.patch and Rust with baseline.patch both differ from it.
A control is confirmed when everything matches: its own scenario, and the frozen
slice (oracle/scenarios/slice-v1), in both forms.

Results go to <case-dir>/.work/confirm.json. Only the verdict line is printed.
"""
import argparse
import json
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = ROOT / "spec" / "campfire.crud"
SLICE = ROOT / "oracle" / "scenarios" / "slice-v1"
SLICE_GOLDEN = ROOT / "oracle" / "golden" / "slice-v1-e"
BASELINE = "/home/ben/linuxbench/crudspec-baseline/src"


def wsl_path(p: Path) -> str:
    p = p.resolve()
    return f"/mnt/{p.drive[0].lower()}{p.as_posix()[2:]}"


def sh(args, **kw):
    return subprocess.run(args, capture_output=True, text=True, encoding="utf-8", errors="replace", **kw)


def wsl(user, script, env=None):
    pre = ["env"] + [f"{k}={v}" for k, v in (env or {}).items()] if env else []
    return sh(["wsl", "-d", "Ubuntu", "-u", user, "--"] + pre + ["bash", "-c", script])


def interp(spec: Path, scen: Path, golden: Path):
    r = sh(["node", str(ROOT / "tools" / "src" / "cli.ts"), "scenarios", str(spec), str(scen), str(golden)])
    last = (r.stdout.strip().splitlines() or [""])[-1]
    if "scenarios match the oracle" not in last:
        return {"match": None, "error": (r.stderr.strip().splitlines() or ["?"])[-1][:300]}
    return {"match": r.returncode == 0, "summary": last, "diff": r.stdout[-3000:] if r.returncode else ""}


def compare(golden: Path, replay: Path):
    r = sh([sys.executable, str(ROOT / "oracle" / "compare.py"), str(golden), str(replay)])
    last = (r.stdout.strip().splitlines() or [""])[-1]
    return {"match": r.returncode == 0, "summary": last, "diff": r.stdout[-3000:] if r.returncode else ""}


def replay(run, scen: Path, out: Path, src, port):
    r = wsl("root", f"bash {wsl_path(ROOT / 'oracle' / 'rails' / 'replay-rust.sh')} {run} {wsl_path(scen)} {src}",
            {"ORACLE_OUT_DIR": wsl_path(out), "REPLAY_PORT": port})
    if r.returncode != 0:
        raise SystemExit(f"replay {run} failed: {(r.stdout + r.stderr).strip()[-800:]}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("case")
    ap.add_argument("--slot", type=int, required=True)
    ap.add_argument("--control", action="store_true")
    a = ap.parse_args()
    case = Path(a.case).resolve()
    cid = case.name
    port = 13780 + 2 * a.slot
    tree = f"/home/ben/linuxbench/crudspec-mutant-{a.slot}"
    stamp = time.strftime("%Y%m%d-%H%M%S")
    try:
        run(a, case, cid, port, tree, stamp)
    finally:
        cleanup(cid, stamp)


def run(a, case, cid, port, tree, stamp):
    work = case / ".work"
    shutil.rmtree(work, ignore_errors=True)
    scen, golden = work / "scenario", work / "golden"
    scen.mkdir(parents=True)
    sc = json.loads((case / "oracle.json").read_text(encoding="utf-8"))
    sc["id"] = cid
    (scen / f"{cid}.json").write_text(json.dumps(sc, indent=2) + "\n", encoding="utf-8")
    res = {"case": cid, "control": a.control, "checks": {}}
    ck = res["checks"]

    # 1. Rails.
    r = wsl("root", f"bash {wsl_path(ROOT / 'oracle' / 'rails' / 'run.sh')} corpus-{cid}-{stamp} {wsl_path(scen)}",
            {"ORACLE_OUT_DIR": wsl_path(golden)})
    if r.returncode != 0 or not (golden / f"{cid}.json").exists():
        ck["rails"] = {"ok": False, "error": (r.stdout + r.stderr).strip()[-1500:]}
        return finish(work, res, False, "the Rails oracle failed on oracle.json")
    ck["rails"] = {"ok": True, "outcomes": [x["outcome"] for x in json.loads((golden / f"{cid}.json").read_text())["results"]]}

    # 2. Spec, unpatched and patched.
    ck["spec_reference"] = interp(SPEC, scen, golden)
    with tempfile.TemporaryDirectory() as tmp:
        t = Path(tmp)
        (t / "spec").mkdir()
        shutil.copy(SPEC, t / "spec" / "campfire.crud")
        ap_ = sh(["git", "apply", str(case / "spec.patch")], cwd=t)
        if ap_.returncode != 0:
            ck["spec_patch"] = {"applies": False, "error": ap_.stderr.strip()[-500:]}
            return finish(work, res, False, "spec.patch doesn't apply to the frozen spec")
        patched = work / "campfire.patched.crud"
        shutil.copy(t / "spec" / "campfire.crud", patched)
    ck["spec_patched"] = interp(patched, scen, golden)
    ck["spec_patched_slice"] = interp(patched, SLICE, SLICE_GOLDEN)

    # 3. Rust, unpatched and patched (in this slot's private tree).
    replay(f"corpus-{cid}-base-{stamp}", scen, work / "rust-base", "", port)
    ck["rust_reference"] = compare(golden, work / "rust-base")
    prep = wsl("ben", f"set -e; test -d {tree} || cp -a {BASELINE} {tree}; cd {tree}; git -c safe.directory='*' checkout -q -- .; "
                      f"git -c safe.directory='*' clean -qfd crates; git -c safe.directory='*' apply {wsl_path(case / 'baseline.patch')}")
    if prep.returncode != 0:
        ck["baseline_patch"] = {"applies": False, "error": prep.stderr.strip()[-500:]}
        return finish(work, res, False, "baseline.patch doesn't apply to 6dae2fd")
    try:
        replay(f"corpus-{cid}-mut-{stamp}", scen, work / "rust-patched", tree, port)
        ck["rust_patched"] = compare(golden, work / "rust-patched")
        if a.control:
            replay(f"corpus-{cid}-slice-{stamp}", SLICE, work / "rust-patched-slice", tree, port)
            ck["rust_patched_slice"] = compare(SLICE_GOLDEN, work / "rust-patched-slice")
    finally:
        wsl("ben", f"cd {tree} && git -c safe.directory='*' checkout -q -- . && git -c safe.directory='*' clean -qfd crates")

    refs_ok = ck["spec_reference"]["match"] is True and ck["rust_reference"]["match"] is True
    if not refs_ok:
        return finish(work, res, False, "the scenario itself is bad: the unpatched spec or Rust disagrees with Rails")
    if a.control:
        good = all(ck[k]["match"] is True for k in ("spec_patched", "spec_patched_slice", "rust_patched", "rust_patched_slice"))
        return finish(work, res, good, "control preserves behaviour in both forms" if good else "control changes behaviour")
    spec_wrong, rust_wrong = ck["spec_patched"]["match"] is False, ck["rust_patched"]["match"] is False
    if ck["spec_patched"]["match"] is None:
        return finish(work, res, False, "the patched spec doesn't parse or crashes the interpreter")
    good = spec_wrong and rust_wrong
    return finish(work, res, good, "bug confirmed wrong in both forms" if good else
                  f"not confirmed: spec form {'wrong' if spec_wrong else 'matches Rails'}, Rust form {'wrong' if rust_wrong else 'matches Rails'}")


def cleanup(cid, stamp):
    # The run copies (about 29 MB each) are only needed while confirming.
    wsl("root", f"rm -rf /home/ben/linuxbench/crudspec-runs/corpus-{cid}-{stamp} /home/ben/linuxbench/crudspec-runs/replay-corpus-{cid}-*-{stamp}")


def finish(work, res, ok, why):
    res["confirmed"], res["verdict"] = ok, why
    (work / "confirm.json").write_text(json.dumps(res, indent=2) + "\n", encoding="utf-8")
    print(f"{'CONFIRMED' if ok else 'REJECTED'} {res['case']}: {why}")
    sys.exit(0 if ok else 1)


main()
