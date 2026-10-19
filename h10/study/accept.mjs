// The H10 study's acceptance checks (docs/H10-STUDY-PROTOCOL.md): the same checks against either
// arm's app, through what people see (visible text, placeholders, labels, roles and names of
// buttons and links) and the routes both apps share, never through markup or field names an arm
// chooses. Each frozen task's acceptance criteria (h10/study/tasks) map to checks here; criteria
// that can't be checked this way, or contradict another, are listed as not scored (CRITERIA).
// Wording a criterion allows several of ("a Pin button or menu option") is matched by any of them.
//
//   node h10/study/accept.mjs <spec|rails> <base-url> <task: base|01…10> [out.json]
// Environment: SINK_FILE (the mail server's messages, one JSON line each, in WSL), H10_TZ.
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const require = createRequire((process.env.PW_DIR ?? "D:/code/crudspec/.scratch/pw") + "/x.js");
const { chromium } = require("playwright");
const exe = process.env.LOCALAPPDATA + "\\ms-playwright\\chromium-1243\\chrome-win64\\chrome.exe";
const [arm, base, task, out] = process.argv.slice(2);
const SINK = process.env.SINK_FILE ?? "/tmp/h10-sink.jsonl";
const TZ = process.env.H10_TZ ?? "America/Chicago";
const result = { arm, task, shared: [], checks: [] };
const step = (list, name, pass, detail) => { list.push({ name, pass: !!pass, ...(detail !== undefined ? { detail: String(typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 400) } : {}) }); };
const shared = (n, p, d) => step(result.shared, n, p, d), check = (n, p, d) => step(result.checks, n, p, d);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- the harness's contract: the clock, the mail server
const DAY = 86_400_000, HOUR = 3_600_000;
async function advance(ms) {
  const r = arm === "spec"
    ? await fetch(base + "/_test/clock", { method: "POST", body: JSON.stringify({ advance_ms: ms }) })
    : await fetch(base + "/_h10/advance", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ms }) });
  if (!r.ok) throw new Error(`advancing the clock: ${r.status}`);
  await sleep(1500);   // due work, and the jobs it started, get a moment (polls below allow 10 s)
}
const mails = () => (spawnSync("wsl", ["-e", "bash", "-c", `cat ${SINK} 2>/dev/null`], { encoding: "utf8" }).stdout || "").split("\n").filter(Boolean).map((l) => {
  const m = JSON.parse(l); return { ...m, text: decodeMail(m.data) };
});
// a message's headers and text, quoted-printable and base64 parts decoded, HTML tags dropped
function decodeMail(raw) {
  const qp = (s) => Buffer.from(s.replace(/=\r?\n/g, "").replace(/=([0-9A-F]{2})/gi, (_m, h) => String.fromCharCode(parseInt(h, 16))), "latin1").toString("utf8");
  let text = raw;
  const parts = raw.split(/\r?\n--[^\r\n]+\r?\n/);
  const out = [];
  for (const p of parts) {
    const [head, ...rest] = p.split(/\r?\n\r?\n/); const body = rest.join("\n\n");
    if (/content-transfer-encoding:\s*base64/i.test(head)) { try { out.push(head, Buffer.from(body.replace(/\s+/g, ""), "base64").toString("utf8")); continue; } catch { /* as is */ } }
    if (/content-transfer-encoding:\s*quoted-printable/i.test(head)) { out.push(head, qp(body)); continue; }
    out.push(p);
  }
  text = out.join("\n");
  // encoded headers (=?utf-8?q?…?= / ?b?)
  text = text.replace(/=\?utf-8\?([qb])\?([^?]*)\?=/gi, (_m, e, s) => e.toLowerCase() === "b" ? Buffer.from(s, "base64").toString("utf8") : qp(s.replace(/_/g, " ")));
  return text.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/[ \t]+/g, " ");
}
const mailsTo = (addr) => mails().filter((m) => (m.to ?? []).some((t) => t.toLowerCase() === addr));
async function waitFor(fn, ms = 10000) { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) return v; await sleep(500); } }

