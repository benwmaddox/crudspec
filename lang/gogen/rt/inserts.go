package rt

// Inserts from typed rows: the generated row struct binds its own columns (Rec.Bind), and a
// batch of new rows (a loop's ensure) goes in InsertMany rows per statement.

// InsertRec writes a new row of a stored entity from its typed fields (a generated create).
func (s *Sess) InsertRec(e *Entity, rec Rec, now int64) *Row {
	s.mustWrite()
	r := s.newRow(e, rec, now)
	st, cn := s.Stmt(e.InsertSQL)
	at := bindMeta(st, 1, r)
	rec.Bind(st, at)
	err := st.Run()
	s.Release(st, cn)
	s.constraint(err, e.Name)
	s.inserted(e, r)
	return r
}

// InsertRecs writes new rows of a stored entity: InsertMany at a time, the rest one by one.
func (s *Sess) InsertRecs(e *Entity, recs []Rec, now int64) []*Row {
	s.mustWrite()
	rows := make([]*Row, len(recs))
	for i, rec := range recs {
		rows[i] = s.newRow(e, rec, now)
	}
	i := 0
	for ; e.InsertMany > 1 && len(rows)-i >= e.InsertMany; i += e.InsertMany {
		st, cn := s.Stmt(e.InsertManySQL)
		at := 1
		for _, r := range rows[i : i+e.InsertMany] {
			at = r.R.Bind(st, bindMeta(st, at, r))
		}
		err := st.Run()
		s.Release(st, cn)
		s.constraint(err, e.Name)
	}
	for ; i < len(rows); i++ {
		st, cn := s.Stmt(e.InsertSQL)
		rows[i].R.Bind(st, bindMeta(st, 1, rows[i]))
		err := st.Run()
		s.Release(st, cn)
		s.constraint(err, e.Name)
	}
	for _, r := range rows {
		s.inserted(e, r)
	}
	return rows
}

func (s *Sess) newRow(e *Entity, rec Rec, now int64) *Row {
	id := s.DB.nextID[e.Name]
	if id == 0 {
		id = 1
	}
	s.DB.nextID[e.Name] = id + 1
	r := &Row{ID: id, Seq: s.DB.seq, Created: now, Updated: now, R: rec}
	s.DB.seq++
	return r
}

func bindMeta(st *Stmt, at int, r *Row) int {
	st.Int(at, r.ID)
	st.Int(at+1, r.Seq)
	st.Int(at+2, r.Created)
	st.Int(at+3, r.Updated)
	return at + 4
}

// inserted records a new row: the session holds it, live pages and the cache are told (as
// wrote does for a row made: every column, and the keys of its values), the change is logged.
func (s *Sess) inserted(e *Entity, r *Row) {
	if len(e.RichFields) > 0 {
		s.writeRich(e, r.ID, nil, r.R.Enc(), true)
	}
	s.ident[key(e.Name, r.ID)] = r
	if s.wkeys == nil {
		s.wkeys = Deps{}
	}
	w := s.wkeys
	w.Add(tableKey(e.Name))
	w.Add(rowLK(e.Name, r.ID))
	w.Add(timeKey(e.Name, r.ID))
	for _, f := range e.Fields {
		w.Add(colKey(e.Name, f.Name))
	}
	for _, c := range []string{"id", "updated", "seq", "created"} {
		w.Add(colKey(e.Name, c))
	}
	r.R.Keys(e.Name, w)
	delete(s.firsts, e.Name)
	s.Log = append(s.Log, Change{E: e.Name, ID: r.ID, Op: "create"})
}

// BindEnc binds one stored value (Enc's form) from position at, as Flat spreads it; the next
// position.
func BindEnc(st *Stmt, at int, v any) int {
	for _, x := range Flat([]any{v}) {
		st.BindAny(at, x)
		at++
	}
	return at
}

// KeyIDs are the values of a unique key's varying column already stored, among ids, with its
// other columns as given: the statement's parameters are those, then the ids as JSON.
func (s *Sess) KeyIDs(q string, fixed []int64, ids []int64) map[int64]bool {
	have := map[int64]bool{}
	if len(ids) == 0 {
		return have
	}
	st, cn := s.Stmt(q)
	for i, f := range fixed {
		st.Int(i+1, f)
	}
	st.Text(len(fixed)+1, idsJSON(ids))
	for {
		ok, err := st.step()
		if err != nil {
			s.Release(st, cn)
			panic(err)
		}
		if !ok {
			break
		}
		have[st.ColInt(0)] = true
	}
	s.Release(st, cn)
	return have
}
