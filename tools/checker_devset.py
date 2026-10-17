"""Runs the checker on the development set: the checker author's own known mutations.

  python tools/checker_devset.py

The development set is the spec mutations in tools/scenario_adequacy.py plus the replay
negative control (B3). The checker may be tuned on these; the seeded-bug corpus is never
seen. Bugs in the corpus that overlap these are flagged at scoring (docs/HYPOTHESES.md, H1).
"""
import ast
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = ROOT / "spec" / "campfire.crud"
SCOPE = ROOT / "spec" / "campfire.scope.json"

tree = ast.parse((ROOT / "tools" / "scenario_adequacy.py").read_text(encoding="utf-8"))
MUTATIONS = next(ast.literal_eval(n.value) for n in tree.body if isinstance(n, ast.Assign) and n.targets[0].id == "MUTATIONS")
MUTATIONS["B3 unboost ignores the booster (replay control)"] = ("require boost.booster == actor else not_found", "require true else not_found")


def main():
    src = SPEC.read_text(encoding="utf-8")
    tmp = ROOT / ".devset.crud"
    caught = 0
    try:
        for name, (a, b) in MUTATIONS.items():
            if src.count(a) != 1:
                print(f"SKIP   {name}: pattern found {src.count(a)} times")
                continue
            tmp.write_text(src.replace(a, b), encoding="utf-8")
            r = subprocess.run(["node", str(ROOT / "tools" / "src" / "cli.ts"), "check", str(tmp), "--scope", str(SCOPE)], capture_output=True, text=True, encoding="utf-8")
            errors = sorted({line.split(" [")[0].split(" ", 1)[1] for line in r.stdout.splitlines() if line.startswith("error ")})
            summary = (r.stdout.strip().splitlines() or ["?"])[-1]
            hit = r.returncode == 1 and errors
            caught += bool(hit)
            print(f"{'caught' if hit else 'missed'} {name}: {', '.join(errors) if errors else '-'}  ({summary})")
            if r.returncode not in (0, 1):
                print(r.stderr[-800:])
    finally:
        tmp.unlink(missing_ok=True)
    print(f"\n{caught}/{len(MUTATIONS)} development mutations rejected by the checker")


main()
