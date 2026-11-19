// Behaviors (lang/behaviors.ts) in a compiled app, in Chromium: each action and trigger, a
// ref's targets, text from people put in as text (never as HTML or script), addresses kept safe,
// a value read only by a behavior still loaded (column pruning), and behaviors on elements a
// live update puts on the page (another person's page adds a note).
//   node lang/browser/behaviors.test.ts        (builds and runs the app: needs Go, lang/test/go-app.ts)
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { startApp } from "../test/go-app.ts";

let failed = 0;
const ok = (what: string, pass: boolean, detail?: unknown) => { console.log(`${pass ? "ok  " : "FAIL"} ${what}`); if (!pass) { failed++; if (detail !== undefined) console.log("     ", JSON.stringify(detail)); } };

const SPEC = `app t { name "T" actor User }
entity User { name: Text  token: Text? }
identity login: User.token from cookie "login"
entity Note { title: Text  body: Text  link: Text = "/" }
policy note_rows: true for rows of Note
policy user_rows: true for rows of User
action add(title: Text, body: Text) { callers people  create Note { title: title, body: body } }
action rename(n: Note, title: Text) { callers people  set n.title = title }
layout l { <main id="main-content"><Slot name=main /></main> }
screen home(editing: Note?) {
  route "/"
  layout l
  require public
  <Fill name=main>
    <div id="composer" cs:ref=composer><textarea name="draft"></textarea></div>
    <Form action={add} class="add-form">
      <Field name=title kind=text label="Title" />
      <Field name=body kind=text label="Body" />
      <Submit label="Add" />
      <On ok stay />
    </Form>
    <List of={Note where true order by created} as=n>
      <div class="note" cs:ref=note style="min-height: 120px">
        <span class="title">{n.title}</span>
        <button type="button" class="reply" cs:click={[prepend(composer, "> " + n.body + "\\n\\n"), focus(composer)]}>Reply</button>
        <button type="button" class="sound" cs:click={play("bell.mp3")}>Play</button>
        <button type="button" class="out" cs:click={go(n.link)}>Out</button>
        <label tabindex="0" class="open" cs:dblclick={go(url_of(home(n)))} cs:key_enter={go(url_of(home(n)))}>{n.title}</label>
        {if editing == n {
          <Form action={rename(n)} auto_submit class="edit-form">
            <Field name=title kind=text class="edit" value={n.title} cs:ref=edit cs:shown={focus(edit)} cs:key_escape={go(url_of(home(none)))} cs:blur_unchanged={go(url_of(home(none)))} />
            <On ok go={home(none)} />
          </Form>
        }}
      </div>
    </List>
    <button type="button" class="jump" hidden cs:hidden_while_in_view={last(note)} cs:click={scroll_to(last(note))}>Newest</button>
  </Fill>
}
`;
const dir = mkdtempSync(join(tmpdir(), "behaviors-"));
writeFileSync(join(dir, "app.crud"), SPEC);
const app = await startApp(join(dir, "app.crud"), 13981);
const exe = ["chromium-1243", "chromium-1217"].map((d) => `${process.env.LOCALAPPDATA}/ms-playwright/${d}/chrome-win64/chrome.exe`).find(existsSync);
const browser = await chromium.launch(exe ? { executablePath: exe } : {});
const row = (id: number, fields: any) => ({ id, seq: id, created: id * 1000, updated: id * 1000, fields });
const notes = (n: number, extra: any[] = []) => [...Array.from({ length: n }, (_, i) => row(i + 1, { title: `Note ${i + 1}`, body: `Body ${i + 1}`, link: "/" })), ...extra];
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
  // a sound played is recorded, not heard
  await page.addInitScript(() => { (window as any).__played = []; (window as any).Audio = function (src: string) { return { play() { (window as any).__played.push(src); return Promise.resolve(); } }; }; });
  const hostile = `"><img src=x onerror="window.__x=1"></script><b>`;
  await app.post("/_test/load", { clock: 1_000_000, rows: { Note: notes(2, [row(3, { title: "Evil", body: hostile, link: "javascript:window.__y=1" })]) } });
  await page.goto(app.base + "/");

  // prepend and focus: the reply quotes a body the page shows nowhere else (pruning keeps it)
  await page.locator(".note").nth(0).locator(".reply").click();
  let st = await page.evaluate(() => { const t = document.querySelector("#composer textarea") as HTMLTextAreaElement; return { v: t.value, focused: document.activeElement === t, caret: t.selectionStart, len: t.value.length }; });
  ok("prepend puts the quote in the field inside the ref'd element", st.v === "> Body 1\n\n", st);
  ok("focus moves to that field, the caret at the end", st.focused && st.caret === st.len, st);
  await page.locator(".note").nth(1).locator(".reply").click();
  st = await page.evaluate(() => { const t = document.querySelector("#composer textarea") as HTMLTextAreaElement; return { v: t.value }; });
  ok("a second prepend goes before the first", st.v === "> Body 2\n\n> Body 1\n\n", st);

  // text from people is text: the hostile body goes into the field as written, runs nothing
  await page.locator(".note").nth(2).locator(".reply").click();
  st = await page.evaluate(() => ({ v: (document.querySelector("#composer textarea") as HTMLTextAreaElement).value, x: (window as any).__x, imgs: document.querySelectorAll("img").length }));
  ok("a body with markup and script goes in as text, running nothing", st.v.startsWith(`> ${hostile}\n\n`) && st.x === undefined && st.imgs === 0, st);
  // a javascript: address from data: not followed (the server keeps it to safe schemes too)
  const before = page.url();
  await page.locator(".note").nth(2).locator(".out").click();
  await page.waitForTimeout(300);
  st = await page.evaluate(() => ({ y: (window as any).__y, attr: document.querySelectorAll(".note")[2].querySelector(".out")!.getAttribute("data-do-click") }));
  ok("a javascript: address isn't followed, and isn't in the page", (st as any).y === undefined && !/javascript/i.test((st as any).attr ?? "") && page.url().startsWith(before.split("#")[0]), st);

  // play
  await page.locator(".note").nth(0).locator(".sound").click();
  const played = await page.evaluate(() => (window as any).__played);
  ok("play plays the asset", played.length === 1 && /\/assets\/bell\.mp3/.test(played[0]), played);

  // dblclick goes; shown focuses the field as it appears; Escape goes back
  await page.locator(".note").nth(0).locator(".open").dblclick();
  await page.waitForURL(/editing=/);
  await page.waitForFunction(() => document.activeElement?.matches(".edit input") ?? false, null, { timeout: 3000 }).catch(() => {});
  st = await page.evaluate(() => ({ focused: document.activeElement?.matches(".edit input") ?? false, ref: document.querySelector(".edit input")?.getAttribute("data-ref") }));
  ok("dblclick goes to the address", page.url().includes("editing="));
  ok("shown focuses the field as the page loads (ref on a <Field> lands on its input)", (st as any).focused && (st as any).ref === "edit", st);
  await page.keyboard.press("Escape");
  await page.waitForURL((u) => !u.search.includes("editing="));
  ok("key_escape goes to the address", !page.url().includes("editing="));

  // key_enter on a focusable label
  await page.locator(".note").nth(1).locator(".open").focus();
  await page.keyboard.press("Enter");
  await page.waitForURL(/editing=/);
  ok("key_enter goes to the address", page.url().includes("editing="));
  // blur unchanged: back; changed: the form saves it (auto_submit) and stays saved
  await page.waitForFunction(() => document.activeElement?.matches(".edit input") ?? false, null, { timeout: 3000 }).catch(() => {});
  await page.locator(".edit input").blur();
  await page.waitForURL((u) => !u.search.includes("editing="));
  ok("blur_unchanged goes when the value is as drawn", !page.url().includes("editing="));
  await page.locator(".note").nth(1).locator(".open").dblclick();
  await page.waitForURL(/editing=/);
  await page.waitForFunction(() => document.activeElement?.matches(".edit input") ?? false, null, { timeout: 3000 }).catch(() => {});
  await page.locator(".edit input").fill("Renamed");
  await page.locator(".edit input").blur();
  await page.waitForURL((u) => !u.search.includes("editing="), { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(300);
  const title2 = (await app.post("/_test/dump", {})).rows.Note.find((r: any) => r.id === 2)?.fields.title;
  ok("a changed value isn't blur_unchanged: the form saves it", title2 === "Renamed", title2);

  // hidden_while_in_view and scroll_to, then a live update adds a note: its behaviors work and
  // the binding follows the new last note
  await app.post("/_test/load", { clock: 2_000_000, rows: { Note: notes(12) } });
  await page.goto(app.base + "/");
  // the jump button's hidden, once it is so (an observer's answer comes a frame or two later)
  const jumpHidden = async (want: boolean) => { await page.waitForFunction((w) => (document.querySelector(".jump") as HTMLElement)?.hidden === w, want, { timeout: 5000 }).catch(() => {}); return page.locator(".jump").evaluate((b: HTMLElement) => b.hidden); };
  let hidden = await jumpHidden(false);
  ok("hidden_while_in_view: shown while the last note is out of view", hidden === false, hidden);
  await page.locator(".jump").click();
  hidden = await jumpHidden(true);
  ok("scroll_to brings the last note into view, and the button hides", hidden === true, hidden);
  // someone else adds a note, in a page of their own
  const other = await browser.newPage();
  await other.goto(app.base + "/");
  await other.locator(".add-form input[name=title]").fill("Fresh");
  await other.locator(".add-form input[name=body]").fill("Fresh body");
  await other.locator(".add-form button[type=submit]").click();
  await other.waitForLoadState("networkidle");
  await page.waitForFunction(() => [...document.querySelectorAll(".note .title")].some((t) => t.textContent === "Fresh"), null, { timeout: 8000 }).catch(() => {});
  const fresh = await page.evaluate(() => [...document.querySelectorAll(".note .title")].some((t) => t.textContent === "Fresh"));
  ok("a live update puts the new note on the page", fresh);
  await page.evaluate(() => window.scrollTo(0, 0));
  await jumpHidden(false);
  await page.locator(".jump").click();
  await jumpHidden(true);
  st = await page.evaluate(() => { const ns = document.querySelectorAll(".note"); const r = ns[ns.length - 1].getBoundingClientRect(); return { last: ns[ns.length - 1].querySelector(".title")!.textContent, inView: r.top < innerHeight && r.bottom > 0, hidden: (document.querySelector(".jump") as HTMLElement).hidden }; });
  ok("after the update, scroll_to and the binding follow the new last note", (st as any).last === "Fresh" && (st as any).inView && (st as any).hidden, st);
  await page.locator(".note").last().locator(".reply").click();
  st = await page.evaluate(() => ({ v: (document.querySelector("#composer textarea") as HTMLTextAreaElement).value }));
  ok("the new note's reply works (events are handled on the document)", (st as any).v.startsWith("> Fresh body"), st);
} finally { await browser.close(); app.stop(); }
process.exitCode = failed ? 1 : 0;
