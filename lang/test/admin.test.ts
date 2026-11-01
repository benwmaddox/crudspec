// The built-in admin section (lang/admin.ts): an app that says who its administrators are gets /_admin,
// a table and a form for each entity, and the actions behind them. Only administrators may use it;
// what the entity's own rules say still holds (sizes, keys, invariants, `transitions`); a Password left
// empty is kept; an entity with no read permission is readable by administrators and nobody else.
//   node lang/test/admin.test.ts      (needs Go: on Windows, in WSL)
process.removeAllListeners("warning");
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "../parser.ts";
import { check } from "../check.ts";
import { deepCheck } from "../deep.ts";
import { withGenerated } from "../scaffold.ts";
import { readSpec } from "../source.ts";
import { startApp } from "./go-app.ts";

let failed = 0;
const ok = (what: string, pass: boolean, detail?: unknown) => { console.log(`${pass ? "ok  " : "FAIL"} ${what}`); if (!pass) { failed++; if (detail !== undefined) console.log(typeof detail === "string" ? detail.slice(0, 500) : JSON.stringify(detail)); } };

const SPEC = `
app t {
  name "T"
  actor User
  sign_in_screen sign_in_screen
  admin actor.role == boss
}
enum Role { member, boss }
enum Stage { draft, live, retired }
entity User {
  name: Text max 20
  email: Email
  password: Password
  role: Role = member
  token: Text?
  unique (email)
}
identity login: Login.token from cookie "login"
entity Page {
  title: Text max 30
  author: User
  stage: Stage = draft
  views: Int = 0
  pinned: Bool = false
  note: Text?
  cover: File?
  unique (title)
  invariant self.views >= 0
  transitions stage {
    draft -> live
    live -> retired
  }
}
entity Secret { body: Text  attachment: File }
singleton Site { motto: Text = "hello"  max_pages: Int = 10 }
data Colour { name: Text } rows [ { name: "red" } ]
policy user_rows: true for rows of User
policy page_rows: true for rows of Page
layout l { <nav><Slot name=nav /></nav><main><Slot name=main /></main> }
screen sign_in_screen { route "/in"  layout l  access public  <Fill name=main><h1>Sign in</h1></Fill> }
action sign_in(email: Email, password: Text) {
  skip policy signed_in
  let u = the_or_none(User where .email == email)
  require u != none and authenticates(u.password, password) else unauthenticated
  create Login { who: u } as l
  result l
}
entity Login { who: User on delete cascade  token: Text = token(24)  unique (token) }
policy signed_in: actor != none else unauthenticated for every action
action setup(email: Email, password: Text) { skip policy signed_in  require not exists(User) else invalid  create User { name: "root", email: email, password: password, role: boss } }
`;
// ---- the generated source, without running anything
{
  const spec = withGenerated(parse(SPEC), parse);
  const names = spec.decls.filter((d: any) => d.generated === "admin").map((d: any) => `${d.kind} ${d.name}`);
  ok("an app with an admin condition gets the section", names.includes("screen admin_index") && names.includes("screen admin_page_edit") && names.includes("action admin_create_page") && names.includes("action admin_delete_user"), names);
  ok("... a singleton has an edit form and no list or delete", names.includes("screen admin_site_edit") && !names.includes("screen admin_site_list") && !names.includes("action admin_delete_site"), names);
  ok("... a data table is left out", !names.some((n) => /colour/i.test(n)), names);
  ok("... an entity that needs a field the forms can't carry (a required File) can't be created, only edited and deleted", !names.includes("action admin_create_secret") && names.includes("action admin_update_secret") && names.includes("action admin_delete_secret"), names);
  const plain = withGenerated(parse(SPEC.replace("  admin actor.role == boss\n", "")), parse);
  ok("an app with no admin condition gets nothing", !plain.decls.some((d: any) => d.generated === "admin" || /^admin_/.test(d.name)));
  ok("the generated section checks clean", check(spec).filter((f) => f.severity === "error").length === 0, check(spec).filter((f) => f.severity === "error").map((f) => `${f.code} ${f.message}`));
  ok("an admin condition with no actor is an error", check(parse(SPEC.replace("  actor User\n", ""))).some((f) => f.code === "ADMIN_NO_ACTOR"));
  const camp = withGenerated(parse(readSpec("apps/campfire")), parse);
  ok("Campfire, which declares none, is unchanged", !camp.decls.some((d: any) => d.generated === "admin"));
}

