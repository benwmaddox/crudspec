package rt

// The generated statement functions' side of the store: a query the generator compiled to one
// statement (its SQL a constant, its parameters bound typed) takes a connection, binds, and
// scans here. Its answers are kept for a read-only request under a key of the statement's
// number and its typed parameters, so a page that asks the same question for every message
// asks the database once, and a prefetch (PrefetchKids) fills the same keys.

// MK is a statement's answer's key: its number, and up to two integers and a text.
type MK struct {
	Q    int32
	A, B int64
	S    string
}

// Stmt is q, prepared on the writer while the session writes, else on a reader taken from the
// pool; the reader goes back when its rows are scanned (ScanAll, ScanCount) or Release.
func (s *Sess) Stmt(q string) (*Stmt, *Conn) {
	s.countStmt(q)
	if s.writing {
		s.DB.W.mu.Lock()
		st, err := s.DB.W.prep(q)
		if err != nil {
			s.DB.W.mu.Unlock()
			panic(err)
		}
		return st, nil
	}
	cn := s.DB.R.Get()
	st, err := cn.prep(q)
	if err != nil {
		s.DB.R.Put(cn)
		panic(err)
	}
	return st, cn
}

// Release gives back the connection Stmt took.
func (s *Sess) Release(st *Stmt, cn *Conn) {
	st.Reset()
	if cn == nil {
		s.DB.W.mu.Unlock()
	} else {
		s.DB.R.Put(cn)
	}
}

// ScanAll is the statement's rows, as the session holds them (one *Row per row), read with
// e's scanner.
func (s *Sess) ScanAll(e *Entity, st *Stmt, cn *Conn) []*Row {
	out, fresh := []*Row{}, []*Row(nil)
	for {
		ok, err := st.step()
		if err != nil {
			s.Release(st, cn)
			panic(err)
		}
		if !ok {
			break
		}
		r := e.Scan(st)
		k := key(e.Name, r.ID)
		if have, ok := s.ident[k]; ok {
			out = append(out, have)
			continue
		}
		s.ident[k] = r
		fresh = append(fresh, r)
		out = append(out, r)
	}
	s.Release(st, cn)
	s.loadRich(e, fresh)
	if s.writing {
		if s.orig == nil {
			s.orig = map[rowKey][]any{}
		}
		for _, r := range fresh {
			s.orig[key(e.Name, r.ID)] = r.R.Enc()
		}
	}
	return out
}

// ScanCount is a count(*) statement's answer.
func (s *Sess) ScanCount(st *Stmt, cn *Conn) int64 {
	ok, err := st.step()
	var n int64
	if ok {
		n = st.ColInt(0)
	}
	s.Release(st, cn)
	if err != nil {
		panic(err)
	}
	return n
}

// Kept is a read-only request's answer to k, if it has one (a copy: callers may reorder it).
func (s *Sess) Kept(k MK) ([]*Row, bool) {
	if s.writing {
		return nil, false
	}
	rows, ok := s.kept[k]
	if !ok {
		return nil, false
	}
	return append([]*Row{}, rows...), true
}

// Keep holds rows as the answer to k, for the rest of a read-only request.
func (s *Sess) Keep(k MK, rows []*Row) {
	if s.writing {
		return
	}
	if s.kept == nil {
		s.kept = map[MK][]*Row{}
	}
	s.kept[k] = append([]*Row(nil), rows...)
}

func (s *Sess) KeptCount(k MK) (int64, bool) {
	if s.writing {
		return 0, false
	}
	n, ok := s.keptN[k]
	return n, ok
}
func (s *Sess) KeepCount(k MK, n int64) {
	if s.writing {
		return
	}
	if s.keptN == nil {
		s.keptN = map[MK]int64{}
	}
	s.keptN[k] = n
}

// ReadWhere records a statement's reads for a live page (the session is recording).
func (s *Sess) ReadWhere(e *Entity, where string, args ...any) { s.readWhere(e, where, args) }

// ReadKept records the rows a query returned, for live pages (readRows).
func (s *Sess) ReadKept(e *Entity, rows []*Row) { s.readRows(e, rows, false) }

// PrefetchKids answers statement q (rows of e whose reference field col is a given parent,
// the parent its one parameter, in that order) for every parent at once: one query, grouped,
// kept as each parent's answer under q's key.
func (s *Sess) PrefetchKids(e *Entity, q int32, col int, order string, parents []*Row) []*Row {
	if s.writing || !e.Stored || len(parents) < 2 {
		return nil
	}
	ids := make([]int64, 0, len(parents))
	groups := map[int64][]*Row{}
	for _, p := range parents {
		if _, done := groups[p.ID]; !done {
			ids = append(ids, p.ID)
			groups[p.ID] = []*Row{}
			if s.Reads != nil {
				s.read(valKey(e.Name, e.Fields[col].Name, p.ID))
				s.read(anyKey(e.Name))
			}
		}
	}
	rows := s.scan(e, s.query("SELECT "+e.Cols+" FROM "+Q(e.Name)+" t0 WHERE t0."+Q(e.Fields[col].Name)+" IN (SELECT value FROM json_each(?)) ORDER BY "+order, idsJSON(ids)))
	for _, r := range rows {
		if ref, ok := r.Get(col).(Ref); ok {
			groups[ref.ID] = append(groups[ref.ID], r)
		}
	}
	for id, g := range groups {
		s.Keep(MK{Q: q, A: id}, g)
	}
	return rows
}

func BoolInt(b bool) int64 {
	if b {
		return 1
	}
	return 0
}

// ---- typed binds of the language's values

func (s *Stmt) Ref(i int, r Ref) {
	if r.ID == 0 {
		s.Null(i)
	} else {
		s.Int(i, r.ID)
	}
}
func (s *Stmt) OptText(i int, o Opt[string]) {
	if o.Ok {
		s.Text(i, o.V)
	} else {
		s.Null(i)
	}
}
func (s *Stmt) OptInt(i int, o Opt[int64]) {
	if o.Ok {
		s.Int(i, o.V)
	} else {
		s.Null(i)
	}
}
func (s *Stmt) OptBool(i int, o Opt[bool]) {
	if o.Ok {
		s.Bool(i, o.V)
	} else {
		s.Null(i)
	}
}
