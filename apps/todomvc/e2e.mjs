// TodoMVC's app spec (todomvc.com/app-spec), checked in a browser against the running app: the
// same behaviours the reference implementations' tests check, through what a person does.
//   node apps/todomvc/e2e.mjs <base-url> [screenshot.png]
import { createRequire } from "node:module";
const require = createRequire("D:/code/crudspec/.scratch/pw/x.js");
const { chromium } = require("playwright");
const exe = process.env.LOCALAPPDATA + "\\ms-playwright\\chromium-1243\\chrome-win64\\chrome.exe";
const [base, shot] = process.argv.slice(2);
let failed = 0;
const ok = (what, pass, detail) => { console.log(`${pass ? "ok  " : "FAIL"} ${what}`); if (!pass) { failed++; if (detail !== undefined) console.log("     " + JSON.stringify(detail)); } };
const b = await chromium.launch({ executablePath: exe });
const page = await (await b.newContext({ viewport: { width: 800, height: 900 } })).newPage();
const settle = () => page.waitForLoadState("networkidle").catch(() => {});
const input = () => page.getByPlaceholder("What needs to be done?");
const add = async (t) => { await input().fill(t); await input().press("Enter"); await settle(); };
const titles = async () => page.locator(".todo-list .todo label").allInnerTexts().then((l) => l.map((x) => x.trim()));
const item = (t) => page.locator(".todo-list .todo").filter({ hasText: t });
const count = async () => (await page.locator(".todo-count").innerText().catch(() => "")).trim();
try {
  await page.goto(base + "/"); await settle();
  ok("no todos: no main section and no footer", (await page.locator(".main").count()) === 0 && (await page.locator(".footer").count()) === 0);
  await add("   buy milk   ");
  ok("a new todo is added, trimmed", JSON.stringify(await titles()) === '["buy milk"]', await titles());
  ok("the input is cleared after adding", (await input().inputValue()) === "");
  await add("   ");
  ok("an empty todo isn't added", (await titles()).length === 1);
  await add("walk the dog"); await add("water plants");
  ok("todos are listed in the order added", JSON.stringify(await titles()) === '["buy milk","walk the dog","water plants"]', await titles());
  ok("the counter says 3 items left", (await count()) === "3 items left", await count());
  await item("walk the dog").getByRole("button", { name: "Mark as complete" }).click(); await settle();
  ok("a todo can be marked complete", (await item("walk the dog").getAttribute("class")).includes("completed"));
  ok("the counter follows (2 items left)", (await count()) === "2 items left", await count());
  ok("Clear completed shows when a todo is complete", (await page.getByRole("button", { name: "Clear completed" }).count()) === 1);
  await page.getByRole("link", { name: "Active" }).click(); await settle();
  ok("the Active filter shows the active ones", JSON.stringify(await titles()) === '["buy milk","water plants"]', await titles());
  ok("and is selected", (await page.getByRole("link", { name: "Active" }).getAttribute("class")).includes("selected"));
  await page.getByRole("link", { name: "Completed" }).click(); await settle();
  ok("the Completed filter shows the completed ones", JSON.stringify(await titles()) === '["walk the dog"]', await titles());
  await page.getByRole("link", { name: "All" }).click(); await settle();
  // editing
  await item("buy milk").locator("label").dblclick(); await page.waitForURL(/editing=/); await settle();
  const edit = page.locator(".todo.editing input[type=text]");
  ok("double-clicking a todo opens it for editing", (await edit.count()) === 1 && (await edit.inputValue()) === "buy milk");
  ok("the edit field has the focus", await edit.evaluate((e) => e === document.activeElement));
  await edit.fill("  buy oat milk  "); await edit.press("Enter"); await settle();
  ok("Enter saves the edit, trimmed", (await titles()).includes("buy oat milk") && (await page.locator(".todo.editing").count()) === 0, await titles());
  await item("water plants").locator("label").dblclick(); await page.waitForURL(/editing=/); await settle();
  await page.locator(".todo.editing input[type=text]").fill("something else"); await page.locator(".todo.editing input[type=text]").press("Escape"); await settle();
  ok("Escape cancels the edit", (await titles()).includes("water plants") && !(await titles()).includes("something else"), await titles());
  await item("water plants").locator("label").dblclick(); await page.waitForURL(/editing=/); await settle();
  await page.locator(".todo.editing input[type=text]").fill("water all plants"); await page.locator("h1").click(); await settle();
  ok("leaving the field saves the edit", (await titles()).includes("water all plants"), await titles());
  await item("buy oat milk").locator("label").dblclick(); await page.waitForURL(/editing=/); await settle();
  await page.locator(".todo.editing input[type=text]").fill(""); await page.locator(".todo.editing input[type=text]").press("Enter"); await settle();
  ok("an edit left empty removes the todo", !(await titles()).includes("buy oat milk"), await titles());
  // toggle all, clear completed, destroy
  await page.getByRole("button", { name: "Mark all as complete" }).click(); await settle();
  ok("Mark all as complete completes them all", (await page.locator(".todo.completed").count()) === (await page.locator(".todo").count()));
  ok("the counter says 0 items left", (await count()) === "0 items left", await count());
  await page.getByRole("button", { name: "Mark all as complete" }).click(); await settle();
  ok("again, it makes them all active", (await page.locator(".todo.completed").count()) === 0);
  await item("walk the dog").getByRole("button", { name: "Mark as complete" }).click(); await settle();
  ok("1 item left (singular)", (await count()) === "1 item left", await count());
  await page.getByRole("button", { name: "Clear completed" }).click(); await settle();
  ok("Clear completed removes the completed ones", JSON.stringify(await titles()) === '["water all plants"]', await titles());
  ok("and hides itself", (await page.getByRole("button", { name: "Clear completed" }).count()) === 0);
  await item("water all plants").hover();
  await item("water all plants").getByRole("button", { name: "Delete" }).click(); await settle();
  ok("the destroy button removes a todo; the footer goes with the last one", (await page.locator(".todo").count()) === 0 && (await page.locator(".footer").count()) === 0);
  // persistence, and one list per browser
  await add("persist me"); await page.reload(); await settle();
  ok("todos persist across reloads", (await titles()).includes("persist me"));
  const other = await (await b.newContext()).newPage(); await other.goto(base + "/"); await other.waitForLoadState("networkidle");
  ok("another browser has its own list", (await other.locator(".todo").count()) === 0);
  await add("second item");
  await item("second item").getByRole("button", { name: "Mark as complete" }).click(); await settle();
  if (shot) await page.screenshot({ path: shot });
} catch (e) { ok("crashed", false, e.message); }
await b.close();
process.exit(failed ? 1 : 0);
