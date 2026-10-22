package rt

import (
	"time"
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
	NewRec       func(f []Val) Rec     // its typed fields from dynamic values (generated)
	Scan         Scanner               // one row's columns into its typed fields (generated)
	ScanMask     func(st *Stmt, m uint64) *Row // the fields m says only, as colsFor selects them (prune.go; generated)
	pruned       prunedCache           // column lists and statements for masks (prune.go)
	NCols        int                   // the stored columns after id, seq, created, updated
	FieldCols    [][]string            // each field's columns, quoted (a Time two, a File four), for updates of changed fields only
	RichFields   []RichField           // rich-text fields: their mentions and previews tables (richstore.go)
	Create       func(c *Ctx, f []Val, set uint64, ensure bool) (Ref, bool)
	Setters      map[string]func(c *Ctx, target Val, v Val)
	Delete       func(c *Ctx, ref Ref)
	TouchParents func(c *Ctx, r *Row)
	AgentRow     func(a *Agents, s *Sess, ref Ref, row *Row) map[string]any // the row as agents see it (no private fields)
	Cols      string // the SELECT list, in spec order
	InsertSQL string
	InsertManySQL string // the insert of InsertMany rows at once (inserts.go)
	InsertMany    int
	UpdateSQL string
}

type Row struct {
	ID, Seq, Created, Updated int64
	R                         Rec // its fields (rec.go)
	// its reference, boxed once when the row is made, for reference data's rows: they're shared
	// by every request, so a query over them doesn't box each row again on every use (RowBox)
	Box Val
}

func Q(n string) string { return `"` + strings.ReplaceAll(n, `"`, `""`) + `"` }

// ---- the database: one writer connection, a pool of readers (WAL)

type DB struct {
	W       *Conn // the writer: sessions writing hold mu, and so do the cold paths (mail, schedules, agents)
	R       *Pool // readers, one per query being read
	path    string
	mu      sync.Mutex // one writer at a time
	nextID  map[string]int64
	seq     int64
	Version atomic.Int64 // bumps on every commit, for live pages
	Live    Live         // the recent commits' keys, for live pages (live.go)
	Cache   FragCache    // rendered fragments (cache.go)
	IDs     IDCache      // the session lookup's answers (idcache.go)
	Pages   *PageCache   // whole pages, dropped by keys when PageKeys is on (pagecache.go)
}

// checkpoints copies the WAL into the database, in the background, once a second when there
// were commits since the last
func (db *DB) checkpoints(ck *Conn) {
	last := db.Version.Load()
	for range time.Tick(time.Second) {
		if v := db.Version.Load(); v != last {
			last = v
			ck.Exec("PRAGMA wal_checkpoint(PASSIVE)")
		}
	}
}

func Open(path string, ents map[string]*Entity) (*DB, error) {
	w, err := OpenConn(path, true)
	if err != nil {
		return nil, err
	}
	for _, q := range []string{"PRAGMA journal_mode = " + JournalMode, "PRAGMA synchronous = NORMAL", "PRAGMA foreign_keys = OFF"} {
		if err := w.Exec(q); err != nil { // journal_mode answers with a row, which Run allows
			return nil, err
		}
	}
	r, err := NewPool(path, 32) // a request holds one while it renders (stmts.go)
	if err != nil {
		return nil, err
	}
	db := &DB{W: w, R: r, path: path, nextID: map[string]int64{}}
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
	// the WAL is copied into the database by a checkpoint: SQLite does it in the commit that
	// takes the log past 1000 pages, so that request waits for the copy and its sync. Here a
	// goroutine does it, PASSIVE (it waits for no reader or writer), a second after writes
	if JournalMode == "WAL" {
		if err := w.Exec("PRAGMA wal_autocheckpoint = 0"); err == nil {
			if ck, err := OpenConn(path, true); err == nil {
				go db.checkpoints(ck)
			}
		}
	}
	return db, nil
}

// ---- a request's view of the store: an identity map, and the writer while it writes

type Change struct {
	E      string
	ID     int64
	Op     string // create, update, delete
	Fields []string
}

