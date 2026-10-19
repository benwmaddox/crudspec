package rt

import (
	"database/sql"
	"fmt"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"

	_ "github.com/mattn/go-sqlite3"
)

// ---- the schema, generated from the spec

type Field struct {
	Name     string
	Kind     byte // 'r' reference, 't' text, 'i' int, 'b' bool, 'j' JSON
	Ref      string
	Type     string
	Optional bool
}
type Entity struct {
	Name      string
	Fields    []Field
	Index     map[string]int
	Uniques   [][]string
	Stored    bool // false for reference data (`data`), which lives in memory
	Singleton bool
	Data      []*Row
	// generated (gen.ts): the entity compiled
	Decode       func(raw []any) []Val // stored columns to values
	Encode       func(f []Val) []any   // values to stored values, one per field (a Time's is a TimeCol: two columns, see Flat)
	NCols        int                   // the stored columns after id, seq, created, updated
	RichFields   []RichField           // rich-text fields: their mentions and previews tables (richstore.go)
	Create       func(c *Ctx, f []Val, set uint64, ensure bool) (Ref, bool)
	Setters      map[string]func(c *Ctx, target Val, v Val)
	Delete       func(c *Ctx, ref Ref)
	TouchParents func(c *Ctx, r *Row)
	AgentRow     func(a *Agents, s *Sess, ref Ref, row *Row) map[string]any // the row as agents see it (no private fields)
	Cols      string // the SELECT list, in spec order
	InsertSQL string
	UpdateSQL string
}

type Row struct {
	ID, Seq, Created, Updated int64
	F                         []Val
}

func Q(n string) string { return `"` + strings.ReplaceAll(n, `"`, `""`) + `"` }

// ---- the database: one writer connection, a pool of readers (WAL)

type DB struct {
	W, R    *sql.DB
	mu      sync.Mutex // one writer at a time
	nextID  map[string]int64
	seq     int64
	stmtsMu sync.Mutex
	wStmts  map[string]*sql.Stmt
	rStmts  map[string]*sql.Stmt
	Version atomic.Int64 // bumps on every commit, for live pages
	Live    Live         // the recent commits' keys, for live pages (live.go)
	Cache   FragCache    // rendered fragments (cache.go)
	IDs     IDCache      // the session lookup's answers (idcache.go)
}

func Open(path string, ents map[string]*Entity) (*DB, error) {
	dsn := "file:" + path + "?_journal_mode=" + JournalMode + "&_synchronous=NORMAL&_busy_timeout=5000&_foreign_keys=off"
	w, err := sql.Open("sqlite3", dsn)
	if err != nil {
		return nil, err
	}
	w.SetMaxOpenConns(1)
	w.SetMaxIdleConns(1)
	w.SetConnMaxIdleTime(0)
	r, err := sql.Open("sqlite3", dsn+"&mode=ro")
	if err != nil {
		return nil, err
	}
	r.SetMaxOpenConns(16)
	r.SetMaxIdleConns(16)
	db := &DB{W: w, R: r, nextID: map[string]int64{}, wStmts: map[string]*sql.Stmt{}, rStmts: map[string]*sql.Stmt{}}
	seq := int64(1)
	var s sql.NullString
	if w.QueryRow(`SELECT value FROM crudspec_meta WHERE key = 'seq'`).Scan(&s); s.Valid {
		fmt.Sscan(s.String, &seq)
	}
	for name, e := range ents {
		if !e.Stored {
			continue
		}
		var maxID, maxSeq sql.NullInt64
		w.QueryRow(`SELECT max(id), max(seq) FROM ` + Q(name)).Scan(&maxID, &maxSeq)
		db.nextID[name] = maxID.Int64 + 1
		if maxSeq.Int64+1 > seq {
			seq = maxSeq.Int64 + 1
		}
	}
	db.seq = seq
	return db, nil
}

func (db *DB) stmt(write bool, q string) *sql.Stmt {
	db.stmtsMu.Lock()
	defer db.stmtsMu.Unlock()
	m, conn := db.rStmts, db.R
	if write {
		m, conn = db.wStmts, db.W
	}
	if s, ok := m[q]; ok {
		return s
	}
	s, err := conn.Prepare(q)
	if err != nil {
		panic(fmt.Errorf("prepare %s: %w", q, err))
	}
	m[q] = s
	return s
}

// ---- a request's view of the store: an identity map, and the writer while it writes

type Change struct {
	E      string
	ID     int64
	Op     string // create, update, delete
	Fields []string
}

