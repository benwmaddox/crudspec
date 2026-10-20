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

// Campfire as it is: the signed-out actions without a rate limit, one create that a repeat refuses,
// and the banned user's messages removed later, though unban can come first (user_screen is reached
// now: avatars link to it, as Rails' do)
ok("Campfire: only the known findings", JSON.stringify(base.map((f) => f.code).sort()) === JSON.stringify(["SIGNED_OUT_UNLIMITED", "SIGNED_OUT_UNLIMITED", "SIGNED_OUT_UNLIMITED", "UNIQUE_UNGUARDED", "WORKFLOW_STALE_CHECK"]), base);
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
const verified = (extra: string) => fu(`entity Account { owner: User on delete cascade  verified: Bool = false  plan: Text? }
action open() { require actor != none else forbidden  create Account { owner: actor } }
view mine() { rows Account where .owner == actor and .verified and .plan != none }
${extra}`);
ok("a field read but never set, with a default: FIELD_READ_NEVER_SET", verified("").includes("FIELD_READ_NEVER_SET Account.verified"), verified(""));
ok("... an optional one, never set: FIELD_READ_NEVER_SET (always none)", verified("").includes("FIELD_READ_NEVER_SET Account.plan"), verified(""));
ok("... set by an action: not reported", !verified("action verify(a: Account) { require actor != none and a.owner == actor else forbidden  set a.verified = true }").includes("FIELD_READ_NEVER_SET Account.verified"));
ok("... given at create: not reported", !fu(`entity Account { owner: User on delete cascade  verified: Bool = false }
action open() { require actor != none else forbidden  create Account { owner: actor, verified: true } }
view mine() { rows Account where .owner == actor and .verified }`).includes("FIELD_READ_NEVER_SET Account.verified"));
ok("a default worked out for each row (token(24)): not reported", !fu("").some((c) => c.includes("Session.token")), fu(""));
ok("a field with a constant default, never set or read: FIELD_NEVER_WRITTEN", fu("entity Flag { on: Bool = false }\naction mk() { require actor != none else forbidden  create Flag { } }").includes("FIELD_NEVER_WRITTEN Flag.on"));

// outcomes a form's fields can bring about, and the <on>s that take them
const forms = (body: string, extra = "") => deepCheck(parse(`
app t { name "T"  actor User }
entity User { name: Text  email: Email  code: Text?  unique (email) }
entity Team { name: Text  owner: User on delete cascade }
action rename_team(t: Team, name: Text) {
  require actor != none and t.owner == actor else forbidden
  require name != "" and name != "admin" else invalid
  set t.name = name
}
action invite(t: Team, email: Email, code: Text) {
  require actor != none and t.owner == actor else forbidden
  require code == "open" else not_found
  create User { name: "?", email: email }
}
${extra}
layout page { <main><slot name=main /></main> }
screen s(t: Team) {
  route "/t/{t}"
  layout page
  <main>${body}</main>
}
`)).filter((f) => f.code === "OUTCOME_UNHANDLED").map((f) => f.message);
const inv = forms(`<form action={invite(t)}><field name=email kind=email /><field name=code kind=text /><submit label="Go" /><on not_found flash="Wrong code." /></form>`);
ok("a form that handles one outcome its fields bring about but not another: OUTCOME_UNHANDLED", inv.length === 1 && /handles not_found, but not invalid/.test(inv[0]), inv);
ok("... an outcome about the row or who acts (forbidden for t, given by the call) is not asked for", !inv.some((m) => /forbidden/.test(m)), inv);
ok("a form with no <on> leaves them all to the default: not reported", forms(`<form action={invite(t)}><field name=email kind=email /><field name=code kind=text /><submit label="Go" /></form>`).length === 0);
ok("a unique key checked first: no invalid to handle", forms(`<form action={invite(t)}><field name=email kind=email /><field name=code kind=text /><submit label="Go" /><on not_found flash="Wrong code." /></form>`.replace("invite(t)", "invite2(t)"), `action invite2(t: Team, email: Email, code: Text) {
  require actor != none and t.owner == actor else forbidden
  require code == "open" else not_found
  require not exists(User where .email == email) else not_found
  create User { name: "?", email: email }
}`).length === 0);
ok("a button's <on>s are the ones right after it", forms(`<button action={rename_team(t, "x")} label="X" /><on ok flash="Done." /><on forbidden flash="No." />`).length === 0);
const fld = forms(`<form action={rename_team(t)}><field name=name kind=text /><submit label="Go" /><on forbidden flash="No." /></form>`);
ok("a require on the entered name: invalid is asked for when another outcome is handled", fld.length === 1 && /not invalid/.test(fld[0]), fld);

