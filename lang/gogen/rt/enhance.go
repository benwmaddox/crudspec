package rt

import (
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"strings"
)

// Built-in enhancements a page's script gives the elements that ask for them, so an app needs no
// script of its own for them:
//   - <Markdown sortable>: its tables sort by a column when its heading is clicked;
//   - <ThemeToggle default=dark>: a button between the app's two themes (html[data-theme]),
//     remembered in the browser;
//   - <MarkdownEditor links known images>: the next Markdown text field in its form gets
//     formatting buttons, an image picker and a live preview (POST /_markdown); with visual,
//     a switch to edit it as it will look (visual.js, loaded only when switched to).

// ThemeToggle is the button; def is the theme the app's stylesheet shows with no data-theme.
func ThemeToggle(class, def string) string {
	if def != "light" {
		def = "dark"
	}
	return `<button type="button" class="` + Esc(class) + `" data-theme-toggle="` + def + `">` + map[string]string{"dark": "☀ Light", "light": "☾ Dark"}[def] + `</button>`
}

func linesOf(v Val) string {
	switch x := v.(type) {
	case nil:
		return ""
	case List:
		parts := make([]string, 0, len(x))
		for _, e := range x {
			parts = append(parts, Plain(e))
		}
		return strings.Join(parts, "\n")
	}
	return Plain(v)
}

// MarkdownEditorTag marks where the editor goes; the page's script builds it around the next
// Markdown field (a textarea) in the same form. Each lookup is signed (SignLookup), "" for none:
//   - known: asked by the preview for each name the text links to, to mark the ones no page has;
//   - images: asked as someone types in the image picker, giving "address|caption" lines;
//   - files: asked by the preview for a [[File:Name]]'s address; with it, the picker inserts an
//     image by its name, for a <Markdown files={…}>.
// With visual, a switch to the visual editor (visual.js), loaded from VisualScriptPath only when
// someone switches to it.
func MarkdownEditorTag(links Val, known, images, files string, visual bool) string {
	f := ""
	if visual {
		f = ` data-visual="` + VisualScriptPath + `"`
	}
	return `<cs-markdown-editor data-links="` + Esc(Plain(links)) + `" data-known-lookup="` + Esc(known) + `" data-images-lookup="` + Esc(images) + `" data-files-lookup="` + Esc(files) + `"` + f + `></cs-markdown-editor>`
}

//go:embed visual.js
var visualScript string

// VisualScriptPath is where visual.js is served, its content's hash in the name, cached for good.
var VisualScriptPath = func() string {
	h := sha256.Sum256([]byte(visualScript))
	return "/_visual." + hex.EncodeToString(h[:6]) + ".js"
}()

