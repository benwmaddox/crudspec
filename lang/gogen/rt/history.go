package rt

import (
	"bytes"
	"encoding/json"
	"strconv"
	"strings"
)

// Change history (entity … { history }): every change to a row of such an entity is kept in
// crudspec_history, in the same transaction as the change, so a refused action leaves none:
//   - a create and a delete, with the row's id;
//   - each field set, with what it held and what it holds now (a Password as "changed", never
//     its value), whoever set it (the actor, or the schedule or workflow) and in which action.
// <History of={row} /> shows a row's, newest first; the admin section shows it on a row's form.
// An upgrade keeps the table (upgradeMeta).

const historyTable = `CREATE TABLE IF NOT EXISTS crudspec_history (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, entity TEXT NOT NULL, row INTEGER NOT NULL, op TEXT NOT NULL, field TEXT NOT NULL DEFAULT '', old TEXT, new TEXT, actor TEXT NOT NULL DEFAULT '', action TEXT NOT NULL DEFAULT '');
CREATE INDEX IF NOT EXISTS crudspec_history_row ON crudspec_history (entity, row, id)`

// prepareHistory makes the table as the app starts, outside any transaction, when an entity keeps
// its history (a refused first change can't take the table back with it)
func (a *App) prepareHistory() {
	keeps := false
	for _, e := range a.Ents {
		keeps = keeps || e.History
	}
	if !keeps {
		return
	}
	a.DB.mu.Lock()
	defer a.DB.mu.Unlock()
	for _, q := range strings.Split(historyTable, ";\n") {
		if err := a.DB.W.Exec(q); err != nil {
			panic(err)
		}
	}
	a.DB.historyMade = true
}

// who did it: the actor's entity and id ("User:7"), or nothing for a schedule or a workflow
func historyActor(c *Ctx) string {
	if r, ok := c.Actor.(Ref); ok && r.ID != 0 {
		return r.E + ":" + strconv.FormatInt(r.ID, 10)
	}
	return ""
}

// History records one change to a row of an entity that keeps its history, from a generated
// setter: field i went from before to after
func (c *Ctx) History(e *Entity, id int64, i int, before, after Val) {
	if e.History {
		c.S.history(e, id, "update", i, before, after, c.Now(), historyActor(c))
	}
}

// historyRow records a create or a delete, with who and when the session's action says
func (s *Sess) historyRow(e *Entity, id int64, op string) {
	if e.History {
		at := int64(0)
		if s.Clock != nil {
			at = s.Clock()
		}
		actor := ""
		if r, ok := s.Actor.(Ref); ok && r.ID != 0 {
			actor = r.E + ":" + strconv.FormatInt(r.ID, 10)
		}
		s.history(e, id, op, 0, nil, nil, at, actor)
	}
}

