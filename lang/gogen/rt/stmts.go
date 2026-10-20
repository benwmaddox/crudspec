package rt

import (
	"fmt"
	"strconv"
	"strings"
)

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
	if rd := s.reader(); rd != nil {
		return rd.Prep(q), rd
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
	} else if cn != s.rd { // the snapshot's reader stays the session's
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
// the parent its one parameter, in that order) for every parent at once.
func (s *Sess) PrefetchKids(e *Entity, q int32, col int, order string, parents []*Row) []*Row {
	ids := make([]int64, len(parents))
	for i, p := range parents {
		ids[i] = p.ID
	}
	return s.PrefetchBy(e, q, col, order, ids)
}

// PrefetchBy answers statement q (rows of e whose reference field col is a given row, that
// row its one parameter, in that order) for each of ids at once: one query, grouped, kept as
// each one's answer under q's key. A loop over rows that asks q for each (a list's children,
// a nested loop's rows) then asks the database once.
func (s *Sess) PrefetchBy(e *Entity, q int32, col int, order string, ids []int64) []*Row {
	if s.writing || !e.Stored {
		return nil
	}
	want := make([]int64, 0, len(ids))
	groups := map[int64][]*Row{}
	for _, id := range ids {
		if _, done := groups[id]; done || id == 0 {
			continue
		}
		if _, kept := s.kept[MK{Q: q, A: id}]; kept {
			continue
		}
		want = append(want, id)
		groups[id] = []*Row{}
		if s.Reads != nil {
			s.read(valKey(e.Name, e.Fields[col].Name, id))
			s.read(anyKey(e.Name))
		}
	}
	if len(want) < 2 {
		return nil
	}
	rows := s.scan(e, s.query("SELECT "+e.Cols+" FROM "+Q(e.Name)+" t0 WHERE t0."+Q(e.Fields[col].Name)+" IN (SELECT value FROM json_each(?)) ORDER BY "+order, idsJSON(want)))
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

// ---- a statement's reads for live pages, as the generator found them (livekeys.ts)

// ReadEq records rows of e whose col holds the value with key k (keyVal's form).
func (s *Sess) ReadEq(e, col, k string) {
	s.read(LK{K: '=', E: e, Col: col, Val: k})
	s.read(anyKey(e))
}

// ReadRow records one row of e, by id.
func (s *Sess) ReadRow(e string, id int64) {
	s.read(rowLK(e, id))
	s.read(anyKey(e))
}

// ReadTable records e read whole; ReadCol, as far as one column.
func (s *Sess) ReadTable(e string)     { s.read(tableKey(e)) }
func (s *Sess) ReadCol(e, col string) { s.read(colKey(e, strings.TrimSuffix(col, "__seq"))) }

// typed values in keyVal's form
func KRef(r Ref) string {
	if r.ID == 0 {
		return "~"
	}
	return strconv.FormatInt(r.ID, 10)
}
func KInt(n int64) string { return strconv.FormatInt(n, 10) }
func KBool(b bool) string {
	if b {
		return "1"
	}
	return "0"
}
func KOptBool(o Opt[bool]) string {
	if !o.Ok {
		return "~"
	}
	return KBool(o.V)
}

// AddValKey adds a stored value's key, as Sess.wrote does.
func AddValKey(d Deps, e, col string, v any) {
	if keyable(v) {
		d.Add(valKey(e, col, v))
	}
}

func KOptText(o Opt[string]) string {
	if !o.Ok {
		return "~"
	}
	return o.V
}
func KOptInt(o Opt[int64]) string {
	if !o.Ok {
		return "~"
	}
	return strconv.FormatInt(o.V, 10)
}

// liveKeysText is a parse as livekeys.ts writes one.
func liveKeysText(ks []readKey) string {
	parts := make([]string, len(ks))
	for i, k := range ks {
		if k.col != "" {
			parts[i] = k.table + "." + k.col + "@" + strconv.Itoa(k.arg)
		} else {
			parts[i] = k.table + "[" + strings.Join(k.cols, ",") + "]"
		}
	}
	return strings.Join(parts, ";")
}

// CheckLiveKeys is whether the generator found the reads parseWhere finds, for every statement.
func CheckLiveKeys(checks [][3]string) error {
	for _, c := range checks {
		if got := liveKeysText(parseWhere(c[0], c[1])); got != c[2] {
			return fmt.Errorf("live keys of %s WHERE %s: the generator has %q, the runtime %q", c[0], c[1], c[2], got)
		}
	}
	return nil
}

// ---- one snapshot per request: a request's reads all see the database as it was at its first
// read (one read transaction on one reader), until it writes or ends. Request sessions opt in
// (Snapshot); a session that lives long (a workflow, a schedule) reads statement by statement,
// so it never holds the log back from being checkpointed.

// reader is the session's snapshot connection, begun on first use; nil when it doesn't keep one.
func (s *Sess) reader() *Conn {
	if !s.Snapshot || s.writing {
		return nil
	}
	if s.rd == nil {
		// the version first: every commit it counts is in the snapshot (a commit is published
		// after it is made), so what the request shows is at least as new as the version it
		// says (the page's live data, the fragment cache's entries)
		s.snapV = s.DB.Version.Load()
		cn := s.DB.R.Get()
		if err := cn.Exec("BEGIN"); err != nil {
			s.DB.R.Put(cn)
			panic(err)
		}
		// the read transaction starts at the first read of the database: now
		if err := cn.Exec("SELECT 1 FROM sqlite_master LIMIT 1"); err != nil {
			cn.Exec("ROLLBACK")
			s.DB.R.Put(cn)
			panic(err)
		}
		s.rd = cn
	}
	return s.rd
}

// ReadVersion is the data version the session's reads show: its snapshot's, or the current one.
func (s *Sess) ReadVersion() int64 {
	if s.reader() != nil {
		return s.snapV
	}
	return s.DB.Version.Load()
}

// EndSnapshot ends the session's read transaction and gives the reader back (before it writes,
// when it ends, before a request that only waits: the live stream).
func (s *Sess) EndSnapshot() {
	if s.rd == nil {
		return
	}
	cn := s.rd
	s.rd = nil
	if err := cn.Exec("COMMIT"); err != nil {
		cn.Exec("ROLLBACK")
	}
	s.DB.R.Put(cn)
}
