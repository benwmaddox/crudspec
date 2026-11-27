// Change history (entity … { history }, gogen/rt/history.go): each create, field change (by a
// setter or a bulk set) and delete of such a row is kept in the action's transaction, with who and
// in which action; a refused action keeps nothing. <History>{row}</History> shows it, newest first:
// a reference by its label, a password as "a new password", a private field without its values.
//   node lang/test/history.test.ts      (needs Go: on Windows, in WSL)
process.removeAllListeners("warning");
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "../parser.ts";
import { check } from "../check.ts";
import { typecheck } from "../types.ts";
import { startApp } from "./go-app.ts";

let failed = 0;
const ok = (what: string, pass: boolean, detail?: unknown) => { console.log(`${pass ? "ok  " : "FAIL"} ${what}`); if (!pass) { failed++; if (detail !== undefined) console.log("     ", typeof detail === "string" ? detail.slice(0, 900) : JSON.stringify(detail)?.slice(0, 600)); } };

const SPEC = `
app t { name "T"  actor User  sign_in_screen sign_in_screen  admin actor.boss }
enum Status { open, done }
entity User { name: Text max 40  boss: Bool = false  token: Text?  unique (token) }
entity Task {
  title: Text max 80
  status: Status = open
  owner: User
  note: Text? private
  history
}
entity Plain { title: Text }
identity login: User.token from cookie "login"
policy user_rows: true for rows of User
policy task_rows: true for rows of Task
policy plain_rows: true for rows of Plain
layout l { <main><Slot name=main /></main> }
screen sign_in_screen { route "/in"  layout l  require public  <Fill name=main><h1>Sign in</h1></Fill> }
screen task_screen(task: Task) {
  route "/tasks/:task"
  layout l
  <Fill name=main><h1>{task.title}</h1><History>{task}</History></Fill>
}
// Adds a task.
action add(title: Text) { create Task { title: title, owner: actor } as t  result t }
// Renames a task.
action rename(task: Task, title: Text) { set task.title = title }
// Hands a task to someone.
action give(task: Task, to: User) { set task.owner = to }
// Notes a task, privately.
action note(task: Task, note: Text) { set task.note = note }
// Closes every open task.
action close_all() { for each t in Task where .status == open { set t.status = done } }
// Renames a task, then refuses.
action rename_then_refuse(task: Task, title: Text) { set task.title = title  reject invalid "no" }
// Deletes a task.
action drop(task: Task) { delete task }
`;

const errs = (src: string) => { const s = parse(src); return [...check(s, { source: src }), ...typecheck(s).findings].filter((f: any) => f.severity === "error").map((f: any) => f.code); };
ok("the spec checks clean", errs(SPEC).length === 0, errs(SPEC));
ok("<History> of an entity that keeps none is refused", errs(SPEC + "screen p(x: Plain) { route \"/p/:x\"  layout l  <Fill name=main><History>{x}</History></Fill> }").includes("HISTORY_NOT_KEPT"));
ok("a field called history is still a field", errs(SPEC.replace("entity Plain { title: Text }", "entity Plain { title: Text  history: Text? }")).length === 0);

