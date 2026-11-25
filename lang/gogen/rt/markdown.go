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
// that exist, or a lookup asked for each linked name), a link to any other gets class="new". With `toc`, three or more headings get a
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
func wikiLinks(src, base string, known func(name string) bool, missing map[string]bool) string {
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
			if known != nil && !known(name) {
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
// isn't relative, http(s) or mailto (data:, file:, …), as the rest of the UI does: every
// href="…" and src="…" (in any case, as (?i)(href|src)="([^"]*)" finds them) whose address is
// another scheme becomes "#". A scan rather than that regexp: it ran over every page's whole
// HTML, and its case folding was a tenth of a wiki page's time.
func safeMdURLs(h string) string {
	var b strings.Builder
	last := 0
	for i := 0; i < len(h); {
		j := strings.Index(h[i:], `="`)
		if j < 0 {
			break
		}
		j += i // h[j] is '=', h[j+1] the opening quote
		name := ""
		if j >= 4 && strings.EqualFold(h[j-4:j], "href") {
			name = h[j-4 : j]
		} else if j >= 3 && strings.EqualFold(h[j-3:j], "src") {
			name = h[j-3 : j]
		}
		if name == "" {
			i = j + 1
			continue
		}
		end := strings.IndexByte(h[j+2:], '"')
		if end < 0 {
			break
		}
		end += j + 2 // the closing quote
		u := strings.ToLower(strings.TrimSpace(h[j+2 : end]))
		if k := strings.IndexAny(u, ":/?#"); k >= 0 && u[k] == ':' && !(strings.HasPrefix(u, "http:") || strings.HasPrefix(u, "https:") || strings.HasPrefix(u, "mailto:")) {
			if b.Len() == 0 {
				b.Grow(len(h))
			}
			b.WriteString(h[last : j-len(name)])
			b.WriteString(name + `="#"`)
			last = end + 1
		}
		i = end + 1
	}
	if last == 0 {
		return h
	}
	b.WriteString(h[last:])
	return b.String()
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
	// Known, when set, says whether a [[link]]'s name exists, asked once for each name the text
	// links to (known={page_exists(w, _)}): a page reads only what it links to, not every name
	Known func(name string) bool
}

// MarkdownHTML renders the text in a div with the class. known: the names [[links]] may name
// that exist (a list of text, compared in lower case; none: don't mark any); toc: contents
// before three or more headings.
func MarkdownHTML(text, links, class string, known Val, toc bool, sortable ...bool) string {
	return MarkdownWith(text, links, class, known, MarkdownOpts{Toc: toc, Sortable: len(sortable) > 0 && sortable[0]})
}

// ---- snippets and named images

// a text's snippets: at most this deep, this many lookups, this many snippets put in, and this
// much text in all (a snippet used a thousand times, holding one used a thousand times, would
// otherwise make gigabytes from a short page)
const includeDepth, includeBudget, includeUses, includeMaxBytes = 3, 50, 500, 2_000_000

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
// ({{Name|a=1|b}}: a is 1, 1 is b), outside code blocks; one with neither shows as it's written
func fillParams(text string, params map[string]string) string {
	if !strings.Contains(text, "{{{") {
		return text
	}
	return outsideFences(text, func(p string) string {
		return includeParam.ReplaceAllStringFunc(p, func(m string) string {
			g := includeParam.FindStringSubmatch(m)
			if v, ok := params[strings.TrimSpace(g[1])]; ok {
				return v
			}
			if strings.Contains(m, "|") {
				return g[2]
			}
			return m
		})
	})
}

// includes: what a text's snippets have used up, and the lookups' results
type includes struct {
	look                 func(string) (string, bool)
	lookups, uses, bytes int
	cache                map[string]*string
}

// expandIncludes replaces each {{Name}} with the lookup's text for it, its own {{…}} too, as deep
// as includeDepth; a name it can't give (not found, a loop, too deep, past a limit) becomes a
// [[link]] to it. \{{Name}} is written as it is.
func expandIncludes(src string, st *includes, seen []string) string {
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
			if s > 0 && p[s-1] == '\\' { // \{{Name}}: Markdown shows \{ as {
				continue
			}
			b.WriteString(p[at:s])
			b.WriteString(expandOne(p[ix[2]:ix[3]], p[ix[4]:ix[5]], st, seen))
			at = e
		}
		b.WriteString(p[at:])
		return b.String()
	})
}

