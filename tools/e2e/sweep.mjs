import { chromium } from "playwright";
const exe = process.env.LOCALAPPDATA + "\\ms-playwright\\chromium-1243\\chrome-win64\\chrome.exe";
const [base, out] = process.argv.slice(2);
const b = await chromium.launch({ executablePath: exe });
const p = await b.newPage({ viewport: { width: 1100, height: 750 } });
await p.goto(base + "/session/new");
await p.fill("input[name=email]", "ada@example.test");
await p.fill("input[name=password]", "correct horse battery");
await p.click("form button[type=submit]");
await p.waitForLoadState();
const routes = ["/", "/rooms/1", "/rooms/1/edit", "/rooms/opens/new", "/rooms/opens/new?closed=true", "/rooms/directs/new", "/searches?q=deploy",
  "/users/2", "/users/me/profile", "/account/edit", "/account/custom_styles/edit", "/account/bots", "/account/bots/new", "/users/me/push_subscriptions"];
let i = 0;
for (const r of routes) {
  const resp = await p.goto(base + r);
  const text = await p.evaluate(() => document.body?.innerText ?? "");
  const name = `sweep-${String(++i).padStart(2, "0")}`;
  await p.screenshot({ path: `${out}/${name}.png` });
  console.log(`${name} ${r} -> ${resp.status()} ${p.url().replace(base, "")}${text.includes("server error") ? " SERVER ERROR" : ""} (${text.length} chars)`);
}
await b.close();
