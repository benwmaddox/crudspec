// <MarkdownEditor visual>: a visual way to write the same Markdown. The page's script loads this
// module only when someone switches an editor to Visual, so reading pages never pays for it.
//
// The text field stays the source of truth: what's posted, kept on a refused save and read by
// moderation is the Markdown. The text is split into its top-level blocks, each keeping its own
// source. A block this editor can show and write back exactly (a paragraph, heading, list or
// quote with bold, italic, struck, code and links in it) is edited in place; any other (a table,
// tabs, a collapsed section, code, HTML, a nested list) shows as the page would, locked, and opens
// as Markdown (a table in the table grid) to change. A block nobody changed goes back out as it
// came in, byte for byte, so a visual edit's diff is only what was edited.

const isBlank = (l) => l.trim() === "";
const atx = /^ {0,3}#{1,6}(\s|$)/;
const fenceOpen = /^ {0,3}(`{3,}|~{3,})/;
const boxOpen = /^:::\s*\S/;
const boxClose = /^:::\s*$/;
const kindOf = (l) => /^ {0,3}>/.test(l) ? "quote" : /^ {0,3}([-*+]|\d{1,9}[.)])(\s|$)/.test(l) ? "list" : /^\s*\|/.test(l) ? "table" : "para";

// The text's top-level blocks, each with its source and the text between it and the one before
// (gap), and what comes before the first (lead) and after the last (tail), so that
// lead + blocks[0].src + blocks[1].gap + blocks[1].src + … + tail is the text again.
export function split(text) {
  const lines = text.split("\n"), n = lines.length, ranges = [];
  let i = 0;
  while (i < n) {
    if (isBlank(lines[i])) { i++; continue; }
    const s = i;
    const f = fenceOpen.exec(lines[i]);
    if (f) {
      const close = new RegExp("^ {0,3}" + (f[1][0] === "~" ? "~" : "\\x60") + "{" + f[1].length + ",}\\s*$");
      i++;
      while (i < n && !close.test(lines[i])) i++;
      i = Math.min(i + 1, n);
    } else if (boxOpen.test(lines[i])) {
      let depth = 1;
      i++;
      while (i < n && depth) { if (boxOpen.test(lines[i])) depth++; else if (boxClose.test(lines[i])) depth--; i++; }
    } else if (atx.test(lines[i])) {
      i++;
    } else {
      // a run of lines up to a blank line or a block that starts on its own; a list's indented
      // lines stay with it, and a change of kind (a paragraph, then a list) starts a new block
      const k = kindOf(lines[i]);
      i++;
      while (i < n && !isBlank(lines[i]) && !atx.test(lines[i]) && !fenceOpen.test(lines[i]) && !boxOpen.test(lines[i])) {
        const kk = /^\s{2,}\S/.test(lines[i]) && k === "list" ? "list" : kindOf(lines[i]);
        if (kk !== k && !(k === "para" && kk === "para")) break;
        i++;
      }
    }
    ranges.push([s, i]);
  }
  if (!ranges.length) return { lead: text, blocks: [], tail: "" };
  const blocks = ranges.map(([s, e], k) => {
    const pe = k ? ranges[k - 1][1] : 0;
    return { src: lines.slice(s, e).join("\n"), gap: k ? "\n" + (s > pe ? lines.slice(pe, s).join("\n") + "\n" : "") : "" };
  });
  const s0 = ranges[0][0], last = ranges[ranges.length - 1][1];
  return { lead: s0 ? lines.slice(0, s0).join("\n") + "\n" : "", blocks, tail: last < n ? "\n" + lines.slice(last).join("\n") : "" };
}

// ---- Markdown → the editor's elements, for the blocks it can edit

const h = (tag, cls) => { const x = document.createElement(tag); if (cls) x.className = cls; return x; };
const atomOf = (src) => {
  const a = h("span", "editor-atom");
  a.contentEditable = "false"; a.dataset.src = src;
  const file = /^\[\[(?:File|Image):([^|\]]*)/i.exec(src);
  a.textContent = file ? "🖼 " + file[1].trim() : src;
  a.title = file ? "An image: switch to Markdown to change it" : "Kept as written: switch to Markdown to change it";
  return a;
};
const punct = /[!-/:-@[-`{-~]/;
const space = (c) => c === undefined || /\s/.test(c);
const alnum = (c) => c !== undefined && /[\p{L}\p{N}]/u.test(c);

// A line's inline Markdown, appended to `into`; false when it has something this editor doesn't
// edit (HTML, an entity), and the block stays locked.
function inline(s, into) {
  let text = "";
  const flush = () => { if (text) { into.appendChild(document.createTextNode(text)); text = ""; } };
  const put = (node) => { flush(); into.appendChild(node); };
  for (let i = 0; i < s.length;) {
    const c = s[i], rest = s.slice(i);
    if (c === "\\" && punct.test(s[i + 1] || "")) { text += s[i + 1]; i += 2; continue; }
    if (c === "<" && /^<[A-Za-z/!?]/.test(rest)) return false;
    if (c === "&" && /^&#?\w+;/.test(rest)) return false;
    if (c === "\x60") {
      const run = /^\x60+/.exec(rest)[0], end = s.indexOf(run, i + run.length);
      if (end < 0) { text += run; i += run.length; continue; }
      let body = s.slice(i + run.length, end);
      const padded = body.length > 1 && body[0] === " " && body[body.length - 1] === " ";
      if (padded) body = body.slice(1, -1);
      const code = h("code"); code.textContent = body; code.dataset.run = run; if (padded) code.dataset.pad = "1";
      put(code); i = end + run.length; continue;
    }
    if (rest.startsWith("{{")) {
      let depth = 0, j = i;
      for (; j < s.length - 1; j++) { if (s.startsWith("{{", j)) { depth++; j++; } else if (s.startsWith("}}", j)) { depth--; j++; if (!depth) break; } }
      if (depth) return false;
      put(atomOf(s.slice(i, j + 1))); i = j + 1; continue;
    }
    if (rest.startsWith("[[")) {
      const end = s.indexOf("]]", i + 2);
      if (end < 0) return false;
      const body = s.slice(i + 2, end);
      if (/^(File|Image):/i.test(body) || body.includes("[") || body.includes("{")) { put(atomOf(s.slice(i, end + 2))); i = end + 2; continue; }
      const bar = body.indexOf("|"), a = h("a", "editor-wl");
      a.dataset.page = bar < 0 ? body : body.slice(0, bar);
      a.textContent = bar < 0 ? body : body.slice(bar + 1);
      if (bar >= 0) a.dataset.shown = "1";
      put(a); i = end + 2; continue;
    }
    if (rest.startsWith("![")) {
      const m = /^!\[[^\]\n]*\]\([^)\s]*\)/.exec(rest);
      if (!m) return false;
      put(atomOf(m[0])); i += m[0].length; continue;
    }
    if (c === "[") {
      const m = /^\[((?:\\.|[^\]\\])*)\]\(([^)\s]*)\)/.exec(rest);
      if (m) {
        const a = h("a"); a.dataset.href = m[2];   // no href: nothing in the text is a live link while editing
        if (inline(m[1], a) === false) return false;
        put(a); i += m[0].length; continue;
      }
    }
    // **strong**, *em*, __strong__, _em_, ~~struck~~: the closing run after a non-space
    const run = /^(\*\*|__|\*|_|~~)/.exec(rest);
    if (run && !space(s[i + run[0].length]) && !(run[0][0] === "_" && alnum(s[i - 1]))) {
      const d = run[0];
      let end = -1;
      for (let j = i + d.length + 1; j <= s.length - d.length; j++) {
        if (s[j - 1] === "\\") continue;
        if (s.startsWith(d, j) && !space(s[j - 1]) && !(d.length === 1 && s[j + 1] === d) && !(d.length === 1 && s[j - 1] === d) && !(d[0] === "_" && alnum(s[j + d.length]))) { end = j; break; }
      }
      if (end > 0) {
        const e = h(d === "~~" ? "del" : d.length === 2 ? "strong" : "em");
        e.dataset.d = d;
        if (inline(s.slice(i + d.length, end), e) === false) return false;
        put(e); i = end + d.length; continue;
      }
    }
    text += c; i++;
  }
  flush();
  return true;
}

