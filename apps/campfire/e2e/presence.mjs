// Presence (membership/connectable.rb, presence_channel.rb): while Ada has the room open she
// is connected, so a new message doesn't mark the room unread for her; Cy, away, does get it.
import { chromium } from "playwright";
import { DatabaseSync } from "node:sqlite";
const exe = `${process.env.LOCALAPPDATA}/ms-playwright/chromium-1243/chrome-win64/chrome.exe`;
const [base, dataDir] = process.argv.slice(2);
const b = await chromium.launch({ executablePath: exe });
async function signIn(email, password) {
  const p = await (await b.newContext()).newPage();
  await p.goto(base + "/session/new");
  await p.fill("input[name=email]", email); await p.fill("input[name=password]", password);
  await p.click("form button[type=submit]"); await p.waitForLoadState();
  return p;
}
const ada = await signIn("ada@example.test", "correct horse battery");
await ada.goto(base + "/rooms/1");          // Ada stays here: the presence channel opens
await ada.waitForTimeout(1000);
// Bob joins and posts
const bob = await (await b.newContext()).newPage();
const join = await ada.inputValue("#system_welcome input[readonly]");
await bob.goto(join);
await bob.fill("input[name=name]", "Cy Away"); await bob.fill("input[name=email]", `cy${Date.now()}@example.test`); await bob.fill("input[name=password]", "away away");
await bob.click("form button[type=submit]"); await bob.waitForLoadState();
await bob.close();                           // Cy leaves, so Cy is not connected
const poster = await signIn("ada@example.test", "correct horse battery");   // a second tab of Ada's would also be present; use the API instead:
await poster.close();
// A message from the room's bot via the API (any member posting would do)
const db = new DatabaseSync(`${dataDir}/app.sqlite`, { readOnly: true });
const bot = db.prepare(`select id, bot_token from "User" where role = 'bot' and status = 'active' limit 1`).get();
const r = await fetch(`${base}/rooms/1/${bot.id}-${bot.bot_token}/messages`, { method: "POST", body: "presence check" });
await ada.waitForTimeout(800);
const m = (uid) => db.prepare(`select unread_since, connected_at from Membership where room = 1 and user = ?`).get(uid);
const cy = db.prepare(`select id from "User" where name = 'Cy Away' order by id desc limit 1`).get();
console.log("bot post:", r.status);
console.log("Ada (room open) unread:", m(1)?.unread_since !== null, "connected_at set:", !!m(1)?.connected_at);
console.log("Cy (away) unread:", m(cy.id)?.unread_since !== null);
await b.close();