const enhanceScript = `
(() => {
  // ---- <Markdown sortable>: click a heading to sort its table
  document.addEventListener("click", (e) => {
    const th = e.target.closest && e.target.closest("[data-sortable] table th");
    if (!th) return;
    const table = th.closest("table"), body = table.tBodies[0];
    if (!body) return;
    const col = [...th.parentNode.children].indexOf(th);
    const dir = th.dataset.sort === "asc" ? "desc" : "asc";
    table.querySelectorAll("th").forEach((h) => (h.dataset.sort = "none"));
    th.dataset.sort = dir;
    const key = (tr) => (tr.children[col]?.textContent || "").trim();
    const num = (s) => { const n = parseFloat(s.replace(/[^0-9.+-]/g, "")); return /\d/.test(s) && !isNaN(n) ? n : null; };
    [...body.rows].sort((a, b) => {
      const x = key(a), y = key(b), nx = num(x), ny = num(y);
      const c = nx !== null && ny !== null ? nx - ny : x.localeCompare(y, undefined, { numeric: true, sensitivity: "base" });
      return dir === "asc" ? c : -c;
    }).forEach((r) => body.appendChild(r));
  });
  const markSortable = () => document.querySelectorAll("[data-sortable] table th:not([data-sort])").forEach((th) => (th.dataset.sort = "none"));

  // ---- <ThemeToggle>: the app's other theme, remembered
  const THEME = "crudspec-theme";
  const stored = () => { try { return localStorage.getItem(THEME); } catch { return null; } };
  const apply = () => {
    const b = document.querySelector("[data-theme-toggle]"), def = b ? b.dataset.themeToggle : "dark", t = stored();
    if (t && t !== def) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
    document.querySelectorAll("[data-theme-toggle]").forEach((x) => {
      const now = document.documentElement.dataset.theme || x.dataset.themeToggle;
      x.textContent = now === "dark" ? "☀ Light" : "☾ Dark";
      x.setAttribute("aria-label", now === "dark" ? "Switch to the light theme" : "Switch to the dark theme");
    });
  };
  document.addEventListener("click", (e) => {
    const b = e.target.closest && e.target.closest("[data-theme-toggle]");
    if (!b) return;
    const now = document.documentElement.dataset.theme || b.dataset.themeToggle;
    try { localStorage.setItem(THEME, now === "dark" ? "light" : "dark"); } catch { /* this page only */ }
    if (stored() === null) document.documentElement.dataset.theme = now === "dark" ? "light" : "dark";
    apply();
  });

  // ---- <MarkdownEditor>: buttons, images and a preview for the next Markdown field
  const editor = (tag) => {
    if (tag.dataset.ready) return;
    const form = tag.closest("form");
    let ta = null;
    for (const t of (form || document).querySelectorAll("textarea")) if (tag.compareDocumentPosition(t) & Node.DOCUMENT_POSITION_FOLLOWING) { ta = t; break; }
    if (!ta) return;
    tag.dataset.ready = "1";
    const links = tag.dataset.links || "", knownLookup = tag.dataset.knownLookup || "";
    const imagesLookup = tag.dataset.imagesLookup || "", filesLookup = tag.dataset.filesLookup || "";
    const el = (name, cls) => { const x = document.createElement(name); if (cls) x.className = cls; return x; };
    const wrap = el("div", "editor"), bar = el("div", "editor-bar"), panes = el("div", "editor-panes"), preview = el("div", "editor-preview");
    bar.setAttribute("role", "toolbar"); bar.setAttribute("aria-label", "Formatting"); preview.setAttribute("aria-live", "polite");
    ta.parentNode.insertBefore(wrap, ta); wrap.append(bar, panes); panes.append(ta, preview);
    // a <label> around the field and the editor: tied to the field, so a click elsewhere in it
    // (the preview, the label's text) doesn't press the toolbar's first button
    const label = ta.closest("label");
    if (label && !label.htmlFor) { if (!ta.id) ta.id = "cs-editor-" + Math.random().toString(36).slice(2); label.htmlFor = ta.id; }
    const changed = () => ta.dispatchEvent(new Event("input", { bubbles: true }));
    const wrapSel = (before, after = before, ph = "text") => {
      const s = ta.selectionStart, e = ta.selectionEnd, v = ta.value, inner = v.slice(s, e) || ph;
      ta.value = v.slice(0, s) + before + inner + after + v.slice(e); ta.focus(); ta.setSelectionRange(s + before.length, s + before.length + inner.length); changed();
    };
    const linePrefix = (p) => { const s = ta.selectionStart, v = ta.value, st = v.lastIndexOf("\n", s - 1) + 1; ta.value = v.slice(0, st) + p + v.slice(st); ta.focus(); ta.setSelectionRange(s + p.length, s + p.length); changed(); };
    const insert = (text) => { const s = ta.selectionStart, v = ta.value, lead = s > 0 && v[s - 1] !== "\n" ? "\n" : ""; ta.value = v.slice(0, s) + lead + text + v.slice(ta.selectionEnd); const at = s + lead.length + text.length; ta.focus(); ta.setSelectionRange(at, at); changed(); };
    // the visual editor (visual.js), once someone switches to it: the buttons act on it then
    let vis = null;
    const visual = () => vis && wrap.dataset.mode === "visual";
    const button = (label, title, run, cmd, arg) => { const b = el("button"); b.type = "button"; b.innerHTML = label; b.title = title; b.setAttribute("aria-label", title); b.addEventListener("click", () => (visual() && cmd ? vis.command(cmd, arg) : run())); bar.appendChild(b); return b; };
    button("<b>B</b>", "Bold", () => wrapSel("**"), "bold");
    button("<i>I</i>", "Italic", () => wrapSel("*"), "italic");
    button("H2", "Heading", () => linePrefix("## "), "h2");
    button("H3", "Smaller heading", () => linePrefix("### "), "h3");
    if (links) button("[[ ]]", "Link to a page", () => wrapSel("[[", "]]", "Page name"), "page");
    button("🔗", "Link to a web address", () => wrapSel("[", "](https://)", "link text"), "link");
    button("•", "List", () => linePrefix("- "), "list");
    button("❝", "Quote", () => linePrefix("> "), "quote");
    // ▦: a grid of fields for the table at the caret, or a new one; Done writes it back lined up
    const tableAt = () => {
      const v = ta.value, lines = v.split("\n");
      let at = 0, row = 0;
      for (; row < lines.length; row++) { if (at + lines[row].length >= ta.selectionStart) break; at += lines[row].length + 1; }
      const isRow = (l) => /^\s*\|/.test(l || "");
      if (!isRow(lines[row])) return null;
      let a = row, b = row;
      while (a > 0 && isRow(lines[a - 1])) a--;
      while (b < lines.length - 1 && isRow(lines[b + 1])) b++;
      if (b - a < 1 || !/^\s*\|?\s*:?-{1,}/.test(lines[a + 1])) return null;
      const start = lines.slice(0, a).join("\n").length + (a ? 1 : 0);
      const end = start + lines.slice(a, b + 1).join("\n").length;
      return { start, end, lines: lines.slice(a, b + 1) };
    };
    // a row's cells: split at | outside [[…]] and not escaped
    const cellsOf = (l) => {
      const out = []; let cur = "", depth = 0;
      const s = l.trim().replace(/^\|/, "").replace(/\|$/, "");
      for (let i = 0; i < s.length; i++) {
        if (s.startsWith("[[", i)) { depth++; cur += "[["; i++; continue; }
        if (s.startsWith("]]", i) && depth) { depth--; cur += "]]"; i++; continue; }
        if (s[i] === "\\" && s[i + 1] === "|") { cur += "\\|"; i++; continue; }
        if (s[i] === "|" && !depth) { out.push(cur.trim()); cur = ""; continue; }
        cur += s[i];
      }
      out.push(cur.trim());
      return out;
    };
    // given a table's lines and where to write it (the visual editor), that table; else the one
    // at the caret in the text, or a new one
    const tableEditor = (given, write) => {
      if (wrap.querySelector(".editor-table")) return;
      const found = write ? (given ? { lines: given } : null) : tableAt();
      let rows = found ? [found.lines[0], ...found.lines.slice(2)].map(cellsOf) : [["Name", "Value"], ["", ""], ["", ""]];
      let aligns = found ? cellsOf(found.lines[1]).map((c) => (/^:-+:$/.test(c) ? "center" : /-:$/.test(c) ? "right" : /^:/.test(c) ? "left" : "")) : ["", ""];
      const width = () => Math.max(...rows.map((r) => r.length), aligns.length);
      const box = el("div", "editor-table"); box.setAttribute("role", "dialog"); box.setAttribute("aria-label", "Edit the table");
      const grid = el("table"), tools = el("div", "editor-table-tools");
      const draw = () => {
        const w = width();
        rows = rows.map((r) => [...r, ...Array(Math.max(0, w - r.length)).fill("")]);
        aligns = [...aligns, ...Array(Math.max(0, w - aligns.length)).fill("")];
        grid.innerHTML = "";
        const head = el("tr");
        head.appendChild(el("th"));
        for (let c = 0; c < w; c++) {
          const th = el("th");
          const al = el("select"); al.title = "Line up the column"; al.setAttribute("aria-label", "Column " + (c + 1) + " lines up");
          for (const [v, t] of [["", "—"], ["left", "⇤"], ["center", "↔"], ["right", "⇥"]]) { const o = el("option"); o.value = v; o.textContent = t; al.appendChild(o); }
          al.value = aligns[c]; al.addEventListener("change", () => { aligns[c] = al.value; });
          const x = el("button"); x.type = "button"; x.textContent = "✕"; x.title = "Remove this column"; x.setAttribute("aria-label", "Remove column " + (c + 1));
          x.addEventListener("click", () => { if (w > 1) { rows.forEach((r) => r.splice(c, 1)); aligns.splice(c, 1); draw(); } });
          th.append(al, x); head.appendChild(th);
        }
        grid.appendChild(head);
        rows.forEach((r, i) => {
          const tr = el("tr");
          const ctl = el("td", "editor-table-row");
          const mk = (t, title, run) => { const b = el("button"); b.type = "button"; b.textContent = t; b.title = title; b.setAttribute("aria-label", title); b.addEventListener("click", run); ctl.appendChild(b); };
          if (i > 1) mk("↑", "Move row " + i + " up", () => { [rows[i - 1], rows[i]] = [rows[i], rows[i - 1]]; draw(); });
          if (i > 0 && i < rows.length - 1) mk("↓", "Move row " + i + " down", () => { [rows[i + 1], rows[i]] = [rows[i], rows[i + 1]]; draw(); });
          if (i > 0) mk("✕", "Remove row " + i, () => { rows.splice(i, 1); draw(); });
          tr.appendChild(ctl);
          r.forEach((v, c) => {
            const td = el(i === 0 ? "th" : "td"), inp = el("input");
            inp.type = "text"; inp.value = v; inp.className = "input";
            inp.setAttribute("aria-label", (i === 0 ? "Heading " : "Row " + i + ", ") + "column " + (c + 1));
            inp.addEventListener("input", () => { rows[i][c] = inp.value; });
            inp.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); const next = grid.rows[i + 2]?.cells[c + 1]?.querySelector("input"); if (next) next.focus(); else { rows.push(Array(width()).fill("")); draw(); grid.rows[i + 2]?.cells[c + 1]?.querySelector("input")?.focus(); } } });
            td.appendChild(inp); tr.appendChild(td);
          });
          grid.appendChild(tr);
        });
      };
      const act = (t, run, cls) => { const b = el("button", cls); b.type = "button"; b.textContent = t; b.addEventListener("click", run); tools.appendChild(b); };
      act("+ Row", () => { rows.push(Array(width()).fill("")); draw(); });
      act("+ Column", () => { rows.forEach((r) => r.push("")); aligns.push(""); draw(); });
      act("Done", () => {
        const w = width(), esc = (s) => s.replace(/\n/g, " ");
        const widths = Array.from({ length: w }, (_, c) => Math.max(3, ...rows.map((r) => esc(r[c] || "").length)));
        const line = (r) => "| " + r.map((v, c) => { const s = esc(v || ""); return aligns[c] === "right" ? s.padStart(widths[c]) : s.padEnd(widths[c]); }).join(" | ") + " |";
        const sep = "| " + widths.map((n, c) => aligns[c] === "center" ? ":" + "-".repeat(n - 2) + ":" : aligns[c] === "right" ? "-".repeat(n - 1) + ":" : aligns[c] === "left" ? ":" + "-".repeat(n - 1) : "-".repeat(n)).join(" | ") + " |";
        const md = [line(rows[0]), sep, ...rows.slice(1).map(line)].join("\n");
        if (write) { box.remove(); write(md); return; }
        const v = ta.value;
        if (found) ta.value = v.slice(0, found.start) + md + v.slice(found.end);
        else { const s = ta.selectionStart, lead = s > 0 && v[s - 1] !== "\n" ? "\n\n" : ""; ta.value = v.slice(0, s) + lead + md + "\n" + v.slice(s); }
        box.remove(); ta.focus(); changed();
      }, "primary");
      act("Cancel", () => { box.remove(); ta.focus(); });
      box.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.preventDefault(); box.remove(); ta.focus(); } });
      const scroll = el("div", "editor-table-scroll"); scroll.appendChild(grid);
      box.append(tools, scroll);
      wrap.insertBefore(box, panes);
      draw();
      grid.querySelector("input")?.focus();
    };
    button("▦", "Table: edit the table at the cursor, or make one", () => tableEditor(), "table");
    const tabsMd = "::: tabs\n== First tab\nText of the first tab.\n== Second tab\nText of the second tab.\n:::", boxMd = "::: collapsed Title people click\nText that shows when opened.\n:::";
    button("⧉ Tabs", "Tabs: a title on each == line", () => insert(tabsMd + "\n"), "block", tabsMd);
    button("▸ Collapsed", "A section that opens when clicked", () => insert(boxMd + "\n"), "block", boxMd);
    button("&lt;/&gt;", "Code", () => wrapSel(String.fromCharCode(96)), "code");
    // the image picker: a box that asks the page's images lookup (/_lookup, lookup.go) as someone
    // types, so the page carries none of them; empty, it asks with "" (the lookup's newest)
    if (imagesLookup) {
      const pick = el("div", "editor-images"); pick.hidden = true;
      const find = el("input"); find.type = "search"; find.placeholder = "Find an image"; find.setAttribute("aria-label", "Find an image");
      const found = el("div", "editor-images-found"); found.setAttribute("aria-live", "polite");
      pick.append(find, found);
      let asked = 0, wait = 0;
      const search = async () => {
        const n = ++asked;
        try {
          const res = await fetch("/_lookup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ lookup: imagesLookup, name: find.value }) });
          if (!res.ok || n !== asked) return;
          const v = (await res.json()).value;
          const lines = (Array.isArray(v) ? v : String(v || "").split("\n")).map(String).filter(Boolean);
          found.replaceChildren();
          for (const l of lines) {
            const i = l.indexOf("|"), im = { src: i < 0 ? l : l.slice(0, i), caption: i < 0 ? "" : l.slice(i + 1) };
            const b = el("button"); b.type = "button"; b.title = "Insert " + (im.caption || "this image");
            const img = el("img"); img.src = im.src + "?w=200"; img.alt = im.caption; img.loading = "lazy"; b.appendChild(img);
            b.addEventListener("click", () => {
              const md = filesLookup ? "[[File:" + im.caption + "]]" : "![" + (im.caption || "image") + "](" + im.src + "?w=800)";
              if (visual()) vis.command("atom", md); else insert(md + "\n");
              pick.hidden = true;
            });
            found.appendChild(b);
          }
          if (!lines.length) found.textContent = find.value ? "No image by that name." : "No images yet.";
        } catch { /* offline: what was found stays */ }
      };
      find.addEventListener("input", () => { clearTimeout(wait); wait = setTimeout(search, 200); });
      button("🖼 Image", "Insert an uploaded image", () => { pick.hidden = !pick.hidden; if (!pick.hidden) { search(); find.focus(); } });
      wrap.insertBefore(pick, panes);
    }
    const tabs = el("div", "editor-tabs");
    for (const [name, label] of [["write", "Write"], ["preview", "Preview"]]) {
      const t = el("button"); t.type = "button"; t.textContent = label;
      t.addEventListener("click", () => { wrap.dataset.show = name; tabs.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === t)); });
      if (name === "write") t.classList.add("on");
      tabs.appendChild(t);
    }
    bar.appendChild(tabs); wrap.dataset.show = "write";
    // <MarkdownEditor visual>: Visual or Markdown, the choice remembered; the text field stays
    // what's sent, the visual editor writing into it
    if (tag.dataset.visual) {
      const modes = el("div", "editor-mode"), pick = {};
      modes.setAttribute("role", "group"); modes.setAttribute("aria-label", "Edit as");
      const set = async (mode) => {
        if (mode === "visual" && !vis) {
          try { vis = (await import(tag.dataset.visual)).mount({ ta, wrap, panes, changed, links, knownLookup, filesLookup, tableEditor }); }
          catch { return; }   // the script didn't load: Markdown stays
        }
        if (vis && mode === "markdown") vis.flush();
        wrap.dataset.mode = mode;
        if (mode === "markdown") render();
        for (const m in pick) { pick[m].classList.toggle("on", m === mode); pick[m].setAttribute("aria-pressed", String(m === mode)); }
        if (mode === "visual") vis.show();
        try { localStorage.setItem("cs-editor-mode", mode); } catch { /* storage off */ }
      };
      for (const [mode, label] of [["visual", "Visual"], ["markdown", "Markdown"]]) {
        const b = el("button"); b.type = "button"; b.textContent = label; b.addEventListener("click", () => set(mode));
        pick[mode] = b; modes.appendChild(b);
      }
      bar.insertBefore(modes, bar.firstChild); wrap.dataset.mode = "markdown"; pick.markdown.classList.add("on");
      let saved = null;
      try { saved = localStorage.getItem("cs-editor-mode"); } catch { /* storage off */ }
      if (saved === "visual") set("visual");
      if (form) form.addEventListener("submit", () => { if (vis) vis.flush(); }, true);
    }
    let timer = 0, seq = 0;
    const render = async () => {
      if (wrap.dataset.mode === "visual") return;   // the preview is hidden: shown again on switching back
      const n = ++seq;
      try {
        const res = await fetch("/_markdown", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: ta.value, links, known_lookup: knownLookup, files_lookup: filesLookup, toc: true }) });
        if (res.ok && n === seq) preview.innerHTML = (await res.text()) || "";
      } catch { /* offline: the last preview stays */ }
    };
    ta.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(render, 250); });
    // a refused save (a conflict, a rate limit) comes back to this form with the stored text: the
    // text the person wrote is kept in this tab until then, and put back with a note
    if (form) {
      const key = "cs-kept:" + location.pathname + "|" + form.getAttribute("action");
      let kept = null;
      try { kept = sessionStorage.getItem(key); sessionStorage.removeItem(key); } catch { /* storage off: nothing kept */ }
      if (kept !== null && kept !== ta.value && document.querySelector(".flash")) {
        const stored = ta.value, note = el("p", "editor-kept");
        note.textContent = "Your text wasn't saved, so it's kept here. ";
        const use = el("button"); use.type = "button"; use.textContent = "Show the saved text instead";
        use.addEventListener("click", () => { ta.value = stored; note.remove(); changed(); });
        note.appendChild(use); wrap.insertBefore(note, bar);
        ta.value = kept; changed();   // as if typed: a live refresh keeps it
      }
      form.addEventListener("submit", () => { try { sessionStorage.setItem(key, ta.value); } catch { /* storage off */ } });
    }
    ta.addEventListener("keydown", (e) => { if ((e.ctrlKey || e.metaKey) && (e.key === "b" || e.key === "i")) { e.preventDefault(); wrapSel(e.key === "b" ? "**" : "*"); } });
    render();
  };
  // ---- Markdown's ::: tabs: each section's title becomes a tab; one section shows at a time
  const tabs = (box) => {
    if (box.dataset.ready) return;
    box.dataset.ready = "1";
    const secs = [...box.children].filter((s) => s.classList.contains("md-tab"));
    if (secs.length < 2) return;
    const bar = document.createElement("div");
    bar.className = "md-tabbar"; bar.setAttribute("role", "tablist");
    const show = (k, focus) => {
      secs.forEach((s, i) => { s.hidden = i !== k; });
      [...bar.children].forEach((b, i) => { b.setAttribute("aria-selected", String(i === k)); b.classList.toggle("on", i === k); b.tabIndex = i === k ? 0 : -1; if (i === k && focus) b.focus(); });
    };
    secs.forEach((s, i) => {
      const t = s.querySelector(":scope > .md-tab-title");
      const b = document.createElement("button");
      b.type = "button"; b.setAttribute("role", "tab");
      b.innerHTML = t ? t.innerHTML : String(i + 1);   // the server's own HTML for the title
      b.addEventListener("click", () => show(i));
      bar.appendChild(b);
      if (t) t.hidden = true;
      s.setAttribute("role", "tabpanel");
    });
    bar.addEventListener("keydown", (e) => {
      const k = [...bar.children].indexOf(document.activeElement);
      if (k < 0) return;
      const to = e.key === "ArrowRight" ? (k + 1) % secs.length : e.key === "ArrowLeft" ? (k + secs.length - 1) % secs.length : e.key === "Home" ? 0 : e.key === "End" ? secs.length - 1 : -1;
      if (to >= 0) { e.preventDefault(); show(to, true); }
    });
    box.prepend(bar);
    show(0);
  };
  const all = () => { markSortable(); apply(); document.querySelectorAll("cs-markdown-editor").forEach(editor); document.querySelectorAll(".md-tabs").forEach(tabs); };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", all); else all();
  new MutationObserver(() => { markSortable(); document.querySelectorAll("cs-markdown-editor:not([data-ready])").forEach(editor); document.querySelectorAll(".md-tabs:not([data-ready])").forEach(tabs); }).observe(document.documentElement, { childList: true, subtree: true });
})();
`