// ---- the browser
const b = await chromium.launch({ executablePath: exe });
const ctx = async () => { const c = await b.newContext({ viewport: { width: 1200, height: 900 }, timezoneId: TZ, acceptDownloads: true }); const p = await c.newPage(); p.on("dialog", (d) => d.accept().catch(() => {})); return p; };
const settle = (page) => page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
const field = (page, text) => page.getByPlaceholder(text, { exact: true }).or(page.getByLabel(text, { exact: true })).first();
const submitIn = (loc) => loc.locator("button[type=submit], input[type=submit]").first();
const submit = async (form) => {
  const page = form.page();
  const answered = page.waitForResponse((r) => r.request().method() !== "GET", { timeout: 8000 }).catch(() => null);
  const nav = navigated(page);
  const btn = submitIn(form);
  // a form that submits itself (an auto-submitting switch) has no button: submit it as its control would
  if (await btn.count()) await btn.click(); else await form.first().evaluate((f) => f.requestSubmit());
  await answered; await landed(page, nav);
};
// turns a checkbox on: by its label when the box itself is drawn as a zero-size switch (the house style)
const checkOn = async (page, box) => {
  if (await box.isChecked().catch(() => false)) return;
  const shown = await box.isVisible().catch(() => false);
  const nav = navigated(page);
  if (shown) await box.check({ timeout: 3000 }); else await box.evaluate((e) => e.closest("label")?.click() ?? e.click());
  await landed(page, nav);
};
const textOf = async (scope) => ((await scope.locator("body").innerText().catch(() => null)) ?? (await scope.innerText().catch(() => ""))).replace(/\s+/g, " ");
const go = async (page, path) => { await page.goto(path.startsWith("http") ? path : base + path); await settle(page); };
const messageWith = (page, text) => page.locator(".message").filter({ hasText: text }).last();
// opens a scope's menus (details, the message options control, anything that says it has a popup)
async function openMenus(scope) {
  await scope.hover().catch(() => {});
  for (const s of await scope.locator("details:not([open]) > summary").all()) await s.click({ timeout: 1500 }).catch(() => {});
  for (const s of await scope.locator(".message__options-btn, [aria-haspopup=true], [aria-haspopup=menu]").all()) await s.click({ timeout: 1500 }).catch(() => {});
}
// a control (button or link) by its accessible name, in a scope, its menus opened first
async function control(scope, name) {
  await openMenus(scope);
  const c = scope.getByRole("button", { name }).or(scope.getByRole("link", { name })).or(scope.getByRole("menuitem", { name })).or(scope.getByRole("checkbox", { name }));
  return (await c.count()) ? c.first() : null;
}
// after something that may load a page: wait for that page (any response alone could be the
// page's own background traffic), or a short while when nothing navigates
const navigated = (page) => page.waitForEvent("framenavigated", { predicate: (f) => f === page.mainFrame(), timeout: 2500 }).catch(() => null);
const landed = async (page, nav) => { if (await nav) await page.waitForLoadState("load", { timeout: 8000 }).catch(() => {}); await settle(page); };
const click = async (page, loc) => { const nav = navigated(page); await loc.click({ timeout: 4000 }); await landed(page, nav); };
const post = async (page, text) => {
  const box = page.locator("#composer textarea:visible, #composer [contenteditable=true]:visible, trix-editor:visible, lexxy-editor [contenteditable=true]:visible, form textarea:visible").last();   // the composer: a message's own edit box comes earlier, hidden
  await box.fill(text); await box.press("Enter");
  await page.waitForFunction((t) => document.body.innerText.includes(t), text, { timeout: 8000 });
};
const roomOf = (page) => Number(/\/rooms\/(\d+)/.exec(page.url())?.[1]);
async function newRoom(page, name) {
  await go(page, "/rooms/opens/new");
  await page.getByPlaceholder("Name the room").fill(name);
  await submit(page.locator("form").filter({ has: page.getByPlaceholder("Name the room") }));
  await page.waitForURL(/\/rooms\/\d+/, { timeout: 10000 }).catch(() => {}); await settle(page);   // Turbo updates the address after the answer
  return roomOf(page);
}
async function signUp(page, url, name, email, password) {
  await go(page, url);
  await field(page, "Name").fill(name); await field(page, "Email address").fill(email); await field(page, "Password").fill(password);
  await submit(page.locator("form").filter({ has: field(page, "Password") }));
  await page.waitForURL(/\/rooms\/\d+/, { timeout: 10000 }).catch(() => {}); await settle(page);
}
// a form field anywhere on the page whose label, placeholder or nearby text matches
async function fieldLike(page, re) {
  const f = page.getByLabel(re).or(page.getByPlaceholder(re)).or(page.getByRole("textbox", { name: re })).or(page.getByRole("combobox", { name: re })).or(page.getByRole("checkbox", { name: re })).or(page.getByRole("spinbutton", { name: re }));
  // only form controls (a label or heading saying "From" isn't one)
  const g = f.and(page.locator("input:visible, select:visible, textarea:visible, [contenteditable=true]:visible, [role=combobox]:visible, [role=textbox]:visible, [role=checkbox]:visible, [role=spinbutton]:visible, [role=switch]:visible"));
  if (await g.count()) return g.first();
  // a checkbox drawn as a switch: the box has no size, its label is what people see and click
  const sw = f.and(page.locator("label:visible input[type=checkbox]"));
  return (await sw.count()) ? sw.first() : null;
}
// the room's settings page, by the room page's link to it
async function roomSettings(page, room) {
  await go(page, `/rooms/${room}`);
  const l = page.getByRole("link", { name: /settings for this room/i }).first();
  const href = (await l.count()) ? await l.getAttribute("href") : null;
  await go(page, href ?? `/rooms/${room}/edit`);
}

const S = {};   // the shared world: Ada (administrator, creator of the first room), Bob, rooms
async function sharedSetup() {
  S.ada = await ctx();
  for (let i = 0; ; i++) { try { await S.ada.goto(base + "/"); break; } catch (e) { if (i >= 40) throw e; await sleep(500); } }
  await field(S.ada, "Name").fill("Ada Lovelace"); await field(S.ada, "Email address").fill("ada@h10.test"); await field(S.ada, "Password").fill("h10 password one");
  await submit(S.ada.locator("form").filter({ has: field(S.ada, "Password") }));
  await S.ada.waitForURL(/\/rooms\/\d+/, { timeout: 10000 }).catch(() => {}); await settle(S.ada);
  shared("first run lands in a room", /\/rooms\/\d+/.test(S.ada.url()), S.ada.url());
  S.room = roomOf(S.ada);
  S.roomName = (await S.ada.locator(".room--current, [aria-current=page]").first().innerText().catch(() => "")).trim() || "All Talk";
  await go(S.ada, "/account/edit");
  S.join = await S.ada.locator("input[readonly]").evaluateAll((xs) => xs.map((x) => x.value).find((v) => v.includes("/join/")));
  shared("the account page shows a join link", !!S.join, S.join);
  S.bob = await ctx();
  await signUp(S.bob, S.join, "Bob Builder", "bob@h10.test", "h10 password two");
  shared("Bob joins and lands in a room", /\/rooms\/\d+/.test(S.bob.url()), S.bob.url());
  S.design = await newRoom(S.ada, "Design Studio");
  shared("Ada makes a second room", S.design > 0 && S.design !== S.room, S.ada.url());
  await go(S.ada, `/rooms/${S.room}`); await post(S.ada, "Pin me please");
  await go(S.bob, `/rooms/${S.room}`); await post(S.bob, "A note from Bob");
  shared("both post in the room", (await textOf(S.bob)).includes("Pin me please"));
}