const dir = mkdtempSync(join(tmpdir(), "history-"));
writeFileSync(join(dir, "app.crud"), SPEC);
const app = await startApp(join(dir, "app.crud"), 13971);
try {
  await app.post("/_test/load", { clock: Date.parse("2026-11-20T15:00:00Z"), rows: { User: [
    { id: 1, seq: 1, created: 0, updated: 0, fields: { name: "Ada", boss: true, token: "ada-token" } },
    { id: 2, seq: 2, created: 0, updated: 0, fields: { name: "Bo", boss: false, token: "bo-token" } }] } });
  const ada = "login=ada-token", bo = "login=bo-token";
  const post = async (cookie: string, action: string, args: Record<string, string> = {}) => {
    const r = await fetch(`${app.base}/_do/${action}`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: app.base, Cookie: cookie }, body: new URLSearchParams(args), redirect: "manual" });
    return r.headers.get("X-Crudspec-Outcome");
  };
  const page = async (path: string, cookie = ada) => (await (await fetch(app.base + path, { headers: { Cookie: cookie, "X-No-Cache": "1" } })).text());
  const items = (html: string) => [...html.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m) => m[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim());

  // the first history write of a fresh app refused: the table stays, and later ones are kept
  await app.post("/_test/load", { clock: Date.parse("2026-11-20T15:00:00Z"), rows: {
    User: [{ id: 1, seq: 1, created: 0, updated: 0, fields: { name: "Ada", boss: true, token: "ada-token" } }, { id: 2, seq: 2, created: 0, updated: 0, fields: { name: "Bo", boss: false, token: "bo-token" } }],
    Task: [{ id: 5, seq: 5, created: 0, updated: 0, fields: { title: "Seed", status: "open", owner: { ref: "User", id: 1 }, note: null } }] } });
  ok("a fresh app's first change to a history entity, refused, ...", (await post(ada, "rename_then_refuse", { task: "5", title: "Nope" })) === "invalid");
  ok("... doesn't stop the next one being kept", (await post(ada, "rename", { task: "5", title: "Seeded" })) === "ok" && items(await page("/tasks/5")).some((x) => /set title from Seed to Seeded/.test(x)));
  const cached = await (await fetch(app.base + "/tasks/5", { headers: { Cookie: ada } })).text();
  await post(ada, "rename", { task: "5", title: "Seeded again" });
  ok("a page kept in the cache shows a change made after it", items(await (await fetch(app.base + "/tasks/5", { headers: { Cookie: ada } })).text()).some((x) => /to Seeded again/.test(x)) && cached.length > 0);
  await app.post("/_test/load", { clock: Date.parse("2026-11-20T15:00:00Z"), rows: {
    User: [{ id: 1, seq: 1, created: 0, updated: 0, fields: { name: "Ada", boss: true, token: "ada-token" } }, { id: 2, seq: 2, created: 0, updated: 0, fields: { name: "Bo", boss: false, token: "bo-token" } }] } });
  ok("add a task", (await post(ada, "add", { title: "Write the plan" })) === "ok");
  const id = String(((await app.post("/_test/dump", {})).rows.Task ?? [])[0]?.id);
  let h = items(await page(`/tasks/${id}`));
  ok("its history says who created it", h.length === 1 && /Ada created it/.test(h[0]), h);
  await post(ada, "rename", { task: id, title: "Write the real plan" });
  await post(ada, "give", { task: id, to: "2" });
  await post(bo, "note", { task: id, note: "the secret" });
  await post(ada, "close_all");
  h = items(await page(`/tasks/${id}`));
  ok("a rename keeps the old and the new title, newest first", h.some((x) => /Ada set title from Write the plan to Write the real plan/.test(x)) && /created it/.test(h[h.length - 1]), h);
  ok("a reference shows by its label", h.some((x) => /set owner from Ada to Bo/.test(x)), h);
  ok("a private field says it changed, not to what", h.some((x) => /Bo set note \(private\)/.test(x)) && !h.some((x) => x.includes("the secret")), h);
  ok("a bulk set is kept for each row it changed", h.some((x) => /Ada set status from Open to Done|Ada set status from open to done/.test(x)), h);
  const before = h.length;
  ok("a refused action ...", (await post(ada, "rename_then_refuse", { task: id, title: "Nope" })) === "invalid");
  ok("... keeps nothing", items(await page(`/tasks/${id}`)).length === before);
  ok("an action that changes nothing keeps nothing", (await post(ada, "rename", { task: id, title: "Write the real plan" })) === "ok" && items(await page(`/tasks/${id}`)).length === before);
  const admin = await page(`/_admin/task/${id}`);
  ok("the admin's form for the row shows its history", /<h2>History<\/h2>/.test(admin) && items(admin).some((x) => /set title from/.test(x)), admin.slice(0, 300));
  ok("delete the task", (await post(ada, "drop", { task: id })) === "ok");
} finally { app.stop(); }
if (failed) { console.log(`${failed} FAILED`); process.exit(1); }
console.log("all passed");
