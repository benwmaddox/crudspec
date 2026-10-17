"""Runs the checker on the development set: the checker author's own known mutations.

  python tools/checker_devset.py

The development set is the spec mutations in tools/scenario_adequacy.py plus the replay
negative control (B3). The checker may be tuned on these; the seeded-bug corpus is never
seen. Bugs in the corpus that overlap these are flagged at scoring (docs/HYPOTHESES.md, H1).
Both pre-registered rejection rules are reported (tools/check_patch.py).
"""
import ast
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from check_patch import check_patch  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
SPEC = ROOT / "spec" / "campfire.crud"

tree = ast.parse((ROOT / "tools" / "scenario_adequacy.py").read_text(encoding="utf-8"))
MUTATIONS = next(ast.literal_eval(n.value) for n in tree.body if isinstance(n, ast.Assign) and n.targets[0].id == "MUTATIONS")
MUTATIONS["B3 unboost ignores the booster (replay control)"] = ("require boost.booster == actor else not_found", "require true else not_found")


def main():
    src = SPEC.read_text(encoding="utf-8")
    tmp = ROOT / ".devset.crud"
    primary = secondary = 0
    try:
        for name, (a, b) in MUTATIONS.items():
            if src.count(a) != 1:
                print(f"SKIP {name}: pattern found {src.count(a)} times")
                continue
            tmp.write_text(src.replace(a, b), encoding="utf-8")
            r = check_patch(tmp)
            if r.get("crash"):
                print(f"CRASH {name}: {r['stderr'][-300:]}")
                continue
            primary += r["primary_reject"]
            secondary += r["secondary_reject"]
            codes = sorted({n.split("|")[0] for n in r["new_findings"]})
            print(f"{'P' if r['primary_reject'] else '-'}{'S' if r['secondary_reject'] else '-'} {name}: {', '.join(codes) or '-'}")
    finally:
        tmp.unlink(missing_ok=True)
    n = len(MUTATIONS)
    print(f"\nprimary rule: {primary}/{n} rejected; secondary rule: {secondary}/{n} rejected")


main()
