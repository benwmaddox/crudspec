package rt

import (
	"bytes"
	"encoding/csv"
	"encoding/json"
	"encoding/xml"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"unicode"
)

// Exports: `export name "/route" (params) csv|json of view(args) { "Column": expr, … }` is a
// download of the view's rows, run as the view runs for whoever asks (its requires, and each
// row's read permission), a column per entry. The checker keeps private fields out.

// Download is an export's answer: a file, or the outcome that refused it.
type Download struct {
	Name, Type string
	Body       []byte
	Outcome    string
	Inline     bool // shown, not saved: a sitemap
	Public     bool // the same for every signed-out visitor, so caches may keep it a while
}

// maxSitemapURLs: a sitemap holds at most 50,000 addresses (sitemaps.org); past that, an index
// of several sitemaps.
const maxSitemapURLs = 50000

// Sitemaps are the routes of the app's sitemaps that take no parameters, the indexes first:
// robots.txt names them.
var Sitemaps []string

// absoluteURL: an address as it is, or a path made absolute with the app's --base-url (none
// when there's no base to make it absolute with, or it's neither)
func (sv *Server) absoluteURL(u string) string {
	switch {
	case u == "":
		return ""
	case strings.HasPrefix(u, "https://") || strings.HasPrefix(u, "http://"):
		return u
	case strings.HasPrefix(u, "/") && !strings.HasPrefix(u, "//") && sv.App.PublicBase != "":
		return sv.App.PublicBase + u
	}
	return ""
}

// sitemap writes the rows as a sitemap (<urlset>) or an index of sitemaps (<sitemapindex>): each
// row's url column (absolute, or a path made absolute with --base-url; a row without one is left
// out) and its changed column, when it has one, as the date it last changed.
func (sv *Server) sitemap(s *Sess, index bool, rows []*Row, at func(r *Row) *Ctx, headers []string, cols []func(c *Ctx) Val) []byte {
	set, item := "urlset", "url"
	if index {
		set, item = "sitemapindex", "sitemap"
	}
	var b bytes.Buffer
	b.WriteString(`<?xml version="1.0" encoding="UTF-8"?>` + "\n" + `<` + set + ` xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">` + "\n")
	n := 0
	for _, r := range rows {
		if n == maxSitemapURLs {
			break
		}
		rowCtx := at(r)
		var loc, mod string
		for i, col := range cols {
			v := col(rowCtx)
			switch headers[i] {
			case "url":
				loc = sv.absoluteURL(strings.TrimSpace(Plain(v)))
			case "changed":
				switch t := v.(type) {
				case Time:
					mod = isoTime(t.T)
				case nil:
				default:
					mod = Plain(t)
				}
			}
		}
		if loc == "" {
			continue
		}
		b.WriteString("  <" + item + "><loc>")
		xml.EscapeText(&b, []byte(loc))
		b.WriteString("</loc>")
		if mod != "" {
			b.WriteString("<lastmod>")
			xml.EscapeText(&b, []byte(mod))
			b.WriteString("</lastmod>")
		}
		b.WriteString("</" + item + ">\n")
		n++
	}
	b.WriteString("</" + set + ">\n")
	return b.Bytes()
}

