package rt

import (
	"strconv"
	"strings"
)

// Rich-text fields keep their mentions and link previews in two tables each, written with the
// row (in its transaction) and read for a batch of rows at once.

// writeRich rewrites the tables of each rich field whose value changed (old nil: all).
func (s *Sess) writeRich(e *Entity, id int64, old, now []any) {
	for _, rf := range e.RichFields {
		if old != nil && rf.Idx < len(old) && keyVal(old[rf.Idx]) == keyVal(now[rf.Idx]) {
			continue
		}
		s.richDelete(rf, id)
		rc, _ := now[rf.Idx].(RichCol)
		if rc.None {
			continue
		}
		for i, m := range rc.Mentions {
			s.mustExec(`INSERT INTO `+Q(rf.Mentions)+` (row, pos, entity, ref) VALUES (?, ?, ?, ?)`, id, i, rc.Entity, m)
		}
		for i, x := range rc.Embeds {
			o, _ := x.(Obj)
			if o == nil {
				if m, ok := x.(map[string]any); ok {
					o = Obj(m)
				}
			}
			var img any
			if v := o["image"]; v != nil {
				img = Plain(v)
			}
			s.mustExec(`INSERT INTO `+Q(rf.Embeds)+` (row, pos, url, title, description, image) VALUES (?, ?, ?, ?, ?, ?)`, id, i, Plain(o["url"]), Plain(o["title"]), Plain(o["description"]), img)
		}
	}
}

func (s *Sess) richDelete(rf RichField, id int64) {
	s.mustExec(`DELETE FROM `+Q(rf.Mentions)+` WHERE row = ?`, id)
	s.mustExec(`DELETE FROM `+Q(rf.Embeds)+` WHERE row = ?`, id)
}

func (s *Sess) mustExec(q string, args ...any) {
	if err := s.exec(q, args...); err != nil {
		panic(err)
	}
}

// loadRich fills the rich fields of freshly read rows with their mentions and previews.
func (s *Sess) loadRich(e *Entity, rows []*Row) {
	if len(e.RichFields) == 0 || len(rows) == 0 {
		return
	}
	byID := make(map[int64]*Row, len(rows))
	for _, r := range rows {
		byID[r.ID] = r
	}
	for start := 0; start < len(rows); start += 500 {
		end := min(start+500, len(rows))
		ids := make([]string, 0, end-start)
		for _, r := range rows[start:end] {
			ids = append(ids, strconv.FormatInt(r.ID, 10))
		}
		in := strings.Join(ids, ",")
		for _, rf := range e.RichFields {
			q := s.query(`SELECT row, entity, ref FROM ` + Q(rf.Mentions) + ` WHERE row IN (` + in + `) ORDER BY row, pos`)
			for q.Next() {
				var id, ref int64
				var ent string
				q.Scan(&id, &ent, &ref)
				if r := byID[id]; r != nil {
					if v, ok := r.F[rf.Idx].(Rich); ok {
						v.Mentions, v.Entity = append(v.Mentions, ref), ent
						r.F[rf.Idx] = v
					}
				}
			}
			q.Close()
			q = s.query(`SELECT row, url, title, description, image FROM ` + Q(rf.Embeds) + ` WHERE row IN (` + in + `) ORDER BY row, pos`)
			for q.Next() {
				var id int64
				var url, title, desc string
				var img *string
				q.Scan(&id, &url, &title, &desc, &img)
				if r := byID[id]; r != nil {
					if v, ok := r.F[rf.Idx].(Rich); ok {
						var im Val
						if img != nil {
							im = *img
						}
						v.Embeds = append(v.Embeds, Obj{"url": url, "title": title, "description": desc, "image": im})
						r.F[rf.Idx] = v
					}
				}
			}
			q.Close()
		}
	}
}
