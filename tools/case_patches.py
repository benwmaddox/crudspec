r"""Helpers for corpus authors: scratch copies and patch files, so writing a case is mechanical.

  python tools/case_patches.py tree N
      Makes D:\code\crudspec-authoring\author-N\ with rust\ (an editable copy of the Rust
      baseline's source at 6dae2fd, as its own git repository) and campfire.crud (a copy of
      the frozen spec). Edit both with ordinary file tools. Run again to reset both.
  python tools/case_patches.py spec <case-dir> N
      Writes <case-dir>/spec.patch from author-N's edited campfire.crud.
  python tools/case_patches.py rust <case-dir> N
      Writes <case-dir>/baseline.patch from the edits in author-N's rust copy.

Between cases, run `tree N` again to start clean. Then confirm with tools/confirm_bug.py.
"""
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = ROOT / "spec" / "campfire.crud"
BASELINE = "/home/ben/linuxbench/crudspec-baseline/src"
AUTHORING = Path("D:/code/crudspec-authoring")   # outside the repository; the checker author never reads it


def wsl_path(p: Path) -> str:
    p = p.resolve()
    return f"/mnt/{p.drive[0].lower()}{p.as_posix()[2:]}"


def wsl(script: str) -> subprocess.CompletedProcess:
    return subprocess.run(["wsl", "-d", "Ubuntu", "-u", "ben", "--", "bash", "-c", script], capture_output=True, text=True, encoding="utf-8", errors="replace")


def die(msg: str):
    print(msg)
    sys.exit(1)


def main():
    if len(sys.argv) < 3:
        die(__doc__)
    cmd = sys.argv[1]
    n = int(sys.argv[3] if cmd in ("spec", "rust") else sys.argv[2])
    base = AUTHORING / f"author-{n}"
    rust = base / "rust"
    if cmd == "tree":
        if not (rust / ".git").exists():
            r = wsl(f"set -e; mkdir -p {wsl_path(rust)}; cd {BASELINE}; git -c safe.directory='*' ls-files -z | grep -zvx reference | xargs -0 cp --parents -t {wsl_path(rust)}")
            if r.returncode:
                die(r.stderr[-800:])
            for args in (["init", "-q"], ["config", "core.autocrlf", "false"], ["add", "-A"], ["-c", "user.name=author", "-c", "user.email=author@example.test", "commit", "-qm", "baseline 6dae2fd"]):
                g = subprocess.run(["git", *args], cwd=rust, capture_output=True, text=True)
                if g.returncode:
                    die(g.stderr[-800:])
        for args in (["checkout", "-q", "--", "."], ["clean", "-qfd"]):
            subprocess.run(["git", *args], cwd=rust, capture_output=True, text=True)
        shutil.copy(SPEC, base / "campfire.crud")
        print(f"Rust copy: {rust}\nspec copy: {base / 'campfire.crud'}")
    elif cmd == "spec":
        case, edited = Path(sys.argv[2]), base / "campfire.crud"
        with tempfile.TemporaryDirectory() as tmp:
            t = Path(tmp)
            (t / "a" / "spec").mkdir(parents=True)
            (t / "b" / "spec").mkdir(parents=True)
            shutil.copy(SPEC, t / "a" / "spec" / "campfire.crud")
            shutil.copy(edited, t / "b" / "spec" / "campfire.crud")
            r = subprocess.run(["git", "diff", "--no-index", "--no-prefix", "a/spec/campfire.crud", "b/spec/campfire.crud"], cwd=t, capture_output=True, text=True, encoding="utf-8")
        if r.returncode == 0:
            die("the edited spec is identical to the frozen one")
        text = "\n".join(line for line in r.stdout.splitlines() if not line.startswith("index ")) + "\n"
        case.mkdir(parents=True, exist_ok=True)
        (case / "spec.patch").write_text(text, encoding="utf-8", newline="\n")
        print(f"wrote {case / 'spec.patch'}")
    elif cmd == "rust":
        case = Path(sys.argv[2])
        r = subprocess.run(["git", "diff"], cwd=rust, capture_output=True, text=True, encoding="utf-8")
        if r.returncode:
            die(r.stderr[-800:])
        if not r.stdout.strip():
            die("no edits in the Rust copy")
        case.mkdir(parents=True, exist_ok=True)
        (case / "baseline.patch").write_text(r.stdout, encoding="utf-8", newline="\n")
        print(f"wrote {case / 'baseline.patch'}")
    else:
        die(__doc__)


main()