// ---- the tasks (h10/study/tasks/task-NN.md), criterion by criterion
const T = {};

T["01"] = async () => {   // Room Topics
  const { ada, bob, room } = S;
  // where the topic is edited: the room page, or its settings page
  const topicControl = async (page) => {
    await go(page, `/rooms/${room}`);
    const c = await control(page.locator("body"), /topic|description/i);
    if (c) return { page, c };
    await roomSettings(page, room);
    const f = await fieldLike(page, /topic|description/i);
    return f ? { page, f } : null;
  };
  const a = await topicControl(ada);
  check("creators and administrators see an edit topic button or field", !!a);
  if (!a) return;
  let f = a.f;
  if (!f) { await click(ada, a.c); f = await fieldLike(ada, /topic|description/i) ?? ada.locator("textarea, input[type=text]").last(); }
  const bobPage = bob; await go(bobPage, `/rooms/${room}`);
  await f.fill("Line one of the topic\nLine two of the topic").catch(async () => { await f.fill("Line one of the topic Line two of the topic"); });
  const form = ada.locator("form").filter({ has: f });
  if (await form.count()) await submit(form); else await f.press("Enter");
  await go(ada, `/rooms/${room}`);
  const t = await textOf(ada);
  check("the room's page shows the topic", t.includes("Line one of the topic"), t.slice(0, 300));
  check("a topic can have several lines", t.includes("Line two of the topic") && (await ada.evaluate(() => document.body.innerText.includes("Line one of the topic\nLine two of the topic") || [...document.querySelectorAll("br")].length > 0)));
  check("others in the room see the topic as it changes, without reloading", await waitFor(async () => (await textOf(bobPage)).includes("Line one of the topic"), 8000));
  await go(bob, `/rooms/${room}`);
  check("others see the topic", (await textOf(bob)).includes("Line one of the topic"));
  const bc = await control(bob.locator("body"), /edit topic|set topic|change topic/i);
  await roomSettings(bob, room);
  const bf = await fieldLike(bob, /topic|description/i);
  let bobChanged = false;
  if (bf && await bf.isEditable().catch(() => false)) { await bf.fill("Bob was here").catch(() => {}); const bform = bob.locator("form").filter({ has: bf }); if (await bform.count()) await submit(bform).catch(() => {}); }
  await go(ada, `/rooms/${room}`); bobChanged = (await textOf(ada)).includes("Bob was here");
  check("other people see no edit button, and can't change it", !bc && !bobChanged);
  await go(ada, `/rooms/${S.design}`);
  check("a room without a topic shows none", !(await textOf(ada)).includes("Line one of the topic"));
};

T["02"] = async () => {   // Message Pinning
  const { ada, bob, room } = S;
  await go(ada, `/rooms/${room}`);
  const pinA = await control(messageWith(ada, "Pin me please"), /^(pin|pin message|pin this message)$/i);
  check("an author has a Pin option on their message", !!pinA);
  await go(bob, `/rooms/${room}`);
  check("someone else has no Pin option on it", !(await control(messageWith(bob, "Pin me please"), /^(pin|pin message|pin this message)$/i)));
  await go(ada, `/rooms/${room}`);
  check("an administrator can pin anyone's message", !!(await control(messageWith(ada, "A note from Bob"), /^(pin|pin message|pin this message)$/i)));
  if (!pinA) return;
  await go(ada, `/rooms/${room}`); await post(ada, "Not pinned at all");
  await click(ada, await control(messageWith(ada, "Pin me please"), /^(pin|pin message|pin this message)$/i));
  await go(ada, `/rooms/${room}`);
  const marked = async (page, text) => messageWith(page, text).evaluate((m) => {
    const inControl = (e) => e.closest("button, form, a[href*=pin], [role=menuitem], details > div");
    const labelled = [...m.querySelectorAll("[title], [aria-label], img[alt]")].filter((e) => !inControl(e)).some((e) => /pin/i.test(e.getAttribute("title") || e.getAttribute("aria-label") || e.getAttribute("alt") || ""));
    const text = [...m.querySelectorAll("*")].filter((e) => !inControl(e) && e.children.length === 0).some((e) => /\bpinned\b|📌/i.test(e.textContent || ""));
    return labelled || text;
  }).catch(() => false);
  check("a pinned message shows a pin icon or label", await marked(ada, "Pin me please"));
  check("an unpinned message has none", !(await marked(ada, "Not pinned at all")));
  const t = await textOf(ada);
  check("the room shows a Pinned badge with the count", /pinned\D{0,20}1\b|\b1\D{0,15}pinned/i.test(t), t.slice(0, 300));
  const badge = ada.getByRole("link", { name: /pinned/i }).or(ada.getByRole("button", { name: /pinned/i })).first();
  if (await badge.count()) {
    await click(ada, badge);
    const v = await textOf(ada);
    check("the badge opens a view listing the pinned messages", v.includes("Pin me please"));
  } else check("the badge opens a view listing the pinned messages", false, "no Pinned link or button");
  await go(bob, `/rooms/${room}`);
  check("only authors and administrators can unpin", !(await control(messageWith(bob, "Pin me please"), /^unpin/i)));
  await go(ada, `/rooms/${room}`);
  const del = await control(messageWith(ada, "Pin me please"), /^delete/i);
  if (del) { await click(ada, del); const confirm = ada.getByRole("button", { name: /^delete/i }).first(); if (await confirm.isVisible().catch(() => false)) await click(ada, confirm).catch(() => {}); }
  await go(ada, `/rooms/${room}`);
  check("a deleted message is unpinned (the count goes)", !/pinned\D{0,20}1\b|\b1\D{0,15}pinned/i.test(await textOf(ada)));
};

