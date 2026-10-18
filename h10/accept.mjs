// H10 acceptance (docs/H10-PROTOCOL.md): the same browser checks against either arm's app,
// through what users see (placeholders, labels, button names, visible text) and the routes both
// apps share, never through field names or markup an arm chooses.
//   node h10/accept.mjs <base-url> <task: base|topic|pin|display> [out.json]
// It starts from a fresh app (no account yet). Prints, and writes, {task, shared, checks}.
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
const require = createRequire((process.env.PW_DIR ?? "D:/code/crudspec/.scratch/pw") + "/x.js");
const { chromium } = require("playwright");
const exe = process.env.LOCALAPPDATA + "\\ms-playwright\\chromium-1243\\chrome-win64\\chrome.exe";
const [base, task, out] = process.argv.slice(2);
const result = { task, shared: [], checks: [] };
const step = (list, name, pass, detail) => { list.push({ name, pass: !!pass, ...(detail ? { detail: String(detail).slice(0, 300) } : {}) }); };
const shared = (n, p, d) => step(result.shared, n, p, d), check = (n, p, d) => step(result.checks, n, p, d);

const b = await chromium.launch({ executablePath: exe });
const ctx = async () => (await b.newContext({ viewport: { width: 1100, height: 800 } })).newPage();
const field = (page, text) => page.getByPlaceholder(text, { exact: true }).or(page.getByLabel(text, { exact: true })).first();
const submitIn = (loc) => loc.locator("button[type=submit], input[type=submit]").first();
// submits a form and waits for its answer (Turbo submits by fetch: the page may not navigate)
const submit = async (form) => {
  const page = form.page();
  const answered = page.waitForResponse((r) => r.request().method() !== "GET", { timeout: 8000 }).catch(() => null);
  await submitIn(form).click();
  await answered;
  await settle(page);
};
const textOf = async (page) => (await page.locator("body").innerText()).replace(/\s+/g, " ");
// a message on the page, by its text
const messageWith = (page, text) => page.locator(".message").filter({ hasText: text }).last();
// a button by its name in a message, opening its menus first
const buttonIn = async (scope, name) => {
  for (const d of await scope.locator("details:not([open]) > summary").all()) await d.click().catch(() => {});
  return scope.getByRole("button", { name, exact: true }).first();
};
const post = async (page, text) => {
  const box = page.locator("#composer textarea, #composer [contenteditable=true], trix-editor, form textarea").first();
  await box.fill(text); await box.press("Enter");
  await page.waitForFunction((t) => document.body.innerText.includes(t), text, { timeout: 8000 });
};
const settle = (page) => page.waitForLoadState("networkidle").catch(() => {});
// the room's edit page, by the link the room's page has to it (the apps' routes differ)
const editRoom = async (page, room) => {
  await page.goto(`${base}/rooms/${room}`); await settle(page);
  const href = await page.locator(`a[href$="/${room}/edit"]`).first().getAttribute("href").catch(() => null);
  await page.goto(href ? new URL(href, base).href : `${base}/rooms/${room}/edit`); await settle(page);
};