// lines of inline Markdown: a line break in a paragraph is a space on the page, so it shows as
// one here too, kept as the "\n" it is (a <br>, Shift+Enter, is written as a line break as well)
function lines(ls, into) {
  for (let k = 0; k < ls.length; k++) {
    if (k) into.appendChild(document.createTextNode("\n"));
    if (inline(ls[k], into) === false) return false;
  }
  return true;
}

// a block's element, or null when it isn't one this editor edits
function element(src) {
  const ls = src.split("\n");
  const head = /^(#{1,6}) (.*)$/.exec(src);
  if (head && ls.length === 1) { const e = h("h" + head[1].length); return inline(head[2], e) ? e : null; }
  const k = kindOf(ls[0]);
  if (k === "list") {
    const items = ls.map((l) => /^([-*+]|(\d{1,9})([.)])) (.*)$/.exec(l));
    if (items.some((m) => !m)) return null;
    const ordered = !!items[0][2], e = h(ordered ? "ol" : "ul");
    if (ordered) { e.dataset.start = items[0][2]; e.dataset.d = items[0][3]; if (items[0][2] !== "1") e.setAttribute("start", items[0][2]); }
    else e.dataset.m = items[0][1];
    for (const m of items) { const li = h("li"); if (!inline(m[4], li)) return null; e.appendChild(li); }
    return e;
  }
  if (k === "quote") {
    if (!ls.every((l) => /^> /.test(l))) return null;
    const q = h("blockquote"), p = h("p");
    q.appendChild(p);
    return lines(ls.map((l) => l.slice(2)), p) ? q : null;
  }
  if (k === "para") {
    if (ls.some((l) => /^\s|\s$/.test(l) || /^(==|:::)/.test(l) || /^([-*_=])(\s*\1){2,}$/.test(l))) return null;
    const p = h("p");
    return lines(ls, p) ? p : null;
  }
  return null;
}

