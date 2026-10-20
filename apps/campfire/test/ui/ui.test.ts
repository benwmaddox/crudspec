// UI parity: the same journeys, through a real browser (Playwright), on Rails Campfire and on
// crudspec's Campfire side by side, each from an empty database; after each step, what a person
// sees on both is compared: where they are, the room's name, the rooms in the sidebar, the
// messages (author and text), boosts, notices. A difference fails the step and prints both.
//   node apps/campfire/test/ui/ui.test.ts            serves both (serve.sh), then runs
//   UI_REUSE=1 node apps/campfire/test/ui/ui.test.ts  against apps already serving
// Screenshots of each step on both go to .scratch/ui/ (not committed).
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

const RAILS = "http://127.0.0.1:3101", SPEC = "http://127.0.0.1:3102";
const SHOTS = ".scratch/ui";
let failed = 0, passed = 0, departed = 0;
// where crudspec's Campfire shows something other than Rails' on purpose: Rails' behaviour there
// is a defect a person would notice (as apps/campfire/oracle/departures.json for the scenarios)
const DEPARTURES: Record<string, string> = {
  "a wrong password is refused": "Rails answers 401 with the alert but its browser code reloads the sign-in page, so no message ever shows; crudspec shows \"Too many requests or unauthorized.\"",
  "starts a ping with Bob": "Rails' type-to-ping box fetches its suggestions without asking for JSON, gets the editor's HTML prompt back and fails to parse it (\"Unexpected token '<'\"), so no one can be picked; crudspec suggests and starts the ping",
  "her new name is on her messages": "Rails caches each message's HTML by the message alone (cache [message, \"presentation-v3\"]), so a renamed person's old name stays on their messages; crudspec shows the new name",
};
// controls only crudspec has, on purpose: the runtime's, not Campfire's
const SPEC_ONLY_CONTROLS: Record<string, string> = {
  "link: AI agent access": "the profile links /_agents, where a person issues tokens for AI agents acting for them; Rails Campfire has no agent interface",
};
const fail = (what: string, detail?: unknown) => { failed++; console.log(`FAIL ${what}`); if (detail !== undefined) console.log(typeof detail === "string" ? detail : JSON.stringify(detail, null, 1)); };
const pass = (what: string) => { passed++; console.log(`ok   ${what}`); };

if (!process.env.UI_REUSE) {
  const r = spawnSync("wsl", ["-e", "bash", "/mnt/d/code/crudspec/apps/campfire/test/ui/serve.sh"], { encoding: "utf8", env: { ...process.env, MSYS_NO_PATHCONV: "1" } });
  console.log((r.stdout + r.stderr).trim().split("\n").slice(-2).join("\n"));
  if (r.status !== 0) process.exit(2);
}
// both answering from here (WSL forwards a new port to Windows after a moment)
for (const base of [RAILS, SPEC]) {
  let up = false;
  for (let i = 0; i < 100 && !up; i++) { up = await fetch(base + "/up").then((r) => r.ok, () => false); if (!up) await new Promise((r) => setTimeout(r, 200)); }
  if (!up) { console.log(`${base} isn't answering`); process.exit(2); }
}
mkdirSync(SHOTS, { recursive: true });

// ---- what a person sees, read the same way on both (the apps share Campfire's class names)
type View = { path: string; title: string; room: string; rooms: string[]; messages: { author: string; text: string; boosts: string[] }[]; notice: string };
async function view(page: Page): Promise<View> {
  await page.waitForLoadState("networkidle").catch(() => {});
  // Rails loads its sidebar after the page: its rooms, once there
  await page.locator("aside a[href^='/rooms/']").first().waitFor({ timeout: 3000 }).catch(() => {});
  return await page.evaluate(() => {
    const t = (e: Element | null | undefined) => (e?.textContent ?? "").replace(/\s+/g, " ").trim();
    const path = location.pathname.replace(/\d+/g, "#") + (location.search ? "?" : "");
    const room = t(document.querySelector("nav h1, header h1, .room-name, h1"));
    // the rooms in the sidebar: its links to a room, by their own address (not a permalink's)
    const rooms = [...document.querySelectorAll("aside a[href], [role=complementary] a[href]")]
      .filter((a) => /^\/rooms\/\d+$/.test(a.getAttribute("href") ?? ""))
      .map((a) => t(a)).filter(Boolean);
    // messages: author, text (the presentation: Rails marks it by id, crudspec by class too), and
    // who boosted with what (the boost's label)
    const messages = [...document.querySelectorAll("main .message[data-message-id]")].map((m) => {
      const boosts = [...m.querySelectorAll(".boost")].map((b) => { const i = b.querySelector("img"); return i?.getAttribute("aria-label") || i?.getAttribute("alt") || t(b); }).filter(Boolean);
      return { author: t(m.querySelector(".message__author")), text: t(m.querySelector(".message__presentation, [id^=presentation_message_]")), boosts };
    });
    // a notice: the words of the last alert shown since the page loaded (both apps remove theirs
    // when its animation ends), else one still there
    const notice = (window as any).__notice || t(document.querySelector(".flash [role=alert], .flash, [role=alert]"));
    return { path, title: document.title, room, rooms, messages, notice };
  });
}