// expandOne: one {{name|params}}, as expandIncludes says
func expandOne(rawName, rawParams string, st *includes, seen []string) string {
	name := strings.TrimSpace(rawName)
	key := strings.ToLower(name)
	link := "[[" + name + "]]"
	params := map[string]string{}
	if rawParams != "" {
		n := 0
		for _, a := range strings.Split(strings.TrimPrefix(rawParams, "|"), "|") {
			if i := strings.Index(a, "="); i > 0 {
				params[strings.TrimSpace(a[:i])] = strings.TrimSpace(a[i+1:])
			} else {
				n++
				params[strconv.Itoa(n)] = strings.TrimSpace(a)
			}
		}
	}
	for _, s := range seen {
		if s == key {
			return link // a loop
		}
	}
	if len(seen) >= includeDepth || st.uses >= includeUses || st.bytes >= includeMaxBytes {
		return link
	}
	var text *string
	if c, done := st.cache[key]; done {
		text = c
	} else {
		if st.lookups >= includeBudget {
			return link
		}
		st.lookups++
		if t, ok := st.look(name); ok {
			text = &t
		}
		st.cache[key] = text
	}
	if text == nil {
		return link
	}
	st.uses++
	out := expandIncludes(fillParams(*text, params), st, append(append([]string{}, seen...), key))
	if st.bytes+len(out) > includeMaxBytes {
		st.bytes = includeMaxBytes
		return link
	}
	st.bytes += len(out)
	// a snippet of several lines (a table, a ::: block) is blocks of its own: it starts and ends
	// on a line of its own, so two side by side don't run together
	if strings.Contains(strings.TrimSpace(out), "\n") {
		return "\n" + strings.TrimSpace(out) + "\n"
	}
	return out
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

// knownNames: whether a [[link]]'s name exists, from a lookup (asked once a name, in any case) or
// from a list of every name (lower case); nil when neither is given: no link is marked
func knownNames(list Val, look func(string) bool) func(string) bool {
	if look != nil {
		asked := map[string]bool{}
		return func(name string) bool {
			k := strings.ToLower(name)
			v, ok := asked[k]
			if !ok {
				v = look(name)
				asked[k] = v
			}
			return v
		}
	}
	l, ok := list.(List)
	if !ok {
		return nil
	}
	names := map[string]bool{}
	for _, v := range l {
		names[strings.ToLower(strings.TrimSpace(Plain(v)))] = true
	}
	return func(name string) bool { return names[strings.ToLower(name)] }
}

// rowHeadings: a table whose top-left heading is blank (| | Windows | Mac |) labels its rows
// with their first cells, as people read it. Those cells become row headings
// (<th scope="row">) and the blank corner a plain cell, so each value has a heading for screen
// readers on both sides (an empty <th> has none to give)
var mdTable = regexp.MustCompile(`(?s)<table>.*?</table>`)
var mdBlankCorner = regexp.MustCompile(`^(<table>\s*<thead>\s*<tr>\s*)<th([^>]*)>\s*</th>`)
var mdRowFirst = regexp.MustCompile(`(?s)(<tr>\s*)<td([^>]*)>(.*?)</td>`)

func rowHeadings(out string) string {
	if !strings.Contains(out, "<table>") {
		return out
	}
	return mdTable.ReplaceAllStringFunc(out, func(t string) string {
		m := mdBlankCorner.FindStringSubmatchIndex(t)
		if m == nil {
			return t
		}
		head := t[:m[3]] + `<td` + t[m[4]:m[5]] + `></td>`
		rest := t[m[1]:]
		at := strings.Index(rest, "<tbody>")
		if at < 0 {
			return head + rest
		}
		body := mdRowFirst.ReplaceAllString(rest[at:], `$1<th scope="row"$2>$3</th>`)
		return head + rest[:at] + body
	})
}

// MarkdownWith renders the text with the options: snippets and named images first, then
// [[links]], then the Markdown
func MarkdownWith(text, links, class string, known Val, o MarkdownOpts) string {
	if o.Include != nil {
		text = expandIncludes(text, &includes{look: o.Include, cache: map[string]*string{}}, nil)
		text = fillParams(text, map[string]string{}) // a snippet's own page shows its parameters' defaults
	}
	if o.Files != nil {
		text = fileImages(text, o.Files)
	}
	toc, sortable := o.Toc, []bool{o.Sortable}
	missing := map[string]bool{}
	var buf bytes.Buffer
	if err := convertBlocks(wikiLinks(text, links, knownNames(known, o.Known), missing), &buf); err != nil {
		return `<div class="` + Esc(class) + `">` + Esc(text) + "</div>"
	}
	out := rowHeadings(withImageSizes(safeMdURLs(buf.String())))
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
// "known_lookup", "files_lookup", "toc"}, with the editor's signed lookups (lookup.go), asked of each
// name the text links to or shows, as the person previewing. Same origin only; nothing is stored.
func (sv *Server) markdownPreview(w http.ResponseWriter, r *HTTPReq, who Who) {
	if r.Method != "POST" || !sv.sameOrigin(r) {
		status(w, 403, "")
		return
	}
	text, links, toc := r.Text, r.Query.Get("links"), r.Query.Get("toc") == "1"
	var known Val
	// a preview runs the lookups the page signed for it (lookup.go): known, for links to pages no
	// one has written, and files, for a [[File:Name]]'s address; a snippet shows where it goes
	o := MarkdownOpts{Include: func(name string) (string, bool) { return "*(included here: " + escapeMdText(name) + ")*", true }}
	if strings.HasPrefix(r.ContentType, "application/json") {
		var body struct {
			Text  string `json:"text"`
			Links string `json:"links"`
			Known string `json:"known_lookup"`
			Files string `json:"files_lookup"`
			Toc   bool   `json:"toc"`
		}
		if json.Unmarshal([]byte(r.Text), &body) != nil {
			status(w, 400, "")
			return
		}
		text, links, toc = body.Text, body.Links, body.Toc
		c := sv.App.ctx(r.Sess, nil, who.Actor, r.request(who, "read"))
		if body.Known != "" {
			fn, args, ok := sv.App.UnsignLookup(body.Known)
			if !ok {
				status(w, 400, "")
				return
			}
			o.Known = sv.App.knownBy(c, fn, args)
		}
		if body.Files != "" {
			fn, args, ok := sv.App.UnsignLookup(body.Files)
			if !ok {
				status(w, 400, "")
				return
			}
			o.Files = func(name string) (string, bool) {
				v := sv.App.valueBy(c, fn, args, name)
				if v == nil {
					return "", false
				}
				return Plain(v), true
			}
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