type Sess struct {
	DB      *DB
	Ents    map[string]*Entity
	writing bool
	depth   int
	ident   map[rowKey]*Row
	firsts  map[string]*Row
	Log     []Change
	Auto    bool // writes take the writer themselves, outside transactions (workflows)
	dirty   bool
	memo    map[string][]*Row
	counts  map[string]int64
	saved   []struct{ next map[string]int64; seq int64 }
	Reads   Deps                // what a live page's render read (nil: not recording; live.go)
	wkeys   Deps                // what this transaction wrote, for live pages
	orig    map[rowKey][]any    // rows as they were when a write session first read them
	frags   []*fragState        // the fragments being rendered, innermost last (frag.go)
	AllReads Deps               // everything a page read, fragments' too (kept for the test endpoints)
	capture  Deps               // reads being collected besides (a page's gates, reused by every button)
}

func (db *DB) Session(ents map[string]*Entity) *Sess {
	return &Sess{DB: db, Ents: ents, ident: map[rowKey]*Row{}, firsts: map[string]*Row{}}
}

type rowKey struct {
	e  string
	id int64
}

func key(e string, id int64) rowKey { return rowKey{e, id} }

func (s *Sess) query(q string, args ...any) *sql.Rows {
	rows, err := s.DB.stmt(s.writing, q).Query(args...)
	if err != nil {
		panic(fmt.Errorf("query %s: %w", q, err))
	}
	return rows
}

func (s *Sess) scan(e *Entity, rows *sql.Rows) []*Row {
	defer rows.Close()
	out, fresh := []*Row{}, []*Row(nil)
	n := len(e.Fields)
	nc := e.NCols
	if nc == 0 {
		nc = n
	}
	for rows.Next() {
		raw := make([]any, 4+nc)
		ptrs := make([]any, 4+nc)
		for i := range raw {
			ptrs[i] = &raw[i]
		}
		if err := rows.Scan(ptrs...); err != nil {
			panic(err)
		}
		id := toInt(raw[0])
		if have, ok := s.ident[key(e.Name, id)]; ok {
			out = append(out, have)
			continue
		}
		r := &Row{ID: id, Seq: toInt(raw[1]), Created: toInt(raw[2]), Updated: toInt(raw[3]), F: make([]Val, n)}
		r.F = e.Decode(raw[4:])
		s.ident[key(e.Name, id)] = r
		fresh = append(fresh, r)
		out = append(out, r)
	}
	s.loadRich(e, fresh)
	if s.writing {
		if s.orig == nil {
			s.orig = map[rowKey][]any{}
		}
		for _, r := range fresh {
			s.orig[key(e.Name, r.ID)] = e.Encode(r.F)
		}
	}
	return out
}

func toInt(v any) int64 {
	switch x := v.(type) {
	case int64:
		return x
	case float64:
		return int64(x)
	case []byte:
		var n int64
		fmt.Sscan(string(x), &n)
		return n
	case string:
		var n int64
		fmt.Sscan(x, &n)
		return n
	}
	return 0
}

func (s *Sess) Select(e *Entity, where string, args ...any) []*Row {
	if !e.Stored {
		return append([]*Row{}, e.Data...)
	}
	s.readWhere(e, where, args)
	// a read-only request asks the same questions many times (a button per message): the
	// answers are kept for the request, until it writes
	var k string
	if !s.writing {
		k = memoKey(e.Name, where, args)
		if rows, ok := s.memo[k]; ok {
			return append([]*Row{}, rows...)
		}
	}
	rows := s.selectSQL(e, where, args...)
	if !s.writing {
		if s.memo == nil {
			s.memo = map[string][]*Row{}
		}
		s.memo[k] = rows
		return append([]*Row{}, rows...)
	}
	return rows
}

// SelectOrdered is Select with the order and limit in the SQL: orderBy is the ORDER BY's columns
// ("t0.created, t0.seq" or "t0.created DESC, t0.seq DESC"); limit < 0 is no limit. Kept for the
// request like Select.
func (s *Sess) SelectOrdered(e *Entity, where, orderBy string, limit int, args ...any) []*Row {
	s.readWhere(e, where, args)
	var k string
	if !s.writing {
		k = memoKey(e.Name, where+"\x00"+orderBy+"\x00"+strconv.Itoa(limit), args)
		if rows, ok := s.memo[k]; ok {
			return append([]*Row{}, rows...)
		}
	}
	q := "SELECT " + e.Cols + " FROM " + Q(e.Name) + " t0"
	if where != "" {
		q += " WHERE " + where
	}
	q += " ORDER BY " + orderBy
	if limit >= 0 {
		q += " LIMIT " + strconv.Itoa(limit)
	}
	rows := s.scan(e, s.query(q, args...))
	if !s.writing {
		if s.memo == nil {
			s.memo = map[string][]*Row{}
		}
		s.memo[k] = rows
		return append([]*Row{}, rows...)
	}
	return rows
}