// what a screen offers: its controls by role and accessible name (a field by its placeholder
// when it has no name), as a set, anywhere on the page (one app may put them in the sidebar)
async function controls(page: Page): Promise<string[]> {
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.locator("aside a[href^='/rooms/']").first().waitFor({ timeout: 3000 }).catch(() => {});
  const snap = await page.locator("body").ariaSnapshot().catch(() => "");
  const out = new Set<string>();
  const lines = snap.split("\n");
  lines.forEach((l, i) => {
    const m = /- (button|link|checkbox|textbox|searchbox|combobox|radio)(?: "([^"]*)")?/.exec(l);
    if (!m) return;
    let name = m[2] ?? "";
    if (!name && /textbox|searchbox|combobox/.test(m[1])) name = /\/placeholder: (.*)/.exec(lines[i + 1] ?? "")?.[1] ?? "";
    // a boost button names its emoji in one app and not the other; a time link is a permalink
    name = name.replace(/^\p{Extended_Pictographic}️?\s*/u, "").replace(/^\d{1,2}:\d\d [AP]M$/, "(time)").replace(/https?:\/\/\S+/g, "(url)");
    out.add(`${m[1].replace("searchbox", "textbox")}: ${name}`);
  });
  return [...out].sort();
}

// ---- a person, on both apps at once
class Person {
  pages: Record<"rails" | "spec", Page> = {} as any;
  name: string;
  constructor(name: string) { this.name = name; }
  static async make(browser: Browser, name: string) {
    const p = new Person(name);
    for (const app of ["rails", "spec"] as const) {
      p.pages[app] = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
      p.pages[app].on("dialog", (d) => d.accept()); // a confirmation, accepted
      // every alert shown is noted as it appears (before its animation removes it)
      await p.pages[app].addInitScript(() => {
        const note = () => { const a = document.querySelector(".flash [role=alert], [role=alert]"); if (a && a.textContent.trim()) (window as any).__notice = a.textContent.replace(/\s+/g, " ").trim(); };
        new MutationObserver(note).observe(document, { childList: true, subtree: true });
        document.addEventListener("DOMContentLoaded", note);
      });
    }
    return p;
  }
  base(app: "rails" | "spec") { return app === "rails" ? RAILS : SPEC; }
  // a step, done the same way on both
  // a step, done the same way on both; a step one app can't complete is that app's outcome (stuck),
  // compared with the other's by the next same()
  stuck: Record<"rails" | "spec", string> = { rails: "", spec: "" };
  async both(f: (page: Page, base: string, app: "rails" | "spec") => Promise<void>) {
    await Promise.all((["rails", "spec"] as const).map(async (app) => {
      try { await f(this.pages[app], this.base(app), app); } catch (e) { this.stuck[app] = String((e as Error).message ?? e).split("\n")[0].slice(0, 200); }
    }));
  }
  // compare what this person sees on both; fields: which parts of the view to compare
  async same(step: string, fields: (keyof View)[] = ["path", "title", "room", "rooms", "messages"], shot = true) {
    const [r, s] = await Promise.all([view(this.pages.rails), view(this.pages.spec)]);
    // a step one app couldn't do: that, before what it shows
    if (this.stuck.rails || this.stuck.spec) { (r as any).stuck = this.stuck.rails; (s as any).stuck = this.stuck.spec; fields = ["stuck" as keyof View, ...fields]; this.stuck = { rails: "", spec: "" }; }
    if (shot) await Promise.all((["rails", "spec"] as const).map((app) => this.pages[app].screenshot({ path: `${SHOTS}/${String(++shotN).padStart(2, "0")}-${slug(step)}-${app}.png` }).catch(() => {})));
    const diffs = fields.filter((f) => JSON.stringify(r[f]) !== JSON.stringify(s[f])).map((f) => ({ field: f, rails: r[f], spec: s[f] }));
    const why = DEPARTURES[step];
    if (diffs.length && why) { departed++; console.log(`dep  ${this.name}: ${step} — departs from Rails as declared: ${why}`); }
    else if (diffs.length) fail(`${this.name}: ${step}`, diffs); else pass(`${this.name}: ${step}`);
    return { rails: r, spec: s };
  }
  // compare what a screen offers on both: only in one app, by control
  async sameControls(step: string) {
    const [r, s] = await Promise.all([controls(this.pages.rails), controls(this.pages.spec)]);
    await Promise.all((["rails", "spec"] as const).map((app) => this.pages[app].screenshot({ path: `${SHOTS}/${String(++shotN).padStart(2, "0")}-${slug(step)}-${app}.png` }).catch(() => {})));
    const onlyRails = r.filter((x) => !s.includes(x)), onlySpec = s.filter((x) => !r.includes(x) && !SPEC_ONLY_CONTROLS[x]);
    for (const x of s) if (SPEC_ONLY_CONTROLS[x] && !r.includes(x)) { departed++; console.log(`dep  ${this.name}: ${step} — "${x}" departs from Rails as declared: ${SPEC_ONLY_CONTROLS[x]}`); }
    if (onlyRails.length || onlySpec.length) fail(`${this.name}: ${step} (controls)`, { onlyRails, onlySpec }); else pass(`${this.name}: ${step} (controls)`);
  }
  async goto(path: string) { await this.both(async (page, base) => { await page.goto(base + path); }); }
}
let shotN = 0;
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);