// ---- only administrators make administrators (ADMIN_ESCALATION)
{
  const codes = (extra: string) => deepCheck(parse(SPEC + extra)).filter((f) => f.code === "ADMIN_ESCALATION").length;
  ok("the spec as it is: its setup makes the first administrator only while there is no user, so nothing is flagged", codes("") === 0);
  ok("an action that sets the role without requiring an administrator is an error", codes("action promote(u: User, r: Role) { set u.role = r }") === 1);
  ok("... one that requires the admin condition first is not", codes("action promote(u: User, r: Role) { require actor.role == boss else forbidden  set u.role = r }") === 0);
  ok("... a public sign-up that creates a user with a role from the caller is", codes("action join(name: Text, email: Email, password: Text, r: Role) { skip policy signed_in  create User { name: name, email: email, password: password, role: r } }") === 1);
  ok("... or with the administrator's value", codes("action join2(name: Text, email: Email, password: Text) { skip policy signed_in  create User { name: name, email: email, password: password, role: boss } }") === 1);
  ok("... but a sign-up that makes an ordinary member is fine", codes("action join3(name: Text, email: Email, password: Text) { skip policy signed_in  create User { name: name, email: email, password: password, role: member } }") === 0);
  ok("... and the first run, while there is no user, may make the administrator", codes("action first(email: Email, password: Text) { skip policy signed_in  require not exists(User) else invalid  create User { name: \"root\", email: email, password: password, role: boss } }") === 0);
  ok("... an action that touches another field of the user is not asked for it", codes("action rename(name: Text) { set actor.name = name }") === 0);
}

