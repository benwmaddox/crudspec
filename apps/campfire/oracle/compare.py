"""Compares replay results (another implementation) with the Rails golden files.

  python oracle/compare.py oracle/golden/<run> oracle/replays/<run>

A scenario matches when every action's outcome, any listed rows, and the initial
and final normalized states are equal.
"""
import json
import sys
from pathlib import Path

golden_dir, replay_dir = map(Path, sys.argv[1:3])
total = failed = 0
for g in sorted(golden_dir.glob("*.json")):
    total += 1
    r = replay_dir / g.name
    if not r.exists():
        failed += 1
        print(f"MISSING {g.stem}: no replay (the scenario errored)")
        continue
    gold, rep = json.loads(g.read_text()), json.loads(r.read_text())
    diffs = []
    if gold["initial"] != rep["initial"]:
        diffs.append("initial state")
    for i, (ga, ra) in enumerate(zip(gold["results"], rep["results"]), 1):
        if ga["outcome"] != ra["outcome"]:
            diffs.append(f"action {i} {ga['action']['do']} by {ga['action'].get('actor')}: expected {ga['outcome']}, got {ra['outcome']} (status {ra['status']})")
        if ga.get("rows") != ra.get("rows"):
            diffs.append(f"action {i} {ga['action']['do']}: rows differ")
    for k in gold["final"]:
        if gold["final"][k] != rep["final"].get(k):
            diffs.append(f"final {k}: expected {json.dumps(gold['final'][k])[:300]} got {json.dumps(rep['final'].get(k))[:300]}")
    if diffs:
        failed += 1
        print(f"DIFF {g.stem}")
        for d in diffs:
            print(f"  {d}")
print(f"{total - failed}/{total} scenarios match the Rails oracle")
sys.exit(1 if failed else 0)