async function post(page: Page, text: string) {
  const box = page.getByRole("textbox", { name: "Write a message" });
  await box.click();
  await page.keyboard.type(text);
  await page.keyboard.press("Enter");
  await page.locator("#message-area .message[data-message-id]", { hasText: text }).last().waitFor({ timeout: 10000 });
}
// a message's options menu (the menu opens on its summary)
async function options(page: Page, text: string) {
  const msg = page.locator("#message-area .message[data-message-id]", { hasText: text }).last();
  await msg.hover();
  await msg.locator("summary", { hasText: "Message options" }).click({ force: true });
  return msg;
}
async function boost(page: Page, text: string, emoji: RegExp) {
  const msg = await options(page, text);
  await msg.getByRole("button", { name: emoji }).first().click();
  await page.locator("#message-area .message[data-message-id]", { hasText: text }).last().locator(".boost").first().waitFor({ timeout: 10000 });
}
// Rails edits on its own form (an Edit link, then "Save changes"); crudspec in the menu
async function openEditor(page: Page, app: "rails" | "spec", text: string) {
  const msg = await options(page, text);
  if (app === "rails") { await msg.getByRole("link", { name: "Edit" }).click(); await msg.getByRole("textbox", { name: "Edit message" }).waitFor(); }
  else await msg.locator("summary", { hasText: "Edit" }).click({ force: true });
  return msg;
}
async function editMessage(page: Page, app: "rails" | "spec", text: string, to: string) {
  const msg = await openEditor(page, app, text);
  const box = app === "rails" ? msg.getByRole("textbox", { name: "Edit message" }) : msg.locator("details details").getByRole("textbox");
  await box.click();
  await page.keyboard.press("Control+A");
  await page.keyboard.type(to);
  await msg.getByRole("button", { name: app === "rails" ? "Save changes" : "Save" }).click();
  await page.locator("#message-area .message[data-message-id]", { hasText: to }).waitFor({ timeout: 10000 });
  await page.reload();
}
async function deleteMessage(page: Page, app: "rails" | "spec", text: string) {
  const msg = await openEditor(page, app, text);
  await msg.getByRole("button", { name: app === "rails" ? "Delete message" : "Delete" }).click();
  await page.locator("#message-area .message[data-message-id]", { hasText: text }).waitFor({ state: "detached", timeout: 10000 }).catch(() => {});
  await page.reload();
}
async function signIn(page: Page, base: string, email: string, password: string) {
  await page.goto(base + "/session/new");
  await page.getByPlaceholder(/email/i).fill(email);
  await page.getByPlaceholder(/password/i).fill(password);
  await page.getByRole("button", { name: "Go" }).click();
  await page.waitForLoadState("networkidle");
}

