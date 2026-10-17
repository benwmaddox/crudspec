// Mentioning a bot in a shared room triggers its webhook (messages_controller.rb
// bots_eligible_for_webhook: mentioned active bots). The mention must be picked from the
// "@" prompt, as in Rails; typed text alone is not a mention.
// Needs a bot named "Echo Bot" whose webhook is http://127.0.0.1:13850/hook (webhook.mjs makes one).
import { chromium } from "playwright";
import { createServer } from "node:http";
const exe = process.env.LOCALAPPDATA + "\\ms-playwright\\chromium-1243\\chrome-win64\\chrome.exe";
const [base, out, email = "ada@example.test", password = "correct horse battery"] = process.argv.slice(2);
const calls = [];
const hook = createServer((req, res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { const j = JSON.parse(b); calls.push(j);
  res.writeHead(200, { "Content-Type": "text/plain" }); res.end(`echo: ${j.message.body.plain}`); }); }).listen(13850, "127.0.0.1");

const br = await chromium.launch({ executablePath: exe });
const p = await br.newPage({ viewport: { width: 1100, height: 750 } });
await p.goto(base + "/session/new");
await p.fill("input[name=email]", email);
await p.fill("input[name=password]", password);
await p.click("form button[type=submit]");
await p.waitForLoadState();
await p.goto(base + "/rooms/1");
const ta = p.locator("#composer textarea[name=body]");

// 1. typed "@Echo Bot" without picking: not a mention, no webhook
await ta.fill("hello @Echo Bot, typed by hand");
await p.keyboard.press("Enter");
await p.waitForLoadState();
await p.waitForTimeout(1500);
const typedCalls = calls.length;

// 2. picked from the prompt: a mention, so the bot's webhook fires
await ta.click();
await ta.pressSequentially("@Ec");
await p.waitForFunction(() => { const b = document.querySelector(".mention-picker"); return b && !b.hidden && b.textContent.trim().startsWith("Echo Bot"); }, null, { timeout: 5000 });
await p.keyboard.press("Enter");
await ta.pressSequentially("please reply");
await p.keyboard.press("Enter");
await p.waitForLoadState();
const replied = await p.waitForFunction(() => document.body.innerText.includes("echo: please reply"), null, { timeout: 8000 }).then(() => true).catch(() => false);
console.log(`typed "@Echo Bot" (not picked): ${typedCalls} webhook call(s)`);
console.log(`picked mention: ${calls.length - typedCalls} webhook call(s); reply shown: ${replied}`);
await p.screenshot({ path: `${out}/mention.png` });
await br.close(); hook.close();