// ---- the editor's elements → Markdown

const blockTags = new Set(["P", "DIV", "H1", "H2", "H3", "H4", "H5", "H6", "UL", "OL", "BLOCKQUOTE", "PRE", "TABLE", "HR"]);

function escapeText(t, before, after) {
  let out = "";
  for (let i = 0; i < t.length; i++) {
    const c = t[i], p = i ? t[i - 1] : before, n = i + 1 < t.length ? t[i + 1] : after;
    if (c === "\\" && punct.test(n || "")) out += "\\\\";
    else if (c === "\x60") out += "\\\x60";
    else if (c === "*" && !(space(p) && space(n))) out += "\\*";
    else if (c === "_" && !(alnum(p) && alnum(n)) && !(space(p) && space(n))) out += "\\_";
    else if ((c === "~" && n === "~") || (c === "{" && n === "{") || (c === "!" && n === "[")) out += "\\" + c;
    else if (c === "[" && (n === "[" || p === "[" || /^[^\]]*\]\(/.test(t.slice(i + 1)))) out += "\\[";
    else if (c === "<" && /[A-Za-z/!?]/.test(n || "")) out += "\\<";
    else if (c === "&" && /^&#?\w+;/.test(t.slice(i))) out += "\\&";
    else out += c;
  }
  return out;
}

// emphasis can't open or close on a space: spaces at its edges move outside it
const wrapMd = (d, inner) => {
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(inner);
  return m[2] ? m[1] + d + m[2] + d + m[3] : inner;
};