// ---- running
const dir = mkdtempSync(join(tmpdir(), "admin-"));
writeFileSync(join(dir, "app.crud"), SPEC);
const app = await startApp(join(dir, "app.crud"), 13931);
try {
  const post = async (cookie: string | null, action: string, args: Record<string, string> = {}) => {
    const r = await fetch(`${app.base}/_do/${action}`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", ...(cookie ? { Cookie: cookie } : {}) }, body: new URLSearchParams(args), redirect: "manual" });
    return { outcome: r.headers.get("X-Crudspec-Outcome"), cookie: r.headers.getSetCookie().find((c) => c.startsWith("login="))?.split(";")[0] };
  };
  const get = async (cookie: string | null, path: string) => { const r = await fetch(app.base + path, { headers: cookie ? { Cookie: cookie } : {}, redirect: "manual" }); return { status: r.status, text: await r.text() }; };
  const dump = async (e: string) => (await app.post("/_test/dump", {})).rows[e] as any[];
  await app.post("/_test/load", { clock: Date.parse("2026-10-14T15:00:00Z"), rows: {} });
  ok("set up the first user, a boss", (await post(null, "setup", { email: "boss@example.test", password: "bosspass" })).outcome === "ok");
  const boss = (await post(null, "sign_in", { email: "boss@example.test", password: "bosspass" })).cookie!;
  // an administrator makes an ordinary user from the admin form's action
  const cu = await post(boss, "admin_create_user", { name: "Mia", email: "mia@example.test", password: "miapass" });
  ok("an administrator creates a user", cu.outcome === "ok", cu);
  ok("... the fields left to their defaults took them (role: member)", (await dump("User")).find((u: any) => u.fields.name === "Mia")?.fields.role === "member");
  const mia = (await post(null, "sign_in", { email: "mia@example.test", password: "miapass" })).cookie!;
  ok("the new user signs in with the password the admin set", !!mia);
  const miaId = String((await dump("User")).find((u: any) => u.fields.name === "Mia").id);

  ok("the section: its index and each table open for an administrator", [await get(boss, "/_admin"), await get(boss, "/_admin/user"), await get(boss, "/_admin/page"), await get(boss, "/_admin/page/new"), await get(boss, `/_admin/user/${miaId}`), await get(boss, "/_admin/site")].every((r) => r.status === 200));
  const list = await get(boss, "/_admin/user"), form = await get(boss, `/_admin/user/${miaId}`);
  ok("a row shows as its name, in the table and on its form (not [object Object])", !list.text.includes("[object Object]") && !form.text.includes("[object Object]") && list.text.includes("Mia") && form.text.includes("Mia"), form.text.replace(/<[^>]+>/g, " ").replace(/s+/g, " ").slice(0, 300));
  const idx = await get(boss, "/_admin");
  ok("... the index lists the tables, with their counts, and no data table", idx.text.includes("Page") && idx.text.includes("Secret") && idx.text.includes("User") && !idx.text.includes("Colour"), idx.text.replace(/<[^>]+>/g, " ").slice(0, 300));
  ok("a user who is not an administrator is sent away from every page of it", ![await get(mia, "/_admin"), await get(mia, "/_admin/user"), await get(mia, "/_admin/page/new")].some((r) => r.status === 200 && /Page|User/.test(r.text.replace(/<head>.*<\/head>/s, ""))));
  ok("... a signed-out visitor too", !(await get(null, "/_admin/user")).text.includes("Mia"));
  ok("... and the actions refuse them", (await post(mia, "admin_create_page", { title: "x", author: miaId, stage: "draft" })).outcome === "forbidden" && (await post(null, "admin_delete_user", { admin_row: miaId })).outcome === "unauthenticated");

  // allow users to be admins: an administrator promotes a user from the form, and they are
  ok("promote: the administrator makes Mia a boss (the password field left empty keeps her password)", (await post(boss, "admin_update_user", { admin_row: miaId, name: "Mia", email: "mia@example.test", role: "boss" })).outcome === "ok");
  ok("... Mia can still sign in with her old password", (await post(null, "sign_in", { email: "mia@example.test", password: "miapass" })).outcome === "ok");
  ok("... and now opens the admin section", (await get(mia, "/_admin")).status === 200 && (await get(mia, "/_admin")).text.includes("Page"));
  ok("a new password in the form replaces the old", (await post(boss, "admin_update_user", { admin_row: miaId, name: "Mia", email: "mia@example.test", role: "member", password: "newpass" })).outcome === "ok" && (await post(null, "sign_in", { email: "mia@example.test", password: "miapass" })).outcome === "unauthenticated" && (await post(null, "sign_in", { email: "mia@example.test", password: "newpass" })).outcome === "ok");
  ok("... and demoted, she is sent away again", !(await get(mia, "/_admin/page")).text.includes("Draft"));

  // the entity's own rules hold in the admin
  const bossId = String((await dump("User")).find((u: any) => u.fields.name === "root").id);
  ok("create a page (a required choice, a reference; optional fields left empty)", (await post(boss, "admin_create_page", { title: "Home", author: bossId, stage: "draft", views: "0", pinned: "false" })).outcome === "ok");
  ok("... a size is held: a title past 30 characters", (await post(boss, "admin_create_page", { title: "x".repeat(31), author: bossId, stage: "draft" })).outcome === "invalid");
  ok("... a unique key is held: the same title twice", (await post(boss, "admin_create_page", { title: "Home", author: bossId, stage: "draft" })).outcome === "invalid");
  ok("... an invariant is held: negative views", (await post(boss, "admin_create_page", { title: "Neg", author: bossId, stage: "draft", views: "-1" })).outcome === "invalid");
  const pageId = String((await dump("Page")).find((p: any) => p.fields.title === "Home").id);
  const edit = (stage: string) => post(boss, "admin_update_page", { admin_row: pageId, title: "Home", author: bossId, stage, views: "3", pinned: "true" });
  ok("... a page starts in the state the admin chose (a create may start anywhere)", (await post(boss, "admin_create_page", { title: "Old news", author: bossId, stage: "retired" })).outcome === "ok");
  ok("... transitions are held: draft -> retired skips live", (await edit("retired")).outcome === "invalid");
  ok("... draft -> live is a declared move", (await edit("live")).outcome === "ok");
  ok("... and live -> draft is not", (await edit("draft")).outcome === "invalid");
  ok("... the other fields were saved with the move", (await dump("Page")).find((p: any) => p.id === Number(pageId))?.fields.views === 3);
  const us = await post(boss, "admin_update_site", { motto: "welcome", max_pages: "20" });
  ok("the singleton's form saves", us.outcome === "ok", us);
  ok("delete a row", (await post(boss, "admin_delete_page", { admin_row: pageId })).outcome === "ok" && !(await dump("Page")).some((p: any) => p.id === Number(pageId)));
  ok("... a row others refer to can't be deleted (the user who wrote the remaining page)", (await post(boss, "admin_delete_user", { admin_row: bossId })).outcome === "invalid");

  // read access: the section reads an entity with no permission of its own; nobody else gets to
  ok("an entity with no read permission of its own (Secret) is listed for administrators", (await get(boss, "/_admin/secret")).status === 200);
  ok("... and the admin's reading it is not an opening for others", !(await get(mia, "/_admin/secret")).text.includes("Secret"));
} finally { app.stop(); }
process.exit(failed ? 1 : 0);
