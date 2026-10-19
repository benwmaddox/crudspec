// Invariants proven with Z3 (lang/invariants.ts): an action that can break one gives a
// counterexample; one that keeps it is proven; what the proof can't follow is unproven with the
// reason; a spec with no invariant doesn't load Z3.
//   node lang/test/invariants.test.ts
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { proveAll, type InvResult } from "../invariants.ts";

let failed = 0;
const ok = (what: string, pass: boolean, detail?: unknown) => { console.log(`${pass ? "ok  " : "FAIL"} ${what}`); if (!pass) { failed++; if (detail !== undefined) console.log(JSON.stringify(detail, null, 2)); } };
const dir = mkdtempSync(join(tmpdir(), "inv-test-"));
let n = 0;
const prove = async (src: string) => { const f = join(dir, `s${n++}.crud`); writeFileSync(f, src); return proveAll(f, { timeoutMs: 8000 }); };
const find = (rs: InvResult[], inv: string, where: string) => rs.find((r) => r.invariant === inv && r.where === `action ${where}`);

const SPEC = `app t { name "T"  actor User }
enum Role { member, administrator }
enum Status { active, gone }
entity User { name: Text  role: Role = member  status: Status = active  token: Text?  digest_on: Bool = false  digest_zone: Text? }
entity Room { name: Text  owner: User on delete cascade }
entity Note { room: Room on delete cascade  body: Text }
identity login: User.token from cookie "login"
invariant has_admin: not exists(User where true) or exists(User where .role == administrator and .status == active)
invariant digest_ready: all(.digest_zone != none for User where .digest_on)
invariant notes_in_rooms: all(.room.name != "" for Note where true)
action deactivate(u: User) { require actor != none and actor.role == administrator else forbidden  set u.status = gone }
action deactivate_safe(u: User) {
  require actor != none and actor.role == administrator else forbidden
  require u.role != administrator or exists(User where .role == administrator and .status == active and it != u) else invalid
  set u.status = gone
}
action digest_on(on: Bool) { require actor != none else forbidden  set actor.digest_on = on }
action digest_with_zone(zone: Text) { require actor != none else forbidden  set actor.digest_zone = zone  set actor.digest_on = true }
action rename(name: Text) { require actor != none else forbidden  set actor.name = name }
action delete_room(r: Room) { require actor != none and r.owner == actor else forbidden  delete r }
action add_note(r: Room, body: Text) { require actor != none else forbidden  create Note { room: r, body: body } }
action blank_room(r: Room) { require actor != none else forbidden  set r.name = "" }
action shout(r: Room) { require actor != none else forbidden  set r.name = upper(r.name) }
action promote_all() { require actor != none and actor.role == administrator else forbidden  for each u in User where .status == active { set u.role = administrator } }
`;
const rs = await prove(SPEC);
const dl = find(rs, "has_admin", "deactivate");
ok("deactivating the last administrator breaks has_admin", dl?.status === "broken" && /status active → gone/.test(dl.counterexample ?? "") && /role administrator/.test(dl.counterexample ?? ""), dl);
ok("... the bounded search found it", dl?.how === "bounded", dl);
ok("checking for another administrator first keeps it", find(rs, "has_admin", "deactivate_safe")?.status === "proven", find(rs, "has_admin", "deactivate_safe"));
const don = find(rs, "digest_ready", "digest_on");
ok("turning the digest on without a zone breaks digest_ready", don?.status === "broken" && /digest_on false → true/.test(don.counterexample ?? "") && /digest_zone none/.test(don.counterexample ?? ""), don);
ok("setting the zone first keeps it", find(rs, "digest_ready", "digest_with_zone")?.status === "proven");
ok("an action that writes nothing the invariant reads is proven at once", find(rs, "has_admin", "rename")?.status === "proven" && /nothing the invariant reads/.test(find(rs, "has_admin", "rename")?.reason ?? ""));
ok("a delete with cascades keeps notes_in_rooms", find(rs, "notes_in_rooms", "delete_room")?.status === "proven", find(rs, "notes_in_rooms", "delete_room"));
ok("a note in a room with a blank name breaks notes_in_rooms (such a room can exist)", find(rs, "notes_in_rooms", "add_note")?.status === "broken", find(rs, "notes_in_rooms", "add_note"));
ok("blanking a room's name breaks notes_in_rooms", find(rs, "notes_in_rooms", "blank_room")?.status === "broken", find(rs, "notes_in_rooms", "blank_room"));
const sh = find(rs, "notes_in_rooms", "shout");
ok("a text function the proof doesn't follow: unproven, not broken", sh?.status === "unproven" && /upper/.test(sh.reason ?? ""), sh);
ok("a loop over rows keeps has_admin", find(rs, "has_admin", "promote_all")?.status === "proven", find(rs, "has_admin", "promote_all"));
ok("a spec with no invariant proves nothing (and loads no Z3)", (await prove(SPEC.replace(/^invariant .*$/gm, ""))).length === 0);
process.exit(failed ? 1 : 0);