func (s *Sess) selectSQL(e *Entity, where string, args ...any) []*Row {
	q := "SELECT " + e.Cols + " FROM " + Q(e.Name) + " t0"
	if where != "" {
		q += " WHERE " + where
	}
	return s.scan(e, s.query(q+" ORDER BY t0.seq", args...))
}

func (s *Sess) Count(e *Entity, where string, args ...any) int64 {
	if !e.Stored {
		return int64(len(e.Data))
	}
	s.readWhere(e, where, args)
	var k string
	if !s.writing {
		k = memoKey("#"+e.Name, where, args)
		if n, ok := s.counts[k]; ok {
			return n
		}
	}
	n := s.countSQL(e, where, args...)
	if !s.writing {
		if s.counts == nil {
			s.counts = map[string]int64{}
		}
		s.counts[k] = n
	}
	return n
}

func (s *Sess) countSQL(e *Entity, where string, args ...any) int64 {
	q := "SELECT count(*) FROM " + Q(e.Name) + " t0"
	if where != "" {
		q += " WHERE " + where
	}
	rows := s.query(q, args...)
	defer rows.Close()
	var n int64
	if rows.Next() {
		rows.Scan(&n)
	}
	return n
}

func (s *Sess) Find(e *Entity, id int64) *Row {
	if !e.Stored {
		for _, r := range e.Data {
			if r.ID == id {
				return r
			}
		}
		return nil
	}
	if s.Reads != nil {
		s.read(rowLK(e.Name, id))
	}
	if r, ok := s.ident[key(e.Name, id)]; ok {
		return r
	}
	rows := s.scan(e, s.query("SELECT "+e.Cols+" FROM "+Q(e.Name)+" t0 WHERE t0.id = ?", id))
	if len(rows) == 0 {
		return nil
	}
	return rows[0]
}

func (s *Sess) First(e *Entity) *Row {
	if !e.Stored {
		if len(e.Data) > 0 {
			return e.Data[0]
		}
		return nil
	}
	s.read(tableKey(e.Name))
	if r, ok := s.firsts[e.Name]; ok {
		return r
	}
	rows := s.scan(e, s.query("SELECT "+e.Cols+" FROM "+Q(e.Name)+" t0 ORDER BY t0.seq LIMIT 1"))
	var r *Row
	if len(rows) > 0 {
		r = rows[0]
	}
	s.firsts[e.Name] = r
	return r
}

func (s *Sess) exec(q string, args ...any) error {
	_, err := s.DB.stmt(true, q).Exec(args...)
	return err
}

func (s *Sess) constraint(err error, e string) {
	if err == nil {
		return
	}
	if strings.Contains(err.Error(), "UNIQUE constraint") {
		panic(&Outcome{O: "invalid", Msg: "unique (" + e + ")", Cause: "unique"})
	}
	panic(err)
}

func (s *Sess) Insert(e *Entity, fields []Val, now int64) *Row {
	if !e.Stored {
		id := int64(len(e.Data) + 1)
		r := &Row{ID: id, Seq: id, Created: now, Updated: now, F: fields}
		e.Data = append(e.Data, r)
		return r
	}
	s.mustWrite()
	id := s.DB.nextID[e.Name]
	if id == 0 {
		id = 1
	}
	s.DB.nextID[e.Name] = id + 1
	r := &Row{ID: id, Seq: s.DB.seq, Created: now, Updated: now, F: fields}
	s.DB.seq++
	enc := e.Encode(fields)
	s.constraint(s.exec(e.InsertSQL, append([]any{r.ID, r.Seq, r.Created, r.Updated}, Flat(enc)...)...), e.Name)
	s.writeRich(e, id, nil, enc)
	s.ident[key(e.Name, id)] = r
	s.wrote(e, id, nil, enc)
	delete(s.firsts, e.Name)
	s.Log = append(s.Log, Change{E: e.Name, ID: id, Op: "create"})
	return r
}

