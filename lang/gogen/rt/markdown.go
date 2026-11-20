package rt

import (
	"bytes"
	"net/url"
	"regexp"
	"strings"

	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/extension"
	"github.com/yuin/goldmark/renderer/html"
)

// <Markdown>: text people wrote, as HTML. goldmark with GitHub's tables, strikethrough, task
// lists and bare links; raw HTML in the text is left out (goldmark's default, without
// WithUnsafe), and links and images to anything but relative, http(s) and mailto addresses
// are dropped. [[Name]] and [[Name|shown]] become links to the element's `links` address with
// the name appended, path-escaped.

var md = goldmark.New(
	goldmark.WithExtensions(extension.Table, extension.Strikethrough, extension.TaskList, extension.Linkify),
	goldmark.WithRendererOptions(html.WithHardWraps()),
)

var wikiLink = regexp.MustCompile(`\[\[([^\[\]|\n]+)(?:\|([^\[\]\n]+))?\]\]`)
var fence = regexp.MustCompile("(?m)^(```|~~~)")

// wikiLinks rewrites [[Name]] into Markdown links, outside fenced code blocks.
func wikiLinks(src, base string) string {
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
			return "[" + escapeMdText(shown) + "](<" + base + url.PathEscape(name) + ">)"
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

// MarkdownHTML renders the text in a div with the class (none when it is empty).
func MarkdownHTML(text, links, class string) string {
	var buf bytes.Buffer
	if err := md.Convert([]byte(wikiLinks(text, links)), &buf); err != nil {
		return `<div class="` + Esc(class) + `">` + Esc(text) + "</div>"
	}
	return `<div class="` + Esc(class) + `" dir="auto">` + safeMdURLs(buf.String()) + "</div>"
}