func (s *Sess) history(e *Entity, id int64, op string, i int, before, after Val, at int64, actor string) {
	field, oldS, newS := "", any(nil), any(nil)
	if op == "update" {
		f := e.Fields[i]
		field = f.Name
		if f.Type == "Password" {
			oldS, newS = "", "changed"
		} else {
			oldS, newS = historyEnc(before), historyEnc(after)
		}
	}
	if err := s.exec(`INSERT INTO crudspec_history (at, entity, row, op, field, old, new, actor, action) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		at, e.Name, id, op, field, oldS, newS, actor, s.Action); err != nil {
		panic(err)
	}
}

// a value as the history keeps it: a row as its entity and id (so it shows by its label when read),
// anything else as the text it shows as; none as NULL
func historyEnc(v Val) any {
	switch x := v.(type) {
	case nil:
		return nil
	case Ref:
		if x.ID == 0 {
			return nil
		}
		b, _ := json.Marshal(map[string]any{"ref": x.E, "id": x.ID})
		return string(b)
	}
	b, _ := json.Marshal(map[string]any{"text": jsString(v)})
	return string(b)
}
func historyDec(s string) Val {
	var x struct {
		Ref  string `json:"ref"`
		ID   int64  `json:"id"`
		Text string `json:"text"`
	}
	if json.Unmarshal([]byte(s), &x) != nil {
		return s
	}
	if x.Ref != "" {
		return Ref{E: x.Ref, ID: x.ID}
	}
	return x.Text
}

// HistoryEntry is one change, as <History> shows it
type HistoryEntry struct {
	At            int64
	Op, Field     string
	Old, New      Val
	Password      bool
	Actor, Action string
}

// HistoryOf is a row's changes, newest first (at most n)
func (s *Sess) HistoryOf(e *Entity, id int64, n int) []HistoryEntry {
	if e == nil || !e.History || !s.DB.historyMade {
		return nil
	}
	rows, err := s.DB.A.Query(`SELECT at, op, field, old, new, actor, action FROM crudspec_history WHERE entity = ? AND row = ? ORDER BY id DESC LIMIT ?`, e.Name, id, n)
	if err != nil {
		return nil
	}
	defer rows.Close()
	out := []HistoryEntry{}
	for rows.Next() {
		var h HistoryEntry
		var oldS, newS *string
		if rows.Scan(&h.At, &h.Op, &h.Field, &oldS, &newS, &h.Actor, &h.Action) != nil {
			continue
		}
		if i, ok := e.Index[h.Field]; ok && e.Fields[i].Type == "Password" {
			h.Password = true
		} else {
			if oldS != nil {
				h.Old = historyDec(*oldS)
			}
			if newS != nil {
				h.New = historyDec(*newS)
			}
		}
		out = append(out, h)
	}
	return out
}

// WriteHistory is <History of={row} />: the row's changes, newest first, as a list. A private
// field's values aren't shown unless showPrivate (the admin section's)
func (sv *Server) WriteHistory(w *bytes.Buffer, rc *RCtx, of Val, limit int, showPrivate bool) {
	r, ok := of.(Ref)
	if !ok || r.ID == 0 {
		return
	}
	e := sv.App.Ents[r.E]
	if e == nil || !e.History {
		return
	}
	s := rc.Req.Sess
	s.read(rowLK(e.Name, r.ID)) // every change writes the row: a live page, and the cache, are told of it
	if limit <= 0 {
		limit = 50
	}
	entries := s.HistoryOf(e, r.ID, limit)
	w.WriteString(`<ol class="history">`)
	if len(entries) == 0 {
		w.WriteString(`<li>No changes yet.</li>`)
	}
	for _, h := range entries {
		w.WriteString(`<li>`)
		WriteTimeHTML(w, Time{T: h.At}, "date", func() string { return "history__when" })
		w.WriteString(" ")
		WriteTimeHTML(w, Time{T: h.At}, "time", func() string { return "history__when" })
		w.WriteString(` <span class="history__who">`)
		if who := sv.historyWho(s, h.Actor); who != "" {
			WriteEsc(w, who)
		} else if h.Action != "" {
			WriteEsc(w, h.Action)
		} else {
			w.WriteString("the app")
		}
		w.WriteString(`</span> `)
		switch h.Op {
		case "create":
			w.WriteString("created it")
		case "delete":
			w.WriteString("deleted it")
		default:
			w.WriteString(`set <strong>`)
			WriteEsc(w, strings.ReplaceAll(h.Field, "_", " "))
			w.WriteString(`</strong>`)
			i, known := e.Index[h.Field]
			switch {
			case h.Password:
				w.WriteString(" (a new password)")
			case known && e.Fields[i].Private && !showPrivate:
				w.WriteString(" (private)")
			default:
				w.WriteString(` from <del>`)
				WriteEsc(w, sv.historyText(s, h.Old))
				w.WriteString(`</del> to <ins>`)
				WriteEsc(w, sv.historyText(s, h.New))
				w.WriteString(`</ins>`)
			}
		}
		w.WriteString(`</li>`)
	}
	w.WriteString(`</ol>`)
}

// a value as the history shows it: a row by its label, none as "nothing"
func (sv *Server) historyText(s *Sess, v Val) string {
	switch x := v.(type) {
	case nil:
		return "nothing"
	case Ref:
		if x.ID == 0 {
			return "nothing"
		}
		return sv.displayOf(s, x)
	}
	if t := jsString(v); t != "" {
		return t
	}
	return "nothing"
}

func (sv *Server) historyWho(s *Sess, actor string) string {
	e, id, ok := strings.Cut(actor, ":")
	if !ok {
		return ""
	}
	n, err := strconv.ParseInt(id, 10, 64)
	if err != nil {
		return ""
	}
	return sv.displayOf(s, Ref{E: e, ID: n})
}
