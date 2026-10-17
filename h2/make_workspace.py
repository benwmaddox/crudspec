"""Builds one H2 run's workspace (docs/H2-PROTOCOL.md).

  python h2/make_workspace.py <task-id> <spec|rust> <run-id> --slot K

Spec arm:  runs/<run>/ has spec/campfire.crud (buggy), LANGUAGE.md, the interpreter and
           checker (tools/), a sample scenario, README.md and issue.md.
Rust arm:  runs/<run>/ has rust/ (the port's source, buggy, without reference/),
           test.py (syncs to WSL slot K and runs cargo test), README.md and issue.md.
Records start.json with the task, arm, slot and the hashes of the starting files.
"""
import argparse
import hashlib
import json
import shutil
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
H2 = Path("D:/code/crudspec-h2")
CORPUS = Path("D:/code/crudspec-corpus/v1/final/bugs")
PRISTINE_RUST = Path("D:/code/crudspec-h2/pristine-rust")   # baseline source at 6dae2fd, no reference/


def wsl_path(p: Path) -> str:
    p = p.resolve()
    return f"/mnt/{p.drive[0].lower()}{p.as_posix()[2:]}"


def git_apply(cwd: Path, patch: Path):
    r = subprocess.run(["git", "apply", str(patch.resolve())], cwd=cwd, capture_output=True, text=True)
    if r.returncode:
        raise SystemExit(f"patch failed: {r.stderr}")


def ensure_pristine():
    if (PRISTINE_RUST / "Cargo.toml").exists():
        return
    PRISTINE_RUST.mkdir(parents=True, exist_ok=True)
    r = subprocess.run(["wsl", "-d", "Ubuntu", "-u", "ben", "--", "bash", "-c",
                        f"cd /home/ben/linuxbench/crudspec-baseline/src && git -c safe.directory='*' ls-files -z | grep -zvx reference | xargs -0 cp --parents -t {wsl_path(PRISTINE_RUST)}"],
                       capture_output=True, text=True)
    if r.returncode:
        raise SystemExit(r.stderr)


SPEC_README = """# Workspace

You are maintaining a small chat application (accounts, users, rooms, memberships,
messages, boosts, bans) that is defined entirely by a crudspec spec:
`spec/campfire.crud`. The language is described in `LANGUAGE.md`.

Fix the problem described in `issue.md` by editing `spec/campfire.crud`.

Tools (run from this directory, with Node 24):

- `node tools/src/cli.ts parse spec/campfire.crud`: parse and count the declarations.
- `node tools/src/cli.ts check spec/campfire.crud --scope spec/campfire.scope.json`: run the checker (static checks plus bounded exploration, about 20 s).
- `node tools/src/cli.ts run spec/campfire.crud <scenario.json>`: run a scenario you write, and print each action's outcome and the final state.
  - `example-scenario.json` shows the format.
  - Action names and parameters are the spec's actions and views.
  - `actor` is a user key; `as` names a created row.
  - Users with an `ip` start signed in.

Work only inside this directory.
"""

RUST_README = """# Workspace

You are maintaining a chat application, a Rust port of Campfire: axum, rusqlite, and
server-rendered HTML. Its source is in `rust/`: crates/campfire holds the controllers and
HTTP handling, crates/db the models.

Fix the problem described in `issue.md` by editing the Rust source in `rust/`.

Tools (run from this directory):

- `python test.py` copies `rust/` into the build tree and runs the test suite: `cargo test -p campfire -p campfire_db`. A first build takes a few minutes; later ones are incremental. You may add tests.
- `python test.py --build` only builds.

Work only inside this directory.
"""

RUST_TEST = r'''"""Syncs rust/ into this run's WSL build tree and runs cargo (see README.md)."""
import subprocess, sys
from pathlib import Path
here = Path(__file__).resolve().parent
src = "/mnt/" + here.drive[0].lower() + (here / "rust").as_posix()[2:]
tree = "/home/ben/linuxbench/h2-slot-SLOT"
cmd = "cargo build -q -p campfire" if "--build" in sys.argv else "cargo test -p campfire -p campfire_db --no-fail-fast 2>&1 | tail -n 80"
script = (f"set -e; test -d {tree} || cp -a /home/ben/linuxbench/crudspec-baseline/src {tree}; "
          f"rsync -a --delete --exclude target --exclude reference --exclude .git {src}/ {tree}/; cd {tree}; export PATH=$HOME/.cargo/bin:$PATH; {cmd}")
sys.exit(subprocess.run(["wsl", "-d", "Ubuntu", "-u", "ben", "--", "bash", "-c", script]).returncode)
'''


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("task")
    ap.add_argument("arm", choices=["spec", "rust"])
    ap.add_argument("run")
    ap.add_argument("--slot", type=int, required=True)
    a = ap.parse_args()
    case = CORPUS / a.task
    task_dir = H2 / "tasks" / a.task
    ws = H2 / "runs" / a.run
    if ws.exists():
        raise SystemExit(f"{ws} exists")
    ws.mkdir(parents=True)
    shutil.copy(task_dir / "issue.md", ws / "issue.md")
    if a.arm == "spec":
        (ws / "spec").mkdir()
        shutil.copy(ROOT / "spec" / "campfire.crud", ws / "spec" / "campfire.crud")
        git_apply(ws, case / "spec.patch")
        shutil.copy(ROOT / "spec" / "campfire.scope.json", ws / "spec" / "campfire.scope.json")
        shutil.copy(ROOT / "docs" / "LANGUAGE.md", ws / "LANGUAGE.md")
        shutil.copytree(ROOT / "tools" / "src", ws / "tools" / "src")
        shutil.copy(ROOT / "h2" / "example-scenario.json", ws / "example-scenario.json")
        (ws / "README.md").write_text(SPEC_README, encoding="utf-8")
        start = {"spec/campfire.crud": hashlib.sha256((ws / "spec" / "campfire.crud").read_bytes()).hexdigest()}
    else:
        ensure_pristine()
        shutil.copytree(PRISTINE_RUST, ws / "rust")
        git_apply(ws / "rust", case / "baseline.patch")
        (ws / "test.py").write_text(RUST_TEST.replace("SLOT", str(a.slot)), encoding="utf-8")
        (ws / "README.md").write_text(RUST_README, encoding="utf-8")
        start = {}
    # A copy of the starting state, outside the workspace, for measuring what the run changed.
    starts = H2 / "starts" / a.run
    starts.mkdir(parents=True)
    if a.arm == "spec":
        shutil.copy(ws / "spec" / "campfire.crud", starts / "campfire.crud")
    else:
        shutil.copytree(ws / "rust", starts / "rust")
    (ws.parent.parent / "meta").mkdir(exist_ok=True)
    meta = {"task": a.task, "arm": a.arm, "run": a.run, "slot": a.slot, "start": start}
    (ws.parent.parent / "meta" / f"{a.run}.json").write_text(json.dumps(meta, indent=2) + "\n")
    print(ws)


main()
