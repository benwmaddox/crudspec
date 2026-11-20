package rt

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
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
			href := base + strings.ReplaceAll(url.PathEscape(name), "%2F", "/") // a subpage's slash stays one
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

// MarkdownOpts: what a <Markdown> does beyond the text. Include and Files are its lookups
// (include={page_text(w, _)}, files={image_url(w, _)}): the text for {{Name}}, the address for
// [[File:Name]]; false when there's none.
type MarkdownOpts struct {
	Toc, Sortable  bool
	Include, Files func(name string) (string, bool)
}

// MarkdownHTML renders the text in a div with the class. known: the names [[links]] may name
// that exist (a list of text, compared in lower case; none: don't mark any); toc: contents
// before three or more headings.
func MarkdownHTML(text, links, class string, known Val, toc bool, sortable ...bool) string {
	return MarkdownWith(text, links, class, known, MarkdownOpts{Toc: toc, Sortable: len(sortable) > 0 && sortable[0]})
}

// ---- snippets and named images

// at most this deep a snippet's snippets go, and this many lookups a text makes
const includeDepth, includeBudget = 3, 50

var include = regexp.MustCompile(`\{\{([^{}|\n]+)((?:\|[^{}\n]*)?)\}\}`)
var includeParam = regexp.MustCompile(`\{\{\{([^{}|\n]+)(?:\|([^{}\n]*))?\}\}\}`)
var fileRef = regexp.MustCompile(`\[\[(?i:File|Image):([^\[\]|\n]+)((?:\|[^\[\]\n]*)?)\]\]`)

// outsideFences applies f to the text outside fenced code blocks
func outsideFences(src string, f func(string) string) string {
	parts := fence.Split(src, -1)
	marks := fence.FindAllString(src, -1)
	var b strings.Builder
	for i, p := range parts {
		if i > 0 {
			b.WriteString(marks[i-1])
		}
		if i%2 == 1 {
			b.WriteString(p)
		} else {
			b.WriteString(f(p))
		}
	}
	return b.String()
}

// fillParams puts a snippet's {{{name}}} and {{{name|default}}} in from its call's parameters
// ({{Name|a=1|b}}: a is 1, 1 is b); one with neither shows as it's written
func fillParams(text string, params map[string]string) string {
	return includeParam.ReplaceAllStringFunc(text, func(m string) string {
		g := includeParam.FindStringSubmatch(m)
		if v, ok := params[strings.TrimSpace(g[1])]; ok {
			return v
		}
		if strings.Contains(m, "|") {
			return g[2]
		}
		return m
	})
}

// expandIncludes replaces each {{Name}} with the lookup's text for it, its own {{…}} too, as deep
// as includeDepth; a name it can't give (not found, a loop, too deep, over the budget) becomes a
// [[link]] to it
func expandIncludes(src string, look func(string) (string, bool), seen []string, budget *int, cache map[string]*string) string {
	if !strings.Contains(src, "{{") {
		return src
	}
	return outsideFences(src, func(p string) string {
		// each {{Name}} that isn't part of a {{{parameter}}}: one right after another is one too
		var b strings.Builder
		at := 0
		for _, ix := range include.FindAllStringSubmatchIndex(p, -1) {
			s, e := ix[0], ix[1]
			if (s > 0 && p[s-1] == '{') || (e < len(p) && p[e] == '}') {
				continue
			}
			b.WriteString(p[at:s])
			b.WriteString(expandOne(p[ix[2]:ix[3]], p[ix[4]:ix[5]], look, seen, budget, cache))
			at = e
		}
		b.WriteString(p[at:])
		return b.String()
	})
}

// expandOne: one {{name|params}}, as expandIncludes says
func expandOne(rawName, rawParams string, look func(string) (string, bool), seen []string, budget *int, cache map[string]*string) string {
	{
		{
			g := []string{"", "", rawName, rawParams}
			lead, name := "", strings.TrimSpace(g[2])
			key := strings.ToLower(name)
			params := map[string]string{}
			n := 0
			for _, a := range strings.Split(strings.TrimPrefix(g[3], "|"), "|") {
				if g[3] == "" {
					break
				}
				if i := strings.Index(a, "="); i > 0 {
					params[strings.TrimSpace(a[:i])] = strings.TrimSpace(a[i+1:])
				} else {
					n++
					params[strconv.Itoa(n)] = strings.TrimSpace(a)
				}
			}
			loop := false
			for _, s := range seen {
				loop = loop || s == key
			}
			text, ok := "", false
			if c, done := cache[key]; done {
				if c != nil {
					text, ok = *c, true
				}
			} else if !loop && len(seen) < includeDepth && *budget > 0 {
				*budget--
				text, ok = look(name)
				if ok {
					cache[key] = &text
				} else {
					cache[key] = nil
				}
			}
			if !ok || loop || len(seen) >= includeDepth {
				return lead + "[[" + name + "]]"
			}
			out := expandIncludes(fillParams(text, params), look, append(append([]string{}, seen...), key), budget, cache)
			// a snippet of several lines (a table, a ::: block) is blocks of its own: it starts and
			// ends on a line of its own, so two side by side don't run together
			if strings.Contains(strings.TrimSpace(out), "\n") {
				return lead + "\n" + strings.TrimSpace(out) + "\n"
			}
			return lead + out
		}
	}
}

