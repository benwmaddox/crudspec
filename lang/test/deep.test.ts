// The deep checks (lang/deep.ts): what they say about Campfire and Tasks as they are, and that
// each one catches the mistake it is for, on a broken copy or a small spec.
//   node lang/test/deep.test.ts
import { readFileSync } from "node:fs";
import { parse } from "../parser.ts";
import { deepCheck } from "../deep.ts";

let failed = 0;
const ok = (what: string, pass: boolean, detail?: unknown) => { console.log(`${pass ? "ok  " : "FAIL"} ${what}`); if (!pass) { failed++; if (detail) console.log(JSON.stringify(detail, null, 2)); } };
const codes = (src: string) => deepCheck(parse(src)).map((f) => f.code);
const campfire = readFileSync("apps/campfire/campfire.crud", "utf8");
const change = (from: string, to: string) => { if (!campfire.includes(from)) throw new Error(`not in the spec: ${from}`); return deepCheck(parse(campfire.replace(from, to))); };
const base = deepCheck(parse(campfire));
const has = (fs: { code: string; message: string }[], code: string, text = "") => fs.filter((f) => f.code === code && f.message.includes(text)).length > base.filter((f) => f.code === code && f.message.includes(text)).length;

// Campfire as it is: the signed-out actions without a rate limit, and one create that a repeat refuses
ok("Campfire: only the known findings", JSON.stringify(base.map((f) => f.code).sort()) === JSON.stringify(["SIGNED_OUT_UNLIMITED", "SIGNED_OUT_UNLIMITED", "SIGNED_OUT_UNLIMITED", "UNIQUE_UNGUARDED"]), base);
ok("Tasks: sign-up and sign-in have no rate limit; Task.notes is never used", JSON.stringify(codes(readFileSync("apps/tasks/tasks.crud", "utf8")).sort()) === JSON.stringify(["FIELD_NEVER_WRITTEN", "SIGNED_OUT_UNLIMITED", "SIGNED_OUT_UNLIMITED"]));

// writes
ok("delete_message's checks removed: the delete is unchecked", has(change("  require member(actor, message.room) else not_found\n  require can_administer(actor, message.creator) else forbidden\n  delete message", "  delete message"), "WRITE_UNCHECKED", "delete_message"));
ok("sign_in's rate limit removed: reported", has(change("  rate_limit 10 per 3 min by request.ip else blocked\n", ""), "SIGNED_OUT_UNLIMITED", "sign_in"));

// enum values and states
const flow = (extra: string) => `
enum Status { draft, review, published, archived }
entity Post { title: Text  status: Status = draft }
action submit(p: Post) { require actor != none and p.status == draft else invalid  set p.status = review }
action publish(p: Post) { require actor != none and p.status == review else invalid  set p.status = published }
${extra}`;
ok("every state reachable: nothing reported", !codes(flow(`action archive(p: Post) { require actor != none and p.status == published else invalid  set p.status = archived }`)).includes("ENUM_VALUE_UNREACHABLE"));
const noArchive = deepCheck(parse(flow("")));
ok("a state nothing moves to: reported", noArchive.some((f) => f.code === "ENUM_VALUE_UNREACHABLE" && f.message.includes("never holds archived")), noArchive);
const deadEnd = deepCheck(parse(flow(`action archive(p: Post) { require actor != none and p.status == retired else invalid  set p.status = archived }`.replace("retired", "archived"))));
ok("a state only reachable from itself: reported", deadEnd.some((f) => f.code === "ENUM_VALUE_UNREACHABLE" && f.message.includes("guarded by a value it never holds")), deadEnd);
ok("a value set from an argument: anything is reachable", !codes(flow(`action force(p: Post, s: Status) { require actor != none else invalid  set p.status = s }`)).includes("ENUM_VALUE_UNREACHABLE"));
ok("Campfire: a new user status nothing sets is reported", change("enum UserStatus { active, deactivated, banned }", "enum UserStatus { active, deactivated, banned, suspended }").some((f) => f.code === "ENUM_VALUE_UNREACHABLE" && f.message.includes("never holds suspended")));
ok("... but not a new involvement, which people choose (set_involvement takes it as an argument)", !change("enum Involvement {", "enum Involvement { loud,").some((f) => f.code === "ENUM_VALUE_UNREACHABLE"));

