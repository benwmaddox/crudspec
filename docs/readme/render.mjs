// Renders docs/readme/example.crud as a picture for the README (and for sharing): the code
// coloured by what each part is in crudspec, in VS Code's default dark theme (Dark+), at twice
// the size for sharp text.
//   node docs/readme/render.mjs        (writes example.png beside it)
import { readFileSync } from "node:fs";
import { chromium } from "playwright";

const dir = new URL(".", import.meta.url);
const src = readFileSync(new URL("example.crud", dir), "utf8").replace(/\s+$/, "");

const KEYWORDS = new Set(["app", "entity", "enum", "data", "permission", "read", "action", "view", "screen", "component", "layout", "route", "access",
  "create", "set", "delete", "require", "else", "if", "for", "each", "in", "let", "match", "rows", "where", "order", "by", "desc", "and", "or", "not",
  "result", "emit", "trigger", "on", "max", "min", "agents", "people", "no", "true", "false", "none"]);
// the control flow, coloured apart as VS Code colours if and for
const CONTROL = new Set(["if", "else", "for", "each", "in", "match", "require", "result", "emit"]);
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const span = (cls, s) => `<span class="${cls}">${esc(s)}</span>`;

// a small reader of the spec as it is written: code, markup tags, the text between tags, and
// the {…} inside text, which is code again
function highlight(s) {
  let out = "", i = 0;
  const modes = ["code"];   // code | text (between tags)
  const depth = [];         // brace depth at which each {…} in text began
  let braces = 0;
  const mode = () => modes[modes.length - 1];
  while (i < s.length) {
    const rest = s.slice(i);
    let m;
    if (mode() === "text") {
      if (rest[0] === "<") { modes.pop(); continue; }                       // a tag: read as code
      if (rest[0] === "{") { out += span("br", "{"); braces++; depth.push(braces); modes.push("code"); i++; continue; }
      if (rest[0] === "}") { modes.pop(); continue; }
      m = /^[^<{}]+/.exec(rest); out += span("txt", m[0]); i += m[0].length; continue;
    }
    if ((m = /^\/\/[^\n]*/.exec(rest))) { out += span("com", m[0]); i += m[0].length; continue; }
    if ((m = /^"(?:[^"\\]|\\.)*"/.exec(rest))) { out += span("str", m[0]); i += m[0].length; continue; }
    if ((m = /^<\/?([A-Za-z][\w-]*)/.exec(rest))) {
      // a tag and its attributes, up to its ">"
      out += span("p", m[0].startsWith("</") ? "</" : "<") + span(/^[A-Z]/.test(m[1]) ? "tag" : "html", m[1]); i += m[0].length;
      const closing = m[0].startsWith("</");
      for (;;) {
        const r = s.slice(i);
        let a;
        if ((a = /^\s+/.exec(r))) { out += a[0]; i += a[0].length; continue; }
        if ((a = /^\/?>/.exec(r))) { out += span("p", a[0]); i += a[0].length; if (a[0] === ">" && !closing) modes.push("text"); break; }
        if ((a = /^=[A-Za-z_]\w*/.exec(r))) { out += span("p", "=") + span("name", a[0].slice(1)); i += a[0].length; continue; }   // a bare name as the value
        if ((a = /^[\w-]+/.exec(r))) { out += span("attr", a[0]); i += a[0].length; continue; }
        if ((a = /^=/.exec(r))) { out += span("p", "="); i++; continue; }
        if ((a = /^"(?:[^"\\]|\\.)*"/.exec(r))) { out += span("str", a[0]); i += a[0].length; continue; }
        if (r[0] === "{") {   // a value: code up to its matching }
          let d = 0, j = 0;
          for (; j < r.length; j++) { if (r[j] === "{") d++; else if (r[j] === "}" && --d === 0) break; }
          out += span("br", "{") + highlightCode(r.slice(1, j)) + span("br", "}"); i += j + 1; continue;
        }
        out += esc(r[0]); i++;
      }
      if (closing) { /* back to the content around it */ }
      continue;
    }
    if (rest[0] === "{") { braces++; out += span("br", "{"); i++; continue; }
    if (rest[0] === "}") {
      if (depth.length && depth[depth.length - 1] === braces) { depth.pop(); braces--; modes.pop(); out += span("br", "}"); i++; continue; }
      braces--; out += span("br", "}"); i++; continue;
    }
    out += highlightCode(rest.match(/^[^"<{}\/]+|^./)[0]); i += rest.match(/^[^"<{}\/]+|^./)[0].length;
  }
  return out;
}
// code without tags or braces: keywords, types, numbers, names
function highlightCode(s) {
  return s.replace(/("(?:[^"\\]|\\.)*")|(\/\/[^\n]*)|\b(\d+)\b|(\.?)\b([A-Za-z_]\w*)\b(?=(\s*\()?)|([^\w".]+|\.)/g, (all, str, com, num, dotted, word, call, other) => {
    if (str) return span("str", str);
    if (com) return span("com", com);
    if (num) return span("num", num);
    if (word) {
      if (dotted) return esc(".") + span("field", word);
      if (call !== undefined && !KEYWORDS.has(word)) return span("fn", word);   // a call, or a declared function
      if (CONTROL.has(word)) return span("ctl", word);
      if (KEYWORDS.has(word)) return span("kw", word);
      if (/^[A-Z]/.test(word)) return span("type", word);
      return span("name", word);
    }
    return esc(other ?? all);
  });
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