T["03"] = async () => {   // Starred Messages
  const { ada, bob, room, design } = S;
  await go(ada, `/rooms/${design}`); await post(ada, "A design note");
  await go(ada, `/rooms/${room}`);
  const star = await control(messageWith(ada, "A note from Bob"), /^(star|bookmark|save)/i);
  check("each message has a Star option that toggles", !!star);
  if (!star) return;
  await click(ada, star);
  await go(ada, `/rooms/${room}`);
  const m = messageWith(ada, "A note from Bob");
  const on = (await control(m, /unstar|starred|remove (star|bookmark)|un-?bookmark/i)) || (await m.locator("[aria-pressed=true]").count()) > 0;
  check("when starred, it shows as starred", !!on);
  check("an unstarred message shows the empty star", !!(await control(messageWith(ada, "Pin me please"), /^(star|bookmark|save)/i)));
  await go(ada, `/rooms/${design}`);
  await click(ada, await control(messageWith(ada, "A design note"), /^(star|bookmark|save)/i)).catch(() => {});
  await go(ada, `/rooms/${room}`);
  const nav = ada.getByRole("link", { name: /starred|bookmark|saved/i }).first();
  check("a Starred messages page in the navigation", await nav.count());
  if (!(await nav.count())) return;
  await click(ada, nav);
  const list = await textOf(ada);
  check("listed with the room name, author and text", list.includes("A note from Bob") && list.includes("Bob Builder") && list.includes(S.roomName), list.slice(0, 300));
  check("and the date", (await ada.locator("time").count()) > 0 || /\b(today|yesterday|\d{1,2}:\d{2}|20\d\d|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(list));
  const jump = await ada.locator(`a[href*="/rooms/${room}"]`).count();
  check("each links to the message in its room", jump > 0);
  const filter = await fieldLike(ada, /room|search|filter/i);
  if (filter) {
    if ((await filter.evaluate((e) => e.tagName)) === "SELECT") await filter.selectOption({ label: "Design Studio" }).catch(async () => filter.selectOption({ index: 1 }));
    else { await filter.fill("Design"); await filter.press("Enter").catch(() => {}); }
    await settle(ada); await sleep(800);
    const ft = await textOf(ada);
    check("can be searched or filtered by room", ft.includes("A design note") && !ft.includes("A note from Bob"), ft.slice(0, 300));
  } else check("can be searched or filtered by room", false, "no room filter");
  await go(bob, `/rooms/${room}`);
  const bnav = bob.getByRole("link", { name: /starred|bookmark|saved/i }).first();
  let bobSees = false;
  if (await bnav.count()) { await click(bob, bnav); bobSees = (await textOf(bob)).includes("A note from Bob"); }
  await go(bob, `/rooms/${room}`);
  check("a star is personal: others don't see it starred", !bobSees && !!(await control(messageWith(bob, "A note from Bob"), /^(star|bookmark|save)/i)));
};

T["04"] = async () => {   // Advanced Message Search with Filters
  const { ada, bob, room, design } = S;
  await go(ada, `/rooms/${room}`); await post(ada, "findme from Ada in the lobby");
  await go(bob, `/rooms/${room}`); await post(bob, "findme from Bob in the lobby");
  await go(ada, `/rooms/${design}`); await post(ada, "findme from Ada in design");
  await go(ada, "/searches");
  const t = await textOf(ada);
  const has = async (re) => !!(await fieldLike(ada, re)) || !!(await control(ada.locator("body"), re));
  check("filters for author, room, date range and message type", (await has(/author|from|sender|person/i)) && (await has(/room/i)) && (await has(/date/i)) && /mention/i.test(t) && /attachment/i.test(t) && /reaction|boost/i.test(t), t.slice(0, 300));
  check("date presets: Today, This week, This month, Custom range", /today/i.test(t) && /this week/i.test(t) && /this month/i.test(t) && /custom/i.test(t));
  check("several authors or rooms can be chosen", (await ada.locator("select[multiple]").count()) > 0 || (await ada.getByRole("checkbox").count()) >= 2);
  const q = ada.getByRole("searchbox").or(ada.locator("input[type=search], input[name=q], input[name=query]")).first();
  await q.fill("findme"); await q.press("Enter"); await settle(ada); await sleep(500);
  const r = await textOf(ada);
  check("a plain search still works", r.includes("findme from Ada in the lobby") && r.includes("findme from Bob in the lobby"), r.slice(0, 300));
  check("results show the room name, sender, date and a preview", r.includes("Design Studio") && r.includes("Bob Builder") && ((await ada.locator("time").count()) > 0 || /\d{1,2}:\d{2}/.test(r)));
  check("results link to the message in its room", (await ada.locator(`a[href*="/rooms/"]`).count()) > 0);
  const author = await fieldLike(ada, /author|from|sender|person/i);
  if (author) {
    const tag = await author.evaluate((e) => `${e.tagName}:${e.type}`);
    if (tag.startsWith("SELECT")) await author.selectOption({ label: "Bob Builder" }).catch(() => {});
    else if (tag.includes("checkbox")) { const bobBox = ada.getByRole("checkbox", { name: /bob/i }).first(); if (await bobBox.count()) await checkOn(ada, bobBox); else await checkOn(ada, author); }
    else { await author.fill("Bob Builder"); await author.press("Enter").catch(() => {}); }
    await sleep(2500); await settle(ada);
    const fr = await textOf(ada);
    check("an author filter narrows the results, at once", fr.includes("findme from Bob in the lobby") && !fr.includes("findme from Ada in the lobby"), fr.slice(0, 300));
  } else check("an author filter narrows the results, at once", false, "no author filter");
  const save = await control(ada.locator("body"), /save (this )?search/i);
  check("a Save search button", !!save);
  if (save) {
    await click(ada, save);
    const name = await fieldLike(ada, /name/i);
    if (name && await name.isVisible().catch(() => false)) { await name.fill("Bob's findmes"); const f = ada.locator("form").filter({ has: name }); if (await f.count()) await submit(f); else await name.press("Enter"); }
    await go(ada, "/searches");
    const st = await textOf(ada);
    check("saved searches are listed by name", st.includes("Bob's findmes") || /findme/.test(st), st.slice(0, 300));
    const del = await control(ada.locator("body"), /delete|remove/i);
    if (del) { await click(ada, del); await go(ada, "/searches"); }
    check("a saved search can be deleted", !!del && !(await textOf(ada)).includes("Bob's findmes"));
  }
};

T["05"] = async () => {   // Daily Digest Email
  const { ada, bob, room } = S;
  // where the setting is: the profile page, or a page it links to
  const findSetting = async (page) => {
    await go(page, "/users/me/profile");
    let f = await fieldLike(page, /daily digest|digest/i);
    if (f) return f;
    const l = page.getByRole("link", { name: /digest|email preferences|email settings|notifications/i }).first();
    if (await l.count()) { await click(page, l); f = await fieldLike(page, /daily digest|digest/i); }
    return f;
  };
  const f = await findSetting(bob);
  check("a Daily digest email setting", !!f);
  if (!f) return;
  const settingsUrl = bob.url();
  const tag = await f.evaluate((e) => `${e.tagName}:${e.type}`);
  if (tag.includes("checkbox")) await checkOn(bob, f); else await f.selectOption({ index: 1 }).catch(() => {});
  // turning it on may show the rest of the settings
  const time = bob.locator("input[type=time]:visible").first();
  const timeSel = await fieldLike(bob, /deliver|hour|\btime\b(?!\s*zone)/i);
  check("a preferred delivery time", (await time.count()) > 0 || !!timeSel);
  // 8 AM, in whichever form the setting takes: a time picker, a list, an hour, or text
  const tkind = timeSel ? await timeSel.evaluate((e) => `${e.tagName}:${e.type}`) : "";
  if (await time.count()) await time.fill("08:00");
  else if (tkind.startsWith("SELECT")) await timeSel.selectOption({ label: /8(:00)?\s*(am)?/i }).catch(() => {});
  else if (tkind === "INPUT:number") await timeSel.fill("8");
  else if (tkind.startsWith("INPUT") || tkind.startsWith("TEXTAREA")) await timeSel.fill("08:00");
  check("rooms to include can be chosen", (await bob.getByRole("checkbox", { name: new RegExp(S.roomName + "|Design Studio", "i") }).count()) > 0 || /design studio/i.test(await textOf(bob)));
  // save: the form the time is in, else the setting's own (they may be one form or several)
  const timeForm = (await time.count()) ? bob.locator("form").filter({ has: time }) : timeSel ? bob.locator("form").filter({ has: timeSel }) : null;
  const form = timeForm && (await timeForm.count()) ? timeForm : bob.locator("form").filter({ has: (await fieldLike(bob, /daily digest|digest/i)) ?? f });
  // (a switch that saved itself when turned on isn't submitted again: that would turn it off)
  if (await form.count() && (form === timeForm || (await submitIn(form).count()))) await submit(form);
  await go(bob, "/users/me/profile");
  // unread for Bob: Ada posts while he is elsewhere, and pings him
  await go(ada, `/rooms/${room}`); await post(ada, "Digest-worthy news from Ada");
  await go(ada, "/rooms/directs/new");
  const people = ada.getByRole("checkbox", { name: /bob/i }).or(ada.getByLabel(/bob/i)).first();
  if (await people.count()) { await checkOn(ada, people); const df = ada.locator("form").filter({ has: people }); if (await df.count()) await submit(df); await post(ada, "A direct word for Bob").catch(() => {}); }
  const before = mailsTo("bob@h10.test").length;
  // to the next 9:00 in the harness's zone (America/New_York), by the hour
  for (let i = 0; i < 26 && mailsTo("bob@h10.test").length === before; i++) await advance(HOUR);
  const dig = await waitFor(() => mailsTo("bob@h10.test").slice(before).find((m) => /digest|summary|unread/i.test(m.text)));
  check("a digest email arrives at the chosen time", !!dig);
  if (!dig) return;
  check("it gives each room's unread count, senders and previews", dig.text.includes(S.roomName) && /Ada/.test(dig.text) && dig.text.includes("Digest-worthy news") && /\b\d+\b/.test(dig.text), dig.text.slice(0, 500));
  check("it links to the room", new RegExp(`/rooms/${room}\\b`).test(dig.text), dig.text.slice(0, 500));
  check("direct messages are listed separately", /direct|ping|private/i.test(dig.text) && dig.text.includes("A direct word for Bob"));
  check("it has a Stop digest link", /stop|unsubscribe/i.test(dig.text) && /https?:\/\/\S+/.test(dig.text));
  check("it links to the digest settings", /https?:\/\/\S*(profile|setting|digest|preference)/i.test(dig.text) || dig.text.includes(new URL(settingsUrl).pathname));
  // the next day, nothing unread: no digest
  await go(bob, `/rooms/${room}`); await sleep(1500);
  const n = mailsTo("bob@h10.test").length;
  await advance(DAY); await sleep(3000);
  check("it's sent only when there are unread messages", mailsTo("bob@h10.test").length === n);
};

T["06"] = async () => {   // Automatic Room Archival
  const { ada, bob, room, design } = S;
  await go(ada, `/rooms/${design}`);
  let archiveCtl = await control(ada.locator("body"), /archive (this )?room|^archive$/i);
  if (!archiveCtl) { await roomSettings(ada, design); archiveCtl = await control(ada.locator("body"), /archive (this )?room|^archive$/i); }
  check("creators and administrators see Archive this room", !!archiveCtl);
  await go(bob, `/rooms/${design}`);
  let bobArch = await control(bob.locator("body"), /archive (this )?room|^archive$/i);
  if (!bobArch) { await roomSettings(bob, design); bobArch = await control(bob.locator("body"), /archive (this )?room|^archive$/i); }
  // the lobby keeps being used (a post on day 20); Design Studio has no messages from day 0
  await advance(20 * DAY);
  await go(ada, `/rooms/${room}`); await post(ada, "A post on day 20");
  await advance(11 * DAY);
  await go(ada, `/rooms/${room}`);
  const sidebar = await textOf(ada);
  const archived = async (page, r) => { await go(page, `/rooms/${r}`); return /archived/i.test(await textOf(page)); };
  check("a room with no messages for 30 days is archived, and shown as archived", (await archived(ada, design)) && /archived/i.test(sidebar), sidebar.slice(0, 300));
  check("a room with recent messages stays active", !(await archived(ada, room)));
  await go(ada, `/rooms/${design}`);
  const t = await textOf(ada);
  check("posting is blocked, saying This room is archived", /this room is archived/i.test(t));
  check("an archived room can still be viewed", t.includes("Design Studio"));
  check("people other than its creator and administrators don't see Archive", !bobArch);
  await advance(5 * DAY);
  await go(ada, `/rooms/${design}`);
  check("administrators see when it was archived (Archived 5 days ago)", /archived\s*(5|five)\s*days? ago|archived on/i.test(await textOf(ada)), (await textOf(ada)).slice(0, 300));
  const un = await control(ada.locator("body"), /unarchive|restore/i) ?? (await roomSettings(ada, design), await control(ada.locator("body"), /unarchive|restore/i));
  check("administrators see Unarchive", !!un);
  if (un) { await click(ada, un); }
  check("unarchived, it is active again", !(await archived(ada, design)));
};

T["07"] = async () => {   // Export Room Messages
  const { ada, bob, room } = S;
  await go(ada, `/rooms/${room}`);
  await post(ada, "=1+1 is not a formula here");
  const thumbs = await control(messageWith(ada, "Pin me please"), /thumbs up|👍|boost/i);
  if (thumbs) await click(ada, thumbs).catch(() => {});
  await go(ada, `/rooms/${room}`);
  let exp = await control(ada.locator("body"), /^export/i);
  if (!exp) { await roomSettings(ada, room); exp = await control(ada.locator("body"), /^export/i); }
  check("room creators and administrators see an Export button", !!exp);
  await go(bob, `/rooms/${room}`);
  let bexp = await control(bob.locator("body"), /^export/i);
  if (!bexp) { await roomSettings(bob, room); bexp = await control(bob.locator("body"), /^export/i); }
  check("others see no export option", !bexp);
  if (!exp) return;
  const page = ada;
  await click(page, exp).catch(() => {});
  const t = await textOf(page);
  check("it offers CSV and JSON", /\bcsv\b/i.test(t) && /\bjson\b/i.test(t), t.slice(0, 300));
  const download = async (format) => {
    const opt = page.getByLabel(new RegExp(`^${format}`, "i")).or(page.getByRole("radio", { name: new RegExp(format, "i") })).first();
    if (await opt.count()) await checkOn(page, opt);
    else { const sel = page.locator("select").filter({ hasText: new RegExp(format, "i") }).first(); if (await sel.count()) await sel.selectOption({ label: new RegExp(format, "i") }).catch(() => sel.selectOption(format.toLowerCase())); }
    let btn = page.getByRole("button", { name: /download/i }).or(page.getByRole("link", { name: /download/i })).first();
    if (!(await btn.count())) btn = page.getByRole("link", { name: new RegExp(format, "i") }).or(page.getByRole("button", { name: new RegExp(format, "i") })).first();
    if (!(await btn.count())) return null;
    const [d] = await Promise.all([page.waitForEvent("download", { timeout: 10000 }), btn.click()]).catch(() => [null]);
    if (!d) return null;
    const path = await d.path();
    return { name: d.suggestedFilename(), body: require("node:fs").readFileSync(path, "utf8") };
  };
  const csv = await download("CSV");
  check("Download gives a file", !!csv);
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  if (csv) {
    const slug = S.roomName.toLowerCase().replace(/[^a-z0-9]+/g, "[^a-z0-9]?");
    check("named with the room's name and today's date", new RegExp(slug, "i").test(csv.name) && csv.name.includes(today) && /\.csv$/i.test(csv.name), csv.name);
    const head = csv.body.split(/\r?\n/)[0].toLowerCase();
    check("CSV columns: Timestamp, Author, Message, Reactions, Attachments", ["timestamp", "author", "message", "reactions", "attachments"].every((c) => head.includes(c)), head);
    const pin = csv.body.indexOf("Pin me please"), bobs = csv.body.indexOf("A note from Bob");
    check("oldest to newest", pin >= 0 && bobs > pin);
    check("reactions show the emoji and the count", /👍[^\n]{0,12}1|1[^\n]{0,6}👍/.test(csv.body), csv.body.slice(0, 400));
  }
  await go(page, `/rooms/${room}`);
  exp = await control(page.locator("body"), /^export/i) ?? (await roomSettings(page, room), await control(page.locator("body"), /^export/i));
  if (exp) await click(page, exp).catch(() => {});
  const js = await download("JSON");
  let data = null; try { data = js && JSON.parse(js.body); } catch { /* not JSON */ }
  const list = Array.isArray(data) ? data : Array.isArray(data?.messages) ? data.messages : null;
  check("JSON: an array of messages with timestamp, author, message_text, reactions, attachments", !!list && list.length >= 2 && ["timestamp", "author", "message_text", "reactions", "attachments"].every((k) => k in list[0]) && Array.isArray(list[0].reactions) && Array.isArray(list[0].attachments), js?.body?.slice(0, 300));
  check("attachments as metadata only (no file contents)", !!list && !/base64|data:/.test(js.body));
};

T["08"] = async () => {   // Admin Notifications for Inactive Users
  const { ada, bob } = S;
  await go(ada, "/account/edit");
  let f = await fieldLike(ada, /inactive|14 days/i);
  if (!f) { const l = ada.getByRole("link", { name: /inactive|alerts|notifications/i }).first(); if (await l.count()) { await click(ada, l); f = await fieldLike(ada, /inactive|14 days/i); } }
  check("an Inactive user alerts setting on the account page", !!f);
  if (!f) return;
  check("on by default", await f.isChecked().catch(() => false));
  const cy = await ctx();
  await signUp(cy, S.join, "Cy Young", "cy@h10.test", "h10 password three");
  const before = mailsTo("ada@h10.test").length;
  // Ada keeps signing in; Bob and Cy don't
  for (let d = 0; d < 16 && mailsTo("ada@h10.test").length === before; d++) { await advance(DAY); await go(ada, "/"); }
  const alerts = await waitFor(() => mailsTo("ada@h10.test").slice(before).filter((m) => /inactive/i.test(m.text)));
  const a = alerts?.[0];
  check("an email to the administrators when someone has been inactive for 14 days", !!a);
  if (!a) return;
  check("it gives their name, email, role and last sign-in date", a.text.includes("Bob Builder") && a.text.includes("bob@h10.test") && /member|role|administrator/i.test(a.text) && /\b20\d\d\b|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.? \d/i.test(a.text), a.text.slice(0, 500));
  check("it links to their profile", /https?:\/\/\S*\/users\/\d+/.test(a.text));
  check("several inactive on the same day: one email listing them all", alerts.length === 1 && a.text.includes("Cy Young"), alerts.length);
  const prof = /https?:\/\/\S*\/users\/(\d+)/.exec(a.text);
  if (prof) await go(ada, `/users/${prof[1]}`);
  check("administrators can deactivate or reactivate from the profile", !!(await control(ada.locator("body"), /deactivate|reactivate|remove|ban/i)));
  // Bob signs in again: no more alerts about him until another 14 days
  await go(bob, "/");
  const n = mailsTo("ada@h10.test").length;
  for (let d = 0; d < 7; d++) { await advance(DAY); await go(ada, "/"); }
  await sleep(2000);
  check("after signing in again, no more alerts until another 14 days", !mailsTo("ada@h10.test").slice(n).some((m) => m.text.includes("Bob Builder")));
};

T["09"] = async () => {   // Message Threading
  const { ada, bob, room } = S;
  await go(bob, `/rooms/${room}`);
  const reply = await control(messageWith(bob, "Pin me please"), /^reply/i);
  check("each message has a Reply option", !!reply);
  if (!reply) return;
  await click(bob, reply);
  const t = await textOf(bob);
  check("the reply composer shows the message being replied to", (await bob.locator("#composer, form").filter({ hasText: "Pin me please" }).count()) > 0 || /replying to/i.test(t));
  check("and @ its author", /@\s?Ada/.test(t) || (await bob.locator("#composer textarea, #composer [contenteditable=true]").first().innerText().catch(() => "")).includes("@Ada") || (await bob.locator("#composer textarea").first().inputValue().catch(() => "")).includes("@Ada"));
  await post(bob, "First threaded reply");
  await go(ada, `/rooms/${room}`);
  const orig = messageWith(ada, "Pin me please");
  const badge = orig.getByText(/\b1 repl(y|ies)\b/i).first();
  check("the original shows a replies count", (await badge.count()) > 0 || /\b1 repl(y|ies)\b/i.test(await textOf(ada)));
  await go(bob, `/rooms/${room}`);
  const r2 = await control(messageWith(bob, "Pin me please"), /^reply/i);
  if (r2) { await click(bob, r2); await post(bob, "Second threaded reply"); }
  await go(ada, `/rooms/${room}`);
  const b2 = ada.getByText(/\b2 replies\b/i).first();
  check("the count follows (2 replies)", (await b2.count()) > 0);
  if (await b2.count()) {
    await click(ada, b2);
    const tt = await textOf(ada);
    const i1 = tt.indexOf("First threaded reply"), i2 = tt.indexOf("Second threaded reply"), io = tt.indexOf("Pin me please");
    check("expanding shows the replies under the original, oldest first", io >= 0 && i1 > io && i2 > i1);
    const collapse = ada.getByRole("button", { name: /collapse|hide|close/i }).or(ada.getByText(/\b2 replies\b/i)).first();
    if (await collapse.count()) { await click(ada, collapse); }
    check("threads can be collapsed again", !(await ada.getByText("Second threaded reply").first().isVisible().catch(() => false)));
    await click(ada, ada.getByText(/\b2 replies\b/i).first()).catch(() => {});
  }
  const rep = ada.locator(".message").filter({ hasText: "First threaded reply" }).last();
  check("replies take boosts", !!(await control(rep, /thumbs up|👍|boost/i)));
  check("an administrator can delete a reply", !!(await control(rep, /^delete/i)));
  await go(ada, `/rooms/${room}`);
  check("existing messages have no replies", !/\b\d+ repl(y|ies)\b/i.test(await messageWith(ada, "A note from Bob").innerText().catch(() => "")));
};

T["10"] = async () => {   // Scheduled Messages
  const { ada, room, design } = S;
  await go(ada, `/rooms/${room}`);
  const sched = await control(ada.locator("#composer, form").last(), /^schedule/i) ?? await control(ada.locator("body"), /^schedule/i);
  check("the composer has a Schedule option", !!sched);
  if (!sched) return;
  const box = ada.locator("#composer textarea:visible, #composer [contenteditable=true]:visible, form textarea:visible").last();
  await box.fill("Scheduled hello for later").catch(() => {});
  await click(ada, sched).catch(() => {});
  const dt = ada.locator("input[type=datetime-local]").first(), d = ada.locator("input[type=date]").first(), tm = ada.locator("input[type=time]").first();
  check("a date and time picker", (await dt.count()) > 0 || ((await d.count()) > 0 && (await tm.count()) > 0));
  const zone = await fieldLike(ada, /time ?zone/i);
  const zoneVal = zone ? await zone.evaluate((e) => e.value || e.options?.[e.selectedIndex]?.text || "") : "";
  check("a time zone, the browser's by default", !!zone && /chicago|central|cst|cdt/i.test(zoneVal), zoneVal);
  const at = (days, h) => { const x = new Date(Date.now() + days * DAY); x.setHours(h, 0, 0, 0); return x; };
  const fillWhen = async (when) => {
    const iso = when.toLocaleString("sv-SE", { timeZone: TZ }).replace(" ", "T").slice(0, 16);
    if (await dt.count()) await dt.fill(iso); else { await d.fill(iso.slice(0, 10)); await tm.fill(iso.slice(11)); }
  };
  const confirmSchedule = async () => { const s = ada.getByRole("button", { name: /^(schedule|save|confirm)/i }).last(); if (await s.count()) await click(ada, s); };
  await fillWhen(at(100, 10)); await confirmSchedule();
  await go(ada, `/rooms/${room}`);
  const nav = ada.getByRole("link", { name: /scheduled/i }).first();
  check("a Scheduled messages page in the navigation", await nav.count());
  const listText = async () => { await go(ada, `/rooms/${room}`); const n = ada.getByRole("link", { name: /scheduled/i }).first(); if (await n.count()) await click(ada, n); return textOf(ada); };
  check("no more than 90 days ahead", !(await listText()).includes("Scheduled hello for later"));
  await go(ada, `/rooms/${room}`);
  await box.fill("Scheduled hello for later").catch(() => {});
  await click(ada, await control(ada.locator("body"), /^schedule/i)).catch(() => {});
  const when = at(2, 10); await fillWhen(when); await confirmSchedule();
  const conf = await textOf(ada);
  check("a confirmation with the delivery date and time", /scheduled/i.test(conf) && (/10:00|10 am/i.test(conf)), conf.slice(0, 300));
  const lt = await listText();
  check("listed with its destination, time and a preview", lt.includes("Scheduled hello for later") && lt.includes(S.roomName) && /10:00|10 am/i.test(lt), lt.slice(0, 300));
  // a second, to another room; then edit and cancel
  await go(ada, `/rooms/${design}`);
  await box.fill("Second scheduled one").catch(() => {});
  await click(ada, await control(ada.locator("body"), /^schedule/i)).catch(() => {});
  await fillWhen(at(3, 9)); await confirmSchedule();
  const lt2 = await listText();
  check("several can be scheduled, to different places and times", lt2.includes("Scheduled hello for later") && lt2.includes("Second scheduled one"));
  // the listing's entry for one of them: the smallest element holding its text and a control
  const entry = () => ada.locator("li, tr, article, section, div").filter({ hasText: "Second scheduled one" }).filter({ has: ada.locator("button, a") }).last();
  await listText();
  check("one can be edited before it's sent", !!(await control(entry(), /^edit/i)));
  await listText();
  const cancel = await control(entry(), /^(cancel|delete|remove)/i);
  if (cancel) await click(ada, cancel);
  const after = await listText();
  check("one can be cancelled, and is gone", !!cancel && !after.includes("Second scheduled one") && after.includes("Scheduled hello for later"));
  // its time comes
  await advance(2 * DAY + 2 * HOUR);
  await go(ada, `/rooms/${room}`);
  check("when its time comes, it is sent to the room", await waitFor(async () => { await go(ada, `/rooms/${room}`); return (await textOf(ada)).includes("Scheduled hello for later"); }, 10000));
};

// criteria not scored: they can't be told apart from what's on the page, or contradict another
const CRITERIA = {
  "01": ["Topics can contain multiple lines (scored as: both lines shown)", "persists if a person leaves and rejoins (scored as: shown after reloading)"],
  "02": ["Pinned messages appear in chronological order or in pin order (either is accepted, so it isn't a separate check)"],
  "06": ["Posting to an archived room unarchives it: contradicts 'posting is blocked'; not scored", "Archived rooms are still searchable: not scored separately (viewable is)", "Existing rooms stay active until they meet the condition: the data check"],
  "07": ["Clicking Export opens a modal or menu: scored as offering CSV and JSON", "Attachments show filename, type and size: scored as metadata only"],
  "08": ["The setting is enabled by default for new accounts: scored on the first account"],
  "09": ["Edit rules for replies: scored as an administrator can delete one", "Direct messages support threading: not scored"],
  "10": ["The sent message shows the actual send time: not scored (the harness's clock jump makes the two the same)"],
};

try {
  await sharedSetup();
  if (task !== "base") { if (!T[task]) throw new Error(`no task ${task}`); await T[task](); }
} catch (e) {
  step(task === "base" ? result.shared : result.checks, "crashed", false, e.message);
} finally {
  await b.close();
}
const allPass = (l) => l.every((c) => c.pass);
result.notScored = CRITERIA[task] ?? [];
result.sharedPass = allPass(result.shared);
result.passed = result.checks.filter((c) => c.pass).length;
result.pass = result.sharedPass && result.checks.length > 0 && allPass(result.checks);
console.log(JSON.stringify(result, null, 1));
if (out) writeFileSync(out, JSON.stringify(result, null, 1));
