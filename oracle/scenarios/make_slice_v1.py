"""Generates oracle/scenarios/slice-v1/*.json: scenarios covering every HTTP-observable
rule in docs/RULE-INVENTORY.md. Each scenario lists the rules it exercises."""
import json
from pathlib import Path

OUT = Path(__file__).parent / "slice-v1"
OUT.mkdir(exist_ok=True)

def user(key, name, role="member", ip=True, n=0):
    u = {"key": key, "name": name, "email": f"{key}@example.test", "role": role}
    if ip:
        u["ip"] = f"203.0.113.{10 + n}"
    return u

CAST = [user("ada", "Ada", "administrator", n=0), user("bob", "Bob", n=1), user("cy", "Cy", n=2), user("dee", "Dee", n=3)]
OPEN = {"key": "lobby", "type": "open", "name": "Lobby", "creator": "ada", "members": ["ada", "bob", "cy", "dee"]}

def scenario(sid, rules, setup, actions):
    setup = {"users": CAST, **setup} if "users" not in setup else setup
    (OUT / f"{sid}.json").write_text(json.dumps({"id": sid, "rules": rules, "setup": setup, "actions": actions}, indent=2) + "\n")

def act(actor, do, **kw):
    return {"actor": actor, "do": do, **kw}

# ---- authentication and gates
scenario("a01-unauthenticated", ["A1"],
         {"users": CAST + [user("eve", "Eve", ip=False)], "rooms": [OPEN]},
         [act("eve", "post_message", room="lobby", body="no session")])

shared_ip = [CAST[0], CAST[1], CAST[2], {**user("dee", "Dee", n=3), "ip": CAST[1]["ip"]}]
scenario("a02-banned-ip-blocks-writes-not-reads", ["A2", "N1"],
         {"users": shared_ip, "rooms": [OPEN], "messages": [{"key": "m1", "room": "lobby", "creator": "cy", "body": "hi"}]},
         [act("ada", "ban_user", user="bob"),
          act("bob", "post_message", room="lobby", body="banned, no session"),
          act("dee", "post_message", room="lobby", body="same address as bob"),
          act("dee", "list_messages", room="lobby"),
          act("cy", "post_message", room="lobby", body="different address", **{"as": "m2"})])

scenario("a03-sign-in-needs-active", ["A3", "D3"],
         {"rooms": [OPEN]},
         [act("ada", "deactivate_user", user="cy"),
          act("cy", "sign_in"),
          act("bob", "sign_in")])

# ---- roles
scenario("p-roles", ["P3", "P4", "P5"],
         {"rooms": [OPEN]},
         [act("bob", "change_role", user="cy", role="administrator"),
          act("ada", "change_role", user="bob", role="administrator"),
          act("ada", "change_role", user="cy", role="superuser"),
          act("ada", "deactivate_user", user="dee"),
          act("ada", "change_role", user="dee", role="administrator"),
          act("bob", "deactivate_user", user="cy")])

# ---- rooms
scenario("r02-restricted-room-creation", ["R2", "R3"],
         {"account": {"restrict_room_creation": True}, "rooms": [OPEN]},
         [act("bob", "create_open_room", name="Bob's"),
          act("bob", "create_closed_room", name="Bob's closed", users=["cy"]),
          act("ada", "create_open_room", name="Ada's", **{"as": "ada_room"})])

scenario("r03-open-room-admits-active-users", ["R1", "R3", "R6", "D3"],
         {"rooms": [OPEN]},
         [act("ada", "deactivate_user", user="dee"),
          act("bob", "create_open_room", name="Plans", **{"as": "plans"})])

scenario("r04-closed-room-selected-only", ["R4", "G1"],
         {"rooms": [OPEN]},
         [act("bob", "create_closed_room", name="Secret", users=["cy"], **{"as": "secret"}),
          act("bob", "post_message", room="secret", body="am I in?"),
          act("cy", "post_message", room="secret", body="yes", **{"as": "m1"})])

scenario("r05-direct-find-or-create", ["R5", "R6"],
         {"rooms": [OPEN]},
         [act("bob", "create_direct_room", users=["cy"], **{"as": "bob_cy"}),
          act("cy", "create_direct_room", users=["bob"]),
          act("bob", "create_direct_room", users=["cy", "dee"], **{"as": "trio"}),
          act("dee", "create_direct_room", users=["bob", "cy", "dee"])])

