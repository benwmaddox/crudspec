// Generated default screens, end to end: a feature added to the Tasks spec without any UI
// (rename a project, move a task, list open work) is usable at once through /_auto.
// Starts its own runtime in test mode on port 13811 with a temporary data directory.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "../../../lang/browser/node_modules/playwright/index.mjs";

const FEATURE = `
action rename_project(project: Project, name: Text) {
  require project.owner == actor else forbidden
  set project.name = name
}
action move_task(task: Task, to: Project, status: TaskStatus, estimate: Int?) {
  require member(actor, task.project) and member(actor, to) else forbidden
  set task.project = to
  set task.status = status
}
view my_open_tasks() {
  rows Task where member(actor, .project) and .status != done
  order by created
}
`;
const dir = mkdtempSync(join(tmpdir(), "crudspec-gen-"));
const specPath = join(dir, "tasks-feature.crud");
writeFileSync(specPath, readFileSync("apps/tasks/tasks.crud", "utf8") + FEATURE);
const base = "http://127.0.0.1:13811";
const server = spawn(process.execPath, ["lang/runtime/server.ts", specPath, "--data", join(dir, "data"), "--assets", "apps/tasks/assets", "--port", "13811", "--test"], { stdio: "ignore" });
try {
  for (let i = 0; i < 50; i++) { try { if ((await fetch(`${base}/up`)).ok) break; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 200)); }
  const fx: any = await (await fetch(`${base}/_test/fixture`, { method: "POST", headers: { "Content-Type": "application/json" }, body: readFileSync("apps/tasks/ui/fixture.json", "utf8") })).json();
  const ana = fx.keys.ana, t1 = fx.keys.t1;
  const exe = ["chromium-1243", "chromium-1217"].map((d) => `${process.env.LOCALAPPDATA}/ms-playwright/${d}/chrome-win64/chrome.exe`).find(existsSync);
  const browser = await chromium.launch(exe ? { executablePath: exe } : {});
  const page = await (await browser.newContext({ extraHTTPHeaders: { "X-Test-Actor": `${ana.ref}:${ana.id}` } })).newPage();
  await page.goto(`${base}/_auto`);
  const index = await page.locator("main a").allInnerTexts();
  console.log("index lists:", JSON.stringify(index));
  await page.click("text=Move task");
  await page.selectOption("select[name=task]", String(t1.id));
  await page.selectOption("select[name=to]", String(fx.keys.launch.id));
  await page.selectOption("select[name=status]", "doing");
  await page.click("form[action='/_do/move_task'] button[type=submit]");
  await page.waitForLoadState();
  console.log("after submit:", (await page.locator("body").innerText()).includes("Done.") ? "flash Done." : "no flash");
  await page.goto(`${base}/projects/${fx.keys.launch.id}`);
  console.log("task row now:", JSON.stringify((await page.locator(".task", { hasText: "Write the announcement" }).getAttribute("class")) ?? ""));
  await page.goto(`${base}/_auto/views/my_open_tasks`);
  console.log("my open tasks:", JSON.stringify(await page.locator("main span").allInnerTexts()));
  // choices only offer rows the person may read: Eve, in no project, is offered none of them
  const eve = fx.keys.eve;
  const evePage = await (await browser.newContext({ extraHTTPHeaders: { "X-Test-Actor": `${eve.ref}:${eve.id}` } })).newPage();
  await evePage.goto(`${base}/_auto/actions/move_task`);
  console.log("eve is offered tasks:", JSON.stringify(await evePage.locator("select[name=task] option").allInnerTexts()));
  await browser.close();
} finally { server.kill(); }
