"""Writes corpus/MANIFEST-v1.json: SHA-256 of every file in the assembled corpus, nothing else.

  python tools/corpus_manifest.py [v1-root]

Safe for the checker author: it hashes files without printing their contents. Committing
the manifest freezes the corpus; scoring verifies it first (--verify).
"""
import hashlib
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "corpus" / "MANIFEST-v1.json"
FILES = ("bug.md", "spec.patch", "baseline.patch", "oracle.json")

args = [a for a in sys.argv[1:] if not a.startswith("--")]
final = Path(args[0] if args else "D:/code/crudspec-corpus/v1") / "final"
manifest = {"spec_sha256": hashlib.sha256((ROOT / "spec" / "campfire.crud").read_bytes()).hexdigest(), "cases": {}}
for kind in ("bugs", "controls"):
    for c in sorted(p for p in (final / kind).iterdir() if p.is_dir()):
        manifest["cases"][c.name] = {"kind": kind, **{f: hashlib.sha256((c / f).read_bytes()).hexdigest() for f in FILES}}

if "--verify" in sys.argv:
    want = json.loads(OUT.read_text(encoding="utf-8"))
    bad = sorted(set(want["cases"]) ^ set(manifest["cases"])) + [k for k in want["cases"] if k in manifest["cases"] and want["cases"][k] != manifest["cases"][k]]
    if want["spec_sha256"] != manifest["spec_sha256"]:
        bad.append("spec")
    print("manifest OK" if not bad else f"manifest MISMATCH: {', '.join(bad)}")
    sys.exit(1 if bad else 0)

OUT.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
kinds = [v["kind"] for v in manifest["cases"].values()]
print(f"wrote {OUT.name}: {kinds.count('bugs')} bugs, {kinds.count('controls')} controls")
