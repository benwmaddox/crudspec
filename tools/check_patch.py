"""Runs the frozen checker on one spec change and applies both pre-registered rejection rules.

  python tools/check_patch.py <spec.patch | edited-spec.crud> [--json]

Rules (docs/HYPOTHESES.md, H1):
  primary    rejects when the checker reports any error;
  secondary  rejects when the checker reports any finding (error or warning) that the
             reference spec doesn't also produce. Findings are matched on code, place and
             message with line numbers removed, counting repeats.
A checker crash (exit code other than 0 or 1) is reported as a crash, never as a rejection.
"""
import json
import re
import shutil
import subprocess
import sys
import tempfile
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = ROOT / "spec" / "campfire.crud"
SCOPE = ROOT / "spec" / "campfire.scope.json"
CLI = ROOT / "tools" / "src" / "cli.ts"


def run_check(spec: Path) -> dict:
    r = subprocess.run(["node", str(CLI), "check", str(spec), "--scope", str(SCOPE), "--json"], capture_output=True, text=True, encoding="utf-8")
    if r.returncode not in (0, 1):
        return {"crash": True, "stderr": r.stderr[-1500:]}
    if r.stdout.startswith("error PARSE"):
        return {"crash": False, "findings": [{"severity": "error", "code": "PARSE", "where": "spec", "message": r.stdout.splitlines()[0]}]}
    return {"crash": False, **json.loads(r.stdout)}


def key(f: dict) -> str:
    msg = re.sub(r"\(line \d+\)|\bline \d+\b|\b\d+:\d+\b", "", f["message"])
    return f"{f['code']}|{f['where']}|{msg}"


_reference = None


def reference() -> Counter:
    global _reference
    if _reference is None:
        r = run_check(SPEC)
        assert not r["crash"], r
        _reference = Counter(key(f) for f in r["findings"])
    return _reference


def check_patch(patch_or_spec: Path) -> dict:
    with tempfile.TemporaryDirectory() as tmp:
        t = Path(tmp)
        (t / "spec").mkdir()
        if patch_or_spec.suffix == ".crud":
            shutil.copy(patch_or_spec, t / "spec" / "campfire.crud")
        else:
            shutil.copy(SPEC, t / "spec" / "campfire.crud")
            ap = subprocess.run(["git", "apply", str(patch_or_spec.resolve())], cwd=t, capture_output=True, text=True)
            if ap.returncode:
                return {"applies": False, "error": ap.stderr.strip()[-500:]}
        r = run_check(t / "spec" / "campfire.crud")
    if r["crash"]:
        return {"applies": True, "crash": True, "stderr": r["stderr"]}
    found = Counter(key(f) for f in r["findings"])
    new = found - reference()
    return {
        "applies": True,
        "crash": False,
        "primary_reject": any(f["severity"] == "error" for f in r["findings"]),
        "secondary_reject": bool(new),
        "errors": sorted({f["code"] for f in r["findings"] if f["severity"] == "error"}),
        "new_findings": sorted(new.elements()),
    }


if __name__ == "__main__":
    out = check_patch(Path(sys.argv[1]))
    if "--json" in sys.argv:
        print(json.dumps(out, indent=2))
    else:
        print(f"primary {'REJECT' if out.get('primary_reject') else 'pass'}, secondary {'REJECT' if out.get('secondary_reject') else 'pass'}"
              + (" (CRASH)" if out.get("crash") else "") + ("" if out.get("applies", True) else " (patch doesn't apply)"))
        for n in out.get("new_findings", []):
            print(f"  new: {n}")
