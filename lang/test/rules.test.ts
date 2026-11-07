// Rules written once and woven in (lang/rules.ts, docs/RULES-DESIGN.md): subsets, policies for rows of
// several entities and for rows in a container, and a parameter naming a row its policy hides being a
// row that doesn't exist (not_found), where the parameter is first used.
//   node lang/test/rules.test.ts
process.removeAllListeners("warning");
import { parse, SpecError } from "../parser.ts";
import { check } from "../check.ts";
import { typecheck } from "../types.ts";
import { expandText } from "../expand.ts";

let failed = 0;
const ok = (what: string, pass: boolean, detail?: unknown) => { console.log(`${pass ? "ok  " : "FAIL"} ${what}`); if (!pass) { failed++; if (detail !== undefined) console.log(JSON.stringify(detail).slice(0, 500)); } };
const refused = (src: string): string | undefined => { try { parse(src); return undefined; } catch (e) { return e instanceof SpecError ? e.code : String(e); } };
const show = (d: any) => JSON.stringify(d, (k, v) => (k === "pos" ? undefined : v));

const base = `app t { name "T"  actor User }
enum Status { active, gone }
entity User { name: Text  status: Status = active }
entity Room { name: Text }
entity Membership { room: Room  user: User }
entity Message { room: Room  author: User  body: Text }
entity Boost { message: Message  by: User }
entity Note { user: User  text: Text }
fn member(u: User?, r: Room): Bool = exists(Membership where .room == r and .user == u)
policy user_rows: true for rows of User
policy room_rows: member(actor, room) for rows in Room
policy own_rows: .user == actor for rows of Membership, Note
`;
const spec = (src: string) => parse(base + src);
const decl = (src: string, name: string): any => spec(src).decls.find((d: any) => d.name === name && d.kind !== "permission");
const perm = (src: string, e: string): any => spec(src).decls.find((d: any) => d.kind === "permission" && d.entity === e);

// ---- row policies
{
  ok("for rows in Room covers Room itself, as the policy says", show(perm("", "Room").cond) === show({ kind: "call", name: "member", args: [{ kind: "name", name: "actor" }, { kind: "name", name: "room" }], named: {} }), perm("", "Room").cond);
  ok("... a Message, by its room", show(perm("", "Message").cond).includes('"target":{"kind":"name","name":"message"},"name":"room"'), perm("", "Message").cond);
  ok("... a Boost, by its message's room (two references deep)", show(perm("", "Boost").cond).includes('"target":{"kind":"field","target":{"kind":"name","name":"boost"},"name":"message"},"name":"room"'), perm("", "Boost").cond);
  const m = perm("", "Membership");
  ok("an entity under two policies gets both, joined by and (Membership: in the room, and your own)", m.cond.kind === "binary" && m.cond.op === "and" && m.policies.join() === "room_rows,own_rows", m);
  ok("... and one permission per entity", spec("").decls.filter((d: any) => d.kind === "permission" && d.entity === "Membership").length === 1);
  ok("for rows of A, B: each gets the condition about its own row (.user is note.user)", show(perm("", "Note").cond).includes('"target":{"kind":"name","name":"note"},"name":"user"'), perm("", "Note").cond);
  ok("an optional reference is not a way into the container", perm("entity Draft { room: Room?  text: Text }\npolicy draft_rows: true for rows of Draft\n", "Draft").policies.join() === "draft_rows");
  ok("two shortest ways into the container: refused (ROWS_IN_AMBIGUOUS)", refused(base + "entity Pin { message: Message  boost: Boost  from: Room  to: Room }\n") === "ROWS_IN_AMBIGUOUS");
  ok("a container policy naming .f: refused (ROWS_IN_ROW)", refused(base.replace("member(actor, room) for rows in Room", "member(actor, it) for rows in Room")) === "ROWS_IN_ROW");
  ok("the old naming of the row (note.user): refused, with the new spelling (ROW_POLICY_NAME)", refused(base.replace(".user == actor for rows of Membership, Note", "note.user == actor for rows of Note")) === "ROW_POLICY_NAME");
  const empty = check(parse(`app t { name "T"  actor User }\nentity User { name: Text }\nentity Room { name: Text }\npolicy user_rows: true for rows of User\npolicy rr: true for rows in Room\n`));
  ok("a container nothing else leads to: ROWS_IN_EMPTY", empty.some((f) => f.code === "ROWS_IN_EMPTY"), empty.map((f) => f.code));
  ok("two policies of one name: DUPLICATE", check(spec("policy own_rows: true for rows of Boost\n")).some((f) => f.code === "DUPLICATE"));
  ok("the spec checks and types clean", !check(spec("")).some((f) => f.severity === "error") && !typecheck(spec("")).findings.some((f: any) => f.severity === "error"), [...check(spec("")), ...typecheck(spec("")).findings].filter((f: any) => f.severity === "error"));
}