// robots is /robots.txt when the app has none of its own: everyone may crawl but the runtime's
// own pages (/_…), and the sitemaps the app declares, when it knows its address (--base-url).
func (sv *Server) robots(w http.ResponseWriter) {
	var b strings.Builder
	b.WriteString("User-agent: *\nDisallow: /_\n")
	if sv.App.PublicBase != "" {
		for _, route := range Sitemaps {
			b.WriteString("Sitemap: " + sv.App.PublicBase + route + "\n")
		}
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("Cache-Control", "public, max-age=3600")
	w.WriteHeader(200)
	w.Write([]byte(b.String()))
}

// Export runs the view for the signed-in person and writes its rows in the format.
func (sv *Server) Export(rc *RCtx, format, view string, e *Entity, as string, args map[string]Val, filename Val, headers []string, cols []func(c *Ctx) Val) Download {
	c := rc.Ctx()
	res := sv.App.Run(rc.Req.Sess, view, args, rc.Who.Actor, c.Req, nil)
	if res.Outcome != "ok" {
		return Download{Outcome: res.Outcome}
	}
	rows := rc.Req.Sess.RowsOf(e, res.Rows)
	name := safeFilename(Plain(filename), format)
	at := func(r *Row) *Ctx { // the row, and its name (export … as m)
		n := c.OnRow(e, r)
		if as != "" {
			n.Vars = copyVars(c.Vars)
			n.Vars[as] = Ref{E: e.Name, ID: r.ID}
		}
		return n
	}
	if format == "sitemap" || format == "sitemap_index" {
		return Download{Name: name, Type: "application/xml; charset=utf-8", Body: sv.sitemap(rc.Req.Sess, format == "sitemap_index", rows, at, headers, cols), Outcome: "ok", Inline: true, Public: rc.Who.Actor == nil}
	}
	if format == "json" {
		out := make([]map[string]any, 0, len(rows))
		for _, r := range rows {
			rowCtx := at(r)
			o := make(map[string]any, len(cols))
			for i, col := range cols {
				o[headers[i]] = sv.exportJSON(rc.Req.Sess, col(rowCtx))
			}
			out = append(out, o)
		}
		b, _ := json.MarshalIndent(out, "", "  ")
		return Download{Name: name, Type: "application/json", Body: append(b, '\n'), Outcome: "ok"}
	}
	var buf bytes.Buffer
	w := csv.NewWriter(&buf)
	w.Write(headers)
	for _, r := range rows {
		rowCtx := at(r)
		rec := make([]string, len(cols))
		for i, col := range cols {
			rec[i] = csvCell(sv.exportText(rc.Req.Sess, col(rowCtx)))
		}
		w.Write(rec)
	}
	w.Flush()
	return Download{Name: name, Type: "text/csv; charset=utf-8", Body: buf.Bytes(), Outcome: "ok"}
}

// a value as a CSV cell's text: times in ISO 8601 (UTC), rows by their display, rich text as
// its text, files by name, lists joined with "; "
func (sv *Server) exportText(s *Sess, v Val) string {
	switch x := v.(type) {
	case nil:
		return ""
	case Time:
		return isoTime(x.T)
	case Ref:
		return sv.displayOf(s, x)
	case Rich:
		return x.Text
	case bool:
		return strconv.FormatBool(x)
	case List:
		parts := make([]string, len(x))
		for i, e := range x {
			parts[i] = sv.exportText(s, e)
		}
		return strings.Join(parts, "; ")
	case Obj:
		if _, ok := x["stored"]; ok {
			return Plain(x["file"])
		}
		b, _ := json.Marshal(sv.exportJSON(s, x))
		return string(b)
	}
	return Plain(v)
}

// a value in a JSON export: times in ISO 8601, rows as {id, label}, rich text as its text,
// files as their metadata only (name, type, size), lists and objects element by element
func (sv *Server) exportJSON(s *Sess, v Val) any {
	switch x := v.(type) {
	case nil:
		return nil
	case Time:
		return isoTime(x.T)
	case Dur:
		return x.MS
	case Ref:
		return map[string]any{"id": x.ID, "label": sv.displayOf(s, x)}
	case Rich:
		return x.Text
	case List:
		out := make([]any, len(x))
		for i, e := range x {
			out[i] = sv.exportJSON(s, e)
		}
		return out
	case Obj:
		if _, ok := x["stored"]; ok {
			return map[string]any{"filename": Plain(x["file"]), "type": Plain(x["content_type"]), "size": Num(x["size"])}
		}
		out := make(map[string]any, len(x))
		for k, e := range x {
			out[k] = sv.exportJSON(s, e)
		}
		return out
	}
	return v
}

// csvCell keeps a spreadsheet from reading a cell as a formula (=, +, -, @, tab, return).
func csvCell(s string) string {
	if s != "" && strings.ContainsRune("=+-@\t\r", rune(s[0])) {
		return "'" + s
	}
	return s
}

// safeFilename: no path, quotes or control characters, and the format's extension.
func safeFilename(name, format string) string {
	name = strings.Map(func(r rune) rune {
		if r == '/' || r == '\\' || r == '"' || r == ':' || unicode.IsControl(r) {
			return '_'
		}
		return r
	}, strings.TrimSpace(name))
	name = strings.TrimLeft(name, ".")
	if name == "" {
		name = "export"
	}
	ext := format
	if format == "sitemap" || format == "sitemap_index" {
		ext = "xml"
	}
	if !strings.HasSuffix(strings.ToLower(name), "."+ext) {
		name += "." + ext
	}
	return name
}

// serveDownload writes the file, with its name for a plain client and, encoded, for any other.
func serveDownload(w http.ResponseWriter, d Download) {
	ascii := strings.Map(func(r rune) rune {
		if r > 126 {
			return '_'
		}
		return r
	}, d.Name)
	w.Header().Set("Content-Type", d.Type)
	if d.Inline {
		w.Header().Set("Content-Disposition", "inline")
	} else {
		w.Header().Set("Content-Disposition", `attachment; filename="`+ascii+`"; filename*=UTF-8''`+url.PathEscape(d.Name))
	}
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if d.Public {
		w.Header().Set("Cache-Control", "public, max-age=600")
	} else {
		w.Header().Set("Cache-Control", "private, no-store")
	}
	w.Write(d.Body)
}