closed_bob = {"key": "club", "type": "closed", "name": "Club", "creator": "bob", "members": ["ada", "bob", "cy"]}
scenario("r08-update-permissions", ["R8", "R12"],
         {"rooms": [OPEN, closed_bob]},
         [act("bob", "update_open_room", room="lobby", name="Bob renames"),
          act("ada", "update_open_room", room="lobby", name="Main"),
          act("bob", "update_closed_room", room="club", name="Bob's club", users=["ada", "bob", "cy"]),
          act("dee", "update_closed_room", room="club", name="Dee", users=["dee"])])

scenario("r09-closed-becomes-open", ["R9", "R3"],
         {"rooms": [{"key": "club", "type": "closed", "name": "Club", "creator": "ada", "members": ["ada", "bob"]}]},
         [act("ada", "update_open_room", room="club", name="Now open")])

scenario("r09b-open-becomes-closed", ["R9", "R10"],
         {"rooms": [OPEN]},
         [act("ada", "update_closed_room", room="lobby", name="Now closed", users=["ada", "cy"])])

scenario("r10-closed-revise", ["R10", "R7"],
         {"rooms": [{"key": "club", "type": "closed", "name": "Club", "creator": "ada", "members": ["ada", "bob", {"user": "cy", "involvement": "everything"}]}]},
         [act("ada", "update_closed_room", room="club", name="Club", users=["ada", "cy", "dee"])])

direct = {"key": "dm", "type": "direct", "creator": "bob", "members": ["bob", "cy"]}
scenario("r11-direct-keeps-type", ["R11", "R12"],
         {"rooms": [OPEN, direct]},
         [act("bob", "update_open_room", room="dm", name="Public now"),
          act("bob", "update_closed_room", room="dm", name="Closed now", users=["bob", "cy", "dee"]),
          act("ada", "update_open_room", room="dm", name="Admin tries")])

scenario("r13-delete-room", ["R13", "R14", "G5"],
         {"rooms": [OPEN, {"key": "side", "type": "open", "name": "Side", "creator": "ada", "members": ["ada", "bob"]}],
          "messages": [{"key": "m1", "room": "side", "creator": "bob", "body": "side talk"}, {"key": "m2", "room": "lobby", "creator": "bob", "body": "lobby talk"}],
          "boosts": [{"key": "b1", "message": "m1", "booster": "ada", "content": "+1"}]},
         [act("bob", "delete_room", room="side"),
          act("cy", "delete_room", room="side"),
          act("ada", "delete_room", room="side")])

scenario("r13b-direct-delete-by-any-member", ["R13", "R14"],
         {"rooms": [OPEN, direct], "messages": [{"key": "m1", "room": "dm", "creator": "bob", "body": "psst"}]},
         [act("cy", "delete_room", room="dm"),
          act("dee", "delete_direct_room", room="dm"),
          act("cy", "delete_direct_room", room="dm")])

# ---- memberships
scenario("m-involvement", ["M1", "M2", "M3"],
         {"rooms": [OPEN, {"key": "club", "type": "closed", "name": "Club", "creator": "ada", "members": ["ada", "bob"]}]},
         [act("bob", "set_involvement", room="lobby", involvement="everything"),
          act("bob", "set_involvement", room="lobby", involvement="loud"),
          act("cy", "set_involvement", room="club", involvement="nothing"),
          act("cy", "set_involvement", room="lobby", involvement="invisible")])

# ---- messages
scenario("g-edit-delete-rules", ["G3", "G4", "P2"],
         {"rooms": [OPEN, {"key": "club", "type": "closed", "name": "Club", "creator": "ada", "members": ["ada", "bob"]}],
          "messages": [{"key": "m1", "room": "club", "creator": "bob", "body": "club only"},
                       {"key": "m2", "room": "lobby", "creator": "cy", "body": "cy's"}]},
         [act("cy", "edit_message", message="m1", body="cy can't see this"),
          act("ada", "edit_message", message="m2", body="admin edits cy"),
          act("dee", "delete_message", message="m2"),
          act("cy", "delete_message", message="m2"),
          act("cy", "edit_message", message="m2", body="already gone")])

scenario("u1-unread-marking", ["U1", "G2", "M1"],
         {"rooms": [{"key": "lobby", "type": "open", "name": "Lobby", "creator": "ada",
                     "members": ["ada", {"user": "bob", "involvement": "nothing"}, {"user": "cy", "involvement": "invisible"}, {"user": "dee", "involvement": "everything"}]}],
          "unread": [{"room": "lobby", "user": "dee"}]},
         [act("ada", "post_message", room="lobby", body="news", **{"as": "m1"}),
          act("dee", "post_message", room="lobby", body="more", **{"as": "m2"})])

