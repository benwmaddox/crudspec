package rt

import (
	"bytes"
	"encoding/csv"
	"encoding/json"
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
	if !strings.HasSuffix(strings.ToLower(name), "."+format) {
		name += "." + format
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
	w.Header().Set("Content-Disposition", `attachment; filename="`+ascii+`"; filename*=UTF-8''`+url.PathEscape(d.Name))
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "private, no-store")
	w.Write(d.Body)
}
