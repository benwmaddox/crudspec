// Two browsers: Ada (signed in) watches the room; Bob joins by the invite link and posts.
// Ada's page should show Bob's message without reloading (live views).
import { chromium } from "playwright";
const exe = process.env.LOCALAPPDATA + "\\ms-playwright\\chromium-1243\\chrome-win64\\chrome.exe";
const [base, out] = process.argv.slice(2);
const b = await chromium.launch({ executablePath: exe });
const ada = await (await b.newContext({ viewport: { width: 1100, height: 750 } })).newPage();
await ada.goto(base + "/session/new");
await ada.fill("input[name=email]", "ada@example.test");
await ada.fill("input[name=password]", "correct horse battery");
await ada.click("form button[type=submit]");
await ada.waitForLoadState();
const joinUrl = await ada.inputValue("#system_welcome input[readonly]");
console.log("join link", joinUrl);

const bob = await (await b.newContext({ viewport: { width: 1100, height: 750 } })).newPage();
await bob.goto(base + joinUrl);
await bob.fill("input[name=name]", "Bob Builder");
await bob.fill("input[name=email]", "bob@example.test");
await bob.fill("input[name=password]", "can we fix it");
await bob.click("form button[type=submit]");
await bob.waitForLoadState();
console.log("bob landed on", bob.url());
await bob.fill("#composer textarea[name=body]", "Hi Ada, Bob here. Joined with the invite link!");
await bob.keyboard.press("Enter");
await bob.waitForLoadState();

// Ada didn't reload: the live view should bring Bob's message in.
await ada.waitForFunction(() => document.body.innerText.includes("Bob here"), null, { timeout: 8000 })
  .then(() => console.log("live update: Ada sees Bob's message without reloading"))
  .catch(() => console.log("live update: NOT received"));
await ada.screenshot({ path: `${out}/6-ada-live.png` });
await bob.screenshot({ path: `${out}/7-bob.png` });
await b.close();
