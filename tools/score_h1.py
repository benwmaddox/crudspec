"""Scores H1 on the assembled corpus. Run by the scoring session, not the checker author.

  python tools/score_h1.py [v1-root] [--out reports/h1]

For every case in <v1-root>/final/{bugs,controls} it records:
  - checker, primary rule (any error) and secondary rule (any finding the reference spec lacks);
  - spec plus its example tests: the primary rule, or a mismatch on the frozen slice scenarios;
  - baseline: the Rust port's own tests with baseline.patch applied (baseline/test-patch-wsl.sh).
Writes <out>/results.json and prints the catch and false-alarm rates. The overlap and leak
flags (docs/HYPOTHESES.md, docs/DEVIATIONS.md) are added by the scoring session by hand,
in <out>/flags.json ({"<id>": "reason"}), and the rates are printed with and without them.
"""
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from check_patch import check_patch  # noqa: E402
from corpus_status import state  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
SPEC = ROOT / "spec" / "campfire.crud"
CLI = ROOT / "tools" / "src" / "cli.ts"


def wsl_path(p: Path) -> str:
    p = p.resolve()
    return f"/mnt/{p.drive[0].lower()}{p.as_posix()[2:]}"


def slice_mismatch(patch: Path) -> bool | None:
    with tempfile.TemporaryDirectory() as tmp:
        t = Path(tmp)
        (t / "spec").mkdir()
        shutil.copy(SPEC, t / "spec" / "campfire.crud")
        if subprocess.run(["git", "apply", str(patch.resolve())], cwd=t, capture_output=True).returncode:
            return None
        r = subprocess.run(["node", str(CLI), "scenarios", str(t / "spec" / "campfire.crud"), str(ROOT / "apps" / "campfire" / "oracle" / "scenarios" / "slice-v1"), str(ROOT / "apps" / "campfire" / "oracle" / "golden" / "slice-v1-e")],
                           capture_output=True, text=True, encoding="utf-8")
        last = (r.stdout.strip().splitlines() or [""])[-1]
        if "scenarios match the oracle" not in last:
            return None
        return r.returncode != 0


def baseline_caught(patch: Path, log: Path) -> bool | None:
    r = subprocess.run(["wsl", "-d", "Ubuntu", "-u", "ben", "--", "bash", wsl_path(ROOT / "baseline" / "test-patch-wsl.sh"), wsl_path(patch), wsl_path(log)])
    return {0: False, 1: True}.get(r.returncode)


def rates(results: dict, kind: str, skip: set) -> dict:
    rows = [r for cid, r in results.items() if r["kind"] == kind and cid not in skip]
    out = {"n": len(rows)}
    for arm in ("checker_primary", "checker_secondary", "spec_with_examples", "baseline_tests"):
        vals = [r[arm] for r in rows if r[arm] is not None]
        out[arm] = {"rejected": sum(vals), "scored": len(vals), "rate": round(sum(vals) / len(vals), 3) if vals else None}
    return out


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    root = Path(args[0] if args else "D:/code/crudspec-corpus/v1")
    out = Path(sys.argv[sys.argv.index("--out") + 1]) if "--out" in sys.argv else ROOT / "reports" / "h1"
    (out / "logs").mkdir(parents=True, exist_ok=True)
    results_path = out / "results.json"
    results = json.loads(results_path.read_text()) if results_path.exists() else {}
    for kind in ("bugs", "controls"):
        for c in sorted(p for p in (root / "final" / kind).iterdir() if p.is_dir()):
            if c.name in results:
                continue
            st, ok = state(c)
            if not ok:
                results[c.name] = {"kind": kind, "skipped": st}
                continue
            chk = check_patch(c / "spec.patch")
            primary = None if chk.get("crash") or not chk.get("applies", True) else chk["primary_reject"]
            secondary = None if primary is None else chk["secondary_reject"]
            sl = slice_mismatch(c / "spec.patch")
            results[c.name] = {
                "kind": kind,
                "checker_primary": primary,
                "checker_secondary": secondary,
                "checker_crash": bool(chk.get("crash")),
                "checker_new_findings": chk.get("new_findings", []),
                "spec_with_examples": None if primary is None or sl is None else (primary or sl),
                "baseline_tests": baseline_caught(c / "baseline.patch", out / "logs" / f"{c.name}.log"),
            }
            results_path.write_text(json.dumps(results, indent=2) + "\n")
            print(f"{c.name}: " + ", ".join(f"{k}={v}" for k, v in results[c.name].items() if k not in ("kind", "checker_new_findings")))
    flags = json.loads((out / "flags.json").read_text()) if (out / "flags.json").exists() else {}
    summary = {
        "all": {"bugs": rates(results, "bugs", set()), "controls": rates(results, "controls", set())},
        "without_flagged": {"bugs": rates(results, "bugs", set(flags)), "controls": rates(results, "controls", set(flags))},
        "flagged": flags,
    }
    (out / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    print(json.dumps(summary, indent=2))


main()
