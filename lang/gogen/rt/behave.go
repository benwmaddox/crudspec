package rt

// Behaviors (lang/behaviors.ts): an element's ref and what it does in the browser, written as
// data attributes the page's script (behaviorScript) acts on. The values are worked out on the
// server as the page is drawn; the script only moves focus, scrolls, plays a sound, puts text
// into a field, shows or hides, and goes to an address. Nothing in them runs as script: each is
// JSON in an escaped attribute, and the script sets a field's value or text, never its HTML.

import (
	"encoding/json"
	"strings"
)

// Step is one action of a trigger: what (A), its target's ref (T, Last: the last element so
// named), its value (V: the text, or the address)
type Step struct {
	A, T string
	Last bool
	V    Val
}

// Behave is a trigger's attribute (` data-do-click="…"`), or "" when it does nothing (a go to
// no address)
func (sv *Server) Behave(trigger string, steps []Step) string {
	out := make([]map[string]any, 0, len(steps))
	for _, s := range steps {
		m := map[string]any{"a": s.A}
		if s.T != "" {
			m["t"] = s.T
			if s.Last {
				m["l"] = true
			}
		}
		switch s.A {
		case "go":
			if s.V == nil {
				continue
			}
			m["v"] = SafeURL(Plain(s.V), false)
		case "play":
			if s.V == nil {
				continue
			}
			src := Plain(s.V)
			if strings.Contains(src, ":") || strings.HasPrefix(src, "/") {
				src = SafeURL(src, false)
			} else {
				src = sv.AssetURL(src) // a sound among the app's assets
			}
			m["v"] = src
		case "prepend", "append":
			m["v"] = Plain(s.V)
		}
		out = append(out, m)
	}
	if len(out) == 0 {
		return ""
	}
	return ` data-do-` + strings.ReplaceAll(trigger, "_", "-") + `="` + Esc(behaviorJSON(out)) + `"`
}

// BehaveBind is a binding's attribute: ` data-hide-in-view="…"` for hidden_while_in_view
func BehaveBind(binding, ref string, last bool) string {
	m := map[string]any{"t": ref}
	if last {
		m["l"] = true
	}
	return ` data-` + map[string]string{"hidden_while_in_view": "hide-in-view"}[binding] + `="` + Esc(behaviorJSON(m)) + `"`
}

// RefAttr is an element's ref: ` data-ref="name"`
func RefAttr(name string) string { return ` data-ref="` + Esc(name) + `"` }

func behaviorJSON(v any) string {
	var b strings.Builder
	e := json.NewEncoder(&b)
	e.SetEscapeHTML(true) // <, > and & as <…: inert inside the attribute and anywhere else
	_ = e.Encode(v)
	return strings.TrimSuffix(b.String(), "\n")
}

