// Every screen of an app, rendered with fixture data and written as a text structure an
// agent can read (headings, links and where they go, forms and the action they call, fields,
// lists), optionally with screenshots for people. Compared with an accepted baseline, so a
// UI change shows up as a reviewable text diff.
//
// The runtime must run in --test mode. The fixture is loaded through /_test/fixture.
//   node lang/browser/screens.ts <spec> --base <url> --fixture <file> --out <dir>
//        [--baseline <dir>] [--accept] [--shots]
// Exit codes: 0 no change (or accepted), 2 screens changed, 1 a fixture or screen failed.
//
// Fixture file: { clock?, rows: [...], steps: [...], viewer: "<key>",
//                 screens: { <screen>: { as?: "<key>" | null, args?: { <param>: "$<key>" } } } }
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";
import { parse } from "../parser.ts";
import { readSpec } from "../source.ts";
import { withGenerated } from "../scaffold.ts";

const argv = process.argv.slice(2);
const opt = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const [specPath] = argv;
const base = (opt("--base") ?? "").replace(/\/$/, ""), out = opt("--out"), fixturePath = opt("--fixture"), baseline = opt("--baseline");
if (!specPath || !base || !out || !fixturePath) { console.error("usage: node lang/browser/screens.ts <spec> --base <url> --fixture <file> --out <dir> [--baseline <dir>] [--accept] [--shots]"); process.exit(64); }

const spec = parse(readSpec(specPath));
withGenerated(spec, parse);   // as the runtime does
const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
const loaded = await fetch(`${base}/_test/fixture`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(fixture) });
const fx: any = await loaded.json();
if (!loaded.ok) { console.error(`fixture failed: ${fx.error}`); process.exit(1); }
const keys: Record<string, { ref: string; id: number }> = fx.keys;

// The structure of a rendered page, from the DOM: what an agent needs to check a UI change.
function structure(): string {
  const out: string[] = [];
  const txt = (s: string) => (s ?? "").replace(/\s+/g, " ").trim();
  // inside a closed <details>, content is listed under it (an agent should know the menu holds it)
  const shown = (el: Element) => { if (el.closest("details:not([open]) > :not(summary)")) return !(el as HTMLElement).hidden; const s = getComputedStyle(el); return s.display !== "none" && s.visibility !== "hidden" && !(el as HTMLElement).hidden; };
  // the accessible name, roughly: aria-label, the text (rendered or not, e.g. in a closed menu), an image's alt, title
  const name = (el: Element) => txt(el.getAttribute("aria-label") || (el as HTMLElement).innerText || el.textContent || [...el.querySelectorAll("img[alt]")].map((i) => i.getAttribute("alt")).join(" ") || el.getAttribute("title") || "");
  const sig = (el: Element) => `${el.tagName}.${el.className}`;
  const LANDMARK: Record<string, string> = { NAV: "nav", MAIN: "main", HEADER: "header", FOOTER: "footer", ASIDE: "aside", DIALOG: "dialog", DETAILS: "details" };
  function walk(node: Element, depth: number) {
    const kids = [...node.children].filter((e) => !["SCRIPT", "STYLE", "TEMPLATE", "LINK", "META"].includes(e.tagName) && shown(e));
    // a run of 4+ siblings that look alike is a list: show 3, count the rest (never inside a form: every field matters)
    const inForm = !!node.closest("form");
    for (let i = 0; i < kids.length; i++) {
      let j = i; while (!inForm && j + 1 < kids.length && sig(kids[j + 1]) === sig(kids[i])) j++;
      const run = j - i + 1;
      const shownCount = run >= 4 ? 3 : run;
      for (let k = i; k < i + shownCount; k++) one(kids[k], depth);
      if (run >= 4) out.push(`${"  ".repeat(depth)}… ${run - 3} more like this`);
      i = j;
    }
  }
  function one(el: Element, depth: number) {
    const tag = el.tagName, ind = "  ".repeat(depth);
    if (/^H[1-6]$/.test(tag)) { out.push(`${ind}heading "${txt((el as HTMLElement).innerText)}"`); return; }
    if (tag === "A" && el.getAttribute("href")) { out.push(`${ind}link "${name(el)}" -> ${el.getAttribute("href")}`); return; }
    if (tag === "FORM") { out.push(`${ind}form -> ${el.getAttribute("action") ?? ""}`); walk(el, depth + 1); return; }
    if (tag === "BUTTON") { out.push(`${ind}button "${name(el)}"${el.getAttribute("type") === "submit" || !el.getAttribute("type") ? "" : ` (${el.getAttribute("type")})`}`); return; }
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
      const f = el as HTMLInputElement;
      if (f.type === "hidden") return;
      const opts = tag === "SELECT" ? ` [${[...(el as HTMLSelectElement).options].map((o) => txt(o.text)).slice(0, 6).join(", ")}${(el as HTMLSelectElement).options.length > 6 ? ", …" : ""}]` : "";
      const lbl = el.getAttribute("aria-label") || f.placeholder || "";
      out.push(`${ind}${tag === "SELECT" ? "select" : f.type === "checkbox" ? "checkbox" : `field:${tag === "TEXTAREA" ? "textarea" : f.type}`} ${f.name}${f.required ? " required" : ""}${f.readOnly ? " read-only" : ""}${lbl ? ` "${lbl}"` : ""}${opts}`);
      return;
    }
    if (tag === "IMG") { const a = el.getAttribute("alt"); if (a) out.push(`${ind}image "${a}"`); return; }
    const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => txt(n.textContent ?? "")).filter(Boolean).join(" ");
    const mark = tag === "DETAILS" ? `details${(el as HTMLDetailsElement).open ? " (open)" : " (closed: what follows is hidden until opened)"}` : LANDMARK[tag];
    if (mark) out.push(`${ind}${mark}`);
    if (own) out.push(`${ind}${mark ? "  " : ""}text "${own.slice(0, 140)}"`);
    walk(el, depth + (mark ? 1 : 0));
  }
  walk(document.body, 0);
  return out.join("\n");
}

