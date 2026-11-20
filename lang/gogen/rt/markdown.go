package rt

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"

	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/extension"
	"github.com/yuin/goldmark/parser"
	"github.com/yuin/goldmark/renderer/html"
)

// <Markdown>: text people wrote, as HTML. goldmark with GitHub's tables, strikethrough, task
// lists and bare links; raw HTML in the text is left out (goldmark's default, without
// WithUnsafe), and links and images to anything but relative, http(s) and mailto addresses
// are dropped. Headings get ids from their text. [[Name]] and [[Name|shown]] become links to
// the element's `links` address with the name appended, path-escaped; with `known` (the names
// that exist), a link to any other gets class="new". With `toc`, three or more headings get a
// list of contents first.

var md = goldmark.New(
	goldmark.WithExtensions(extension.Table, extension.Strikethrough, extension.TaskList, extension.Linkify),
	goldmark.WithParserOptions(parser.WithAutoHeadingID()),
	goldmark.WithRendererOptions(html.WithHardWraps()),
)

var wikiLink = regexp.MustCompile(`\[\[([^\[\]|\n]+)(?:\|([^\[\]\n]+))?\]\]`)
var fence = regexp.MustCompile("(?m)^(```|~~~)")

// wikiLinks rewrites [[Name]] into Markdown links, outside fenced code blocks; missing gets the
// addresses of those whose name isn't known (when known isn't nil)
func wikiLinks(src, base string, known map[string]bool, missing map[string]bool) string {
	if !strings.Contains(src, "[[") {
		return src
	}
	parts := fence.Split(src, -1)
	marks := fence.FindAllString(src, -1)
	var b strings.Builder
	for i, p := range parts {
		if i > 0 {
			b.WriteString(marks[i-1])
		}
		if i%2 == 1 { // inside a fence
			b.WriteString(p)
			continue
		}
		b.WriteString(wikiLink.ReplaceAllStringFunc(p, func(m string) string {
			g := wikiLink.FindStringSubmatch(m)
			name := strings.TrimSpace(g[1])
			shown := name
			if strings.TrimSpace(g[2]) != "" {
				shown = strings.TrimSpace(g[2])
			}
			href := base + url.PathEscape(name)
			if known != nil && !known[strings.ToLower(name)] {
				missing[href] = true
			}
			return "[" + escapeMdText(shown) + "](<" + href + ">)"
		}))
	}
	return b.String()
}

var mdSpecial = strings.NewReplacer(`\`, `\\`, `[`, `\[`, `]`, `\]`, `*`, `\*`, `_`, `\_`, "`", "\\`", `<`, `\<`)

func escapeMdText(s string) string { return mdSpecial.Replace(s) }

// goldmark keeps javascript: and the like out of links already; this also drops anything that
// isn't relative, http(s) or mailto (data:, file:, …), as the rest of the UI does
var mdURL = regexp.MustCompile(`(?i)(href|src)="([^"]*)"`)

func safeMdURLs(h string) string {
	return mdURL.ReplaceAllStringFunc(h, func(m string) string {
		g := mdURL.FindStringSubmatch(m)
		u := strings.ToLower(strings.TrimSpace(g[2]))
		if i := strings.IndexAny(u, ":/?#"); i >= 0 && u[i] == ':' {
			if !(strings.HasPrefix(u, "http:") || strings.HasPrefix(u, "https:") || strings.HasPrefix(u, "mailto:")) {
				return g[1] + `="#"`
			}
		}
		return m
	})
}

var mdAnchor = regexp.MustCompile(`<a href="([^"]*)">`)
var mdHeading = regexp.MustCompile(`<h([23]) id="([^"]+)">(.*?)</h[23]>`)
var mdTags = regexp.MustCompile(`<[^>]*>`)

// MarkdownHTML renders the text in a div with the class. known: the names [[links]] may name
// that exist (a list of text, compared in lower case; none: don't mark any); toc: contents
// before three or more headings.
func MarkdownHTML(text, links, class string, known Val, toc bool, sortable ...bool) string {
	var names map[string]bool
	if l, ok := known.(List); ok {
		names = map[string]bool{}
		for _, v := range l {
			names[strings.ToLower(strings.TrimSpace(Plain(v)))] = true
		}
	}
	missing := map[string]bool{}
	var buf bytes.Buffer
	if err := md.Convert([]byte(wikiLinks(text, links, names, missing)), &buf); err != nil {
		return `<div class="` + Esc(class) + `">` + Esc(text) + "</div>"
	}
	out := safeMdURLs(buf.String())
	if len(missing) > 0 {
		out = mdAnchor.ReplaceAllStringFunc(out, func(m string) string {
			if missing[mdAnchor.FindStringSubmatch(m)[1]] {
				return strings.Replace(m, "<a ", `<a class="new" title="This page doesn't exist yet" `, 1)
			}
			return m
		})
	}
	if toc {
		hs := mdHeading.FindAllStringSubmatch(out, -1)
		if len(hs) >= 3 {
			var b strings.Builder
			b.WriteString(`<nav class="toc" aria-label="Contents"><strong>Contents</strong><ul>`)
			for _, h := range hs {
				cls := ""
				if h[1] == "3" {
					cls = ` class="sub"`
				}
				b.WriteString(`<li` + cls + `><a href="#` + h[2] + `">` + mdTags.ReplaceAllString(h[3], "") + `</a></li>`)
			}
			b.WriteString(`</ul></nav>`)
			out = b.String() + out
		}
	}
	sort := ""
	if len(sortable) > 0 && sortable[0] {
		sort = ` data-sortable`
	}
	return `<div class="` + Esc(class) + `" dir="auto"` + sort + `>` + out + "</div>"
}

// /_markdown: a preview of text as <Markdown> shows it, for an editor beside a text field: POST
// the text as the body, with ?links= (the [[link]] address) and &toc=1; or JSON, {"text", "links",
// "known": [names], "toc"}, to mark links to names not known. Same origin only; nothing is stored.
func (sv *Server) markdownPreview(w http.ResponseWriter, r *HTTPReq) {
	if r.Method != "POST" || !sv.sameOrigin(r) {
		status(w, 403, "")
		return
	}
	text, links, toc := r.Text, r.Query.Get("links"), r.Query.Get("toc") == "1"
	var known Val
	if strings.HasPrefix(r.ContentType, "application/json") {
		var body struct {
			Text  string   `json:"text"`
			Links string   `json:"links"`
			Known []string `json:"known"`
			Toc   bool     `json:"toc"`
		}
		if json.Unmarshal([]byte(r.Text), &body) != nil {
			status(w, 400, "")
			return
		}
		text, links, toc = body.Text, body.Links, body.Toc
		if body.Known != nil {
			l := List{}
			for _, k := range body.Known {
				l = append(l, k)
			}
			known = l
		}
	}
	if len(text) > 400_000 {
		status(w, 413, "")
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(200)
	io.WriteString(w, MarkdownHTML(text, links, "md", known, toc))
}