const browser = await chromium.launch();
try {
  const ada = await Person.make(browser, "Ada");
  const bob = await Person.make(browser, "Bob");

  // 1. first run: the first person sets up the account and lands in All Talk
  await ada.both(async (page, base) => {
    await page.goto(base + "/");
    await page.getByPlaceholder("Name").fill("Ada Admin");
    await page.getByPlaceholder("Email address").fill("ada@example.com");
    await page.getByPlaceholder("Password").fill("secret-pass-123");
    await page.getByRole("button", { name: "Save" }).click();
  });
  await ada.same("first run lands in All Talk");

  // 2. a message
  await ada.both((page) => post(page, "Hello from Ada"));
  await ada.same("posts a message");

  // 3. a second person joins with the join link
  await bob.both(async (page, base, app) => {
    const link = await ada.pages[app].locator("input[value*='/join/']").first().inputValue();
    await page.goto(link);
    await page.getByPlaceholder("Name").fill("Bob Builder");
    await page.getByPlaceholder("Email address").fill("bob@example.com");
    await page.getByPlaceholder("Password").fill("bob-pass-12345");
    await page.getByRole("button", { name: "Save" }).click();
  });
  await bob.same("joins with the join link and sees Ada's message");

  // 4. Bob answers; Ada sees it without reloading (live), then after reloading
  await bob.both((page) => post(page, "Hi Ada, Bob here"));
  await bob.same("posts an answer");
  await ada.both(async (page) => { await page.locator("#message-area .message", { hasText: "Bob here" }).waitFor({ timeout: 10000 }).catch(() => {}); });
  await ada.same("sees Bob's answer arrive live");
  await ada.both(async (page) => { await page.reload(); });
  await ada.same("sees both messages after reloading");

  // 5. signing out and in again; a wrong password
  await bob.both(async (page, base) => { await page.context().clearCookies(); await signIn(page, base, "bob@example.com", "wrong-password"); });
  await bob.same("a wrong password is refused", ["path", "title", "notice"]);
  await bob.both(async (page, base) => { await signIn(page, base, "bob@example.com", "bob-pass-12345"); });
  await bob.same("signs in again");

  // 6. boosts, editing and deleting a message (each app's own way to the same end)
  await ada.both((page) => boost(page, "Bob here", /Thumbs up/));
  await ada.same("boosts Bob's message", ["messages"]);
  await bob.both(async (page) => { await page.reload(); });
  await bob.same("sees Ada's boost", ["messages"]);
  await ada.both((page, _b, app) => editMessage(page, app, "Hello from Ada", "Hello from Ada, edited"));
  await ada.same("edits her message", ["path", "messages"]);
  await ada.both((page) => post(page, "A message to delete"));
  await ada.both((page, _b, app) => deleteMessage(page, app, "A message to delete"));
  await ada.same("deletes a message", ["path", "messages"]);

  // 7. a new room, open to everyone
  await ada.goto("/rooms/opens/new");
  await ada.sameControls("the new room form");
  await ada.both(async (page) => { await page.getByPlaceholder("Name the room").fill("Design"); await page.getByRole("button", { name: "Save" }).click(); await page.waitForURL(/\/rooms\/\d+$/); });
  await ada.same("creates the Design room");
  await ada.both((page) => post(page, "First design note"));
  await bob.both(async (page, base) => { await page.goto(base + "/"); });
  await bob.same("sees the new room in the sidebar", ["rooms"]);

  // 8. searching messages
  await bob.goto("/searches");
  await bob.sameControls("the search screen");
  await bob.both(async (page) => { await page.locator("main input[type=search], main input[type=text]").first().fill("design"); await page.getByRole("button", { name: "Search", exact: true }).click(); await page.waitForLoadState("networkidle"); });
  await bob.same("searches for 'design'", ["path", "messages"]);

  // 9. a new name shows on the messages
  await ada.goto("/users/me/profile");
  await ada.sameControls("the profile screen");
  await ada.both(async (page) => { await page.getByPlaceholder("Enter your name").fill("Ada Lovelace"); await page.getByRole("button", { name: "Save changes" }).click(); await page.waitForLoadState("networkidle"); await page.waitForTimeout(500); });
  await ada.goto("/");
  await ada.same("her new name is on her messages", ["messages"]);

  // 10. screens: pinging someone, the account settings (an administrator's, and a member's)
  await ada.goto("/rooms/directs/new");
  await ada.sameControls("the ping screen");
  // a ping: Bob found by typing, chosen, started
  await ada.both(async (page) => {
    await page.locator("main input[type=text]").first().click();
    await page.keyboard.type("Bob");
    await page.getByRole("option", { name: /Bob Builder/ }).first().click({ timeout: 8000 });   // the suggestions: a listbox of options in both
    await page.getByRole("button", { name: "Start Ping" }).click();
    await page.waitForURL(/\/rooms\/\d+$/);
  });
  await ada.same("starts a ping with Bob", ["path", "room", "messages"]);
  await ada.goto("/account/edit");
  await ada.same("the account settings", ["path", "title"]);
  await ada.sameControls("the account settings");
  await bob.goto("/account/edit");
  await bob.same("a member opens the account settings", ["path", "title"]);
  await bob.sameControls("a member's account settings");
} finally {
  await browser.close();
}
console.log(`${passed} steps the same, ${departed} departing as declared, ${failed} different (screenshots: ${SHOTS}/)`);
process.exit(failed ? 1 : 0);
