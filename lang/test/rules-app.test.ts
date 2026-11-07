// The rules in a compiled app, over HTTP (lang/rules.ts): a parameter naming a row a policy for rows
// in a container hides is not_found, a member's call goes through, a subset parameter outside its
// condition is not_found, stamps record who created and changed a row (also for a touch, and for a
// trigger's change), and on delete nullify leaves a referring row with none.
//   node lang/test/rules-app.test.ts
process.removeAllListeners("warning");
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApp } from "./go-app.ts";

let failed = 0;
const ok = (what: string, pass: boolean, detail?: unknown) => { console.log(`${pass ? "ok  " : "FAIL"} ${what}`); if (!pass) { failed++; if (detail !== undefined) console.log(JSON.stringify(detail)); } };

const SPEC = `app chat { name "Chat" actor User }
enum Status { active, gone }
entity User { name: Text  token: Text?  status: Status = active }
identity login: User.token from cookie "login"
entity Room { name: Text }
entity Membership { room: Room on delete cascade  user: User on delete cascade }
entity Message { room: Room on delete cascade  author: User on delete cascade  body: Text }
entity Pin { message: Message on delete cascade  by: User? on delete nullify }
fn member(u: User?, r: Room): Bool = exists(Membership where .room == r and .user == u)
policy user_rows: true for rows of User
policy room_rows: member(actor, room) for rows in Room
policy pin_rows: true for rows of Pin
subset ActiveUser = User where .status == active
stamp created_by: User? = actor on create for rows of Message
stamp changed_by: User? = actor on change for rows of Message
action post(room: Room, body: Text) { create Message { room: room, author: actor, body: body } as m  result m }
action edit(message: Message, body: Text) { require message.author == actor else forbidden  set message.body = body }
action bump(message: Message) { touch message }
action greet(u: ActiveUser) { result u.name }
action pin(message: Message) { create Pin { message: message, by: actor } }
action remove_user(u: User) { delete u }
`;

const dir = mkdtempSync(join(tmpdir(), "rules-app-"));
writeFileSync(join(dir, "app.crud"), SPEC);
const app = await startApp(join(dir, "app.crud"), 13961);
try {
  const row = (id: number, fields: Record<string, unknown>) => ({ id, seq: id, created: 100 + id, updated: 100 + id, fields });
  const ref = (e: string, id: number) => ({ ref: e, id });
  await app.post("/_test/load", { clock: 1000, rows: {
    User: [row(1, { name: "ada", token: null, status: "active" }), row(2, { name: "bob", token: null, status: "active" }), row(3, { name: "cy", token: null, status: "gone" })],
    Room: [row(1, { name: "both" }), row(2, { name: "ada's" })],
    Membership: [row(1, { room: ref("Room", 1), user: ref("User", 1) }), row(2, { room: ref("Room", 1), user: ref("User", 2) }), row(3, { room: ref("Room", 2), user: ref("User", 1) })],
    Message: [row(1, { room: ref("Room", 2), author: ref("User", 1), body: "hi", created_by: null, changed_by: null }), row(2, { room: ref("Room", 1), author: ref("User", 2), body: "yo", created_by: null, changed_by: null })],
  } });
  const call = async (who: number, action: string, args: Record<string, string>) => {
    const r = await fetch(app.base + "/_do/" + action, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Test-Actor": `User:${who}` }, body: new URLSearchParams(args), redirect: "manual" });
    return { outcome: r.headers.get("X-Crudspec-Outcome"), status: r.status };
  };
  const rows = async (entity: string) => ((await app.post("/_test/dump", {})).rows[entity] as any[]);
  const message = async (id: number) => (await rows("Message")).find((r) => r.id === id)?.fields;
  const isRef = (v: any, id: number) => v && v.ref === "User" && v.id === id;

  // a row the policy hides is one that doesn't exist
  let c = await call(2, "edit", { message: "1", body: "hacked" });
  ok("bob, not in ada's room, edits her message there: not_found (not forbidden: he doesn't learn it exists)", c.outcome === "not_found", c);
  ok("... and the message is unchanged", (await message(1))?.body === "hi", await message(1));
  c = await call(2, "post", { room: "2", body: "hello?" });
  ok("bob posts to a room he isn't in: not_found", c.outcome === "not_found", c);
  c = await call(2, "edit", { message: "2", body: "yo!" });
  ok("bob, a member, edits his message: ok", c.outcome === "ok", c);
  c = await call(1, "edit", { message: "2", body: "mine now" });
  ok("ada, a member, edits bob's message: forbidden (the author check, after the member check)", c.outcome === "forbidden", c);

  // stamps
  ok("a change sets changed_by to who acted (bob)", isRef((await message(2))?.changed_by, 2), await message(2));
  c = await call(1, "post", { room: "1", body: "second" });
  const second = (await rows("Message")).find((r) => r.fields.body === "second")?.fields;
  ok("a create sets created_by and changed_by to who acted (ada)", c.outcome === "ok" && isRef(second?.created_by, 1) && isRef(second?.changed_by, 1), second);
  c = await call(1, "bump", { message: "2" });
  ok("a touch is a change: changed_by is ada now", c.outcome === "ok" && isRef((await message(2))?.changed_by, 1), [c, await message(2)]);

  // subsets
  c = await call(1, "greet", { u: "3" });
  ok("a parameter of a subset type outside it (cy is gone): not_found", c.outcome === "not_found", c);
  c = await call(1, "greet", { u: "2" });
  ok("... inside it: ok", c.outcome === "ok", c);

  // on delete nullify
  c = await call(1, "pin", { message: "2" });
  ok("ada pins bob's message", c.outcome === "ok" && (await rows("Pin")).length === 1, c);
  c = await call(2, "remove_user", { u: "1" });
  const pins = await rows("Pin");
  ok("deleting ada isn't refused by the pin's reference to her (on delete nullify)", c.outcome === "ok", c);
  ok("... the pin stays, with by none", pins.length === 1 && (pins[0].fields.by === null || pins[0].fields.by === undefined), pins);
  ok("... and changed_by on bob's message, last ada, is none too (a stamp's reference is nullify)", !isRef((await message(2))?.changed_by, 1), await message(2));} finally {
  await app.stop();
}
process.exit(failed ? 1 : 0);
