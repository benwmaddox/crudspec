// <MarkdownEditor visual> (lang/gogen/rt/visual.js): Markdown into the visual editor and back.
// Text nobody changed comes back byte for byte; an edit changes only its own block; what it can't
// edit in place stays locked, as written; then the switch in a built app: the script loads only
// when switched to, and what's sent is the Markdown. Needs Playwright's Chromium.
//   node lang/test/visual-editor.test.ts
process.removeAllListeners("warning");
import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { startApp } from "./go-app.ts";

let failed = 0;
const ok = (what: string, pass: boolean, detail?: unknown) => { console.log(`${pass ? "ok  " : "FAIL"} ${what}`); if (!pass) { failed++; if (detail !== undefined) console.log("     ", JSON.stringify(detail)); } };

const js = readFileSync(new URL("../gogen/rt/visual.js", import.meta.url), "utf8");
const browser = await chromium.launch();
try {
  // ---- the module on its own, the preview answered by the test
  const page = await browser.newPage();
  await page.route("http://visual.test/**", async (route) => {
    const u = new URL(route.request().url());
    if (u.pathname === "/visual.js") return route.fulfill({ contentType: "text/javascript", body: js });
    if (u.pathname === "/_markdown") {
      const { text } = JSON.parse(route.request().postData()!);
      const m = /\n\n(cs-visual-block-\w+)\n\n/.exec(text);
      const parts = m ? text.split("\n\n" + m[1] + "\n\n") : [text];
      return route.fulfill({ contentType: "text/html", body: parts.map((p: string) => "<div class=shown>" + p.replace(/</g, "&lt;") + "</div>").join(m ? "<p>" + m[1] + "</p>" : "") });
    }
    return route.fulfill({ contentType: "text/html", body: "<!doctype html><div class=editor data-mode=visual><div class=editor-panes><textarea></textarea></div></div>" });
  });
  await page.goto("http://visual.test/");
  await page.evaluate(async () => {
    const m = await import("/visual.js");
    const ta = document.querySelector("textarea")!, wrap = document.querySelector(".editor"), panes = document.querySelector(".editor-panes");
    (window as any).V = m.mount({ ta, wrap, panes, changed: () => {}, links: "/p/", known: [], images: [] });
  });
  const V = (fn: string, arg?: unknown) => page.evaluate(new Function("arg", "return (async (V) => {" + fn + "})(window.V)") as any, arg);

  const texts: Record<string, string> = {
    "headings, paragraphs and lists": "# Title\n\nSome **bold**, *italic*, __strong__, _em_ and ~~struck~~ text.\nA second line.\n\n## Part\n- one\n- two [[Page]]\n\n1. first\n2. second\n",
    "links, code and escapes": "See [[Sword|the sword]] and [a site](https://example.com/a_b).\nUse `x * y` or ``a`b``, and \\*not emphasis\\*, snake_case_name, 3 * 4.\n",
    "includes and files as written": "Costs {{Cost|coins=25|3}} each.\n[[File:Tower.png|thumb|200px]]\n\n> A quote with [[Link]].\n> Two lines.",
    "the locked kinds": "| A | B |\n|---|---|\n| 1 | 2 |\n\n::: tabs\n== One\nFirst.\n\n== Two\nSecond.\n:::\n\n```js\nlet a = 1;\n\nlet b = 2;\n```\n\n<div>html</div>\n\n- a\n  - nested\n\nTitle\n---\n\n***\n",
    "blank lines kept as they were": "\n\nOne\n\n\n\nTwo\n   \nThree",
    "nothing": "",
  };
  for (const [what, text] of Object.entries(texts)) {
    const back = await V("await V.load(arg); return V.text();", text);
    ok(`unchanged, byte for byte: ${what}`, back === text, { back, text });
  }

  const kinds = await V("await V.load(arg); return [...V.surface.children].map((k) => k.classList.contains('editor-locked') ? 'locked' : k.tagName);", texts["the locked kinds"]);
  ok("a table, tabs, code, HTML, a nested list, a setext heading and a rule stay locked", JSON.stringify(kinds) === JSON.stringify(["locked", "locked", "locked", "locked", "locked", "locked", "locked"]), kinds);
  const shown = await V("await V.load(arg); await new Promise((r) => setTimeout(r, 100)); return V.surface.querySelector('.editor-locked .shown')?.textContent;", "| A | B |\n|---|---|\n| 1 | 2 |");
  ok("a locked block shows as the page would (the preview's HTML)", shown === "| A | B |\n|---|---|\n| 1 | 2 |", shown);
  const editable = await V("await V.load(arg); return [...V.surface.children].map((k) => k.tagName);", texts["headings, paragraphs and lists"]);
  ok("headings, paragraphs and lists are edited in place", JSON.stringify(editable) === JSON.stringify(["H1", "P", "H2", "UL", "OL"]), editable);

  const edited = await V("await V.load(arg); const p = V.surface.children[1]; p.lastChild.data += ' More.'; return V.text();", "Intro\n\nA paragraph.\n\n\n| A |\n|---|\n| 1 |\n");
  ok("an edit changes its own block only", edited === "Intro\n\nA paragraph. More.\n\n\n| A |\n|---|\n| 1 |\n", edited);
  const bold = await V(`await V.load(arg); const t = V.surface.querySelector('p').firstChild; const r = document.createRange(); r.setStart(t, 4); r.setEnd(t, 9);
    getSelection().removeAllRanges(); getSelection().addRange(r); V.command('bold'); return V.text();`, "The words here");
  ok("Bold on a selection writes **…**", bold === "The **words** here", bold);
  const typed = await V("await V.load(arg); const p = V.surface.querySelector('p'); p.firstChild.data = 'Price *5* [[x]] # <b>'; return V.text();", "x");
  ok("typed characters that mean something in Markdown are escaped", typed === "Price \\*5\\* \\[\\[x]] # \\<b>", typed);
  const linked = await V(`await V.load(arg); const t = V.surface.querySelector('p').firstChild; const r = document.createRange(); r.setStart(t, 4); r.setEnd(t, 9);
    getSelection().removeAllRanges(); getSelection().addRange(r); window.prompt = () => 'Sword'; V.command('page'); return V.text();`, "The blade is sharp");
  ok("a page link on a selection writes [[Page|shown]]", linked === "The [[Sword|blade]] is sharp", linked);
  const pasted = await V(`await V.load(arg); const p = V.surface.querySelector('p'); const r = document.createRange(); r.selectNodeContents(p); r.collapse(false);
    getSelection().removeAllRanges(); getSelection().addRange(r); const d = new DataTransfer(); d.setData('text/html', '<b>bold</b><script>x()</script>'); d.setData('text/plain', ' plain');
    p.dispatchEvent(new ClipboardEvent('paste', { clipboardData: d, bubbles: true, cancelable: true })); return V.text();`, "Start");
  ok("a paste brings its plain text, never its markup", pasted === "Start plain", pasted);
  const removed = await V("await V.load(arg); V.surface.querySelector('.editor-locked button[title=\"Remove this part\"]').click(); return V.text();", "Keep\n\n```\ncode\n```\n\nAlso keep\n");
  ok("removing a locked part leaves the rest as it was", removed === "Keep\n\nAlso keep\n", removed);
  await page.close();

  // ---- in a built app: the switch, the script loaded only then, and the Markdown sent
  const dir = mkdtempSync(join(tmpdir(), "visual-editor-"));
  writeFileSync(join(dir, "app.crud"), `app t { name "T" }
entity Doc { title: Text  body: Text }
policy doc_rows: true for rows of Doc
policy doc_writes: true else forbidden for writes to Doc
// changes a doc's text
action edit(d: Doc, body: Text) { set d.body = body }
layout l { <main><Slot name=main /></main> }
screen read(d: Doc) { route "/d/:d"  layout l  require public
  <Fill name=main><Markdown links="/d/">{d.body}</Markdown></Fill>
}
screen write(d: Doc) { route "/d/:d/edit"  layout l  require public
  <Fill name=main>
    <Form action={edit(d)}>
      <MarkdownEditor links="/d/" visual />
      <Field name=body kind=textarea value={d.body} />
      <Submit label="Save" />
      <On ok go={read(d)} />
    </Form>
  </Fill>
}
`);
  const app = await startApp(join(dir, "app.crud"), 14071);
  try {
    await app.post("/_test/load", { clock: 1000, rows: { Doc: [{ id: 1, seq: 1, created: 1, updated: 1, fields: { title: "One", body: "# Hello\n\nFirst words.\n\n| a |\n|---|\n| 1 |\n" } }] } });
    const ctx = await browser.newContext();
    const p = await ctx.newPage();
    const loaded: string[] = [];
    p.on("request", (r) => { if (/\/_visual\.\w+\.js$/.test(r.url())) loaded.push(r.url()); });
    await p.goto(app.base + "/d/1");
    ok("a page that only reads doesn't name the visual editor", !(await p.content()).includes("_visual."));
    await p.goto(app.base + "/d/1/edit");
    await p.waitForSelector(".editor-mode");
    ok("the editor opens as Markdown, the script not loaded", (await p.getAttribute(".editor", "data-mode")) === "markdown" && loaded.length === 0, loaded);
    await p.click(".editor-mode button:has-text('Visual')");
    await p.waitForSelector(".editor-visual h1");
    ok("Visual loads the script, once", loaded.length === 1, loaded);
    await p.click(".editor-visual p");
    await p.keyboard.press("End");
    await p.keyboard.type(" And more.");
    await p.click("button:has-text('Save')");
    await p.waitForURL(/\/d\/1$/);
    const html = await p.innerHTML("main");
    ok("what's saved is the Markdown, changed only where typed", html.includes("First words. And more.") && html.includes("<table>"), html);
    await p.goto(app.base + "/d/1/edit");
    await p.waitForSelector(".editor-visual h1");
    ok("the choice is remembered", (await p.getAttribute(".editor", "data-mode")) === "visual");
    await p.click(".editor-mode button:has-text('Markdown')");
    const md = await p.inputValue("textarea");
    ok("back to Markdown: the text field holds it", md === "# Hello\n\nFirst words. And more.\n\n| a |\n|---|\n| 1 |\n", md);
    await ctx.close();
  } finally { app.stop(); }
} finally { await browser.close(); }

console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
