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
	cols      string // the SELECT list, in spec order
}

func (e *Entity) Prepare() {
	e.Index = map[string]int{}
	cols := []string{"t0.id", "t0.seq", "t0.created", "t0.updated"}
	for i, f := range e.Fields {
		e.Index[f.Name] = i
		cols = append(cols, "t0."+Q(f.Name))
	}
	e.cols = strings.Join(cols, ", ")
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
}

func Open(path string, ents map[string]*Entity) (*DB, error) {
	dsn := "file:" + path + "?_journal_mode=WAL&_synchronous=NORMAL&_busy_timeout=5000&_foreign_keys=off"
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
	out := []*Row{}
	n := len(e.Fields)
	for rows.Next() {
		raw := make([]any, 4+n)
		ptrs := make([]any, 4+n)
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
		for i, f := range e.Fields {
			r.F[i] = decode(f, raw[4+i])
		}
		s.ident[key(e.Name, id)] = r
		out = append(out, r)
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

func decode(f Field, v any) Val {
	if v == nil {
		return nil
	}
	switch f.Kind {
	case 'r':
		return Ref{E: f.Ref, ID: toInt(v)}
	case 'i':
		return toInt(v)
	case 'b':
		return toInt(v) == 1
	case 't':
		switch x := v.(type) {
		case string:
			return x
		case []byte:
			return string(x)
		}
		return fmt.Sprint(v)
	default:
		switch x := v.(type) {
		case string:
			return FromJSON(x)
		case []byte:
			return FromJSON(string(x))
		}
		return nil
	}
}

// Encode is a stored value, and a parameter to compare a column with.
func Encode(f Field, v Val) any {
	if v == nil {
		return nil
	}
	switch f.Kind {
	case 'r':
		if r, ok := v.(Ref); ok {
			return r.ID
		}
		return nil
	case 'i':
		return Num(v)
	case 'b':
		if Truthy(v) {
			return int64(1)
		}
		return int64(0)
	case 't':
		return Plain(v)
	}
	return JSON(v)
}

// Param encodes a value for comparing with a column of the given kind, as the planner does:
// a value that can't equal the column becomes one that never matches.
func SQLParam(kind byte, v Val) any {
	const nomatch = "\x00no match"
	if v == nil {
		return nil
	}
	switch kind {
	case 'r', 'd': // a reference, or an id
		if r, ok := v.(Ref); ok {
			return r.ID
		}
		return int64(-1)
	case 't':
		switch x := v.(type) {
		case string:
			return x
		case Rich:
			return x.Text
		}
		return nomatch
	case 'b':
		if b, ok := v.(bool); ok {
			if b {
				return int64(1)
			}
			return int64(0)
		}
		return int64(-1)
	case 'i':
		if isNum(v) {
			return Num(v)
		}
		return nomatch
	}
	return nomatch
}

// ParamList encodes a set or list for `col IN (SELECT value FROM json_each(?))`.
func ParamList(kind byte, refEntity string, v Val) string {
	switch x := v.(type) {
	case Set:
		if (kind == 'r' || kind == 'd') && x.E == refEntity {
			return JSON(nonNilIDs(x.IDs))
		}
		return "[]"
	case List:
		out := []any{}
		for _, e := range x {
			p := SQLParam(kind, e)
			if p == nil || p == "\x00no match" || p == int64(-1) {
				continue
			}
			out = append(out, p)
		}
		return JSON(out)
	}
	return "[]"
}

func (s *Sess) Select(e *Entity, where string, args ...any) []*Row {
	if !e.Stored {
		return append([]*Row{}, e.Data...)
	}
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

func (s *Sess) selectSQL(e *Entity, where string, args ...any) []*Row {
	q := "SELECT " + e.cols + " FROM " + Q(e.Name) + " t0"
	if where != "" {
		q += " WHERE " + where
	}
	return s.scan(e, s.query(q+" ORDER BY t0.seq", args...))
}

func (s *Sess) Count(e *Entity, where string, args ...any) int64 {
	if !e.Stored {
		return int64(len(e.Data))
	}
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
	if r, ok := s.ident[key(e.Name, id)]; ok {
		return r
	}
	rows := s.scan(e, s.query("SELECT "+e.cols+" FROM "+Q(e.Name)+" t0 WHERE t0.id = ?", id))
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
	if r, ok := s.firsts[e.Name]; ok {
		return r
	}
	rows := s.scan(e, s.query("SELECT "+e.cols+" FROM "+Q(e.Name)+" t0 ORDER BY t0.seq LIMIT 1"))
	var r *Row
	if len(rows) > 0 {
		r = rows[0]
	}
	s.firsts[e.Name] = r
	return r
}

// rows whose field holds a value (references, for cascades)
func (s *Sess) Where(e *Entity, field string, v Val) []*Row {
	if !e.Stored {
		out := []*Row{}
		i := e.Index[field]
		for _, r := range e.Data {
			if Equal(r.F[i], v) {
				out = append(out, r)
			}
		}
		return out
	}
	f := e.Fields[e.Index[field]]
	return s.Select(e, "t0."+Q(field)+" = ?", Encode(f, v))
}

// a row other than except with the same full key (empty values never clash)
func (s *Sess) Clash(e *Entity, cols []string, fields []Val, except int64) *Row {
	conds, args := []string{}, []any{}
	for _, c := range cols {
		i := e.Index[c]
		if fields[i] == nil {
			return nil
		}
		conds = append(conds, "t0."+Q(c)+" = ?")
		args = append(args, Encode(e.Fields[i], fields[i]))
	}
	args = append(args, except)
	rows := s.Select(e, strings.Join(conds, " AND ")+" AND t0.id != ?", args...)
	if len(rows) == 0 {
		return nil
	}
	return rows[0]
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
	cols, marks, args := "id, seq, created, updated", "?, ?, ?, ?", []any{r.ID, r.Seq, r.Created, r.Updated}
	for i, f := range e.Fields {
		cols += ", " + Q(f.Name)
		marks += ", ?"
		args = append(args, Encode(f, fields[i]))
	}
	s.constraint(s.exec("INSERT INTO "+Q(e.Name)+" ("+cols+") VALUES ("+marks+")", args...), e.Name)
	s.ident[key(e.Name, id)] = r
	delete(s.firsts, e.Name)
	s.Log = append(s.Log, Change{E: e.Name, ID: id, Op: "create"})
	return r
}

func (s *Sess) Save(e *Entity, r *Row, fields []string) {
	if !e.Stored {
		return
	}
	s.mustWrite()
	sets, args := "updated = ?", []any{r.Updated}
	for i, f := range e.Fields {
		sets += ", " + Q(f.Name) + " = ?"
		args = append(args, Encode(f, r.F[i]))
	}
	args = append(args, r.ID)
	s.constraint(s.exec("UPDATE "+Q(e.Name)+" SET "+sets+" WHERE id = ?", args...), e.Name)
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
	delete(s.ident, key(e.Name, id))
	delete(s.firsts, e.Name)
	s.Log = append(s.Log, Change{E: e.Name, ID: id, Op: "delete"})
}

// Load writes a row exactly as given (the test protocol).
func (s *Sess) Load(e *Entity, r *Row) {
	cols, marks, args := "id, seq, created, updated", "?, ?, ?, ?", []any{r.ID, r.Seq, r.Created, r.Updated}
	for i, f := range e.Fields {
		cols += ", " + Q(f.Name)
		marks += ", ?"
		args = append(args, Encode(f, r.F[i]))
	}
	if err := s.exec("INSERT INTO "+Q(e.Name)+" ("+cols+") VALUES ("+marks+")", args...); err != nil {
		panic(err)
	}
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
			s.DB.Version.Add(1)
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
	s.DB.Version.Add(1)
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
	}
	s.ident = map[rowKey]*Row{}
	s.firsts = map[string]*Row{}
}

// Autocommit marks a write made outside a transaction (workflow steps) as visible to pages.
func (s *Sess) Autocommit() { s.DB.Version.Add(1) }

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
