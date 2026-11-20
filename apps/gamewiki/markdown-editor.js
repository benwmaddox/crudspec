// The page editor: formatting buttons, an image picker and a live preview beside the text.
// Put <markdown-editor links="/w/1/p/" images="…"> just before the form's body field; it takes
// over the next <textarea name="body"> in its form. The preview is the server's own rendering
// (POST /_markdown), so it is exactly what the page will show. images: one image a line,
// "address|caption".
class MarkdownEditor extends HTMLElement {
  connectedCallback() {
    if (this.dataset.ready) return;
    const form = this.closest("form");
    const ta = form && form.querySelector("textarea[name=body]");
    if (!ta) return;
    this.dataset.ready = "1";
    const links = this.getAttribute("links") || "";
    // the wiki's page names, so the preview shows links to pages still to write as the page will
    const known = (this.getAttribute("known") || "").split("\n").filter(Boolean);
    const images = (this.getAttribute("images") || "").split("\n").filter(Boolean).map((l) => {
      const i = l.indexOf("|");
      return { src: i < 0 ? l : l.slice(0, i), caption: i < 0 ? "" : l.slice(i + 1) };
    });

    // ---- the layout: toolbar, then the text and its preview side by side
    const wrap = document.createElement("div");
    wrap.className = "editor";
    const bar = document.createElement("div");
    bar.className = "editor-bar";
    bar.setAttribute("role", "toolbar");
    bar.setAttribute("aria-label", "Formatting");
    const panes = document.createElement("div");
    panes.className = "editor-panes";
    const preview = document.createElement("div");
    preview.className = "editor-preview";
    preview.setAttribute("aria-live", "polite");
    ta.parentNode.insertBefore(wrap, ta);
    wrap.append(bar, panes);
    panes.append(ta, preview);

    // ---- editing the text at the caret
    const changed = () => ta.dispatchEvent(new Event("input", { bubbles: true }));
    const wrapSel = (before, after = before, placeholder = "text") => {
      const s = ta.selectionStart, e = ta.selectionEnd, v = ta.value;
      const inner = v.slice(s, e) || placeholder;
      ta.value = v.slice(0, s) + before + inner + after + v.slice(e);
      ta.focus();
      ta.setSelectionRange(s + before.length, s + before.length + inner.length);
      changed();
    };
    const linePrefix = (prefix) => {
      const s = ta.selectionStart, v = ta.value;
      const start = v.lastIndexOf("\n", s - 1) + 1;
      ta.value = v.slice(0, start) + prefix + v.slice(start);
      ta.focus();
      ta.setSelectionRange(s + prefix.length, s + prefix.length);
      changed();
    };
    const insert = (text) => {
      const s = ta.selectionStart, v = ta.value;
      const lead = s > 0 && v[s - 1] !== "\n" ? "\n" : "";
      ta.value = v.slice(0, s) + lead + text + v.slice(ta.selectionEnd);
      const at = s + lead.length + text.length;
      ta.focus();
      ta.setSelectionRange(at, at);
      changed();
    };
    const button = (label, title, run) => {
      const b = document.createElement("button");
      b.type = "button";
      b.innerHTML = label;
      b.title = title;
      b.setAttribute("aria-label", title);
      b.addEventListener("click", run);
      bar.appendChild(b);
      return b;
    };
    button("<b>B</b>", "Bold", () => wrapSel("**"));
    button("<i>I</i>", "Italic", () => wrapSel("*"));
    button("H2", "Heading", () => linePrefix("## "));
    button("H3", "Smaller heading", () => linePrefix("### "));
    button("[[ ]]", "Link to a page of this wiki", () => wrapSel("[[", "]]", "Page name"));
    button("🔗", "Link to a web address", () => wrapSel("[", "](https://)", "link text"));
    button("•", "List", () => linePrefix("- "));
    button("❝", "Quote", () => linePrefix("> "));
    button("▦", "Table", () => insert("| Name | Value |\n|------|------:|\n| Sword | 12 |\n"));
    button("&lt;/&gt;", "Code", () => wrapSel("`"));

    // ---- images: a picker of the wiki's uploads
    if (images.length) {
      const pick = document.createElement("div");
      pick.className = "editor-images";
      pick.hidden = true;
      for (const im of images) {
        const b = document.createElement("button");
        b.type = "button";
        b.title = "Insert " + (im.caption || "this image");
        const img = document.createElement("img");
        img.src = im.src + "?w=200";
        img.alt = im.caption;
        img.loading = "lazy";
        b.appendChild(img);
        b.addEventListener("click", () => {
          insert("![" + (im.caption || "image") + "](" + im.src + "?w=800)\n");
          pick.hidden = true;
        });
        pick.appendChild(b);
      }
      button("🖼 Image", "Insert an uploaded image", () => { pick.hidden = !pick.hidden; });
      wrap.insertBefore(pick, panes);
    }

    // ---- write / preview tabs, for narrow screens
    const tabs = document.createElement("div");
    tabs.className = "editor-tabs";
    for (const [name, label] of [["write", "Write"], ["preview", "Preview"]]) {
      const t = document.createElement("button");
      t.type = "button";
      t.textContent = label;
      t.addEventListener("click", () => { wrap.dataset.show = name; tabs.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === t)); });
      if (name === "write") t.classList.add("on");
      tabs.appendChild(t);
    }
    bar.appendChild(tabs);
    wrap.dataset.show = "write";

    // ---- the preview, from the server, a moment after typing stops
    let timer = 0, seq = 0;
    const render = async () => {
      const n = ++seq;
      try {
        const res = await fetch("/_markdown", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: ta.value, links, known, toc: true }) });
        if (res.ok && n === seq) preview.innerHTML = (await res.text()) || "";
        if (n === seq && !ta.value.trim()) preview.innerHTML = '<p class="muted">The preview shows here as you write.</p>';
      } catch { /* offline: keep the last preview */ }
    };
    ta.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(render, 250); });
    ta.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === "b" || e.key === "i")) { e.preventDefault(); wrapSel(e.key === "b" ? "**" : "*"); }
    });
    render();
  }
}
customElements.define("markdown-editor", MarkdownEditor);