// triggers
const cyc = codes(`
entity A { n: Int = 0 }
entity B { a: A on delete cascade }
trigger on create A as a { create B { a: a } }
trigger on create B as b { create A { } }
`);
ok("triggers that create each other's rows: a cycle", cyc.includes("TRIGGER_CYCLE"), cyc);
ok("a trigger chain that ends: no cycle", !codes(`
entity A { n: Int = 0 }
entity B { a: A on delete cascade }
trigger on create A as a { create B { a: a } }
`).includes("TRIGGER_CYCLE"));

// deletes and unique keys
const restrict = `
entity Team { name: Text }
entity Member { team: Team }
action drop_team(t: Team) { require actor != none else forbidden  delete t }
`;
ok("a delete a reference restricts: reported", codes(restrict).includes("DELETE_RESTRICTED"));
ok("... not when the referring rows are deleted first", !codes(restrict.replace("delete t }", "delete Member where .team == t  delete t }")).includes("DELETE_RESTRICTED"));
ok("... nor with on delete cascade", !codes(restrict.replace("team: Team", "team: Team on delete cascade")).includes("DELETE_RESTRICTED"));
const uniq = `
entity Tag { name: Text  unique (name) }
action add_tag(name: Text) { require actor != none else forbidden  create Tag { name: name } }
`;
ok("a create keyed by an argument: reported", codes(uniq).includes("UNIQUE_UNGUARDED"));
ok("... not with ensure", !codes(uniq.replace("create Tag", "ensure Tag")).includes("UNIQUE_UNGUARDED"));
ok("... nor after a check", !codes(uniq.replace("else forbidden  create", "else forbidden  require not exists(Tag where .name == name) else invalid  create")).includes("UNIQUE_UNGUARDED"));

// the() and the_or_none() without unique key
const theQuery = `
entity Item { id: Int  code: Text  unique (code) }
action get_without_key(n: Int) { require actor != none else forbidden  let x = the_or_none(Item where .id == n) }
`;
ok("the_or_none() with id pinned: not reported", !codes(theQuery).includes("THE_NOT_UNIQUE"));

const theNoKey = `
entity Item { id: Int  code: Text }
action get_no_key(code: Text) { require actor != none else forbidden  let x = the(Item where .code == code) }
`;
ok("the() without unique key: reported", codes(theNoKey).includes("THE_NOT_UNIQUE"));

const theMultiKey = `
entity Item { id: Int  a: Text  b: Text  unique (a, b) }
action get_multi(a: Text, b: Text) { require actor != none else forbidden  let x = the(Item where .a == a and .b == b) }
`;
ok("the() with all unique key columns: not reported", !codes(theMultiKey).includes("THE_NOT_UNIQUE"));

// field use: reads and writes from every kind of site
const fieldUse = (extra: string) => deepCheck(parse(`
app t { name "T"  actor User }
entity User { name: Text  note: Text?  ua: Text? write_only }
entity Session { user: User on delete cascade  token: Text = token(24)  unique (token) }
identity s: Session.token from cookie "s"
action rename(name: Text) { require actor != none else forbidden  set actor.name = name }
action jot(note: Text) { require actor != none else forbidden  set actor.note = note  set actor.ua = note }
${extra}`));
const fu = (extra: string) => fieldUse(extra).map((f) => `${f.code} ${f.message.split(" ")[0]}`);
ok("a set through actor counts as a write", !fu("").some((c) => c.startsWith("FIELD_NEVER_WRITTEN User.note")), fu(""));
ok("a field written and never read: FIELD_NEVER_READ", fu("").includes("FIELD_NEVER_READ User.note"), fu(""));
ok("a cookie identity reads its token and the session's actor", !fu("").some((c) => /Session\.(token|user)/.test(c)), fu(""));
ok("a write_only field nothing reads: no finding", !fu("").some((c) => c.includes("User.ua")), fu(""));
const readByGate = fieldUse(`gate g: request.method == write and exists(User where .ua == "x") -> blocked`);
ok("a write_only field read by a gate: WRITE_ONLY_READ, an error", readByGate.some((f) => f.code === "WRITE_ONLY_READ" && f.severity === "error" && f.message.includes("gate g")), readByGate);
ok("a field read in a where (.f) counts as read", !fu("view v() { rows User where .note != none }").includes("FIELD_NEVER_READ User.note"), fu("view v() { rows User where .note != none }"));

process.exit(failed ? 1 : 0);
