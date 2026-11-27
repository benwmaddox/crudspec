package rt

import (
	"io"
	"net/http"
	"strings"
)

// The runtime's own pages for people (/_agents, /_agents/all) in the app's look: its theme's
// stylesheets, tokens, custom CSS, icons and language, its classes for the runtime's markup
// (bar, brand, generated_section, button, submit, input), and the same body shell as a screen
// (#nav, #main-content), so the app's stylesheet lays them out as it does its own pages. A
// small style of the runtime's own sets only what an app's stylesheet may not (tables), in
// colors taken from the text, so it reads in a light or a dark theme.

// themeVal: a theme setting worked out outside any screen (none when it can't be)
func (sv *Server) themeVal(name string) (v Val) {
	e := sv.UI.Theme[name]
	if e == nil {
		return nil
	}
	defer func() {
		if recover() != nil {
			v = nil
		}
	}()
	return sv.evalPlain(e)
}

const runtimePageStyle = `<style>.cs-runtime table{border-collapse:collapse;width:100%}` +
	`.cs-runtime th,.cs-runtime td{text-align:left;padding:.45em .6em;border-bottom:1px solid color-mix(in srgb,currentColor 16%,transparent);vertical-align:middle}` +
	`.cs-runtime thead th{font-size:.85em;opacity:.75;font-weight:600}` +
	`.cs-runtime tbody th{font-weight:600}` +
	`.cs-runtime td{white-space:nowrap}` +
	`.cs-runtime .cs-scroll{overflow-x:auto}` +
	`.cs-runtime code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.9em;word-break:break-all;background:color-mix(in srgb,currentColor 8%,transparent);border-radius:4px;padding:.1em .35em}` +
	`.cs-runtime .cs-inline{display:flex;gap:.6em;flex-wrap:wrap;align-items:center;margin-bottom:1em}` +
	`.cs-runtime .cs-inline>*{flex:0 0 auto;width:auto;margin:0}` +
	`.cs-runtime .cs-inline>input{flex:1 1 16em}` +
	`.cs-runtime .cs-token{display:block;font-size:1.05em;padding:.7em .9em;user-select:all}` +
	`.cs-bar-links{display:flex;gap:1em;margin-left:auto;align-items:center;flex-wrap:wrap}</style>`

// runtimePage writes one of the runtime's pages: title, and the main content's sections
func (sv *Server) runtimePage(w http.ResponseWriter, r *HTTPReq, code int, title, main string) {
	lang := "en"
	if l := strings.TrimSpace(Plain(sv.themeVal("lang"))); l != "" {
		lang = l
	}
	if langs := sv.UI.Languages; len(langs) > 1 && r != nil { // the language its address is in (translate.go)
		lang = langs[r.Lang]
	}
	prefix := ""
	if r != nil {
		prefix = r.Prefix
	}
	app := sv.UI.AppName
	var b strings.Builder
	b.WriteString(`<!DOCTYPE html><html lang="` + Esc(lang) + `"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark">` + "\n")
	full := title
	if app != "" {
		full += " · " + app
	}
	b.WriteString(`<title>` + Esc(full) + `</title><meta name="robots" content="noindex">`)
	if l, ok := sv.themeVal("stylesheets").(List); ok {
		for _, n := range l {
			b.WriteString(`<link rel="stylesheet" href="` + Esc(sv.AssetURL(Plain(n))) + `">`)
		}
	}
	b.WriteString(tokenStyle(sv.themeVal("tokens")))
	b.WriteString(sv.iconLinks())
	if sv.Agents.Enabled() {
		b.WriteString(`<link rel="alternate" type="text/markdown" href="/llms.txt" title="For AI agents">`)
	}
	if c := Plain(sv.themeVal("custom")); c != "" {
		b.WriteString(`<style>` + c + `</style>`)
	}
	b.WriteString(runtimePageStyle + "</head>\n<body>\n")
	b.WriteString(`<a href="#main-content"` + ClassAttr(Esc(sv.dc("skip_link"))) + `>Skip to main content</a>` + "\n")
	name := app
	if name == "" {
		name = "Home"
	}
	toggle := ""
	if sv.UI.ThemeToggle != "" {
		toggle = ThemeToggle(sv.dc("button"), sv.UI.ThemeToggle)
	}
	b.WriteString(`<nav id="nav"><div` + ClassAttr(Esc(sv.dc("bar"))) + `><a href="` + Esc(localPath(prefix, "/")) + `"` + ClassAttr(Esc(sv.dc("brand"))) + `>` + Esc(name) + `</a>` +
		`<span class="cs-bar-links"><a href="/llms.txt">For AI agents</a>` + toggle + `</span></div></nav>` + "\n")
	b.WriteString(`<main id="main-content" class="cs-runtime">` + main + "</main>\n")
	if toggle != "" { // the theme toggle's script (the page's other widgets need none)
		b.WriteString(`<script id="crudspec-page" type="application/json">{}</script><script src="` + LiveScriptPath + `" defer></script>`)
	}
	b.WriteString("</body></html>")
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	io.WriteString(w, b.String())
}

// section: one of a runtime page's sections, in the theme's class for generated sections
func (sv *Server) section(inner string) string {
	return `<section` + ClassAttr(Esc(sv.dc("generated_section"))) + `>` + inner + `</section>`
}
