"""Copies confirmed, current cases from the authors' staging directories into the corpus.

  python tools/corpus_assemble.py [v1-root]

Prints only case IDs. A case whose ID already exists in the corpus is skipped and
reported; IDs are never reused.
"""
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from corpus_status import cases, state  # noqa: E402

root = Path(sys.argv[1] if len(sys.argv) > 1 else "D:/code/crudspec-corpus/v1")
final = root / "final"   # the assembled corpus; v1/bugs and v1/controls are abandoned (docs/DEVIATIONS.md)
for slot in cases(root / "staging"):
    for kind in ("bugs", "controls"):
        for c in cases(slot / kind):
            st, ok = state(c)
            dest = final / kind / c.name
            if not ok:
                print(f"left {slot.name}/{kind}/{c.name}: {st}")
            elif dest.exists():
                print(f"SKIPPED {slot.name}/{kind}/{c.name}: the ID already exists in the corpus")
            else:
                shutil.copytree(c, dest)
                print(f"added {kind}/{c.name}")
