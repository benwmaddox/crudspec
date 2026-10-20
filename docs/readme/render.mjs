// Renders docs/readme/example.crud as a picture for the README (and for sharing): the code
// coloured by what each part is in crudspec, in VS Code's default dark theme (Dark+), at twice
// the size for sharp text.
//   node docs/readme/render.mjs        (writes example.png beside it)
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { chromium } from "playwright";

const dir = new URL(".", import.meta.url);
const src = readFileSync(new URL("example.crud", dir), "utf8").replace(/\s+$/, "");
// what each part is, as the editor extension reads it
const { tokens } = createRequire(import.meta.url)("../../editors/vscode/highlight.js");
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
function highlight(s) {
  let out = "", at = 0;
  for (const t of tokens(s)) { out += esc(s.slice(at, t.start)) + `<span class="${t.kind}">${esc(s.slice(t.start, t.end))}</span>`; at = t.end; }
  return out + esc(s.slice(at));
}

// VS Code's Dark+ colours, by the TextMate scope each part would have in TypeScript and JSX
const DARK_PLUS = {
  bg: "#1e1e1e", txt: "#d4d4d4",
  kw: "#569cd6",     // storage and declaration keywords (const, class)
  ctl: "#c586c0",    // control flow (if, for, in)
  type: "#4ec9b0",   // types and classes
  fn: "#dcdcaa",     // functions
  name: "#9cdcfe",   // variables and parameters
  field: "#9cdcfe",  // properties
  str: "#ce9178", num: "#b5cea8", com: "#6a9955",
  tag: "#4ec9b0",    // a component's tag, as JSX colours <MyComponent>
  html: "#569cd6",   // an HTML tag
  attr: "#9cdcfe",   // an attribute
  p: "#808080",      // a tag's < > / and =
  br: "#d4d4d4",     // braces, as plain text
};
const t = DARK_PLUS;
const css = `body{margin:0;background:${t.bg}} pre{margin:0;display:inline-block;background:${t.bg};padding:24px 28px;
  font:15px/1.6 Consolas,"Courier New",monospace;color:${t.txt}}
  ${Object.entries(t).filter(([k]) => k !== "bg").map(([k, v]) => `.${k}{color:${v}}`).join("")}`;
const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 2 });
await page.setContent(`<style>${css}</style><pre>${highlight(src)}</pre>`);
await page.locator("pre").screenshot({ path: new URL("example.png", dir).pathname.replace(/^\/([A-Z]:)/, "$1") });
await browser.close();
console.log("wrote example.png");
