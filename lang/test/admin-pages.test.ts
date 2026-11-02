// The generated admin pages (lang/admin.ts) for one entity, requested as an administrator, as a signed-in
// ordinary user, and signed out. Checks the markup (headings, a table, forms that post to the admin
// actions, no "[object Object]", no empty class="" artifacts, no doubled sections) and that only an
// administrator sees or changes anything.
//   node lang/test/admin-pages.test.ts      (needs Go: on Windows, in WSL)
process.removeAllListeners("warning");
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApp } from "./go-app.ts";

let failed = 0;
const ok = (what: string, pass: boolean, detail?: unknown) => { console.log(`${pass ? "ok  " : "FAIL"} ${what}`); if (!pass) { failed++; if (detail !== undefined) console.log(typeof detail === "string" ? detail.slice(0, 400) : JSON.stringify(detail).slice(0, 400)); } };
const count = (s: string, sub: string) => s.split(sub).length - 1;

const SPEC = `
app t {
  name "T"
  actor User
  sign_in_screen sign_in_screen
  admin actor.role == boss
}
enum Role { member, boss }
enum Stage { draft, live }
entity User {
  name: Text max 20
  email: Email
  password: Password
  role: Role = member
  token: Text?
  unique (email)
}
identity login: Login.token from cookie "login"
entity Login { who: User on delete cascade  token: Text = token(24)  unique (token) }
entity Page {
  title: Text max 30
  author: User
  stage: Stage = draft
  views: Int = 0
  unique (title)
}
policy user_rows: true for rows of User
policy page_rows: true for rows of Page
layout l { <nav><Slot name=nav /></nav><main><Slot name=main /></main> }
screen sign_in_screen { route "/in"  layout l  require public  <Fill name=main><h1>Sign in</h1></Fill> }
action sign_in(email: Email, password: Text) {
  skip policy signed_in
  let u = the_or_none(User where .email == email)
  require u != none and authenticates(u.password, password) else unauthenticated
  create Login { who: u } as l
  result l
}
policy signed_in: actor != none else unauthenticated for every action
action setup(email: Email, password: Text) { skip policy signed_in  require not exists(User) else invalid  create User { name: "root", email: email, password: password, role: boss } }
`;

