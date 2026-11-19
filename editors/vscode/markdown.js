// Markdown preview: a ```crudspec (or ```crud) fence is colored by highlight.js, the same reader
// the editor's semantic tokens use, so a doc's examples look as they do in a .crud file.
// markdown.css gives each kind its color, for light and dark themes.
"use strict";
const { tokens } = require("./highlight");

const LANGS = new Set(["crudspec", "crud"]);
const esc = (t) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// the source as HTML: each token a span with its kind's class, the rest as written
function render(src) {
  let html = "", at = 0;
  for (const t of tokens(src)) {
    if (t.start < at) continue;
    html += esc(src.slice(at, t.start)) + `<span class="cs-${t.kind}">${esc(src.slice(t.start, t.end))}</span>`;
    at = t.end;
  }
  return html + esc(src.slice(at));
}

function extendMarkdownIt(md) {
  const fence = md.renderer.rules.fence;
  md.renderer.rules.fence = (toks, idx, options, env, self) => {
    const t = toks[idx], lang = (t.info || "").trim().split(/\s+/)[0].toLowerCase();
    if (!LANGS.has(lang)) return fence(toks, idx, options, env, self);
    const attrs = t.map ? ` data-line="${t.map[0]}"` : "";   // keeps the preview's scroll sync
    return `<pre class="crudspec"${attrs}><code class="language-crudspec">${render(t.content)}</code></pre>\n`;
  };
  return md;
}

module.exports = { extendMarkdownIt, render };