const screens = spec.decls.filter((d) => d.kind === "screen");
const viewer = fixture.viewer ? keys[fixture.viewer] : undefined;
const exe = ["chromium-1243", "chromium-1217"].map((d) => `${process.env.LOCALAPPDATA}/ms-playwright/${d}/chrome-win64/chrome.exe`).find(existsSync);
const browser = await chromium.launch(exe ? { executablePath: exe } : {});
mkdirSync(out, { recursive: true });
let failed = 0;
const written: string[] = [];
for (const d of screens) {
  const o = fixture.screens?.[d.name] ?? {};
  const actor = "as" in o ? (o.as ? keys[o.as] : null) : d.public ? null : viewer;
  let route: string = d.route, ok = true; const q = new URLSearchParams();
  for (const p of d.params ?? []) {
    let v: any = o.args?.[p.name];
    if (typeof v === "string" && v.startsWith("$")) v = keys[v.slice(1)]?.id;
    if (v === undefined && !p.type.optional) v = Object.values(keys).find((k) => k.ref === p.type.name)?.id;   // the first fixture row of that kind
    if (v === undefined) { if (p.type.optional) continue; console.log(`skip ${d.name}: no fixture row for ${p.name}: ${p.type.name}`); ok = false; break; }
    if (route.includes(`:${p.name}`)) route = route.replace(`:${p.name}`, encodeURIComponent(String(v))); else q.set(p.name, String(v));
  }
  if (!ok) continue;
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 }, timezoneId: "UTC", locale: "en-US", extraHTTPHeaders: actor ? { "X-Test-Actor": `${actor.ref}:${actor.id}` } : {} });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const url = route + (q.toString() ? `?${q}` : "");
  const res = await page.goto(base + url, { waitUntil: "load" });
  await page.waitForTimeout(150);
  const landed = new URL(page.url()).pathname + new URL(page.url()).search;
  const head = `screen ${d.name} ${url} as ${actor ? `${actor.ref} ${actor.id}` : "anonymous"}${landed !== url ? `\nredirected to ${landed}` : ""}${res && res.status() >= 400 ? `\nstatus ${res.status()}` : ""}${errors.length ? `\nscript errors: ${errors.join("; ")}` : ""}`;
  const body = `${head}\n\n${await page.evaluate(structure)}\n`;
  writeFileSync(join(out, `${d.name}.txt`), body);
  written.push(`${d.name}.txt`);
  if (argv.includes("--shots")) await page.screenshot({ path: join(out, `${d.name}.png`), fullPage: true });
  if (errors.length || (res && res.status() >= 500)) failed++;
  await ctx.close();
}
await browser.close();

// compare with the accepted baseline
let changed = 0;
if (baseline) {
  mkdirSync(baseline, { recursive: true });
  const before = new Set(readdirSync(baseline).filter((f) => f.endsWith(".txt")));
  for (const f of written) {
    const now = readFileSync(join(out, f), "utf8"), was = before.has(f) ? readFileSync(join(baseline, f), "utf8") : null;
    if (was === now) continue;
    changed++;
    if (was === null) console.log(`NEW ${f}`);
    else {
      const a = was.split("\n"), b = now.split("\n");
      const removed = a.filter((l) => !b.includes(l)), added = b.filter((l) => !a.includes(l));
      console.log(`CHANGED ${f}`);
      for (const l of removed.slice(0, 15)) console.log(`  - ${l}`);
      for (const l of added.slice(0, 15)) console.log(`  + ${l}`);
    }
    if (argv.includes("--accept")) copyFileSync(join(out, f), join(baseline, f));
  }
  for (const f of before) if (!written.includes(f)) { changed++; console.log(`GONE ${f}`); }
}
console.log(`${written.length} screens -> ${out}${baseline ? `; ${changed} differ from the baseline${argv.includes("--accept") && changed ? " (accepted)" : ""}` : ""}${failed ? `; ${failed} with errors` : ""}`);
process.exit(failed ? 1 : changed && !argv.includes("--accept") ? 2 : 0);
