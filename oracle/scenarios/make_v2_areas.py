"""Generates the v2-area oracle scenarios: parts of Campfire the v1 slice didn't cover.

  python oracle/scenarios/make_v2_areas.py

Each scenario sets "v2": true, so the oracle also records account settings, profiles,
webhooks, search history and push subscriptions.
"""
import json
from pathlib import Path

OUT = Path(__file__).parent / "v2-areas"
OUT.mkdir(exist_ok=True)
for f in OUT.glob("*.json"):
    f.unlink()


def user(key, name, role="member", ip=True, n=0, **extra):
    u = {"key": key, "name": name, "email": f"{key}@example.test", "role": role}
    if ip:
        u["ip"] = f"203.0.113.{10 + n}"
    u.update(extra)
    return u


CAST = [user("ada", "Ada", "administrator", n=0), user("bob", "Bob", n=1), user("cy", "Cy", n=2)]
LOBBY = {"key": "lobby", "type": "open", "name": "Lobby", "creator": "ada", "members": ["ada", "bob", "cy"]}


def act(actor, do, **kw):
    return {"actor": actor, "do": do, **kw}


def scenario(sid, areas, setup, actions):
    setup = {"users": CAST, **setup} if "users" not in setup and not setup.get("empty") else setup
    (OUT / f"{sid}.json").write_text(json.dumps({"id": sid, "v2": True, "rules": areas, "setup": setup, "actions": actions}, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


scenario("v2-search", ["search"],
         {"rooms": [LOBBY, {"key": "club", "type": "closed", "name": "Club", "creator": "ada", "members": ["ada"]}],
          "messages": [{"key": "m1", "room": "lobby", "creator": "ada", "body": "deploy the rocket"},
                       {"key": "m2", "room": "club", "creator": "ada", "body": "rocket secrets"},
                       {"key": "m3", "room": "lobby", "creator": "bob", "body": "hello there"}],
          "searches": [{"user": "bob", "query": f"old{i}"} for i in range(1, 11)]},
         [act("bob", "search", query="rocket"),
          act("bob", "search_results", query="rocket"),
          act("ada", "search_results", query="secrets"),
          act("bob", "search_results", query="secrets"),
          act("bob", "search", query="rocket!"),
          act("cy", "search", query="hello"),
          act("cy", "clear_searches")])

scenario("v2-profile", ["profile"],
         {"rooms": [LOBBY]},
         [act("bob", "update_profile", name="Robert", bio="Builds rockets"),
          act("cy", "update_profile", email="ada@example.test"),
          act("cy", "update_profile", bio="")])

scenario("v2-account", ["account"],
         {"rooms": [LOBBY]},
         [act("ada", "update_account", name="Basecamp"),
          act("bob", "update_account", name="Hijacked"),
          act("ada", "update_custom_styles", custom_styles="body { color: red }"),
          act("bob", "update_custom_styles", custom_styles="body { display: none }"),
          act("bob", "reset_join_code"),
          act("ada", "reset_join_code"),
          act("ada", "update_account", restrict_room_creation=True),
          act("bob", "create_open_room", name="Mine"),
          act("ada", "create_open_room", name="Ours", **{"as": "ours"})])

scenario("v2-bots", ["bots"],
         {"rooms": [LOBBY]},
         [act("bob", "create_bot", name="Rogue"),
          act("ada", "create_bot", name="Botty", webhook_url="https://hooks.example.test/botty", **{"as": "botty"}),
          act("ada", "update_bot", b="botty", name="Botty II"),
          act("ada", "reset_bot_key", b="botty"),
          act("bob", "reset_bot_key", b="botty"),
          act("ada", "delete_bot", b="botty"),
          act("ada", "reset_bot_key", b="botty")])

BOT = user("botty", "Botty", "bot", ip=False, bot_token="TOKENabc1234")
BOT.pop("email")
scenario("v2-bot-api", ["bot api"],
         {"users": CAST + [BOT],
          "rooms": [{**LOBBY, "members": ["ada", "bob", "cy", "botty"]}, {"key": "club", "type": "closed", "name": "Club", "creator": "ada", "members": ["ada"]}]},
         [act("botty", "bot_post", room="lobby", body="deploy done", **{"as": "b1"}),
          act("botty", "bot_post", room="club", body="sneaking in"),
          act("botty", "bot_post", room="lobby", body="bad key", bot_key="999-nope"),
          act("botty", "bot_post", room="lobby", body=""),
          act("botty", "bot_boost", room="lobby", message="b1", content="ship"),
          act("botty", "bot_edit", room="lobby", message="b1", body="deploy really done"),
          act("bob", "post_message", room="lobby", body="nice", **{"as": "m2"}),
          act("botty", "bot_edit", room="lobby", message="m2", body="hijack"),
          act("botty", "bot_delete", room="lobby", message="b1")])

scenario("v2-transfer", ["sessions"],
         {"rooms": [LOBBY]},
         [{"do": "transfer_session", "user": "bob", "ip": "198.51.100.20"},
          {"do": "transfer_session", "link": "bogus-link", "ip": "198.51.100.21"},
          act("ada", "deactivate_user", user="cy"),
          {"do": "transfer_session", "user": "cy", "ip": "198.51.100.22"}])

scenario("v2-first-run", ["setup"],
         {"empty": True, "users": []},
         [{"do": "first_run", "name": "Ada", "email": "ada@example.test", "ip": "203.0.113.10", "as": "ada"},
          {"do": "first_run", "name": "Mallory", "email": "mallory@example.test", "ip": "203.0.113.66"},
          act("ada", "post_message", room="all_talk", body="first!", **{"as": "m1"})])

scenario("v2-push", ["push"],
         {"rooms": [LOBBY]},
         [act("bob", "subscribe_push", endpoint="http://push.example.test/abc", p256dh_key="k", auth_key="a"),
          act("bob", "subscribe_push", endpoint="https://evil.example.test/abc", p256dh_key="k", auth_key="a")])

scenario("v2-deactivate-cleanup", ["deactivation"],
         {"rooms": [LOBBY], "searches": [{"user": "bob", "query": "rockets"}]},
         [act("ada", "deactivate_user", user="bob"),
          act("bob", "search", query="still here")])

print(len(list(OUT.glob("*.json"))), "scenarios")
