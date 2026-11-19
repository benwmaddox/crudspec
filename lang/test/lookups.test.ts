// the_or_none(E where …) is none when no row matches and when two or more do (rt.TheOrNone).
// check warns (LOOKUP_NOT_UNIQUE) unless the condition pins a unique key with ==, it or .id, the
// entity is a singleton, or a data shape's listed rows differ on the fields pinned.
//   node lang/test/lookups.test.ts
process.removeAllListeners("warning");
import { parse } from "../parser.ts";
import { check } from "../check.ts";

let failed = 0;
const ok = (what: string, pass: boolean, detail?: unknown) => { console.log(`${pass ? "ok  " : "FAIL"} ${what}`); if (!pass) { failed++; if (detail !== undefined) console.log(JSON.stringify(detail)); } };

const head = `app t { name "T" actor User }
enum Role { member, administrator }
entity User { name: Text  email: Email  role: Role = member  token: Text?  unique (email) }
identity login: User.token from cookie "login"
entity Room { name: Text }
entity Member { room: Room  user: User  unique (room, user) }
singleton Settings { theme: Text = "light" }
data Sound { name: Text  text: Text? } rows [ { name: "bell", text: "b" }, { name: "horn", text: "h" } ]
data Echo { name: Text } rows [ { name: "a" }, { name: "a" } ]
`;
const warned = (body: string) => check(parse(head + `action a(e: Email, r: Room, u: User, s: Text) {\n  callers people\n  ${body}\n}\n`)).filter((f) => f.code === "LOOKUP_NOT_UNIQUE");

ok("a lookup on a non-unique field warns", warned(`let x = the_or_none(User where .role == administrator)`).length === 1);
ok("... and says what to do (a unique key, first_or_none, exists)", /unique key \(email\).*first_or_none.*exists/.test(warned(`let x = the_or_none(User where .role == administrator)`)[0]?.message ?? ""));
ok("a lookup with no condition warns", warned(`let x = the_or_none(User)`).length === 1);
ok("a unique key matched with == doesn't", warned(`let x = the_or_none(User where .email == e)`).length === 0);
ok("... with more conditions joined by and doesn't", warned(`let x = the_or_none(User where .email == e and .role == member)`).length === 0);
ok("... written value == .field doesn't", warned(`let x = the_or_none(User where e == .email)`).length === 0);
ok("a key of two fields, both matched, doesn't", warned(`let x = the_or_none(Member where .room == r and .user == u)`).length === 0);
ok("a key of two fields, one matched, warns", warned(`let x = the_or_none(Member where .room == r)`).length === 1);
ok("a key matched under or warns (or pins nothing)", warned(`let x = the_or_none(User where .email == e or .role == member)`).length === 1);
ok("it == a row doesn't", warned(`let x = the_or_none(User where it == u)`).length === 0);
ok("a singleton doesn't", warned(`let x = the_or_none(Settings)`).length === 0);
ok("a data shape whose rows differ on the field doesn't", warned(`let x = the_or_none(Sound where .name == s)`).length === 0);
ok("a data shape with two rows alike warns", warned(`let x = the_or_none(Echo where .name == s)`).length === 1);
ok("first_or_none and the() don't", warned(`let x = first_or_none(User where .role == administrator)\n  let y = the(User where .role == administrator)`).length === 0);
ok("in a function too", check(parse(head + `query admin(): User? = the_or_none(User where .role == administrator)\n`)).some((f) => f.code === "LOOKUP_NOT_UNIQUE"));
process.exit(failed ? 1 : 0);