function inl(node) {
  let out = "";
  const kids = [...node.childNodes];
  kids.forEach((k, i) => {
    if (k.nodeType === 3) {
      const t = k.data.replace(/ /g, " ").replace(/​/g, "");
      const prev = kids[i - 1], next = kids[i + 1];
      out += escapeText(t, prev ? "x" : undefined, next ? "x" : undefined);
      return;
    }
    if (k.nodeType !== 1) return;
    const tag = k.tagName;
    if (k.classList.contains("editor-atom")) out += k.dataset.src;
    else if (tag === "BR") out += "\n";
    else if (tag === "STRONG" || tag === "B") out += wrapMd(k.dataset.d || "**", inl(k));
    else if (tag === "EM" || tag === "I") out += wrapMd(k.dataset.d || "*", inl(k));
    else if (tag === "DEL" || tag === "S" || tag === "STRIKE") out += wrapMd("~~", inl(k));
    else if (tag === "CODE") {
      const t = k.textContent;
      let run = k.dataset.run || "\x60";
      while (t.includes(run) && !k.dataset.run) run += "\x60";
      const pad = k.dataset.pad || t.startsWith("\x60") || t.endsWith("\x60") ? " " : "";
      if (t) out += run + pad + t + pad + run;
    } else if (tag === "A" && k.classList.contains("editor-wl")) {
      const page = k.dataset.page, shown = k.textContent;
      out += shown === page && !k.dataset.shown ? "[[" + page + "]]" : "[[" + page + "|" + shown + "]]";
    } else if (tag === "A") out += "[" + inl(k) + "](" + (k.dataset.href ?? "") + ")";
    else if (blockTags.has(tag) || tag === "LI") { const b = inl(k); out += (out && !out.endsWith("\n") ? "\n" : "") + b; }
    else out += inl(k);
  });
  return out;
}