// behaviorScript is the browser's side, part of the live script (one file, cached for good):
// events handled on the document, so elements a live update puts there behave at once; shown
// and hidden_while_in_view run for elements as they appear.
const behaviorScript = `
(() => {
  const KEYS = { Enter: "enter", Escape: "escape", " ": "space", Tab: "tab", Backspace: "backspace", Delete: "delete", ArrowUp: "arrowup", ArrowDown: "arrowdown", ArrowLeft: "arrowleft", ArrowRight: "arrowright" };
  const ref = (s) => { const all = document.querySelectorAll('[data-ref="' + CSS.escape(s.t) + '"]'); return (s.l ? all[all.length - 1] : all[0]) || null; };
  const EDITABLE = '[contenteditable=""], [contenteditable="true"]';
  // a target that isn't a field: the first field inside it (a textarea, an input, an editable)
  const field = (el) => !el ? null : el.matches("textarea, input, select, " + EDITABLE) ? el : el.querySelector("textarea") || el.querySelector("input:not([type=hidden])") || el.querySelector(EDITABLE);
  const typing = (el) => !!el && el !== document.body && (el.matches("textarea, input, select") || el.isContentEditable);
  // relative, http(s), mailto and tel only (the server keeps to these too)
  const safe = (u) => typeof u === "string" && (!/^\s*[a-z][a-z0-9+.-]*:/i.test(u) || /^\s*(https?|mailto|tel):/i.test(u));
  const put = (f, text, first) => {
    if (f.isContentEditable) { f.textContent = first ? text + f.textContent : f.textContent + text; }
    else { f.value = first ? text + f.value : f.value + text; }
    f.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const run = (steps, shown) => {
    for (const s of steps) {
      if (s.a === "go") { if (safe(s.v)) location.href = s.v; return; }
      if (s.a === "play") { if (safe(s.v)) { try { const p = new Audio(s.v).play(); if (p && p.catch) p.catch(() => {}); } catch (e) {} } continue; }
      if (s.a === "prepend" || s.a === "append") { const f = field(ref(s)); if (f) put(f, String(s.v ?? ""), s.a === "prepend"); continue; }
      if (s.a === "focus") {
        const t = ref(s), f = field(t) || t; if (!f) continue;
        // as an element appears, it doesn't take the focus from a field someone is typing in
        if (shown && typing(document.activeElement) && document.activeElement !== f) continue;
        f.focus();
        try { const n = (f.value ?? "").length; if (f.setSelectionRange) f.setSelectionRange(n, n); } catch (e) {}
        continue;
      }
      if (s.a === "scroll_to") { const t = ref(s); if (t) t.scrollIntoView({ behavior: "smooth" }); continue; }
    }
  };
  const stepsOf = (el, n) => { try { const v = JSON.parse(el.getAttribute("data-do-" + n)); return Array.isArray(v) ? v : null; } catch (e) { return null; } };
  const on = (type, n) => document.addEventListener(type, (e) => { const el = e.target.closest && e.target.closest("[data-do-" + n + "]"); const s = el && stepsOf(el, n); if (s) run(s); });
  on("click", "click"); on("dblclick", "dblclick");
  document.addEventListener("keydown", (e) => {
    const k = KEYS[e.key]; if (!k || e.isComposing) return;
    const el = e.target.closest && e.target.closest("[data-do-key-" + k + "]"); const s = el && stepsOf(el, "key-" + k);
    if (s) { e.preventDefault(); run(s); }
  });
  document.addEventListener("focusout", (e) => {
    const el = e.target; if (!el.matches || !el.matches("[data-do-blur-unchanged]")) return;
    const was = el.isContentEditable ? el.dataset.shownText : el.defaultValue, now = el.isContentEditable ? el.textContent : el.value;
    const s = stepsOf(el, "blur-unchanged"); if (s && now === was) run(s);
  });
  // as elements appear: shown, once each; hidden_while_in_view, its target watched (a new last
  // message is a new target)
  const done = new WeakSet(), watched = new Map();
  const appear = () => {
    for (const el of document.querySelectorAll("[data-do-shown]")) {
      if (done.has(el)) continue; done.add(el);
      if (el.isContentEditable) el.dataset.shownText = el.textContent;
      const s = stepsOf(el, "shown"); if (s) run(s, true);
    }
    for (const el of document.querySelectorAll("[data-hide-in-view]")) {
      let t; try { t = JSON.parse(el.getAttribute("data-hide-in-view")); } catch (e) { continue; }
      const target = ref(t), w = watched.get(el);
      if (w && w.target === target) continue;
      if (w) w.io.disconnect();
      if (!target || !window.IntersectionObserver) { watched.set(el, { target, io: { disconnect() {} } }); continue; }
      const io = new IntersectionObserver((es) => { el.hidden = es[es.length - 1].isIntersecting; });
      io.observe(target); watched.set(el, { target, io });
    }
    for (const [el, w] of watched) if (!el.isConnected) { w.io.disconnect(); watched.delete(el); }
  };
  let queued = false;
  new MutationObserver(() => { if (!queued) { queued = true; requestAnimationFrame(() => { queued = false; appear(); }); } }).observe(document.body, { childList: true, subtree: true });
  appear();
})();
`