func (s *Sess) Save(e *Entity, r *Row, fields []string) {
	if !e.Stored {
		return
	}
	s.mustWrite()
	enc := e.Encode(r.F)
	args := append([]any{r.Updated}, Flat(enc)...)
	s.constraint(s.exec(e.UpdateSQL, append(args, r.ID)...), e.Name)
	k := key(e.Name, r.ID)
	s.writeRich(e, r.ID, s.orig[k], enc)
	if len(fields) == 0 {
		s.touched(e, r.ID) // only its time
	} else {
		s.wrote(e, r.ID, s.orig[k], enc)
	}
	if s.orig != nil {
		s.orig[k] = enc
	}
	if len(fields) > 0 {
		s.Log = append(s.Log, Change{E: e.Name, ID: r.ID, Op: "update", Fields: fields})
	}
}

func (s *Sess) Remove(e *Entity, id int64) {
	if !e.Stored {
		for i, r := range e.Data {
			if r.ID == id {
				e.Data = append(e.Data[:i], e.Data[i+1:]...)
				break
			}
		}
		return
	}
	s.mustWrite()
	if err := s.exec("DELETE FROM "+Q(e.Name)+" WHERE id = ?", id); err != nil {
		panic(err)
	}
	for _, rf := range e.RichFields {
		s.richDelete(rf, id)
	}
	old := s.orig[key(e.Name, id)]
	if r, ok := s.ident[key(e.Name, id)]; ok {
		old = append(old, e.Encode(r.F)...)
	}
	s.wrote(e, id, old, nil)
	delete(s.ident, key(e.Name, id))
	delete(s.firsts, e.Name)
	s.Log = append(s.Log, Change{E: e.Name, ID: id, Op: "delete"})
}

// Load writes a row exactly as given (the test protocol).
func (s *Sess) Load(e *Entity, r *Row) {
	enc := e.Encode(r.F)
	if err := s.exec(e.InsertSQL, append([]any{r.ID, r.Seq, r.Created, r.Updated}, Flat(enc)...)...); err != nil {
		panic(err)
	}
	s.writeRich(e, r.ID, nil, enc)
	if r.ID+1 > s.DB.nextID[e.Name] {
		s.DB.nextID[e.Name] = r.ID + 1
	}
	if r.Seq+1 > s.DB.seq {
		s.DB.seq = r.Seq + 1
	}
}

// ---- transactions: the writer is taken for the session's first write transaction

func (s *Sess) mustWrite() {
	if !s.writing && s.Auto {
		s.Write()
	}
	if s.depth == 0 {
		s.dirty = true
	}
	if !s.writing {
		panic(fmt.Errorf("a write outside a write session"))
	}
}

// Write takes the writer for this session (actions, channels, workflows).
func (s *Sess) Write() {
	if !s.writing {
		s.DB.mu.Lock()
		s.writing = true
		s.ident = map[rowKey]*Row{}
		s.firsts = map[string]*Row{}
		s.memo, s.counts = nil, nil
		s.orig = nil
	}
}

// Done releases the writer, if this session holds it.
func (s *Sess) Done() {
	for s.depth > 0 {
		s.Rollback()
	}
	if s.writing {
		if s.dirty {
			s.dirty = false
			s.publish(false)
		}
		s.writing = false
		s.DB.mu.Unlock()
	}
}

func (s *Sess) Begin() {
	s.Write()
	s.saved = append(s.saved, struct {
		next map[string]int64
		seq  int64
	}{copyMap(s.DB.nextID), s.DB.seq})
	if s.depth == 0 {
		s.execRaw("BEGIN IMMEDIATE")
	} else {
		s.execRaw(fmt.Sprintf("SAVEPOINT s%d", s.depth))
	}
	s.depth++
}

