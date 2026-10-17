"""Prints corpus case IDs and whether each is confirmed: nothing about what any case does.

  python tools/corpus_status.py [corpus-root]

Safe for the checker author to run: it reads only the "confirmed" flag, the file
names present, and whether the confirmation is newer than every case file.
"""
import json
import sys
from pathlib import Path

root = Path(sys.argv[1] if len(sys.argv) > 1 else "D:/code/crudspec-corpus/v1")
FILES = ("bug.md", "spec.patch", "baseline.patch", "oracle.json")
for kind in ("bugs", "controls"):
    d = root / kind
    cases = sorted(p for p in d.iterdir() if p.is_dir()) if d.exists() else []
    good = 0
    rows = []
    for c in cases:
        missing = [f for f in FILES if not (c / f).exists()]
        conf = c / ".work" / "confirm.json"
        state = "unconfirmed"
        if conf.exists():
            ok = json.loads(conf.read_text(encoding="utf-8")).get("confirmed") is True
            stale = any((c / f).exists() and (c / f).stat().st_mtime > conf.stat().st_mtime for f in FILES)
            state = ("CONFIRMED" if ok else "rejected") + (" (stale: edited after confirming)" if stale else "")
            good += ok and not stale
        rows.append(f"  {c.name}: {state}{'; missing ' + ', '.join(missing) if missing else ''}")
    print(f"{kind}: {len(cases)} cases, {good} confirmed and current")
    print("\n".join(rows))