// imageSizes: the widths a thumbnail is made at (/files/<key>?w=…)
var imageSizes = []int{100, 200, 400, 800, 1600}

// fileImages replaces [[File:Name.png|caption|200px]] with the image the lookup gives the address
// of (a thumbnail as wide as said, or 800), its caption the last option that isn't a size or a
// placement; a name it can't give shows as its name, struck through
func fileImages(src string, look func(string) (string, bool)) string {
	if !strings.Contains(src, "[[") {
		return src
	}
	return outsideFences(src, func(p string) string {
		return fileRef.ReplaceAllStringFunc(p, func(m string) string {
			g := fileRef.FindStringSubmatch(m)
			name, caption, width := strings.TrimSpace(g[1]), "", 800
			for _, o := range strings.Split(strings.TrimPrefix(g[2], "|"), "|") {
				o = strings.TrimSpace(o)
				lo := strings.ToLower(o)
				switch {
				case o == "" || lo == "thumb" || lo == "thumbnail" || lo == "frame" || lo == "frameless" || lo == "left" || lo == "right" || lo == "center" || lo == "none" || lo == "border" || strings.HasPrefix(lo, "link=") || strings.HasPrefix(lo, "alt=") || strings.HasPrefix(lo, "upright"):
				case strings.HasSuffix(lo, "px"):
					px := 0
					for _, ch := range strings.TrimSuffix(strings.SplitN(lo, "x", 2)[0], "p") {
						if ch >= '0' && ch <= '9' {
							px = px*10 + int(ch-'0')
						}
					}
					if px > 0 {
						width = imageSizes[len(imageSizes)-1]
						for _, s := range imageSizes {
							if s >= px {
								width = s
								break
							}
						}
					}
				default:
					caption = o
				}
			}
			if caption == "" {
				caption = name
				if i := strings.LastIndex(caption, "."); i > 0 {
					caption = caption[:i]
				}
			}
			addr, ok := look(name)
			if !ok || addr == "" {
				return "~~" + escapeMdText(name) + "~~"
			}
			sep := "?"
			if strings.Contains(addr, "?") {
				sep = "&"
			}
			return "![" + escapeMdText(caption) + "](<" + addr + sep + "w=" + strconv.Itoa(width) + ">)"
		})
	})
}

// ---- tabs and collapsed sections
//
//	::: tabs              ::: collapsed Upgrade costs
//	== Attack Speed       …
//	…                     :::
//	== Light Speed Shots
//	…
//	:::
//
// Blocks nest; a ::: inside a code fence is text. Tabs are sections with a title each, which the
// page's script makes into tabs (rt/enhance.go); without it every tab shows, under its title.
// Collapsed is a <details>.

var blockOpen = regexp.MustCompile(`^:::[ \t]*(tabs|collapsed)\b[ \t]*(.*?)[ \t]*$`)
var blockClose = regexp.MustCompile(`^:::[ \t]*$`)
var tabTitle = regexp.MustCompile(`^==[ \t]*(.+?)[ \t]*=*[ \t]*$`)