// ---- parameters: a row the actor can't see is one that doesn't exist
{
  const a = decl("action edit(message: Message, body: Text) {\n  require message.author == actor else forbidden\n  set message.body = body\n}\n", "edit");
  ok("a parameter's row policy is required where it is first used, not_found, before the author's check", a.body[0].kind === "require" && a.body[0].outcome === "not_found" && a.body[0].fromPolicy === "policy room_rows" && a.body[1].outcome === "forbidden", a.body);
  const late = decl("action rename(room: Room, name: Text) {\n  require present(name) else invalid\n  set room.name = name\n}\n", "rename");
  ok("... first used, so a check that doesn't read it comes first (refusals keep their order)", late.body[0].outcome === "invalid" && late.body[1].fromPolicy === "policy room_rows", late.body);
  const said = decl("action leave(room: Room) {\n  require member(actor, room) and present(room.name) else not_found\n  delete Membership where .room == room and .user == actor\n}\n", "leave");
  ok("a require that already says it (as one of its parts): nothing added", said.body.filter((s: any) => s.kind === "require").length === 1, said.body);
  const viaFn = decl("fn mine(n: Note): Bool = n.user == actor and actor != none\naction drop(n: Note) {\n  require mine(n) else not_found\n  delete n\n}\n", "drop");
  ok("... also when it says it through a function of the spec's (mine(n) is n.user == actor and …)", viaFn.body.filter((s: any) => s.kind === "require").length === 1, viaFn.body);
  const opt = decl("action pick(m: Message?) {\n  result m\n}\n", "pick");
  ok("an optional parameter: none passes", opt.body[0].cond.kind === "binary" && opt.body[0].cond.op === "or" && opt.body[0].cond.left.op === "==", opt.body[0]);
  ok("a parameter never used: nothing added (it is never looked up)", decl("action noop(m: Message) {\n  result 1\n}\n", "noop").body.length === 1);
  ok("a policy that is true (user_rows): nothing added", decl("action hi(u: User) {\n  result u.name\n}\n", "hi").body.length === 1);
  const sk = decl("action wipe(m: Message) {\n  skip policy room_rows\n  delete m\n}\n", "wipe");
  ok("skip policy <row policy>: the action opts out", sk.body.length === 1 && sk.body[0].kind === "delete", sk.body);
  ok("... skipping one that covers nothing it takes: SKIP_UNNEEDED", refused(base + "action hey(u: User) {\n  skip policy room_rows\n  result u.name\n}\n") === "SKIP_UNNEEDED");
  const v = decl("view messages(room: Room) {\n  rows Message where .room == room\n}\n", "messages");
  ok("a view: the policy joins its requires (the view reads the room)", v.requires.length === 1 && v.requires[0].outcome === "not_found" && v.requires[0].fromPolicy === "policy room_rows", v.requires);
  const sc = decl("layout l { <main><Slot name=main /></main> }\nscreen room_screen(room: Room) {\n  route \"/r/:room\"\n  layout l\n  require member(actor, room) else go room_screen(room) flash \"No\"\n  <h1>{room.name}</h1>\n}\n", "room_screen");
  ok("a screen that says it with its own outcome (go … flash): kept as it is", sc.requires.length === 1 && sc.requires[0].go, sc.requires);
  const ch = decl("channel presence(room: Room) {\n  require true\n}\n", "presence");
  ok("a channel: the policy joins its require", ch.requires.kind === "binary" && ch.requires.op === "and", ch.requires);
}

