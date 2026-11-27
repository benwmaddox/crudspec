package rt

import (
	"bytes"
	"regexp"
	"strings"
)

// Translation (lang/translate.ts): an app with languages ["en", "es"] is served in its first
// language at its own addresses and in each other under /<lang>/ (/es/notes). The request's
// language is read off its path before it is routed (Lang, Prefix), and everything that writes an
// address of the app puts it back (Local), so a page links within its language. The page and
// fragment caches key by it. The generated code looks a page's text up by its index and the
// request's language (Tr); the runtime's own words by their English (T).

// a request's language, from its path: the prefix taken off, and the language's index
func (sv *Server) readLanguage(r *HTTPReq) {
	langs := sv.UI.Languages
	for i := 1; i < len(langs); i++ {
		p := "/" + langs[i]
		if r.Path == p || strings.HasPrefix(r.Path, p+"/") {
			r.Lang, r.Prefix = i, p
			r.Path = strings.TrimPrefix(r.Path, p)
			if r.Path == "" {
				r.Path = "/"
			}
			return
		}
	}
}

// Tr is the page's text i in the request's language (or as the spec writes it, when it has no
// translation)
func (sv *Server) Tr(rc *RCtx, i int) string {
	row := sv.UI.Texts[i]
	if l := rc.Req.Lang; l < len(row) && row[l] != "" {
		return row[l]
	}
	return row[0]
}

// T is one of the runtime's own words (pager, history, a form's hidden field) in the language
func (sv *Server) T(rc *RCtx, en string) string {
	if rc == nil || rc.Req == nil || rc.Req.Lang == 0 {
		return en
	}
	if row, ok := sv.UI.RuntimeTexts[en]; ok && rc.Req.Lang < len(row) && row[rc.Req.Lang] != "" {
		return row[rc.Req.Lang]
	}
	return en
}

// Local is an address of the app in the request's language: its prefix put on an address that is
// the app's own (/…), not another site's (//…) or a file's
func (sv *Server) Local(rc *RCtx, path string) string {
	if rc == nil || rc.Req == nil || rc.Req.Prefix == "" {
		return path
	}
	return localPath(rc.Req.Prefix, path)
}
func localPath(prefix, path string) string {
	if prefix == "" || !strings.HasPrefix(path, "/") || strings.HasPrefix(path, "//") {
		return path
	}
	for _, own := range []string{"/assets/", "/files/", "/_el/", "/_live", "/_qr/", "/favicon", "/apple-touch-icon", "/_do/", "/_avatar"} {
		if strings.HasPrefix(path, own) {
			return path // the same in every language
		}
	}
	if path == "/" {
		return prefix + "/"
	}
	return prefix + path
}

// PageLang is the request's language's code ("en" when the app says none)
func (sv *Server) PageLang(rc *RCtx) string {
	if langs := sv.UI.Languages; len(langs) > 0 {
		return langs[rc.Req.Lang]
	}
	return ""
}

var timeWord = regexp.MustCompile(`\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|AM|PM)\b`)

// WriteTimeIn is WriteTimeHTML in the request's language: its day and month names and AM/PM
// translated (the runtime's words), the order as the spec's language writes it
func (sv *Server) WriteTimeIn(w *bytes.Buffer, rc *RCtx, v Val, as string, class func() string) {
	if rc == nil || rc.Req == nil || rc.Req.Lang == 0 {
		WriteTimeHTML(w, v, as, class)
		return
	}
	t, ok := v.(Time)
	if !ok || t.T == 0 {
		return
	}
	d := jsTime(t.T)
	layout := "3:04 PM"
	if as == "date" {
		layout = "Mon Jan 02 2006"
	}
	text := timeWord.ReplaceAllStringFunc(d.Format(layout), func(word string) string { return sv.T(rc, word) })
	w.WriteString(`<time class="`)
	WriteEsc(w, class())
	w.WriteString(`" datetime="`)
	w.WriteString(d.UTC().Format("2006-01-02T15:04:05.000Z"))
	w.WriteString(`">`)
	WriteEsc(w, text)
	w.WriteString("</time>")
}
