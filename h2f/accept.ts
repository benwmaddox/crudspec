// Runs one H2-F task's acceptance checks (docs/H2F-PROTOCOL.md) against the crudspec arm:
// a runtime in --test mode serving the implementing run's spec.
// usage: node h2f/accept.ts <acceptance.json> --base <url> [--json]
// The seed becomes a fixture through Campfire's own actions; each check runs in a browser as
// its person (X-Test-Actor). A refused action is recognised by the runtime's outcome header,
// or by the control not being offered at all.
import { readFileSync, existsSync } from "node:fs";
import { chromium, type Page } from "../lang/browser/node_modules/playwright/index.mjs";

const argv = process.argv.slice(2);
const [file] = argv;
const base = (argv[argv.indexOf("--base") + 1] ?? "").replace(/\/$/, "");
if (!file || !base) { console.error("usage: node h2f/accept.ts <acceptance.json> --base <url> [--json]"); process.exit(64); }
const task = JSON.parse(readFileSync(file, "utf8"));
const seed = task.seed ?? {};

// ---- the seed, through Campfire's actions
const rows: any[] = [{ entity: "Account", fields: { name: "Campfire" } }];
for (const u of seed.users ?? []) rows.push({ entity: "User", fields: { name: u.name, email: u.email, password: `accept-${u.key}-pass`, role: u.role ?? "member" }, save: u.key });
const steps: any[] = [];
for (const r of seed.rooms ?? []) {
  const members = [...new Set([r.creator, ...(r.members ?? [])])].map((k: string) => `$${k}`);
  if (r.type === "direct") steps.push({ as: r.creator, call: "create_direct_room", args: { users: members }, entity: "Room", save: r.key });
  else if (r.type === "closed") steps.push({ as: r.creator, call: "create_closed_room", args: { name: r.name, users: members }, entity: "Room", save: r.key });
  else steps.push({ as: r.creator, call: "create_open_room", args: { name: r.name }, entity: "Room", save: r.key });
}
for (const m of seed.messages ?? []) steps.push({ as: m.author, call: "post_message", args: { room: `$${m.room}`, body: m.body }, entity: "Message", save: m.key });
for (const b of seed.boosts ?? []) steps.push({ as: b.author, call: "boost", args: { message: `$${b.message}`, content: b.content } });
const loaded = await fetch(`${base}/_test/fixture`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rows, steps }) });
const fx: any = await loaded.json();
if (!loaded.ok) { console.log(JSON.stringify({ task: task.id, seeded: false, error: fx.error })); process.exit(1); }
const keys: Record<string, { ref: string; id: number }> = fx.keys;
const bodyOf = new Map<string, string>((seed.messages ?? []).map((m: any) => [m.key, m.body]));

