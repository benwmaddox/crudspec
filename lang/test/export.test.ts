// export: a view's rows as CSV or JSON, in the compiled app over HTTP. The view's requires and
// the rows' read permission hold (a non-member gets nothing); cells a spreadsheet would run as
// formulas are neutralized; the file is named safely; private fields are refused by the checker.
//   node lang/test/export.test.ts
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "../parser.ts";
import { check } from "../check.ts";
import { startApp } from "./go-app.ts";

let failed = 0;
const ok = (what: string, pass: boolean, detail?: unknown) => { console.log(`${pass ? "ok  " : "FAIL"} ${what}`); if (!pass) { failed++; if (detail !== undefined) console.log(JSON.stringify(detail).slice(0, 900)); } };
const errors = (src: string) => check(parse(src)).filter((f) => f.severity === "error");
const BASE = `
app t { name "T" actor User }
entity User { name: Text  token: Text?  secret: Text? private }
display User: .name
entity Room { name: Text }
entity Membership { room: Room  user: User }
entity Message { room: Room  author: User  body: Text  pic: File? }
entity Boost { message: Message  content: Text }
identity login: User.token from cookie "login"
predicate member(r: Room) = exists(Membership where .room == r and .user == actor)
permission read Message: member(message.room)
view room_messages(room: Room) {
  require actor != none else unauthenticated
  require member(room) else not_found
  rows Message where .room == room order by .created
}
`;
const SPEC = BASE + `
export room_csv "/rooms/:room/export.csv" (room: Room) csv of room_messages(room) as m named room.name + " messages" {
  "Timestamp": .created, "Author": .author, "Message": .body, "Reactions": list(.content for Boost where .message == m), "Attachment": .pic
}
export room_json "/rooms/:room/export.json" (room: Room) json of room_messages(room) as m named room.name + ".json" {
  timestamp: .created, author: .author.name, message_text: .body, reactions: list(.content for Boost where .message == m), attachments: [.pic]
}
`;

ok("the spec checks", !errors(SPEC).length, errors(SPEC));
ok("a private field can't be exported", errors(BASE + `export x "/x/:room" (room: Room) csv of room_messages(room) { "S": .author.secret }`).some((f) => f.code === "PRIVATE_FIELD"));
ok("an export is of a view's rows", errors(BASE + `export x "/x" csv of nothing() { "A": .body }`).some((f) => f.code === "EXPORT_SOURCE"));
ok("a column once", errors(BASE + `export x "/x/:room" (room: Room) csv of room_messages(room) { "A": .body, "A": .body }`).some((f) => f.code === "EXPORT_COLUMN"));

const dir = mkdtempSync(join(tmpdir(), "export-"));
writeFileSync(join(dir, "app.crud"), SPEC);
const app = await startApp(join(dir, "app.crud"), 13895);
try {
  const T = Date.UTC(2026, 0, 5, 12, 0);
  const row = (id: number, fields: any, created = T) => ({ id, seq: id, created, updated: created, fields });
  await app.post("/_test/load", { clock: T + 10_000, rows: {
    User: [row(1, { name: "Ada", token: "tok-ada", secret: "s1" }), row(2, { name: "Bob", token: "tok-bob", secret: null })],
    Room: [row(1, { name: "Gen/eral\"" })],
    Membership: [row(1, { room: { ref: "Room", id: 1 }, user: { ref: "User", id: 1 } })],
    Message: [row(1, { room: { ref: "Room", id: 1 }, author: { ref: "User", id: 1 }, body: "=1+1", pic: { file: "a.png", stored: "k.png", content_type: "image/png", size: 10 } }, T + 1000),
      row(2, { room: { ref: "Room", id: 1 }, author: { ref: "User", id: 1 }, body: "hello, \"world\"\nline two", pic: null }, T + 2000)],
    Boost: [row(1, { message: { ref: "Message", id: 1 }, content: "👍" }), row(2, { message: { ref: "Message", id: 1 }, content: "🎉" })],
  } });
  const get = (path: string, token?: string) => fetch(app.base + path, { headers: token ? { Cookie: `login=${token}` } : {}, redirect: "manual" });
  const csv = await get("/rooms/1/export.csv", "tok-ada");
  const text = await csv.text();
  ok("a member downloads the CSV", csv.status === 200 && csv.headers.get("content-type")?.startsWith("text/csv") === true, { status: csv.status, text });
  ok("named safely, with its extension", /attachment; filename="Gen_eral_ messages\.csv"/.test(csv.headers.get("content-disposition") ?? ""), csv.headers.get("content-disposition"));
  const lines = text.trim().split("\n");
  ok("a header row, then the rows oldest first", lines[0] === "Timestamp,Author,Message,Reactions,Attachment" && lines[1].startsWith("2026-01-05T12:00:01.000Z,Ada,"), lines);
  ok("a formula is neutralized", lines[1].includes(",'=1+1,"), lines[1]);
  ok("reactions and the attachment's name", lines[1].endsWith(",👍; 🎉,a.png"), lines[1]);
  ok("quotes and line breaks are escaped", text.includes('"hello, ""world""\nline two"'), text);
  const js = await get("/rooms/1/export.json", "tok-ada");
  const data = await js.json();
  ok("the JSON export: an array of objects", js.status === 200 && Array.isArray(data) && data.length === 2, data);
  ok("its fields", data[0].timestamp === "2026-01-05T12:00:01.000Z" && data[0].author === "Ada" && data[0].message_text === "=1+1" && JSON.stringify(data[0].reactions) === JSON.stringify(["👍", "🎉"]), data[0]);
  ok("files as metadata only", JSON.stringify(data[0].attachments) === JSON.stringify([{ filename: "a.png", size: 10, type: "image/png" }]) && JSON.stringify(data[1].attachments) === "[null]", data[0].attachments);
  ok("a non-member gets nothing (the view's require)", (await get("/rooms/1/export.csv", "tok-bob")).status === 404);
  ok("no one signed in is sent to sign in", [302, 303].includes((await get("/rooms/1/export.csv")).status));
} finally { app.stop(); }
process.exit(failed ? 1 : 0);