type Sess struct {
	stmtLog *[]string // the statements run, while an action is counted (actionstats.go)
	DB      *DB
	Ents    map[string]*Entity
	writing bool
	mask    map[string]uint64 // the fields a page reads, by entity, while it renders (prune.go)
	check   bool              // and marks the text fields left out (prune.go)
	depth   int
	ident   map[rowKey]*Row
	firsts  map[string]*Row
	Log     []Change
	Auto    bool // writes take the writer themselves, outside transactions (workflows)
	dirty   bool
	memo    map[string][]*Row
	counts  map[string]int64
	kept    map[MK][]*Row // the generated statements' answers (stmts.go)
	keptN   map[MK]int64
	saved   []struct{ next map[string]int64; seq int64 }
	Reads   Deps                // what a live page's render read (nil: not recording; live.go)
	wkeys   Deps                // what this transaction wrote, for live pages
	orig    map[rowKey][]any    // rows as they were when a write session first read them
	frags   []*fragState        // the fragments being rendered, innermost last (frag.go)
	AllReads Deps               // everything a page read, fragments' too (kept for the test endpoints)
	PageReads IDs               // everything the request read, for the page cache by keys (pagecache.go)
	capture  Deps               // reads being collected besides (a page's gates, reused by every button)
	last     LK                 // the read last recorded (read)
	clockRead bool              // something it rendered read the clock (the page cache doesn't keep it)
	Snapshot bool               // its reads share one snapshot (a request's; stmts.go)
	rd       *Conn              // the snapshot's reader, while it has one
	snapV    int64              // the data version when the snapshot began
	lastOK   bool
}

func (db *DB) Session(ents map[string]*Entity) *Sess {
	return &Sess{DB: db, Ents: ents, ident: map[rowKey]*Row{}, firsts: map[string]*Row{}}
}

type rowKey struct {
	e  string
	id int64
}

func key(e string, id int64) rowKey { return rowKey{e, id} }

// query runs q on the writer while the session writes, else on a reader; the rows hold that
// connection until they are read to the end or closed
func (s *Sess) query(q string, args ...any) *Rows {
	s.countStmt(q)
	if s.writing {
		rows, _ := s.DB.W.Query(q, args...)
		return rows
	}
	if cn := s.reader(); cn != nil {
		st := cn.Prep(q)
		st.BindAll(args)
		return &Rows{S: st}
	}
	rows, _ := s.DB.R.Query(q, args...)
	return rows
}

func (s *Sess) scan(e *Entity, rows *Rows) []*Row {
	defer rows.Close()
	out, fresh := []*Row{}, []*Row(nil)
	for rows.Next() {
		r := s.scanRow(e, rows.S)
		if have, ok := s.ident[key(e.Name, r.ID)]; ok {
			out = append(out, have)
			continue
		}
		s.ident[key(e.Name, r.ID)] = r
		fresh = append(fresh, r)
		out = append(out, r)
	}
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
	q := "SELECT " + s.cols(e) + " FROM " + Q(e.Name) + " t0"
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
	q := "SELECT " + s.cols(e) + " FROM " + Q(e.Name) + " t0"
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
	rows := s.scan(e, s.query("SELECT "+s.cols(e)+" FROM "+Q(e.Name)+" t0 WHERE t0.id = ?", id))
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
	rows := s.scan(e, s.query("SELECT "+s.cols(e)+" FROM "+Q(e.Name)+" t0 ORDER BY t0.seq LIMIT 1"))
	var r *Row
	if len(rows) > 0 {
		r = rows[0]
	}
	s.firsts[e.Name] = r
	return r
}

func (s *Sess) exec(q string, args ...any) error {
	s.countStmt(q)
	return s.DB.W.Exec(q, args...)
}

func (s *Sess) constraint(err error, e string) {
	if err == nil {
		return
	}
	if msg := err.Error(); strings.Contains(msg, "UNIQUE constraint") {
		// "UNIQUE constraint failed: Ban.user, Ban.ip": the key, as the spec says it
		cols := []string{}
		if _, list, ok := strings.Cut(msg, "failed: "); ok {
			for _, c := range strings.Split(list, ", ") {
				if _, f, ok := strings.Cut(strings.TrimSpace(c), "."); ok {
					cols = append(cols, f)
				}
			}
		}
		if len(cols) > 0 {
			panic(&Outcome{O: "invalid", Msg: "unique (" + e + ": " + strings.Join(cols, ", ") + ")", Cause: "unique"})
		}
		panic(&Outcome{O: "invalid", Msg: "unique (" + e + ")", Cause: "unique"})
	}
	panic(err)
}