// ---- checks
const exe = ["chromium-1243", "chromium-1217"].map((d) => `${process.env.LOCALAPPDATA}/ms-playwright/${d}/chrome-win64/chrome.exe`).find(existsSync);
const browser = await chromium.launch(exe ? { executablePath: exe } : {});
type Outcome = { check: number; as: string; passed: boolean; failedStep?: number; reason?: string };
const outcomes: Outcome[] = [];
for (const [ci, check] of (task.checks ?? []).entries()) {
  const who = keys[check.as];
  const ctx = await browser.newContext({ timezoneId: "UTC", extraHTTPHeaders: who ? { "X-Test-Actor": `${who.ref}:${who.id}` } : {} });
  const page: Page = await ctx.newPage();
  let lastOutcome: string | null = null, lastMissing = false;
  page.on("dialog", (d) => d.accept());   // "Are you sure?": a person clicking Delete means it
  page.on("response", (r) => { const o = r.headers()["x-crudspec-outcome"]; if (process.env.ACCEPT_DEBUG && r.request().method() === "POST") console.log("POST", r.url(), r.status(), o, r.request().postData()?.slice(0, 200)); if (o && r.request().method() === "POST") lastOutcome = o; });
  const scope = (inKey?: string) => (inKey ? page.locator(".message, [id^='message_']", { hasText: bodyOf.get(inKey) ?? `@@${inKey}` }).first() : page.locator("body"));
  // within a message, a boost's own controls (remove my boost) don't count unless the step says "boost": true
  const control = (where: any, label: string, inMessage: boolean, boost: boolean) => {
    const all = where.getByRole("button", { name: label }).or(where.getByRole("link", { name: label })).or(where.getByText(label, { exact: true }));
    return (inMessage && !boost ? all.filter({ hasNot: where.page().locator("xx-never") }).and(where.locator(":scope :not([class*='boost'] *):not([class*='boost'])")) : all).first();
  };
  const res: Outcome = { check: ci + 1, as: check.as, passed: true };
  try {
    for (const [si, st] of check.steps.entries()) {
      const fail = (reason: string) => { res.passed = false; res.failedStep = si + 1; res.reason = reason; };
      if (st.visit) {
        const id = keys[st.of]?.id;
        const path = { room: `/rooms/${id}`, home: "/", profile: "/users/me/profile", account: "/account/edit", user: `/users/${id}` }[st.visit as string];
        if (!path) { fail(`unknown page ${st.visit}`); break; }
        const r = await page.goto(base + path); lastOutcome = r && r.status() >= 400 ? "denied" : null; lastMissing = false;
        continue;
      }
      if (st.click || st.submit) {
        const target = control(scope(st.in), st.click ?? st.submit, !!st.in, !!st.boost);
        if (!(await target.count())) { lastMissing = true; if (check.steps[si + 1]?.denied) continue; fail(`no "${st.click ?? st.submit}" to click`); break; }
        lastOutcome = null; lastMissing = false;
        // a control inside a closed menu: open the menu first, as a person would
        await target.evaluate((el: Element) => { for (let d = el.closest("details"); d; d = d.parentElement?.closest("details") ?? null) (d as HTMLDetailsElement).open = true; });
        await target.click(); await page.waitForLoadState(); await page.waitForTimeout(100);
        continue;
      }
      if (st.fill) {
        const f = page.getByLabel(st.fill).or(page.getByPlaceholder(st.fill)).first();
        if (!(await f.count())) { lastMissing = true; if (check.steps.slice(si + 1).find((x: any) => !x.fill && !x.select)?.denied) continue; fail(`no field "${st.fill}"`); break; }
        await f.fill(st.with); continue;
      }
      if (st.select) {
        const f = page.getByLabel(st.select).first();
        if (!(await f.count())) { lastMissing = true; fail(`no choice "${st.select}"`); break; }
        await f.selectOption({ label: st.option }); continue;
      }
      if (st.see !== undefined || st.not_see !== undefined) {
        const text = st.see ?? st.not_see;
        const n = await scope(st.in).getByText(text, { exact: false }).count();
        if (st.see !== undefined && !n) { fail(`"${text}" not shown${st.in ? ` in ${st.in}` : ""}`); break; }
        if (st.not_see !== undefined && n) { fail(`"${text}" shown${st.in ? ` in ${st.in}` : ""}`); break; }
        continue;
      }
      if (st.denied) {
        const refused = lastMissing || (lastOutcome !== null && lastOutcome !== "ok");
        if (!refused) { fail("the action wasn't refused"); break; }
        continue;
      }
      fail(`unknown step ${JSON.stringify(st)}`); break;
    }
  } catch (e) { res.passed = false; res.reason = `error: ${(e as Error).message.split("\n")[0]}`; }
  outcomes.push(res);
  await ctx.close();
}
await browser.close();
const passed = outcomes.every((o) => o.passed);
if (argv.includes("--json")) console.log(JSON.stringify({ task: task.id, seeded: true, passed, outcomes }, null, 2));
else { for (const o of outcomes) console.log(`${o.passed ? "ok  " : "FAIL"} check ${o.check} as ${o.as}${o.passed ? "" : ` at step ${o.failedStep}: ${o.reason}`}`); console.log(passed ? "all checks pass" : "some checks fail"); }
process.exit(passed ? 0 : 2);