// convertBlocks renders Markdown with its ::: blocks
func convertBlocks(src string, w *bytes.Buffer) error {
	if !strings.Contains(src, ":::") {
		return md.Convert([]byte(src), w)
	}
	lines := strings.Split(src, "\n")
	var plain []string
	flush := func() error {
		if len(plain) == 0 {
			return nil
		}
		err := md.Convert([]byte(strings.Join(plain, "\n")), w)
		plain = plain[:0]
		return err
	}
	inFence := false
	for i := 0; i < len(lines); i++ {
		l := lines[i]
		if fence.MatchString(l) {
			inFence = !inFence
		}
		m := blockOpen.FindStringSubmatch(l)
		if inFence || m == nil {
			plain = append(plain, l)
			continue
		}
		// the block's lines, to its own closing ::: (nested blocks counted, fences skipped)
		depth, j, f := 1, i+1, false
		for ; j < len(lines); j++ {
			if fence.MatchString(lines[j]) {
				f = !f
			}
			if f {
				continue
			}
			if blockOpen.MatchString(lines[j]) {
				depth++
			} else if blockClose.MatchString(lines[j]) {
				if depth--; depth == 0 {
					break
				}
			}
		}
		body := lines[i+1 : min(j, len(lines))]
		if err := flush(); err != nil {
			return err
		}
		if m[1] == "collapsed" {
			title := m[2]
			if title == "" {
				title = "More"
			}
			w.WriteString(`<details class="md-collapsed"><summary>` + inlineMD(title) + `</summary>`)
			if err := convertBlocks(strings.Join(body, "\n"), w); err != nil {
				return err
			}
			w.WriteString("</details>\n")
		} else {
			w.WriteString(`<div class="md-tabs">`)
			var tab []string
			title, open := "", false
			emit := func() error {
				if !open {
					return nil
				}
				w.WriteString(`<section class="md-tab"><h4 class="md-tab-title">` + inlineMD(title) + `</h4>`)
				err := convertBlocks(strings.Join(tab, "\n"), w)
				w.WriteString("</section>")
				return err
			}
			bf, nested := false, 0 // a == inside a code fence or a nested block is that one's
			for _, b := range body {
				if fence.MatchString(b) {
					bf = !bf
				}
				if !bf && blockOpen.MatchString(b) {
					nested++
				} else if !bf && nested > 0 && blockClose.MatchString(b) {
					nested--
				}
				if t := tabTitle.FindStringSubmatch(b); t != nil && !bf && nested == 0 {
					if err := emit(); err != nil {
						return err
					}
					title, open, tab = t[1], true, nil
					continue
				}
				if !open { // text before the first == is a tab of its own
					title, open = "…", strings.TrimSpace(b) != ""
					if !open {
						continue
					}
				}
				tab = append(tab, b)
			}
			if err := emit(); err != nil {
				return err
			}
			w.WriteString("</div>\n")
		}
		i = j
	}
	return flush()
}

// inlineMD: a title's Markdown (bold, a link) as HTML without its paragraph
func inlineMD(s string) string {
	var b bytes.Buffer
	if md.Convert([]byte(s), &b) != nil {
		return Esc(s)
	}
	h := strings.TrimSpace(b.String())
	h = strings.TrimPrefix(h, "<p>")
	return strings.TrimSuffix(h, "</p>")
}

// MarkdownWith renders the text with the options: snippets and named images first, then
// [[links]], then the Markdown
func MarkdownWith(text, links, class string, known Val, o MarkdownOpts) string {
	if o.Include != nil {
		budget := includeBudget
		text = expandIncludes(text, o.Include, nil, &budget, map[string]*string{})
	}
	text = fillParams(text, map[string]string{})
	if o.Files != nil {
		text = fileImages(text, o.Files)
	}
	toc, sortable := o.Toc, []bool{o.Sortable}
	var names map[string]bool
	if l, ok := known.(List); ok {
		names = map[string]bool{}
		for _, v := range l {
			names[strings.ToLower(strings.TrimSpace(Plain(v)))] = true
		}
	}
	missing := map[string]bool{}
	var buf bytes.Buffer
	if err := convertBlocks(wikiLinks(text, links, names, missing), &buf); err != nil {
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
	// a preview can't run the page's lookups: a snippet shows where it goes, and a named image
	// is found among the editor's images ("address|name" each)
	o := MarkdownOpts{Include: func(name string) (string, bool) { return "*(included here: " + escapeMdText(name) + ")*", true }}
	if strings.HasPrefix(r.ContentType, "application/json") {
		var body struct {
			Text   string   `json:"text"`
			Links  string   `json:"links"`
			Known  []string `json:"known"`
			Toc    bool     `json:"toc"`
			Images []string `json:"images"`
		}
		if json.Unmarshal([]byte(r.Text), &body) != nil {
			status(w, 400, "")
			return
		}
		text, links, toc = body.Text, body.Links, body.Toc
		if body.Images != nil {
			byName := map[string]string{}
			for _, l := range body.Images {
				if i := strings.Index(l, "|"); i > 0 {
					byName[strings.ToLower(strings.TrimSpace(l[i+1:]))] = l[:i]
				}
			}
			o.Files = func(name string) (string, bool) { a, ok := byName[strings.ToLower(strings.TrimSpace(name))]; return a, ok }
		}
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
	o.Toc = toc
	io.WriteString(w, MarkdownWith(text, links, "md", known, o))
}
