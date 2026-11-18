// Campfire's browser behaviors, in Chromium, on the compiled app: what its five Go widgets did
// before, now built-in behaviors (lang/behaviors.ts) and one declared element.
// - <message-formatter>: threading and first-of-day;
// - reply: quoting into the composer;
// - the jump-to-newest button;
// - /play sounds;
// - the install instructions.
// Needs Go (lang/test/go-app.ts) and Campfire's assets (CAMPFIRE_ASSETS, by default
// D:/code/crudspec-assets/campfire).
//   node apps/campfire/test/behaviors.test.ts
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { startApp } from "../../../lang/test/go-app.ts";

const { chromium } = createRequire(new URL("../../../lang/browser/package.json", import.meta.url))("playwright");
let failed = 0;
const ok = (what: string, pass: boolean, detail?: unknown) => { console.log(`${pass ? "ok  " : "FAIL"} ${what}`); if (!pass) { failed++; if (detail !== undefined) console.log("     ", JSON.stringify(detail)); } };
const assets = process.env.CAMPFIRE_ASSETS ?? "D:/code/crudspec-assets/campfire";
if (!existsSync(assets)) { console.log(`skipped: no Campfire assets at ${assets} (set CAMPFIRE_ASSETS)`); process.exit(0); }

const app = await startApp("apps/campfire/campfire.crud", 13986, { assets });
const exe = ["chromium-1243", "chromium-1217"].map((d) => `${process.env.LOCALAPPDATA}/ms-playwright/${d}/chrome-win64/chrome.exe`).find(existsSync);
const browser = await chromium.launch(exe ? { executablePath: exe } : {});
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  await page.addInitScript(() => { (window as any).__played = []; (window as any).Audio = function (src: string) { return { play() { (window as any).__played.push(src); return Promise.resolve(); } }; }; });
  // first run: the first person, landing in All Talk
  await page.goto(app.base + "/");
  await page.locator("input[name=name]").fill("Ada");
  await page.locator("input[name=email]").fill("ada@example.com");
  await page.locator("input[name=password]").fill("secret-password-1");
  await page.locator("button[type=submit]").click();
  await page.waitForSelector("#composer textarea", { timeout: 15000 });
  const room = page.url();
  const post = async (text: string) => {
    await page.locator("#composer textarea").fill(text);
    await page.locator("#composer textarea").press("Enter");
    await page.waitForFunction((t) => [...document.querySelectorAll(".message")].some((m) => m.textContent?.includes(t)), text, { timeout: 8000 });
  };
  await post("first message");
  await post("second message\nwith a second line");
  // the next day: a new day's first message
  await app.post("/_test/clock", { advance_ms: 26 * 3600 * 1000 });
  await post("a day later");
  await page.waitForTimeout(300);
  const cls = await page.evaluate(() => [...document.querySelectorAll(".messages .message")].map((m) => ({ text: m.querySelector(".message__body")?.textContent?.trim().slice(0, 20) ?? m.textContent?.trim().slice(0, 20), first: m.classList.contains("message--first-of-day"), threaded: m.classList.contains("message--threaded") })));
  ok("<message-formatter>: the first message starts its day, the next from the same person joins it", cls.length >= 3 && cls[0].first && !cls[0].threaded && cls[1].threaded && !cls[1].first, cls);
  ok("... and a message a day later starts a new day", cls.length >= 3 && cls[2].first && !cls[2].threaded, cls);
  const local = await page.evaluate(() => document.querySelector(".message__day-separator [data-local], .message__day-separator[data-local]")?.textContent ?? "");
  ok("... with the day in the reader's own words", /\d{4}/.test(local) && /[A-Za-z]/.test(local), local);

  // reply: the second message's lines quoted into the composer, focused
  await page.locator("#composer textarea").fill("");
  await page.locator(".messages .message").nth(1).hover();
  await page.locator(".messages .message").nth(1).locator(".message__options-btn, summary").first().click();
  await page.locator(".messages .message").nth(1).locator("button:has(.for-screen-reader:text('Reply'))").click();
  const reply = await page.evaluate(() => { const t = document.querySelector("#composer textarea") as HTMLTextAreaElement; return { v: t.value, focused: document.activeElement === t }; });
  ok("reply quotes the message, each line marked, and focuses the composer", reply.v === "> second message\n> with a second line\n\n" && reply.focused, reply);
  await page.locator("#composer textarea").fill("");

  // /play: the sound's button plays its file, and the file is there
  await post("/play bell");
  await page.locator(".sound button").last().click();
  const played = await page.evaluate(() => (window as any).__played);
  const sound = played[0] ? await fetch(new URL(played[0], app.base)) : undefined;
  ok("a /play message's button plays the sound, and the server has the file", played.length === 1 && /bell\.mp3/.test(played[0]) && sound?.status === 200, { played, status: sound?.status });

  // jump to newest: hidden at the bottom, shown once scrolled away, and it brings the newest back
  for (let i = 0; i < 25; i++) await post(`filler ${i}`);
  await page.waitForTimeout(500);
  const jump = page.locator(".message-area__return-to-latest");
  await page.evaluate(() => { const ms = document.querySelectorAll(".messages .message"); ms[ms.length - 1].scrollIntoView(); });
  await page.waitForTimeout(500);
  ok("the jump button is hidden while the newest message is in view", await jump.evaluate((b: HTMLElement) => b.hidden));
  await page.evaluate(() => document.querySelector(".messages .message")!.scrollIntoView());
  await page.waitForTimeout(500);
  ok("... and shows once it isn't", !(await jump.evaluate((b: HTMLElement) => b.hidden)));
  await jump.click();
  await page.waitForTimeout(1500);
  ok("clicking it brings the newest message back, and it hides", await jump.evaluate((b: HTMLElement) => b.hidden));

  // the element's script is served as JavaScript, cached for good
  const src = await page.evaluate(() => (document.querySelector('script[type=module][src^="/_el/message-formatter."]') as HTMLScriptElement)?.getAttribute("src"));
  const js = src ? await fetch(new URL(src, app.base)) : undefined;
  ok("the element's script is served as JavaScript, immutable", !!src && js?.status === 200 && /javascript/.test(js.headers.get("content-type") ?? "") && /immutable/.test(js.headers.get("cache-control") ?? ""), { src, status: js?.status });

  // the install instructions, now plain markup
  await page.goto(app.base + "/users/me/profile");
  const pwa = await page.evaluate(() => document.querySelector("details.pwa__instructions summary strong")?.textContent);
  ok("the profile shows how to install the web app", pwa === "Install Campfire as a web app.", pwa);
  const errors: string[] = [];
  page.on("pageerror", (e: Error) => errors.push(e.message));
  await page.goto(room);
  await page.waitForTimeout(800);
  ok("no script errors on the room page", errors.length === 0, errors);
} finally { await browser.close(); app.stop(); }
process.exitCode = failed ? 1 : 0;
