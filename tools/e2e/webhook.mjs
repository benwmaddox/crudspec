// A bot with a webhook replies in a direct room (webhook.rb): the runtime POSTs the
// message as JSON to the bot's URL and posts a 200 text reply back into the room.
import { chromium } from "playwright";
import { createServer } from "node:http";
const exe = process.env.LOCALAPPDATA + "\\ms-playwright\\chromium-1243\\chrome-win64\\chrome.exe";
const [base, out, email = "ada@example.test", password = "correct horse battery"] = process.argv.slice(2);

let received = null;
const hook = createServer((req, res) => {
  let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => {
    received = JSON.parse(body);
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end(`echo: ${received.message.body.plain}`);
  });
}).listen(13850, "127.0.0.1");

const b = await chromium.launch({ executablePath: exe });
const p = await b.newPage({ viewport: { width: 1100, height: 750 } });
await p.goto(base + "/session/new");
await p.fill("input[name=email]", email);
await p.fill("input[name=password]", password);
await p.click("form button[type=submit]");
await p.waitForLoadState();
await p.goto(base + "/account/bots/new");
await p.fill("input[name=name]", "Echo Bot");
await p.fill("input[name=webhook_url]", "http://127.0.0.1:13850/hook");
await p.click("form button[type=submit]");
await p.waitForLoadState();
// the newest bot's page, then Ping it
const botId = await p.$$eval("a[href^='/account/bots/'][href$='/edit']", (as) => Math.max(...as.map((a) => Number(a.getAttribute("href").split("/")[3]))));
await p.goto(`${base}/users/${botId}`);
await p.click("form[action='/_do/create_direct_room'] button");
await p.waitForLoadState();
console.log("direct room:", p.url());
await p.fill("#composer textarea[name=body]", "ping the echo bot");
await p.keyboard.press("Enter");
await p.waitForLoadState();
const ok = await p.waitForFunction(() => document.body.innerText.includes("echo: ping the echo bot"), null, { timeout: 8000 }).then(() => true).catch(() => false);
console.log("webhook received:", received ? JSON.stringify({ user: received.user.name, room: received.room.name, plain: received.message.body.plain }) : "nothing");
console.log("bot reply shown in the room:", ok);
await p.screenshot({ path: `${out}/webhook.png` });
await b.close();
hook.close();
