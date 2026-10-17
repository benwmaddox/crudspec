// Tasks, end to end: two people, a shared project, tasks finished and stamped,
// and permission (a stranger can't see the project).
import { chromium } from "playwright";
const exe = `${process.env.LOCALAPPDATA}/ms-playwright/chromium-1243/chrome-win64/chrome.exe`;
const [base, out] = process.argv.slice(2);
const b = await chromium.launch({ executablePath: exe });
const page = async () => (await b.newContext({ viewport: { width: 1000, height: 720 } })).newPage();
const signUp = async (p, name, email) => {
  await p.goto(base + "/sign-up");
  await p.fill("input[name=name]", name); await p.fill("input[name=email]", email); await p.fill("input[name=password]", "pass-" + name);
  await p.click("form[action='/_do/sign_up'] button[type=submit]"); await p.waitForLoadState();
};
const t = Date.now();
const ana = await page(); await signUp(ana, "Ana", `ana${t}@example.test`);
const ben = await page(); await signUp(ben, "Ben", `ben${t}@example.test`);
const eve = await page(); await signUp(eve, "Eve", `eve${t}@example.test`);

await ana.fill("input[name=name]", "Launch"); await ana.click("form[action='/_do/create_project'] button[type=submit]"); await ana.waitForLoadState();
const projectUrl = ana.url();
await ana.fill("input[name=email]", `ben${t}@example.test`); await ana.click("form[action='/_do/add_member'] button"); await ana.waitForLoadState();
for (const title of ["Write the announcement", "Fix the signup bug"]) { await ana.fill("input[name=title]", title); await ana.click("form[action='/_do/add_task'] button"); await ana.waitForLoadState(); }

// Ben, now a member, finishes a task
await ben.goto(projectUrl);
const benSees = await ben.locator(".task").count();
await ben.locator(".task", { hasText: "Fix the signup bug" }).locator("form[action='/_do/set_status'] button[title], form[action='/_do/set_status'] button").first().click();
await ben.waitForLoadState();
const doneText = await ben.locator(".list.done").innerText();

// Eve is not a member: she is sent home
await eve.goto(projectUrl);
const eveUrl = eve.url();

console.log("ana's project:", projectUrl.replace(base, ""));
console.log("ben sees tasks:", benSees);
console.log("done list:", JSON.stringify(doneText.replace(/\s+/g, " ").trim()));
console.log("eve redirected to:", eveUrl.replace(base, ""));
await ana.goto(projectUrl); await ana.screenshot({ path: `${out}/tasks-project.png` });
await b.close();
