package rt

import (
	"encoding/base64"
	"encoding/json"
	"net/url"
	"strings"
)

// Paging: a view with `page n` (and no window) gives one page of its rows at a time, in its
// order. Where a page starts is a cursor: the order's values on the row before it, so the next page
// is the rows after those (a keyset; SQLite reads only the page, through an index in that order,
// not every row before it as an offset would). The cursor is opaque to whoever holds it: a screen's
// list has it in its address (?after.<view>=…), an agent sends it back as cursor.
//
// Its condition goes last in the SQL, after the view's own, and what the page reads is recorded as
// the view's own condition: a superset of every page's rows, so a commit to any of them drops it.

// keysetPage: n rows after the request's cursor, and the cursor after them when there are more
func (c *Ctx) keysetPage(q *Query, n int, args ...any) []*Row {
	cols := splitTop(q.SQLOrder)
	order, cmp := q.SQLOrder, ">"
	if q.Desc {
		order, cmp = q.SQLOrderDesc, "<"
	}
	// rows with the same order are told apart by when they were made, so none is skipped or shown twice
	if last := strings.TrimSpace(cols[len(cols)-1]); last != "t0.seq" && last != "t0.id" {
		cols = append(cols, "t0.seq")
		if q.Desc {
			order += ",t0.seq DESC"
		} else {
			order += ",t0.seq"
		}
	}
	where, all := q.SQL, append([]any{}, args...)
	if c.Req != nil && c.Req.Cursor != "" {
		vals, ok := decodeCursor(c.Req.Cursor, len(cols))
		if !ok {
			Refuse("invalid", "the cursor isn't one this view gave: start again without it", "cursor")
		}
		cond := "(" + strings.Join(cols, ", ") + ") " + cmp + " (" + strings.TrimSuffix(strings.Repeat("?, ", len(cols)), ", ") + ")"
		if where == "" {
			where = cond
		} else {
			where = "(" + where + ") AND " + cond
		}
		all = append(all, vals...)
	}
	c.S.readWhere(q.E, q.SQL, args)
	rows := c.S.selectOrdered(q.E, where, order, n+1, all...)
	if c.Req != nil {
		c.Req.Next = ""
	}
	if len(rows) > n {
		rows = rows[:n]
		if c.Req != nil {
			c.Req.Next = c.cursorAt(q.E, cols, rows[n-1].ID)
		}
	}
	c.S.readRows(q.E, rows, false)
	c.S.readOrder(q.E, q.SQL, q.OrderReads)
	return rows
}

// splitTop: an ORDER BY's columns, split at the commas outside parentheses (a subquery or a
// function call is one column)
func splitTop(s string) []string {
	var out []string
	depth, start := 0, 0
	inStr := byte(0)
	for i := 0; i < len(s); i++ {
		ch := s[i]
		switch {
		case inStr != 0:
			if ch == inStr {
				inStr = 0
			}
		case ch == '\'' || ch == '"':
			inStr = ch
		case ch == '(':
			depth++
		case ch == ')':
			depth--
		case ch == ',' && depth == 0:
			out = append(out, strings.TrimSpace(s[start:i]))
			start = i + 1
		}
	}
	return append(out, strings.TrimSpace(s[start:]))
}

// cursorAt: the order's values on a row, as stored, encoded
func (c *Ctx) cursorAt(e *Entity, cols []string, id int64) string {
	vals := make([]any, len(cols))
	ptrs := make([]any, len(cols))
	for i := range vals {
		ptrs[i] = &vals[i]
	}
	rows := c.S.query("SELECT "+strings.Join(cols, ", ")+" FROM "+Q(e.Name)+" t0 WHERE t0.id = ?", id)
	if rows == nil {
		return ""
	}
	defer rows.Close()
	if !rows.Next() || rows.Scan(ptrs...) != nil {
		return ""
	}
	b, _ := json.Marshal(vals)
	return base64.RawURLEncoding.EncodeToString(b)
}

// decodeCursor: a cursor's values, as many as the order has columns, each a number or text
func decodeCursor(cur string, n int) ([]any, bool) {
	b, err := base64.RawURLEncoding.DecodeString(cur)
	if err != nil {
		return nil, false
	}
	d := json.NewDecoder(strings.NewReader(string(b)))
	d.UseNumber()
	var vals []any
	if d.Decode(&vals) != nil || len(vals) != n {
		return nil, false
	}
	for i, v := range vals {
		switch x := v.(type) {
		case json.Number:
			if k, err := x.Int64(); err == nil {
				vals[i] = k
			} else if f, err := x.Float64(); err == nil {
				vals[i] = f
			} else {
				return nil, false
			}
		case string:
		default:
			return nil, false
		}
	}
	return vals, true
}

// PagerParam is a paged list's cursor in its screen's address
func PagerParam(view string) string { return "after." + view }

// ViewPage is a paged view's rows for a screen's list, from the cursor in the address, and the
// cursor after them ("" on the last page). A cursor that isn't the view's gives its first page.
func (sv *Server) ViewPage(rc *RCtx, view string, raw map[string]Val) ([]Ref, string) {
	req := rc.Req.request(rc.Who, "get")
	req.Cursor = rc.Req.Query.Get(PagerParam(view))
	out := sv.App.Run(rc.Req.Sess, view, raw, rc.Who.Actor, req, nil)
	if out.Outcome == "invalid" && req.Cursor != "" {
		req.Cursor = ""
		out = sv.App.Run(rc.Req.Sess, view, raw, rc.Who.Actor, req, nil)
	}
	return out.Rows, req.Next
}

// PagerHTML: the links after a paged list: to the next page (this list's cursor in the address,
// the rest of it kept), and back to the first once past it
func (sv *Server) PagerHTML(rc *RCtx, view, next string) string {
	cls := sv.dc("pager") // the theme's class for it (classes { pager: "…" }), or pager
	if cls == "" {
		cls = "pager"
	}
	param := PagerParam(view)
	at := rc.Req.Query.Get(param)
	if next == "" && at == "" {
		return ""
	}
	link := func(cur string) string {
		v := url.Values{}
		for k, xs := range rc.Req.Query {
			v[k] = append([]string{}, xs...)
		}
		v.Del(param)
		if cur != "" {
			v.Set(param, cur)
		}
		qs := v.Encode()
		if qs == "" {
			return rc.Req.Path
		}
		return rc.Req.Path + "?" + qs
	}
	var b strings.Builder
	b.WriteString(`<nav class="` + Esc(cls) + `" aria-label="More">`)
	if at != "" {
		b.WriteString(`<a href="` + Esc(link("")) + `" rel="first">Back to the start</a>`)
	}
	if next != "" {
		b.WriteString(`<a href="` + Esc(link(next)) + `" rel="next">Next</a>`)
	}
	b.WriteString(`</nav>`)
	return b.String()
}
