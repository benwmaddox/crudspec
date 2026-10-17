// Link previews (unfurl_links_controller.rb, opengraph/*): pasting a link into the composer
// fetches its OpenGraph card; it can be removed before sending, and the sent message shows it.
// Needs internet access to github.com.
import { chromium } from "playwright";
const exe = process.env.LOCALAPPDATA + "/ms-playwright/chromium-1243/chrome-win64/chrome.exe";
const [base, out, email = "ada@example.test", password = "correct horse battery"] = process.argv.slice(2);
const br = await chromium.launch({ executablePath: exe });
const ctx = await br.newContext({ viewport: { width: 1100, height: 750 } });
await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: base });
const p = await ctx.newPage();
await p.goto(base + "/session/new");
await p.fill("input[name=email]", email); await p.fill("input[name=password]", password);
await p.click("form button[type=submit]"); await p.waitForLoadState();
await p.goto(base + "/rooms/1");
const ta = p.locator("#composer textarea[name=body]");
const paste = async (text) => {
  await ta.click();
  await p.evaluate((t) => { const dt = new DataTransfer(); dt.setData("text/plain", t);
    const ta = document.querySelector("#composer textarea[name=body]"); ta.value += t;
    ta.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true })); }, text);
};
// 1. paste, then remove the card: nothing is embedded
await paste("https://github.com/nodejs/node");
await p.waitForSelector("#composer .embed-preview", { timeout: 15000 });
await p.click("#composer .embed-preview button");
const removed = await p.inputValue("#composer input[name=body__embeds]");
// 2. paste again and send: the message carries the card
await ta.fill("");
await paste("https://github.com/nodejs/node");
await p.waitForSelector("#composer .embed-preview", { timeout: 15000 });
await p.keyboard.press("Enter"); await p.waitForLoadState();
const card = await p.waitForSelector(".og-embed__title a", { timeout: 8000 }).then((e) => e.innerText()).catch(() => null);
const img = await p.locator(".og-embed__image img").count();
console.log("after removing the card, embeds =", removed);
console.log("sent message card:", JSON.stringify(card), "image:", img > 0);
await p.screenshot({ path: `${out}/unfurl.png` });
await br.close();
