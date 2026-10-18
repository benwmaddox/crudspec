// Acceptance for the third app (app3/BRIEF.md): a browser through what the brief names
// (placeholders, labels, links, buttons, visible text), on a fresh installation.
//   node app3/accept.mjs <base-url> [out.json]
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
const require = createRequire((process.env.PW_DIR ?? "D:/code/crudspec/.scratch/pw") + "/x.js");
const { chromium } = require("playwright");
const exe = process.env.LOCALAPPDATA + "\\ms-playwright\\chromium-1243\\chrome-win64\\chrome.exe";
const [base, out] = process.argv.slice(2);
const checks = [];
const check = (name, pass, detail) => { checks.push({ name, pass: !!pass, ...(detail ? { detail: String(detail).slice(0, 300) } : {}) }); };
const b = await chromium.launch({ executablePath: exe });
const page = async () => (await b.newContext({ viewport: { width: 1100, height: 800 } })).newPage();
const settle = (p) => p.waitForLoadState("networkidle").catch(() => {});
const input = (p, text) => p.getByPlaceholder(text, { exact: true }).or(p.getByLabel(text, { exact: true })).first();
const body = async (p) => (await p.locator("body").innerText()).replace(/\s+/g, " ");
const click = async (p, loc) => {
  const answered = p.waitForResponse((r) => r.request().method() !== "GET", { timeout: 8000 }).catch(() => null);
  await loc.click(); await answered; await settle(p);
};
const button = (p, name) => p.getByRole("button", { name, exact: true }).first();
const link = (p, name) => p.getByRole("link", { name, exact: true }).first();
const fillAndSend = async (p, fieldName, text, buttonName) => { await input(p, fieldName).fill(text); await click(p, button(p, buttonName)); };

try {
  // the first visit: the first staff member
  const staff = await page();
  for (let i = 0; ; i++) { try { await staff.goto(base + "/"); break; } catch (e) { if (i > 40) throw e; await new Promise((r) => setTimeout(r, 500)); } }
  await settle(staff);
  await input(staff, "Name").fill("Sam Staff"); await input(staff, "Email address").fill("sam@desk.test"); await input(staff, "Password").fill("desk password one");
  await click(staff, staff.locator("form").filter({ has: input(staff, "Password") }).locator("button[type=submit], input[type=submit]").first());
  check("the first visit sets up a staff member, signed in", !(await input(staff, "Password").count()), staff.url());
  // two customers sign up
  const signUp = async (name, email) => {
    const p = await page(); await p.goto(base + "/"); await settle(p);
    await click(p, link(p, "Sign up"));
    await input(p, "Name").fill(name); await input(p, "Email address").fill(email); await input(p, "Password").fill("desk password two");
    await click(p, p.locator("form").filter({ has: input(p, "Password") }).locator("button[type=submit], input[type=submit]").first());
    return p;
  };
  const ann = await signUp("Ann Customer", "ann@desk.test");
  check("a customer signs up from the sign-in page and is signed in", (await link(ann, "New ticket").count()) > 0, ann.url());
  const bea = await signUp("Bea Customer", "bea@desk.test");
  // Ann's ticket
  await click(ann, link(ann, "New ticket"));
  await input(ann, "Subject").fill("Printer is on fire"); await input(ann, "Description").fill("Smoke everywhere since Tuesday.");
  await click(ann, button(ann, "Submit ticket"));
  const ticketUrl = ann.url();
  let t = await body(ann);
  check("submitting shows the ticket: subject, description, status Open", t.includes("Printer is on fire") && t.includes("Smoke everywhere since Tuesday.") && /\bOpen\b/.test(t), t.slice(0, 200));
  await ann.goto(base + "/"); await settle(ann);
  check("the customer's home lists their ticket", (await body(ann)).includes("Printer is on fire"));
  check("the customer has no staff buttons", !(await button(ann, "Add note").count()) && !(await button(ann, "Assign to me").count()) && !(await button(ann, "Mark solved").count()) && (await (async () => { await ann.goto(ticketUrl); await settle(ann); return !(await button(ann, "Add note").count()) && !(await button(ann, "Mark solved").count()); })()));
  // Bea can't see it
  await bea.goto(base + "/"); await settle(bea);
  check("another customer's home doesn't list it", !(await body(bea)).includes("Printer is on fire"));
  await bea.goto(ticketUrl); await settle(bea);
  check("another customer can't open it", !(await body(bea)).includes("Smoke everywhere since Tuesday."));
  // staff: the queue, then work the ticket
  await staff.goto(base + "/"); await settle(staff);
  check("the staff home is a queue that lists the ticket", (await body(staff)).includes("Printer is on fire"));
  await click(staff, link(staff, "Printer is on fire"));
  await fillAndSend(staff, "Reply", "Unplug it and step away.", "Send reply");
  await fillAndSend(staff, "Note", "Second fire this month.", "Add note");
  await click(staff, button(staff, "Assign to me"));
  t = await body(staff);
  check("staff see their reply and note", t.includes("Unplug it and step away.") && t.includes("Second fire this month."));
  check("assignment shows on the ticket", /Assigned to.{0,20}Sam Staff/.test(t), t.slice(0, 300));
  await ann.goto(ticketUrl); await settle(ann);
  t = await body(ann);
  check("the customer sees the reply", t.includes("Unplug it and step away."));
  check("the customer never sees the note", !t.includes("Second fire this month."));
  // status
  await staff.goto(ticketUrl); await settle(staff);
  await click(staff, button(staff, "Mark pending"));
  check("Mark pending: the ticket is Pending", /\bPending\b/.test(await body(staff)));
  await click(staff, button(staff, "Mark solved"));
  check("Mark solved: the ticket is Solved", /\bSolved\b/.test(await body(staff)));
  await staff.goto(base + "/"); await settle(staff);
  check("solved tickets leave the queue", !(await body(staff)).includes("Printer is on fire"));
  // the customer replies: it reopens
  await ann.goto(ticketUrl); await settle(ann);
  await fillAndSend(ann, "Reply", "It started again.", "Send reply");
  t = await body(ann);
  check("the customer can reply, and that reopens the ticket", t.includes("It started again.") && /\bOpen\b/.test(t));
  await staff.goto(base + "/"); await settle(staff);
  check("the reopened ticket is back in the queue", (await body(staff)).includes("Printer is on fire"));
  await staff.goto(ticketUrl); await settle(staff);
  check("staff can reopen a solved ticket (Reopen)", await (async () => { await click(staff, button(staff, "Mark solved")); const r = button(staff, "Reopen"); if (!(await r.count())) return false; await click(staff, r); return /\bOpen\b/.test(await body(staff)); })());
} catch (e) {
  check("crashed", false, e.message);
} finally { await b.close(); }
const result = { pass: checks.every((c) => c.pass), passed: checks.filter((c) => c.pass).length, total: checks.length, checks };
console.log(JSON.stringify(result, null, 1));
if (out) writeFileSync(out, JSON.stringify(result, null, 1));