// ---- subsets
{
  const sub = `subset Active = User where .status == active\nsubset ActiveBob = Active where .name == "bob"\n`;
  const q = decl(sub + "view people() {\n  rows Active where .name != \"x\"\n}\n", "people");
  ok("a query of a subset reads its entity where the subset's condition holds, and the query's own", q.rows.entity === "User" && q.rows.where.op === "and" && show(q.rows.where.left).includes('"name":"status"'), q.rows);
  const nested = decl(sub + "view bobs() {\n  rows ActiveBob\n}\n", "bobs");
  ok("a subset of a subset: both conditions", nested.rows.entity === "User" && show(nested.rows.where).includes('"status"') && show(nested.rows.where).includes('"bob"'), nested.rows);
  const p = decl(sub + "action greet(u: Active) {\n  result u.name\n}\n", "greet");
  ok("a parameter of a subset type is its entity, checked where first used: not_found", p.params[0].type.name === "User" && p.params[0].subset === "Active" && p.body[0].outcome === "not_found" && p.body[0].fromPolicy === "subset Active", p.body);
  const loop = decl(sub + "action wave(users: set of User) {\n  for each u in Active where u in users {\n    set u.name = \"hi\"\n  }\n}\n", "wave");
  ok("for each … in a subset: the loop reads its entity", loop.body[0].entity === "User" && loop.body[0].where.op === "and", loop.body[0]);
  ok("exists(Subset) and count(Subset)", show(decl(sub + "fn any_active(): Bool = exists(Active)\n", "any_active").body).includes('"entity":"User"'));
  ok("create of a subset: refused, it takes the entity (SUBSET_NOT_ROWS)", refused(base + sub + "action mk() {\n  create Active { name: \"a\" }\n}\n") === "SUBSET_NOT_ROWS");
  ok("a stored field of a subset type: refused (SUBSET_STORED)", refused(base + sub + "entity Badge { holder: Active }\n") === "SUBSET_STORED");
  ok("a fn's parameter of a subset type: refused (SUBSET_FN_PARAM)", refused(base + sub + "fn f(u: Active): Bool = true\n") === "SUBSET_FN_PARAM");
  ok("set of a subset: refused, with how (SUBSET_SET)", refused(base + sub + "action s(us: set of Active) {\n  result 1\n}\n") === "SUBSET_SET");
  ok("subsets defined by each other: refused (SUBSET_CYCLE)", refused(base + "subset A = B where true\nsubset B = A where true\n") === "SUBSET_CYCLE");
  ok("a subset of something that isn't an entity: refused (SUBSET_BASE)", refused(base + "subset A = Status where true\n") === "SUBSET_BASE");
  ok("a subset named like an entity: refused (SUBSET_NAME)", refused(base + "subset Note = User where true\n") === "SUBSET_NAME");
  const s = spec(sub + "action greet(u: Active) {\n  result u.name\n}\nview people() {\n  rows Active where .name != \"x\"\n}\n");
  ok("a spec with subsets checks and types clean", !check(s).some((f) => f.severity === "error") && !typecheck(s).findings.some((f: any) => f.severity === "error"), [...check(s), ...typecheck(s).findings].filter((f: any) => f.severity === "error"));
}

// ---- expand
{
  const s = spec("subset Active = User where .status == active\naction edit(message: Message, by: Active) {\n  require message.author == actor else forbidden\n  set message.body = by.name\n}\n");
  const t = expandText(s.decls, "edit")!;
  ok("expand shows each woven require with where it came from, and the parameter's type as written", /require member\(actor, message\.room\) else not_found {3}\/\/ from policy room_rows/.test(t) && /by: Active/.test(t) && /\/\/ from subset Active/.test(t), t);
}
process.exit(failed ? 1 : 0);