const dir = mkdtempSync(join(tmpdir(), "admin-pages-"));
writeFileSync(join(dir, "app.crud"), SPEC);
const app = await startApp(join(dir, "app.crud"), 13961);
try {
  const post = async (cookie: string | null, action: string, args: Record<string, string> = {}) => {
    const r = await fetch(`${app.base}/_do/${action}`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", ...(cookie ? { Cookie: cookie } : {}) }, body: new URLSearchParams(args), redirect: "manual" });
    return { outcome: r.headers.get("X-Crudspec-Outcome"), cookie: r.headers.getSetCookie().find((c) => c.startsWith("login="))?.split(";")[0] };
  };
  const get = async (cookie: string | null, path: string) => {
    const r = await fetch(app.base + path, { headers: cookie ? { Cookie: cookie } : {}, redirect: "manual" });
    return { status: r.status, location: r.headers.get("location"), text: await r.text() };
  };
  const dump = async (e: string) => (await app.post("/_test/dump", {})).rows[e] as any[];
  await app.post("/_test/load", { clock: Date.parse("2026-10-14T15:00:00Z"), rows: {} });
  ok("set up the first administrator", (await post(null, "setup", { email: "boss@example.test", password: "bosspass" })).outcome === "ok");
  const boss = (await post(null, "sign_in", { email: "boss@example.test", password: "bosspass" })).cookie!;
  ok("create an ordinary user as an administrator", (await post(boss, "admin_create_user", { name: "Mia", email: "mia@example.test", password: "miapass" })).outcome === "ok");
  const mia = (await post(null, "sign_in", { email: "mia@example.test", password: "miapass" })).cookie!;
  const bossId = String((await dump("User")).find((u: any) => u.fields.name === "root").id);
  ok("create a page as an administrator", (await post(boss, "admin_create_page", { title: "Home", author: bossId, stage: "draft", views: "0" })).outcome === "ok");
  const pageId = String((await dump("Page")).find((p: any) => p.fields.title === "Home").id);

  // ---- as an administrator: the list, the new form, the edit form
  const list = await get(boss, "/_admin/page"), added = await get(boss, "/_admin/page/new"), edit = await get(boss, `/_admin/page/${pageId}`);
  const pages = { list, added, edit };
  for (const [name, p] of Object.entries(pages)) {
    ok(`admin: the ${name} page opens (200)`, p.status === 200, p.status);
    ok(`admin: the ${name} page has no "[object Object]"`, !p.text.includes("[object Object]"));
    const bad = p.text.match(/<[^>]*class=""[^>]*>/g) ?? [];
    ok(`admin: the ${name} page has no empty class="" artifact`, bad.length === 0, bad.join(" | "));
    ok(`admin: the ${name} page has no "undefined" or "null" text`, !/>\s*(undefined|null)\s*</.test(p.text));
    ok(`admin: the ${name} page's title is the entity's`, /<title>[^<]*Page[^<]*<\/title>/i.test(p.text), (p.text.match(/<title>[^<]*<\/title>/i) ?? ["no title"])[0]);
    ok(`admin: the ${name} page's section is not doubled`, count(p.text, "<section") <= 1 && count(p.text, "</main>") <= 1, { s: count(p.text, "<section"), m: count(p.text, "</main>") });
    ok(`admin: the ${name} page has exactly one <h1>`, count(p.text, "<h1") === 1, count(p.text, "<h1"));
  }
  ok("admin: the list has a heading and a table of rows", /<h1[^>]*>Page<\/h1>/.test(list.text) && list.text.includes("Home") && list.text.includes('class="list"'), list.text.slice(0, 300));
  ok("admin: the list links each row to its edit form", list.text.includes(`/_admin/page/${pageId}`));
  ok("admin: the list links to the new form", list.text.includes("/_admin/page/new"));
  ok("admin: the new form has a heading and posts to admin_create_page", /<h1[^>]*>New page<\/h1>/.test(added.text) && /action="[^"]*admin_create_page[^"]*"/.test(added.text), added.text.slice(0, 300));
  ok("admin: the new form has a field for each editable column", ["title", "author", "stage", "views"].every((f) => added.text.includes(`name="${f}"`)), ["title", "author", "stage", "views"].filter((f) => !added.text.includes(`name="${f}"`)));
  ok("admin: the edit form has a heading and posts to admin_update_page", /<h1[^>]*>Edit page<\/h1>/.test(edit.text) && edit.text.includes("admin_update_page"), edit.text.slice(0, 300));
  ok("admin: the edit form is filled with the row's values", edit.text.includes('value="Home"') && edit.text.includes('value="0"'));
  ok("admin: the edit form has a delete button for admin_delete_page", edit.text.includes("admin_delete_page"));
  ok("admin: a user's row shows by name, not as an object", !list.text.includes("[object Object]") && (await get(boss, "/_admin/user")).text.includes("Mia"));

  // ---- as a signed-in ordinary user: refused
  for (const path of ["/_admin/page", "/_admin/page/new", `/_admin/page/${pageId}`]) {
    const r = await get(mia, path);
    ok(`signed-in user: ${path} is refused (not 200, no admin content)`, r.status !== 200 && !r.text.includes("admin_") && !r.text.includes("Home"), r.status);
  }
  const denied = await post(mia, "admin_update_page", { admin_row: pageId, title: "Hacked", author: bossId, stage: "live", views: "9" });
  ok("signed-in user: the update action refuses", denied.outcome === "forbidden", denied);
  ok("signed-in user: the create action refuses", (await post(mia, "admin_create_page", { title: "Mine", author: bossId, stage: "draft", views: "0" })).outcome === "forbidden");
  ok("signed-in user: the delete action refuses", (await post(mia, "admin_delete_page", { admin_row: pageId })).outcome === "forbidden");
  ok("the refused changes did not happen", (await dump("Page")).some((p: any) => p.id === Number(pageId) && p.fields.title === "Home" && p.fields.views === 0));
  // escalation: an ordinary user cannot make herself an administrator through the user admin action
  const miaId = String((await dump("User")).find((u: any) => u.fields.name === "Mia").id);
  const escalate = await post(mia, "admin_update_user", { admin_row: miaId, name: "Mia", email: "mia@example.test", password: "miapass", role: "boss" });
  ok("signed-in user: cannot promote herself to boss", escalate.outcome === "forbidden", escalate);
  ok("the promotion did not happen", (await dump("User")).some((u: any) => u.id === Number(miaId) && u.fields.role === "member"));
  ok("signed-in user: still refused the admin page after the attempt", (await get(mia, "/_admin/page")).status !== 200);

  // ---- signed out: refused
  for (const path of ["/_admin/page", "/_admin/page/new", `/_admin/page/${pageId}`]) {
    const r = await get(null, path);
    ok(`signed out: ${path} is refused (not 200, no admin content)`, r.status !== 200 && !r.text.includes("admin_") && !r.text.includes("Home"), r.status);
  }
  ok("signed out: the update action is unauthenticated", (await post(null, "admin_update_page", { admin_row: pageId, title: "Hacked", author: bossId, stage: "live", views: "9" })).outcome === "unauthenticated");
  ok("signed out: the delete action is unauthenticated", (await post(null, "admin_delete_page", { admin_row: pageId })).outcome === "unauthenticated");
  ok("the signed-out attempts did not happen", (await dump("Page")).some((p: any) => p.id === Number(pageId) && p.fields.title === "Home"));
} finally { app.stop(); }
process.exit(failed ? 1 : 0);