func (s *Sess) Insert(e *Entity, fields []Val, now int64) *Row {
	if !e.Stored {
		id := int64(len(e.Data) + 1)
		r := &Row{ID: id, Seq: id, Created: now, Updated: now, R: ValsRec(fields), Box: Ref{E: e.Name, ID: id}}
		e.Data = append(e.Data, r)
		return r
	}
	return s.InsertRec(e, e.NewRec(fields), now)
}

func (s *Sess) Save(e *Entity, r *Row, fields []string) {
	if !e.Stored {
		return
	}
	s.mustWrite()
	// a touch: only its time changes, so only that is written (nothing else to encode or compare)
	if len(fields) == 0 && s.orig[key(e.Name, r.ID)] != nil {
		s.constraint(s.exec("UPDATE "+Q(e.Name)+" SET updated = ? WHERE id = ?", r.Updated, r.ID), e.Name)
		s.touched(e, r.ID)
		return
	}
	enc := r.R.Enc()
	k := key(e.Name, r.ID)
	// only the columns that changed since the row was read (a touch: only its time), so a
	// row's large or searchable text isn't written again when something else changes; a row
	// this session didn't read as stored (one it made) is written whole
	if old := s.orig[k]; old != nil && len(old) == len(enc) && len(e.FieldCols) == len(enc) {
		var b strings.Builder
		b.WriteString("UPDATE " + Q(e.Name) + " SET updated = ?")
		args := []any{r.Updated}
		for i := range enc {
			if keyVal(old[i]) == keyVal(enc[i]) {
				continue
			}
			for _, c := range e.FieldCols[i] {
				b.WriteString(", " + c + " = ?")
			}
			args = append(args, Flat(enc[i:i+1])...)
		}
		b.WriteString(" WHERE id = ?")
		s.constraint(s.exec(b.String(), append(args, r.ID)...), e.Name)
	} else {
		args := append([]any{r.Updated}, Flat(enc)...)
		s.constraint(s.exec(e.UpdateSQL, append(args, r.ID)...), e.Name)
	}
	s.writeRich(e, r.ID, s.orig[k], enc, false)
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
		old = append(old, r.R.Enc()...)
	}
	s.wrote(e, id, old, nil)
	delete(s.ident, key(e.Name, id))
	delete(s.firsts, e.Name)
	s.Log = append(s.Log, Change{E: e.Name, ID: id, Op: "delete"})
}

// Load writes a row exactly as given (the test protocol).
func (s *Sess) Load(e *Entity, r *Row) {
	enc := r.R.Enc()
	if err := s.exec(e.InsertSQL, append([]any{r.ID, r.Seq, r.Created, r.Updated}, Flat(enc)...)...); err != nil {
		panic(err)
	}
	s.writeRich(e, r.ID, nil, enc, false)
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
		s.EndSnapshot() // its writes see the database as it is now
		s.DB.mu.Lock()
		s.writing = true
		s.ident = map[rowKey]*Row{}
		s.firsts = map[string]*Row{}
		s.memo, s.counts = nil, nil
		s.kept, s.keptN = nil, nil
		s.orig = nil
	}
}

// Done releases the writer, if this session holds it.
func (s *Sess) Done() {
	defer s.EndSnapshot()
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
	s.countStmt(q)
	if err := s.DB.W.Exec(q); err != nil {
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

// SaveField writes one field of a row with the statement the generator made for it
// (UPDATE "E" SET updated = ?, <the field's columns> = ? WHERE id = ?): a set writes exactly
// what it changes. What live pages and the cache are told, the change, and the row as the
// session holds it are as Save records them.
func (s *Sess) SaveField(e *Entity, r *Row, i int, sql string) {
	if !e.Stored {
		return
	}
	s.mustWrite()
	enc := r.R.Enc()
	args := append([]any{r.Updated}, Flat(enc[i:i+1])...)
	s.constraint(s.exec(sql, append(args, r.ID)...), e.Name)
	k := key(e.Name, r.ID)
	s.wrote(e, r.ID, s.orig[k], enc)
	if s.orig != nil {
		s.orig[k] = enc
	}
	s.Log = append(s.Log, Change{E: e.Name, ID: r.ID, Op: "update", Fields: []string{e.Fields[i].Name}})
}