// a workflow acts later than the action that emitted it
const stale = (step: string, extra = "") => deepCheck(parse(`
app t { name "T"  actor User }
enum Status { active, banned }
entity User { name: Text  status: Status = active }
entity Post { author: User on delete cascade  body: Text }
action ban(u: User) { require actor != none else forbidden  set u.status = banned  emit Banned(u) }
action unban(u: User) { require actor != none else forbidden  set u.status = active }
workflow on Banned(u) {
  step clean: ${step}
}
${extra}`)).filter((f) => f.code === "WORKFLOW_STALE_CHECK").map((f) => f.message);
const st1 = stale("delete Post where .author == u");
ok("a step that acts on a field the emitter set, which another action can change: WORKFLOW_STALE_CHECK", st1.length === 1 && /set u\.status to banned/.test(st1[0]) && /action unban/.test(st1[0]), st1);
ok("... the step reads it again: not reported", stale("if u.status == banned { delete Post where .author == u }").length === 0);
ok("... nothing else changes the field: not reported", stale("delete Post where .author == u", "").length === 1 && deepCheck(parse(`
app t { name "T"  actor User }
entity User { name: Text  verified: Bool = false }
entity Post { author: User on delete cascade  body: Text }
action verify(u: User) { require actor != none and not u.verified else forbidden  set u.verified = true  emit Verified(u) }
workflow on Verified(u) {
  step welcome: create Post { author: u, body: "hi" }
}`)).filter((f) => f.code === "WORKFLOW_STALE_CHECK").length === 0);
ok("a step that only reads: not reported", stale("let n = count(Post where .author == u)").length === 0);

// links to screens that refuse who follows them
ok("Campfire's admin links, in if administrator(actor): covered (administrator implies can_administer(actor, none))", !base.some((f) => f.code === "LINK_NOT_ALLOWED"));
const unguarded = change(`    if administrator(actor) {
      <row class="flex align-center gap flex-item-justify-end">
        <link to={bots_screen()} icon="bot" label="Set up chat bots" />`, `    <link to={bots_screen()} icon="bot" label="Set up chat bots" />
    if administrator(actor) {
      <row class="flex align-center gap flex-item-justify-end">`);
ok("the bots link moved out of its if: LINK_NOT_ALLOWED", unguarded.some((f) => f.code === "LINK_NOT_ALLOWED" && /bots_screen, which needs can_administer\(actor, none\) \(else forbidden\)/.test(f.message)), unguarded.filter((f) => f.code === "LINK_NOT_ALLOWED"));
const links = (extra: string) => deepCheck(parse(`
app t { name "T"  actor User }
enum Role { member, admin }
entity User { name: Text  role: Role = member }
predicate admin(u: User?) = u != none and u.role == admin
layout page { <main><slot name=main /></main> }
screen settings { route "/settings"  layout page  require admin(actor) else forbidden  <text>Settings</text> }
screen room(r: User) { route "/r/:r"  layout page  require r.name == actor.name else not_found  <text>Room</text> }
component admin_menu() { <link to={settings()} label="Settings" /> }
${extra}`)).filter((f) => f.code === "LINK_NOT_ALLOWED").map((f) => f.message);
ok("a component shown only on screens that require it: covered", links(`screen admin_home { route "/a"  layout page  require admin(actor) else forbidden  <admin_menu /> }`).length === 0);
ok("... shown on one that doesn't: reported", links(`screen admin_home { route "/a"  layout page  require admin(actor) else forbidden  <admin_menu /> }
screen home { route "/"  layout page  <admin_menu /> }`).length === 1);
ok("a require about the screen's own row (r): left to the screen, not asked of the link", links(`screen home { route "/"  layout page  <link to={room(actor)} label="Mine" /> }`).length === 0);

// screens nothing links to
ok("Campfire: every screen is linked (user_screen from avatars; join_screen through url_of in join_url)", base.filter((f) => f.code === "SCREEN_UNREACHABLE").length === 0, base.filter((f) => f.code === "SCREEN_UNREACHABLE"));ok("join_url as a hand-built address: join_screen is unreachable", change(`fn join_url(): Url = url_of(join_screen(Account.join_code))`, `fn join_url(): Url = url("/join/" + Account.join_code)`).some((f) => f.code === "SCREEN_UNREACHABLE" && /join_screen/.test(f.message)));
const reach = (extra: string) => deepCheck(parse(`
app t { name "T"  actor User  sign_in login }
entity User { name: Text }
layout page { <main><slot name=main /></main> }
screen home { route "/"  layout page  <link to={a()} label="A" /> }
screen login { route "/login"  layout page  access public  <text>Sign in</text> }
screen a { route "/a"  layout page  <menu /> }
component menu() { <link to={b()} label="B" /> }
screen b { route "/b"  layout page  <text>B</text> }
${extra}`)).filter((f) => f.code === "SCREEN_UNREACHABLE").map((f) => f.message.split(" ")[1]);
ok("home, sign-in, a linked screen and one a shown component links to: all reached", reach("").length === 0, reach(""));
ok("a screen only an unreached screen links to: unreachable, both", JSON.stringify(reach(`screen c { route "/c"  layout page  <link to={d()} label="D" /> }
screen d { route "/d"  layout page  <text>D</text> }`).sort()) === JSON.stringify(["c", "d"]));
ok("a screen a mail names: reached", reach(`screen c { route "/c"  layout page  <text>C</text> }
action ping() { require actor != none else forbidden  send mail { to: "a@b.c", subject: "Hi", text: "See " + url_of(c()) } }`).length === 0);

process.exit(failed ? 1 : 0);
