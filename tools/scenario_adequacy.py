"""Scenario adequacy: does the oracle scenario set notice when the spec is wrong?

Applies targeted mutations to the reference spec, one at a time, and runs the
scenarios against the golden files. A mutation the scenarios don't catch is a gap
in the scenario set (or a mutation that doesn't change behaviour), and is listed.

  python tools/scenario_adequacy.py <golden-dir>
"""
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = ROOT / "spec" / "campfire.crud"
SCEN = ROOT / "oracle" / "scenarios" / "slice-v1"

MUTATIONS = {
    "R3 open room doesn't admit everyone": ("trigger on create Room as r when r.type == open {", "trigger on create Room as r when r.type == closed {"),
    "P2 creator can't administer": ("u.role == administrator or u == creator", "u.role == administrator"),
    "U1 invisible members marked unread": ("and .involvement != invisible and not .connected", "and not .connected"),
    "U1 creator marked unread": ("where .room == m.room and .user != m.creator and", "where .room == m.room and"),
    "D3 deactivation removes direct memberships": ("delete Membership where .user == user and .room.type != direct", "delete Membership where .user == user"),
    "A2/A1 gate order swapped": ("gate blocked_ip: request.method == write and exists(Ban where .ip == request.ip) -> blocked\ngate signed_in: not exists(Session where .user == actor) -> unauthenticated",
                                 "gate signed_in: not exists(Session where .user == actor) -> unauthenticated\ngate blocked_ip: request.method == write and exists(Ban where .ip == request.ip) -> blocked"),
    "A2 bans block reads too": ("request.method == write and exists(Ban", "exists(Ban"),
    "R2 restriction ignored": ("not Account.restrict_room_creation or u.role == administrator", "true"),
    "R4 closed room admits creator": ("for each u in User where it in users {                    // R4", "for each u in User where it in users or it == actor {                    // R4"),
    "R5 direct room always new": ("if not exists(Room where .type == direct and same_members(it, users, actor)) {", "if true {"),
    "R6 direct default involvement": ("if .room.type == direct then everything else mentions", "mentions"),
    "R10 closed update doesn't revoke": ("delete Membership where .room == room and not (.user in users)", "set room.name = name"),
    "R11 direct room reachable by update": ("require member(actor, room) and room.type != direct else not_found   // R11, R12\n  require can_administer(actor, room.creator) else forbidden           // R8\n  set room.name = name\n  set room.type = open",
                                            "require member(actor, room) else not_found   // R11, R12\n  require can_administer(actor, room.creator) else forbidden           // R8\n  set room.name = name\n  set room.type = open"),
    "R13 direct delete needs admin": ("require member(actor, room) and room.type == direct else not_found   // R13: any member",
                                      "require member(actor, room) and room.type == direct and can_administer(actor, room.creator) else not_found   // R13: any member"),
    "G1 non-member may post": ("require member(actor, room) else not_found                // G1", "require true else not_found                // G1"),
    "B2 one boost per user": ("create Boost { message: message, booster: actor, content: content } as boost", "if not exists(Boost where .message == message and .booster == actor) { create Boost { message: message, booster: actor, content: content } as boost }"),
    "B3 anyone may unboost": ("require boost.booster == actor else not_found", "require true else not_found"),
    "P4 unknown role becomes administrator": ('if role == "administrator" then administrator else member', 'if role == "member" then member else administrator'),
    "P5 role change on inactive user": ("require user.status == active else not_found              // P5\n  set user.role", "set user.role"),
    "N1 ban keeps messages": ("step remove_messages: delete Message where .creator == u", "step remove_messages: delete Ban where .user == u and .ip == \"none\""),
    "N2 private addresses accepted": ('require all(Session where .user == user : .ip == "" or public_ip(.ip)) else invalid', "require true else invalid"),
    "N3 unban leaves status": ("delete Ban where .user == user                             // N3\n  set user.status = active", "delete Ban where .user == user                             // N3"),
    "D1 join skips open rooms": ("trigger on create User as u {                               // D1", "trigger on create User as u when false {                               // D1"),
    "G6 page size 30": ("window 40 last", "window 30 last"),
    "M2 involvement for non-members": ("require member(actor, room) else not_found                // M2", "require true else not_found                // M2"),
}

def main():
    golden = sys.argv[1]
    src = SPEC.read_text(encoding="utf-8")
    missed = []
    tmp = ROOT / ".mutant.crud"
    try:
        for name, (a, b) in MUTATIONS.items():
            if src.count(a) != 1:
                print(f"SKIP {name}: pattern found {src.count(a)} times")
                continue
            tmp.write_text(src.replace(a, b), encoding="utf-8")
            r = subprocess.run(["node", str(ROOT / "tools" / "src" / "cli.ts"), "scenarios", str(tmp), str(SCEN), golden], capture_output=True, text=True)
            summary = (r.stdout.strip().splitlines() or ["(no output)"])[-1]
            if "scenarios match the oracle" not in summary:
                print(f"ERROR   {name}: the run crashed: {(r.stderr.strip().splitlines() or ['?'])[-1]}")
                missed.append(name)
                continue
            caught = r.returncode != 0
            print(f"{'caught' if caught else 'MISSED'}  {name}: {summary}")
            if not caught:
                missed.append(name)
    finally:
        tmp.unlink(missing_ok=True)
    print(f"\n{len(MUTATIONS) - len(missed)}/{len(MUTATIONS)} mutations caught")
    if missed:
        print("missed: " + "; ".join(missed))

main()
