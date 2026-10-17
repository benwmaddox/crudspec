// Push notifications: the bell's push_permission button registers the service worker,
// subscribes through the browser's push service and records the subscription
// (users/push_subscriptions_controller.rb); a test notification is then sent to it.
// Runs in Microsoft Edge, whose push service (Windows WNS) works headless; Playwright's Chromium
// build has no push service. Needs internet access.
import { chromium } from "playwright";

const [base, out, email = "ada@example.test", password = "correct horse battery"] = process.argv.slice(2);
const headed = process.env.HEADED === "1";
const ctx = await chromium.launchPersistentContext("", { channel: "msedge", headless: !headed, viewport: { width: 1100, height: 750 } });
await ctx.grantPermissions(["notifications"], { origin: base });
const p = await ctx.newPage();
await p.goto(base + "/session/new");
await p.fill("input[name=email]", email); await p.fill("input[name=password]", password);
await p.click("form button[type=submit]"); await p.waitForLoadState();
await p.goto(base + "/rooms/1");
await p.waitForSelector("[data-push-subscribe]", { state: "attached" });
await p.evaluate(() => document.querySelector("[data-push-subscribe]").click());
const label = await p.waitForFunction(() => { const t = document.querySelector("[data-push-label]")?.textContent; return t !== "Turn on notifications" && t; }, null, { timeout: 30000 }).then((h) => h.jsonValue()).catch(() => "(no change)");
console.log("button:", label, "| error:", await p.evaluate(() => window.__pushError ?? "none"));
const endpoint = (await ctx.cookies(base)).find((c) => c.name === "push_endpoint")?.value;
console.log("endpoint cookie:", endpoint ? decodeURIComponent(endpoint).replace(/\/[^/]{20,}$/, "/…") : "none");
await p.goto(base + "/users/me/push_subscriptions");
console.log("subscriptions listed:", await p.locator("form[action='/_do/unsubscribe_push']").count());
// a test notification for each listed subscription (older ones belong to closed browsers and
// may be expired), received by this browser's service worker and posted back to the page
const got = p.evaluate(() => new Promise((res) => { navigator.serviceWorker.addEventListener("message", (e) => res(e.data.push)); setTimeout(() => res(null), 30000); }));
await p.evaluate(async () => { for (const f of document.querySelectorAll("form[action='/_do/send_test_notification']")) await fetch(f.action + "?fetch=1", { method: "POST", body: new FormData(f) }); });
console.log("test notification received:", JSON.stringify(await got));
await p.waitForTimeout(3000);
await p.reload();
await p.screenshot({ path: `${out}/push.png` });
await ctx.close();
