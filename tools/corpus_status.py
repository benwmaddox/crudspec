"""Prints corpus case IDs and whether each is confirmed and current: nothing about what any case does.

  python tools/corpus_status.py [v1-root]

Safe for the checker author: it reads only confirm.json's "confirmed" flag and hashes.
A case is current when its confirmation was made against today's spec and its four
files haven't changed since (both recorded as SHA-256 in confirm.json).
"""
import hashlib
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC_SHA = hashlib.sha256((ROOT / "spec" / "campfire.crud").read_bytes()).hexdigest()
FILES = ("bug.md", "spec.patch", "baseline.patch", "oracle.json")


def state(c: Path) -> tuple[str, bool]:
    missing = [f for f in FILES if not (c / f).exists()]
    if missing:
        return f"incomplete (missing {', '.join(missing)})", False
    conf = c / ".work" / "confirm.json"
    if not conf.exists():
        return "unconfirmed", False
    j = json.loads(conf.read_text(encoding="utf-8"))
    if j.get("confirmed") is not True:
        return "rejected", False
    if j.get("spec_sha256") != SPEC_SHA:
        return "stale (confirmed against another spec)", False
    if any(j.get("case_sha256", {}).get(f) != hashlib.sha256((c / f).read_bytes()).hexdigest() for f in FILES):
        return "stale (edited after confirming)", False
    return "CONFIRMED", True


def cases(d: Path):
    return sorted(p for p in d.iterdir() if p.is_dir()) if d.exists() else []


if __name__ == "__main__":
    root = Path(sys.argv[1] if len(sys.argv) > 1 else "D:/code/crudspec-corpus/v1")
    places = [("corpus", root / "final")] + [(f"staging {s.name}", s) for s in cases(root / "staging")]
    for label, base in places:
        for kind in ("bugs", "controls"):
            cs = cases(base / kind)
            if not cs:
                continue
            states = [(c.name, *state(c)) for c in cs]
            print(f"{label} {kind}: {len(cs)} cases, {sum(ok for _, _, ok in states)} confirmed and current")
            for name, st, _ in states:
                print(f"  {name}: {st}")
