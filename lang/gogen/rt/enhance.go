package rt

import (
	"strings"
)

// Built-in enhancements a page's script gives the elements that ask for them, so an app needs no
// script of its own for them:
//   - <Markdown sortable>: its tables sort by a column when its heading is clicked;
//   - <ThemeToggle default=dark>: a button between the app's two themes (html[data-theme]),
//     remembered in the browser;
//   - <MarkdownEditor links known images>: the next Markdown text field in its form gets
//     formatting buttons, an image picker and a live preview (POST /_markdown).

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
// Markdown field (a textarea) in the same form. known and images are lists (or lines of text):
// the names [[links]] may name, and "address|caption" for each image the picker offers.
func MarkdownEditorTag(links, known, images Val) string {
	return `<cs-markdown-editor data-links="` + Esc(Plain(links)) + `" data-known="` + Esc(linesOf(known)) + `" data-images="` + Esc(linesOf(images)) + `"></cs-markdown-editor>`
}

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
    const links = tag.dataset.links || "", known = (tag.dataset.known || "").split("\n").filter(Boolean);
    const images = (tag.dataset.images || "").split("\n").filter(Boolean).map((l) => { const i = l.indexOf("|"); return { src: i < 0 ? l : l.slice(0, i), caption: i < 0 ? "" : l.slice(i + 1) }; });
    const el = (name, cls) => { const x = document.createElement(name); if (cls) x.className = cls; return x; };
    const wrap = el("div", "editor"), bar = el("div", "editor-bar"), panes = el("div", "editor-panes"), preview = el("div", "editor-preview");
    bar.setAttribute("role", "toolbar"); bar.setAttribute("aria-label", "Formatting"); preview.setAttribute("aria-live", "polite");
    ta.parentNode.insertBefore(wrap, ta); wrap.append(bar, panes); panes.append(ta, preview);
    const changed = () => ta.dispatchEvent(new Event("input", { bubbles: true }));
    const wrapSel = (before, after = before, ph = "text") => {
      const s = ta.selectionStart, e = ta.selectionEnd, v = ta.value, inner = v.slice(s, e) || ph;
      ta.value = v.slice(0, s) + before + inner + after + v.slice(e); ta.focus(); ta.setSelectionRange(s + before.length, s + before.length + inner.length); changed();
    };
    const linePrefix = (p) => { const s = ta.selectionStart, v = ta.value, st = v.lastIndexOf("\n", s - 1) + 1; ta.value = v.slice(0, st) + p + v.slice(st); ta.focus(); ta.setSelectionRange(s + p.length, s + p.length); changed(); };
    const insert = (text) => { const s = ta.selectionStart, v = ta.value, lead = s > 0 && v[s - 1] !== "\n" ? "\n" : ""; ta.value = v.slice(0, s) + lead + text + v.slice(ta.selectionEnd); const at = s + lead.length + text.length; ta.focus(); ta.setSelectionRange(at, at); changed(); };
    const button = (label, title, run) => { const b = el("button"); b.type = "button"; b.innerHTML = label; b.title = title; b.setAttribute("aria-label", title); b.addEventListener("click", run); bar.appendChild(b); return b; };
    button("<b>B</b>", "Bold", () => wrapSel("**"));
    button("<i>I</i>", "Italic", () => wrapSel("*"));
    button("H2", "Heading", () => linePrefix("## "));
    button("H3", "Smaller heading", () => linePrefix("### "));
    if (links) button("[[ ]]", "Link to a page", () => wrapSel("[[", "]]", "Page name"));
    button("🔗", "Link to a web address", () => wrapSel("[", "](https://)", "link text"));
    button("•", "List", () => linePrefix("- "));
    button("❝", "Quote", () => linePrefix("> "));
    button("▦", "Table", () => insert("| Name | Value |\n|------|------:|\n| Sword | 12 |\n"));
    button("&lt;/&gt;", "Code", () => wrapSel(String.fromCharCode(96)));
    if (images.length) {
      const pick = el("div", "editor-images"); pick.hidden = true;
      for (const im of images) {
        const b = el("button"); b.type = "button"; b.title = "Insert " + (im.caption || "this image");
        const img = el("img"); img.src = im.src + "?w=200"; img.alt = im.caption; img.loading = "lazy"; b.appendChild(img);
        b.addEventListener("click", () => { insert("![" + (im.caption || "image") + "](" + im.src + "?w=800)\n"); pick.hidden = true; });
        pick.appendChild(b);
      }
      button("🖼 Image", "Insert an uploaded image", () => { pick.hidden = !pick.hidden; });
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
    let timer = 0, seq = 0;
    const render = async () => {
      const n = ++seq;
      try {
        const res = await fetch("/_markdown", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: ta.value, links, known, toc: true }) });
        if (res.ok && n === seq) preview.innerHTML = (await res.text()) || "";
      } catch { /* offline: the last preview stays */ }
    };
    ta.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(render, 250); });
    ta.addEventListener("keydown", (e) => { if ((e.ctrlKey || e.metaKey) && (e.key === "b" || e.key === "i")) { e.preventDefault(); wrapSel(e.key === "b" ? "**" : "*"); } });
    render();
  };
  const all = () => { markSortable(); apply(); document.querySelectorAll("cs-markdown-editor").forEach(editor); };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", all); else all();
  new MutationObserver(() => { markSortable(); document.querySelectorAll("cs-markdown-editor:not([data-ready])").forEach(editor); }).observe(document.documentElement, { childList: true, subtree: true });
})();
`