func (s *Sess) Commit() {
	s.depth--
	s.saved = s.saved[:len(s.saved)-1]
	if s.depth > 0 {
		s.execRaw(fmt.Sprintf("RELEASE s%d", s.depth))
		return
	}
	s.exec(`INSERT INTO crudspec_meta (key, value) VALUES ('seq', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, fmt.Sprint(s.DB.seq))
	s.execRaw("COMMIT")
	s.publish(false)
}

func (s *Sess) Rollback() {
	s.depth--
	last := s.saved[len(s.saved)-1]
	s.saved = s.saved[:len(s.saved)-1]
	s.DB.nextID, s.DB.seq = last.next, last.seq
	if s.depth > 0 {
		s.execRaw(fmt.Sprintf("ROLLBACK TO s%d", s.depth))
		s.execRaw(fmt.Sprintf("RELEASE s%d", s.depth))
	} else {
		s.execRaw("ROLLBACK")
		s.wkeys = nil // nothing was written
	}
	s.ident = map[rowKey]*Row{}
	s.firsts = map[string]*Row{}
	s.orig = nil
}

// Autocommit marks a write made outside a transaction (workflow steps) as visible to pages.
func (s *Sess) Autocommit() { s.publish(s.wkeys == nil) }

func (s *Sess) execRaw(q string) {
	if _, err := s.DB.W.Exec(q); err != nil {
		panic(fmt.Errorf("%s: %w", q, err))
	}
}

func copyMap(m map[string]int64) map[string]int64 {
	out := make(map[string]int64, len(m))
	for k, v := range m {
		out[k] = v
	}
	return out
}

// Clear empties every stored table (the test protocol's loads).
func (s *Sess) Clear() {
	s.Write()
	for name, e := range s.Ents {
		if e.Stored {
			s.execRaw("DELETE FROM " + Q(name))
			for _, rf := range e.RichFields {
				s.execRaw("DELETE FROM " + Q(rf.Mentions))
				s.execRaw("DELETE FROM " + Q(rf.Embeds))
			}
			s.DB.nextID[name] = 1
		}
	}
	s.execRaw("DELETE FROM crudspec_meta WHERE key = 'seq'")
	s.DB.seq = 1
	s.ident = map[rowKey]*Row{}
	s.firsts = map[string]*Row{}
}

func memoKey(e, where string, args []any) string {
	b := make([]byte, 0, len(e)+len(where)+16*len(args)+2)
	b = append(b, e...)
	b = append(b, 0)
	b = append(b, where...)
	for _, a := range args {
		b = append(b, 0)
		switch x := a.(type) {
		case nil:
			b = append(b, 'n')
		case int64:
			b = append(b, 'i')
			b = strconv.AppendInt(b, x, 10)
		case string:
			b = append(b, 's')
			b = append(b, x...)
		default:
			b = append(b, 'o')
			b = append(b, fmt.Sprint(x)...)
		}
	}
	return string(b)
}

// ---- prefetch: what a page will read, fetched in a few queries before it is rendered
// (the generator plans it from the page's elements)

// RowsOf are the rows of these references, from the request's rows where they are.
func (s *Sess) RowsOf(e *Entity, refs []Ref) []*Row {
	out := make([]*Row, 0, len(refs))
	for _, r := range refs {
		if row := s.Find(e, r.ID); row != nil {
			out = append(out, row)
		}
	}
	return out
}

func idsJSON(ids []int64) string {
	b := make([]byte, 0, 8*len(ids)+2)
	b = append(b, '[')
	for i, id := range ids {
		if i > 0 {
			b = append(b, ',')
		}
		b = strconv.AppendInt(b, id, 10)
	}
	return string(append(b, ']'))
}

// PrefetchRefs loads, in one query, the rows that rows refer to through field i, and
// returns them all.
func (s *Sess) PrefetchRefs(target *Entity, rows []*Row, i int) []*Row {
	if !target.Stored {
		return nil
	}
	missing, seen := []int64{}, map[int64]bool{}
	for _, r := range rows {
		ref, ok := r.Get(i).(Ref)
		if !ok || seen[ref.ID] {
			continue
		}
		seen[ref.ID] = true
		if _, have := s.ident[key(target.Name, ref.ID)]; !have {
			missing = append(missing, ref.ID)
		}
	}
	if len(missing) > 1 {
		s.selectSQL(target, "t0.id IN (SELECT value FROM json_each(?))", idsJSON(missing))
	}
	out := make([]*Row, 0, len(seen))
	for id := range seen {
		if r := s.Find(target, id); r != nil {
			out = append(out, r)
		}
	}
	return out
}

// PrefetchChildren answers `where` (a single `t0."col" IS ?` on a parent) for every parent
// at once: one query, grouped, kept as each parent's answer for the request.
func (s *Sess) PrefetchChildren(e *Entity, where string, col int, parents []*Row) []*Row {
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
	rows := s.selectSQL(e, "t0."+Q(e.Fields[col].Name)+" IN (SELECT value FROM json_each(?))", idsJSON(ids))
	for _, r := range rows {
		if ref, ok := r.Get(col).(Ref); ok {
			groups[ref.ID] = append(groups[ref.ID], r)
		}
	}
	if s.memo == nil {
		s.memo = map[string][]*Row{}
	}
	for id, g := range groups {
		s.memo[memoKey(e.Name, where, []any{id})] = g
	}
	return rows
}