paging_msgs = [{"key": f"m{i}", "room": "lobby", "creator": "bob" if i % 2 else "cy", "body": f"message {i}"} for i in range(1, 46)]
scenario("g6-paging", ["G6"],
         {"rooms": [OPEN, {"key": "empty", "type": "open", "name": "Empty", "creator": "ada", "members": ["ada", "bob", "cy", "dee"]},
                    {"key": "club", "type": "closed", "name": "Club", "creator": "ada", "members": ["ada"]}],
          "messages": paging_msgs},
         [act("bob", "list_messages", room="lobby"),
          act("bob", "list_messages", room="lobby", before="m10"),
          act("bob", "list_messages", room="lobby", after="m40"),
          act("bob", "list_messages", room="lobby", after="m1"),
          act("bob", "list_messages", room="empty"),
          act("bob", "list_messages", room="club")])

# ---- boosts
scenario("b-boosts", ["B1", "B2", "B3"],
         {"rooms": [OPEN, {"key": "club", "type": "closed", "name": "Club", "creator": "ada", "members": ["ada", "bob", "cy"]}],
          "messages": [{"key": "m1", "room": "club", "creator": "bob", "body": "boost me"}]},
         [act("cy", "boost", message="m1", content="+1", **{"as": "b1"}),
          act("dee", "boost", message="m1", content="nope"),
          act("bob", "boost", message="m1", content="self", **{"as": "b2"}),
          act("bob", "boost", message="m1", content="self again", **{"as": "b3"}),
          act("ada", "boost", message="m1", content="twenty characters!!", **{"as": "b4"}),
          act("dee", "unboost", boost="b1"),
          act("bob", "unboost", boost="b1"),
          act("cy", "unboost", boost="b1")])

# ---- users
scenario("d1-join", ["D1", "D2", "A1"],
         {"rooms": [OPEN, {"key": "club", "type": "closed", "name": "Club", "creator": "ada", "members": ["ada"]}]},
         [{"do": "join", "join_code": "WRONG", "name": "Fay", "email": "fay@example.test", "ip": "203.0.113.40"},
          {"do": "join", "join_code": "JOIN-CODE", "name": "Fay", "email": "fay@example.test", "ip": "203.0.113.40", "as": "fay"},
          {"do": "join", "join_code": "JOIN-CODE", "name": "Fay again", "email": "fay@example.test", "ip": "203.0.113.41"},
          act("fay", "post_message", room="lobby", body="hello, I'm new", **{"as": "m1"})])

scenario("d3-deactivate", ["D3", "D4", "P5"],
         {"rooms": [OPEN, {"key": "club", "type": "closed", "name": "Club", "creator": "ada", "members": ["ada", "cy"]}, {"key": "dm", "type": "direct", "creator": "cy", "members": ["bob", "cy"]}],
          "messages": [{"key": "m1", "room": "lobby", "creator": "cy", "body": "before"}],
          "boosts": [{"key": "b1", "message": "m1", "booster": "cy", "content": "me"}]},
         [act("ada", "deactivate_user", user="cy"),
          act("ada", "deactivate_user", user="cy"),
          act("cy", "post_message", room="dm", body="still here?")])

loop_user = [CAST[0], CAST[1], {**user("cy", "Cy", n=2), "ip": "127.0.0.1"}, CAST[3]]
scenario("n2-ban-private-address", ["N2"],
         {"users": loop_user, "rooms": [OPEN], "messages": [{"key": "m1", "room": "lobby", "creator": "cy", "body": "from localhost"}]},
         [act("ada", "ban_user", user="cy")])

scenario("n-ban-unban", ["N1", "N3", "N4", "P3"],
         {"rooms": [OPEN], "messages": [{"key": "m1", "room": "lobby", "creator": "bob", "body": "spam"}, {"key": "m2", "room": "lobby", "creator": "cy", "body": "fine"}],
          "boosts": [{"key": "b1", "message": "m2", "booster": "bob", "content": "+1"}]},
         [act("bob", "sign_in", ip="198.51.100.7"),
          act("cy", "ban_user", user="bob"),
          act("ada", "ban_user", user="bob"),
          act("ada", "unban_user", user="bob"),
          act("bob", "sign_in", ip="198.51.100.8")])

print(len(list(OUT.glob("*.json"))), "scenarios")