// a line's start mustn't read as a block of its own
const lineStart = (l) => l.replace(/^(\s*)(#{1,6}(?=\s|$)|>|\||[-+*](?=\s|$)|:::|==)/, "$1\\$2").replace(/^(\s*\d{1,9})([.)])(?=\s|$)/, "$1\\$2");
const linesMd = (s) => s.split("\n").map((l) => lineStart(l.replace(/\s+$/, ""))).join("\n");

function blockMd(e) {
  const tag = e.tagName;
  if (/^H[1-6]$/.test(tag)) { const t = inl(e).replace(/\n/g, " ").trim(); return t ? "#".repeat(+tag[1]) + " " + t.replace(/^#/, "\\#") : ""; }
  if (tag === "UL" || tag === "OL") {
    let n = +(e.dataset.start || e.getAttribute("start") || 1);
    const items = [...e.children].filter((li) => li.tagName === "LI").map((li) => inl(li).replace(/\n+/g, " ").trim());
    return items.map((t) => (tag === "OL" ? n++ + (e.dataset.d || ".") : e.dataset.m || "-") + " " + lineStart(t)).join("\n");
  }
  if (tag === "BLOCKQUOTE") {
    const parts = [...e.childNodes].some((k) => k.nodeType === 1 && blockTags.has(k.tagName)) ? [...e.children].map(inl) : [inl(e)];
    return parts.map((p) => linesMd(p.trim())).filter(Boolean).join("\n\n").split("\n").map((l) => (l ? "> " + l : ">")).join("\n");
  }
  if (tag === "TABLE" || tag === "HR") return "";
  return linesMd(inl(e).replace(/^\n+|\n+$/g, ""));
}

// ---- the editor

export function mount(ctx) {
  const { ta, wrap, panes, changed, links, known, images } = ctx;
  try { document.execCommand("defaultParagraphSeparator", false, "p"); } catch { /* older browsers: divs, read as paragraphs */ }
  const surface = h("div", "editor-visual");
  surface.contentEditable = "true";
  surface.setAttribute("role", "textbox"); surface.setAttribute("aria-multiline", "true"); surface.setAttribute("aria-label", "Text, as it will look");
  surface.spellcheck = true;
  panes.appendChild(surface);
  let doc = { lead: "", blocks: [], tail: "" }, last = null, timer = 0;

  const preview = async (texts) => {
    // the locked blocks' HTML, from one request: each block between markers
    const mark = "cs-visual-block-" + Math.random().toString(36).slice(2);
    try {
      const res = await fetch("/_markdown", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: texts.join("\n\n" + mark + "\n\n"), links, known, images }) });
      if (!res.ok) return null;
      const parts = (await res.text()).split(new RegExp("<p>" + mark + "</p>"));
      return parts.length === texts.length ? parts : null;
    } catch { return null; }
  };
  const showLocked = (box, html) => {
    const body = box.querySelector(".editor-locked-body");
    if (html == null) { body.innerHTML = ""; const pre = h("pre"); pre.textContent = box.dataset.src; body.appendChild(pre); }
    else body.innerHTML = html;
  };
  const spacer = () => { const p = h("p"); p.appendChild(h("br")); return p; };
  const isTable = (src) => src.split("\n").every((l) => /^\s*\|/.test(l));
  const locked = (src, i) => {
    const box = h("div", "editor-locked");
    box.contentEditable = "false"; box.dataset.src = src;
    if (i !== undefined) box.dataset.i = String(i);
    const tools = h("div", "editor-locked-tools"), body = h("div", "editor-locked-body");
    const btn = (label, title, run) => { const b = h("button"); b.type = "button"; b.textContent = label; b.title = title; b.addEventListener("click", run); tools.appendChild(b); };
    if (isTable(src) && ctx.tableEditor) btn("▦ Edit table", "Edit the table in a grid", () => ctx.tableEditor(box.dataset.src.split("\n"), (md) => replaceLocked(box, md)));
    btn("Edit as Markdown", "Change this part as Markdown", () => editLocked(box));
    btn("✕", "Remove this part", () => { box.remove(); sync(); });
    box.append(tools, body);
    return box;
  };
  const replaceLocked = async (box, md) => {
    box.dataset.src = md; delete box.dataset.i;
    const [html] = (await preview([md])) || [null];
    showLocked(box, html); sync();
  };
  const editLocked = (box) => {
    const body = box.querySelector(".editor-locked-body"), area = h("textarea", "input");
    area.value = box.dataset.src; area.rows = Math.min(20, box.dataset.src.split("\n").length + 2);
    area.setAttribute("aria-label", "This part, as Markdown");
    const done = h("button", "primary"), cancel = h("button");
    done.type = cancel.type = "button"; done.textContent = "Done"; cancel.textContent = "Cancel";
    const old = body.innerHTML;
    body.innerHTML = ""; body.append(area, done, cancel); area.focus();
    done.addEventListener("click", () => replaceLocked(box, area.value));
    cancel.addEventListener("click", () => { body.innerHTML = old; });
  };

  // the text into blocks: the ones it can edit as elements, the others locked
  const load = async (text) => {
    doc = split(text);
    surface.innerHTML = "";
    const lockedBoxes = [];
    doc.blocks.forEach((b, i) => {
      const e = element(b.src);
      if (e && blockMd(e) === b.src) { e.dataset.i = String(i); surface.appendChild(e); }
      else { const box = locked(b.src, i); lockedBoxes.push(box); surface.appendChild(box); }
    });
    // somewhere to type after a locked part that ends the text or is followed by another: an
    // empty paragraph, which writes nothing
    for (const box of lockedBoxes) if (!box.nextSibling || box.nextSibling.classList.contains("editor-locked")) box.after(spacer());
    if (!surface.firstChild) surface.appendChild(spacer());
    last = text;
    if (lockedBoxes.length) {
      const html = await preview(lockedBoxes.map((b) => b.dataset.src));
      lockedBoxes.forEach((b, k) => showLocked(b, html ? html[k] : null));
    }
  };

  // the elements back to the text: a block as it came unless it was changed
  const text = () => {
    const out = [];
    let pending = null;
    const nodes = [...surface.childNodes];
    const emit = (md, i) => { if (md.trim()) out.push({ md, i }); };
    for (const k of nodes) {
      const inlineNode = k.nodeType === 3 || (k.nodeType === 1 && !blockTags.has(k.tagName) && !k.classList.contains("editor-locked"));
      if (inlineNode) { (pending ||= h("p")).appendChild(k.cloneNode(true)); continue; }
      if (pending) { emit(blockMd(pending), undefined); pending = null; }
      if (k.nodeType !== 1) continue;
      const i = k.dataset.i !== undefined ? +k.dataset.i : undefined;
      emit(k.classList.contains("editor-locked") ? k.dataset.src : blockMd(k), i);
    }
    if (pending) emit(blockMd(pending), undefined);
    // the same block twice (a paragraph split in two): the first that's unchanged keeps it
    const used = new Set();
    for (const o of out) { o.orig = o.i !== undefined && !used.has(o.i) && o.md === doc.blocks[o.i].src; if (o.orig) used.add(o.i); }
    // between two blocks that were next to each other, what was between them; else a blank line
    let s = "";
    out.forEach((o, k) => {
      const p = out[k - 1];
      s += !k ? (o.i === 0 ? doc.lead : "") : (o.i !== undefined && p.i !== undefined && o.i === p.i + 1 ? doc.blocks[o.i].gap : "\n\n");
      s += o.md;
    });
    const end = out[out.length - 1];
    if (end) s += end.orig && end.i === doc.blocks.length - 1 ? doc.tail : doc.tail.includes("\n") ? "\n" : "";
    return s;
  };
  const sync = () => {
    clearTimeout(timer);
    const t = text();
    if (t === ta.value) return;
    last = t; ta.value = t; changed();
  };
  surface.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(sync, 200); });
  // the field's <label> holds the editor: a click in the text mustn't go on to the label's first
  // button; links in it don't navigate while editing
  surface.addEventListener("click", (e) => { if (!e.target.closest("button, summary")) e.preventDefault(); });
  // pasting brings plain text: pasted markup never reaches the page
  surface.addEventListener("paste", (e) => {
    e.preventDefault();
    const t = (e.clipboardData || window.clipboardData).getData("text/plain");
    document.execCommand("insertText", false, t);
  });
  surface.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === "b" || e.key === "i")) { e.preventDefault(); document.execCommand(e.key === "b" ? "bold" : "italic"); }
  });
  // changed as text (a refused save put back, a table grid's Done): shown again
  ta.addEventListener("input", () => { if (ta.value !== last && wrap.dataset.mode === "visual") load(ta.value); });

  // the block the caret is in, as a child of the surface
  const here = () => {
    const sel = getSelection();
    let n = sel && sel.rangeCount ? sel.getRangeAt(0).startContainer : null;
    if (!n || !surface.contains(n)) return null;
    while (n.parentNode !== surface) n = n.parentNode;
    return n;
  };
  const insertBlock = async (md) => {
    const at = here(), box = locked(md);
    if (at) at.after(box); else surface.appendChild(box);
    const [html] = (await preview([md])) || [null];
    showLocked(box, html); sync();
    return box;
  };
  const insertHTML = (node) => {
    surface.focus();
    const sel = getSelection();
    if (!sel.rangeCount || !surface.contains(sel.anchorNode)) { const p = h("p"); p.appendChild(node); surface.appendChild(p); sync(); return; }
    const r = sel.getRangeAt(0);
    r.deleteContents(); r.insertNode(node); r.setStartAfter(node); r.collapse(true);
    sel.removeAllRanges(); sel.addRange(r); sync();
  };
  const block = (tag) => {
    surface.focus();
    const at = here();
    document.execCommand("formatBlock", false, at && at.tagName === tag.toUpperCase() ? "p" : tag);
    sync();
  };
  const command = (name, arg) => {
    const sel = getSelection(), picked = sel && sel.rangeCount && surface.contains(sel.anchorNode) ? sel.toString() : "";
    switch (name) {
      case "bold": surface.focus(); document.execCommand("bold"); break;
      case "italic": surface.focus(); document.execCommand("italic"); break;
      case "h2": block("h2"); break;
      case "h3": block("h3"); break;
      case "list": surface.focus(); document.execCommand("insertUnorderedList"); break;
      case "quote": block("blockquote"); break;
      case "code": { const c = h("code"); c.textContent = picked || "code"; insertHTML(c); break; }
      case "page": {
        const page = prompt("Link to which page?", picked);
        if (!page) return;
        const a = h("a", "editor-wl"); a.dataset.page = page; a.textContent = picked || page; if (picked && picked !== page) a.dataset.shown = "1";
        insertHTML(a); break;
      }
      case "link": {
        const url = prompt("Link to which address?", "https://");
        if (!url || url === "https://") return;
        const a = h("a"); a.dataset.href = url; a.textContent = picked || url;
        insertHTML(a); break;
      }
      case "table":
        if (ctx.tableEditor) ctx.tableEditor(null, (md) => insertBlock(md));
        else insertBlock("| Name | Value |\n| ---- | ----- |\n|      |       |");
        return;
      case "block": insertBlock(arg).then(editLocked); return;
      case "atom": insertHTML(atomOf(arg)); break;
    }
    sync();
  };

  return {
    surface,
    show() { if (ta.value !== last) load(ta.value); setTimeout(() => surface.focus()); },
    flush: sync,
    command,
    load,
    text,
  };
}