try {
  // ---- shared: Ada sets the app up; Bob joins with the invite link; both post
  const ada = await ctx();
  // the app may still be coming up behind WSL's port forwarding
  for (let i = 0; ; i++) { try { await ada.goto(base + "/"); break; } catch (e) { if (i >= 40) throw e; await new Promise((r) => setTimeout(r, 500)); } }
  await field(ada, "Name").fill("Ada Lovelace");
  await field(ada, "Email address").fill("ada@h10.test");
  await field(ada, "Password").fill("h10 password one");
  await submit(ada.locator("form").filter({ has: field(ada, "Password") }));
  await settle(ada);
  shared("first run lands in a room", /\/rooms\/\d+/.test(ada.url()), ada.url());
  const room = Number(/\/rooms\/(\d+)/.exec(ada.url())?.[1]);
  await ada.goto(base + "/account/edit"); await settle(ada);
  const join = await ada.locator("input[readonly]").evaluateAll((xs) => xs.map((x) => x.value).find((v) => v.includes("/join/")));
  shared("the account page shows a join link", !!join, join);
  const bob = await ctx();
  await bob.goto(join.startsWith("http") ? join : base + join);
  await field(bob, "Name").fill("Bob Builder");
  await field(bob, "Email address").fill("bob@h10.test");
  await field(bob, "Password").fill("h10 password two");
  await submit(bob.locator("form").filter({ has: field(bob, "Password") }));
  await settle(bob);
  shared("Bob joins and lands in a room", /\/rooms\/\d+/.test(bob.url()), bob.url());
  await ada.goto(`${base}/rooms/${room}`); await settle(ada);
  await post(ada, "Pin me please");
  await bob.goto(`${base}/rooms/${room}`); await settle(bob);
  await post(bob, "A note from Bob");
  shared("both post in the room", (await textOf(bob)).includes("Pin me please"));

  if (task === "topic") {
    // T1: a room topic, set where the room is edited by whoever may rename it, shown under its name
    await editRoom(ada, room);
    const topic = ada.getByPlaceholder(/topic/i).or(ada.getByLabel(/topic/i)).first();
    check("the room's edit page has a topic field", await topic.count());
    if (await topic.count()) {
      await topic.fill("Q4 planning, all week");
      await submit(ada.locator("form").filter({ has: topic })); await settle(ada);
      await ada.goto(`${base}/rooms/${room}`); await settle(ada);
      check("the room page shows the topic", (await textOf(ada)).includes("Q4 planning, all week"));
      await bob.goto(`${base}/rooms/${room}`); await settle(bob);
      check("other members see it too", (await textOf(bob)).includes("Q4 planning, all week"));
      // Bob may not rename the room (he isn't an administrator nor its creator): nor set its topic
      await editRoom(bob, room);
      const bt = bob.getByPlaceholder(/topic/i).or(bob.getByLabel(/topic/i)).first();
      if (await bt.count() && await bt.isEditable()) { await bt.fill("Bob was here"); await submit(bob.locator("form").filter({ has: bt })).catch(() => {}); await settle(bob); }
      await ada.goto(`${base}/rooms/${room}`); await settle(ada);
      check("someone who can't rename the room can't set its topic", !(await textOf(ada)).includes("Bob was here"));
      await editRoom(ada, room);
      const long = "x".repeat(201);
      await topic.fill(long); await submit(ada.locator("form").filter({ has: topic })); await settle(ada);
      await ada.goto(`${base}/rooms/${room}`); await settle(ada);
      check("a topic over 200 characters isn't kept", !(await textOf(ada)).includes(long));
    }
  }
  if (task === "pin") {
    // T2: whoever can delete a message can pin it; a pinned message is marked "Pinned"; the same
    // people can unpin it
    await ada.goto(`${base}/rooms/${room}`); await settle(ada);
    const pin = await buttonIn(messageWith(ada, "Pin me please"), "Pin");
    check("the author has a Pin button on their message", await pin.count());
    if (await pin.count()) {
      await pin.click(); await settle(ada);
      await ada.goto(`${base}/rooms/${room}`); await settle(ada);
      check("the message is marked Pinned", /\bPinned\b/.test(await messageWith(ada, "Pin me please").innerText()));
      await bob.goto(`${base}/rooms/${room}`); await settle(bob);
      check("others see it marked Pinned", /\bPinned\b/.test(await messageWith(bob, "Pin me please").innerText()));
      check("Bob can't pin or unpin Ada's message", !(await (await buttonIn(messageWith(bob, "Pin me please"), "Unpin")).count()) && !(await (await buttonIn(messageWith(bob, "Pin me please"), "Pin")).count()));
      check("Bob can pin his own message", await (await buttonIn(messageWith(bob, "A note from Bob"), "Pin")).count());
      check("an administrator can pin anyone's message", await (await buttonIn(messageWith(ada, "A note from Bob"), "Pin")).count());
      const unpin = await buttonIn(messageWith(ada, "Pin me please"), "Unpin");
      check("the author can unpin it", await unpin.count());
      if (await unpin.count()) {
        await unpin.click(); await settle(ada);
        await ada.goto(`${base}/rooms/${room}`); await settle(ada);
        check("unpinned, it is no longer marked", !/\bPinned\b/.test(await messageWith(ada, "Pin me please").innerText()));
      }
    }
  }
  if (task === "display") {
    // T3: messages show the author's display name, which starts as the first word of their name
    // and can be changed on the profile page (up to 40 characters)
    await ada.goto(`${base}/rooms/${room}`); await settle(ada);
    const m = await messageWith(ada, "Pin me please").innerText();
    check("a message shows its author's display name: the first word of the name", /\bAda\b/.test(m) && !m.includes("Ada Lovelace"), m.slice(0, 120));
    await ada.goto(`${base}/users/me/profile`); await settle(ada);
    const dn = ada.getByPlaceholder(/display name/i).or(ada.getByLabel(/display name/i)).first();
    check("the profile page has a display name field", await dn.count());
    if (await dn.count()) {
      await dn.fill("Countess"); await submit(ada.locator("form").filter({ has: dn })); await settle(ada);
      await bob.goto(`${base}/rooms/${room}`); await settle(bob);
      check("after a change, messages show the new display name", (await messageWith(bob, "Pin me please").innerText()).includes("Countess"));
      await ada.goto(`${base}/users/me/profile`); await settle(ada);
      await dn.fill("y".repeat(41)); await submit(ada.locator("form").filter({ has: dn })); await settle(ada);
      await bob.goto(`${base}/rooms/${room}`); await settle(bob);
      check("a display name over 40 characters isn't kept", !(await textOf(bob)).includes("y".repeat(41)));
    }
  }
} catch (e) {
  step(task === "base" ? result.shared : result.checks, "crashed", false, e.message);
} finally {
  await b.close();
}
const ok = (l) => l.every((c) => c.pass);
result.sharedPass = ok(result.shared); result.pass = result.sharedPass && result.checks.length > 0 && ok(result.checks);
console.log(JSON.stringify(result, null, 1));
if (out) writeFileSync(out, JSON.stringify(result, null, 1));
