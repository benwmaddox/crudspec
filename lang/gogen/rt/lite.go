package rt

// SQLite, called directly: its C API, typed (bind an int64, read a column as text), with no
// database/sql and no interface per value. The library is the one mattn/go-sqlite3 compiles in,
// linked once. A Conn is one connection with its own prepared statements; it isn't safe for
// two goroutines at once, so the DB keeps one writer (behind its lock) and a pool of readers.
// Exec, Query and QueryRow, binding from any and scanning into pointers, serve the code that
// isn't on a request's path (agents' tokens, the outbox, schedules, the test protocol); the
// generated code binds and reads typed.

/*
#cgo LDFLAGS: -ldl -lm
#include <stdlib.h>
typedef struct sqlite3 sqlite3;
typedef struct sqlite3_stmt sqlite3_stmt;
int sqlite3_open_v2(const char*, sqlite3**, int, const char*);
int sqlite3_close_v2(sqlite3*);
int sqlite3_busy_timeout(sqlite3*, int);
const char* sqlite3_errmsg(sqlite3*);
int sqlite3_prepare_v2(sqlite3*, const char*, int, sqlite3_stmt**, const char**);
int sqlite3_finalize(sqlite3_stmt*);
int sqlite3_bind_int64(sqlite3_stmt*, int, long long);
int sqlite3_bind_double(sqlite3_stmt*, int, double);
int sqlite3_bind_null(sqlite3_stmt*, int);
int sqlite3_bind_text(sqlite3_stmt*, int, const char*, int, void(*)(void*));
int sqlite3_bind_blob(sqlite3_stmt*, int, const void*, int, void(*)(void*));
int sqlite3_clear_bindings(sqlite3_stmt*);
int sqlite3_step(sqlite3_stmt*);
int sqlite3_reset(sqlite3_stmt*);
int sqlite3_column_count(sqlite3_stmt*);
int sqlite3_column_type(sqlite3_stmt*, int);
long long sqlite3_column_int64(sqlite3_stmt*, int);
double sqlite3_column_double(sqlite3_stmt*, int);
const unsigned char* sqlite3_column_text(sqlite3_stmt*, int);
const void* sqlite3_column_blob(sqlite3_stmt*, int);
int sqlite3_column_bytes(sqlite3_stmt*, int);
int sqlite3_changes(sqlite3*);
static int lite_bind_text(sqlite3_stmt* s, int i, const char* p, int n) { return sqlite3_bind_text(s, i, p, n, (void(*)(void*))-1); }
static int lite_bind_blob(sqlite3_stmt* s, int i, const void* p, int n) { return sqlite3_bind_blob(s, i, p, n, (void(*)(void*))-1); }
*/
import "C"

import (
	"database/sql"
	"errors"
	"fmt"
	"reflect"
	"strconv"
	"sync"
	"unsafe"

	_ "github.com/mattn/go-sqlite3" // compiles SQLite in; nothing here goes through its driver
)

const (
	liteOpenReadOnly  = 0x00000001
	liteOpenReadWrite = 0x00000002
	liteOpenCreate    = 0x00000004
	liteOpenNoMutex   = 0x00008000
	liteRow           = 100
	liteDone          = 101
	liteInteger       = 1
	liteFloat         = 2
	liteText          = 3
	liteBlob          = 4
	liteNull          = 5
)

// Conn is one SQLite connection and the statements prepared on it.
type Conn struct {
	db    *C.sqlite3
	mu    sync.Mutex // the cold paths' Exec and Query hold it; a session holds a reader for itself
	stmts map[string]*Stmt
}

// Stmt is a prepared statement: bind, step, read the columns, reset.
type Stmt struct {
	s *C.sqlite3_stmt
	c *Conn
	q string
}

type LiteError struct{ Msg, SQL string }

func (e *LiteError) Error() string { return e.Msg }

func OpenConn(path string, write bool) (*Conn, error) {
	p := C.CString(path)
	defer C.free(unsafe.Pointer(p))
	flags := C.int(liteOpenReadOnly | liteOpenNoMutex)
	if write {
		flags = liteOpenReadWrite | liteOpenCreate | liteOpenNoMutex
	}
	var db *C.sqlite3
	if rc := C.sqlite3_open_v2(p, &db, flags, nil); rc != 0 {
		msg := "unable to open database file"
		if db != nil {
			msg = C.GoString(C.sqlite3_errmsg(db))
			C.sqlite3_close_v2(db)
		}
		return nil, errors.New(msg + ": " + path)
	}
	C.sqlite3_busy_timeout(db, 5000)
	return &Conn{db: db, stmts: map[string]*Stmt{}}, nil
}

func (c *Conn) Close() {
	for _, s := range c.stmts {
		C.sqlite3_finalize(s.s)
	}
	C.sqlite3_close_v2(c.db)
}

func (c *Conn) err(q string) error { return &LiteError{Msg: C.GoString(C.sqlite3_errmsg(c.db)), SQL: q} }

// Prep is the statement for q, prepared once on this connection.
func (c *Conn) Prep(q string) *Stmt {
	st, err := c.prep(q)
	if err != nil {
		panic(err)
	}
	return st
}
func (c *Conn) prep(q string) (*Stmt, error) {
	if s, ok := c.stmts[q]; ok {
		return s, nil
	}
	p := C.CString(q)
	defer C.free(unsafe.Pointer(p))
	var s *C.sqlite3_stmt
	if rc := C.sqlite3_prepare_v2(c.db, p, -1, &s, nil); rc != 0 {
		return nil, fmt.Errorf("prepare %s: %w", q, c.err(q))
	}
	st := &Stmt{s: s, c: c, q: q}
	c.stmts[q] = st
	return st, nil
}

// ---- typed binds and columns (positions from 1 for binds, 0 for columns, as SQLite has them)

func (s *Stmt) Int(i int, v int64)     { C.sqlite3_bind_int64(s.s, C.int(i), C.longlong(v)) }
func (s *Stmt) Float(i int, v float64) { C.sqlite3_bind_double(s.s, C.int(i), C.double(v)) }
func (s *Stmt) Null(i int)             { C.sqlite3_bind_null(s.s, C.int(i)) }
func (s *Stmt) Bool(i int, v bool) {
	if v {
		s.Int(i, 1)
	} else {
		s.Int(i, 0)
	}
}
func (s *Stmt) Text(i int, v string) {
	if len(v) == 0 { // a nil pointer would bind NULL, not the empty text
		C.lite_bind_text(s.s, C.int(i), (*C.char)(unsafe.Pointer(&emptyText[0])), 0)
		return
	}
	C.lite_bind_text(s.s, C.int(i), (*C.char)(unsafe.Pointer(unsafe.StringData(v))), C.int(len(v)))
}
func (s *Stmt) Blob(i int, v []byte) {
	if len(v) == 0 {
		C.lite_bind_blob(s.s, C.int(i), unsafe.Pointer(&emptyText[0]), 0)
		return
	}
	C.lite_bind_blob(s.s, C.int(i), unsafe.Pointer(&v[0]), C.int(len(v)))
}

var emptyText = [1]byte{}

// Step is the next row (true), or the end (false); an error panics with SQLite's message.
func (s *Stmt) Step() bool {
	ok, err := s.step()
	if err != nil {
		panic(err)
	}
	return ok
}
func (s *Stmt) step() (bool, error) {
	switch C.sqlite3_step(s.s) {
	case liteRow:
		return true, nil
	case liteDone:
		return false, nil
	}
	err := s.c.err(s.q)
	C.sqlite3_reset(s.s)
	return false, err
}

// Run steps a statement that returns no rows, and resets it; its error is returned (a
// constraint, for one).
func (s *Stmt) Run() error {
	rc := C.sqlite3_step(s.s)
	var err error
	if rc != liteDone && rc != liteRow {
		err = s.c.err(s.q)
	}
	C.sqlite3_reset(s.s)
	return err
}
func (s *Stmt) Reset() { C.sqlite3_reset(s.s) }

func (s *Stmt) ColNull(i int) bool      { return C.sqlite3_column_type(s.s, C.int(i)) == liteNull }
func (s *Stmt) ColInt(i int) int64      { return int64(C.sqlite3_column_int64(s.s, C.int(i))) }
func (s *Stmt) ColFloat(i int) float64  { return float64(C.sqlite3_column_double(s.s, C.int(i))) }
func (s *Stmt) ColBool(i int) bool      { return C.sqlite3_column_int64(s.s, C.int(i)) != 0 }
func (s *Stmt) ColText(i int) string {
	p := C.sqlite3_column_text(s.s, C.int(i))
	n := C.sqlite3_column_bytes(s.s, C.int(i))
	if p == nil || n == 0 {
		return ""
	}
	return C.GoStringN((*C.char)(unsafe.Pointer(p)), n)
}
func (s *Stmt) ColBlob(i int) []byte {
	p := C.sqlite3_column_blob(s.s, C.int(i))
	n := C.sqlite3_column_bytes(s.s, C.int(i))
	if p == nil || n == 0 {
		return []byte{}
	}
	return C.GoBytes(p, n)
}

// ---- dynamic binds and scans, for the code off a request's path

// BindAll binds args from the first position (nil, integers, bools, floats, text, bytes).
func (s *Stmt) BindAll(args []any) {
	for i, a := range args {
		s.BindAny(i+1, a)
	}
}
func (s *Stmt) BindAny(i int, a any) {
	switch x := a.(type) {
	case nil:
		s.Null(i)
	case int64:
		s.Int(i, x)
	case int:
		s.Int(i, int64(x))
	case int32:
		s.Int(i, int64(x))
	case bool:
		s.Bool(i, x)
	case float64:
		s.Float(i, x)
	case string:
		s.Text(i, x)
	case []byte:
		s.Blob(i, x)
	default: // a named type (as database/sql allowed)
		switch rv := reflect.ValueOf(a); rv.Kind() {
		case reflect.String:
			s.Text(i, rv.String())
		case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
			s.Int(i, rv.Int())
		case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
			s.Int(i, int64(rv.Uint()))
		case reflect.Bool:
			s.Bool(i, rv.Bool())
		case reflect.Float32, reflect.Float64:
			s.Float(i, rv.Float())
		default:
			s.Text(i, fmt.Sprint(a))
		}
	}
}

// Value is column i as Go has it: nil, int64, float64, string or []byte.
func (s *Stmt) Value(i int) any {
	switch C.sqlite3_column_type(s.s, C.int(i)) {
	case liteNull:
		return nil
	case liteInteger:
		return s.ColInt(i)
	case liteFloat:
		return s.ColFloat(i)
	case liteBlob:
		return s.ColBlob(i)
	}
	return s.ColText(i)
}

// ScanInto reads the columns into pointers: *int64, *int, *bool, *float64, *string, *[]byte,
// *any, *sql.NullInt64, *sql.NullString, *sql.NullBool, **string.
func (s *Stmt) ScanInto(dests ...any) error {
	for i, d := range dests {
		null := s.ColNull(i)
		switch p := d.(type) {
		case *int64:
			*p = s.ColInt(i)
		case *int:
			*p = int(s.ColInt(i))
		case *bool:
			*p = s.ColBool(i)
		case *float64:
			*p = s.ColFloat(i)
		case *string:
			if C.sqlite3_column_type(s.s, C.int(i)) == liteInteger {
				*p = strconv.FormatInt(s.ColInt(i), 10)
			} else {
				*p = s.ColText(i)
			}
		case *[]byte:
			*p = s.ColBlob(i)
		case *any:
			*p = s.Value(i)
		case *sql.NullInt64:
			*p = sql.NullInt64{Int64: s.ColInt(i), Valid: !null}
		case *sql.NullString:
			*p = sql.NullString{String: s.ColText(i), Valid: !null}
		case *sql.NullBool:
			*p = sql.NullBool{Bool: s.ColBool(i), Valid: !null}
		case **string:
			if null {
				*p = nil
			} else {
				v := s.ColText(i)
				*p = &v
			}
		default:
			return fmt.Errorf("scan into %T", d)
		}
	}
	return nil
}

// Exec runs one statement with dynamic args (holding the connection's lock).
func (c *Conn) Exec(q string, args ...any) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	s, err := c.prep(q)
	if err != nil {
		return err
	}
	s.BindAll(args)
	return s.Run()
}

// Rows are a query's results being read; Close lets the connection go.
type Rows struct {
	S       *Stmt
	release func()
	done    bool
}

func (r *Rows) Next() bool {
	if r.done {
		return false
	}
	ok, err := r.S.step()
	if !ok {
		r.Close() // the connection goes back, even when the step failed
	}
	if err != nil {
		panic(err)
	}
	return ok
}
func (r *Rows) Scan(dests ...any) error { return r.S.ScanInto(dests...) }
func (r *Rows) Close() {
	if r.done {
		return
	}
	r.done = true
	r.S.Reset()
	if r.release != nil {
		r.release()
	}
}

// Query runs a statement with dynamic args; the connection is held until the rows are closed.
func (c *Conn) Query(q string, args ...any) (*Rows, error) {
	c.mu.Lock()
	s, err := c.prep(q)
	if err != nil {
		c.mu.Unlock()
		panic(err)
	}
	s.BindAll(args)
	return &Rows{S: s, release: c.mu.Unlock}, nil
}

// Row is QueryRow's one row.
type Row1 struct {
	c    *Conn
	q    string
	args []any
}

func (c *Conn) QueryRow(q string, args ...any) *Row1 { return &Row1{c: c, q: q, args: args} }
func (r *Row1) Scan(dests ...any) error {
	rows, _ := r.c.Query(r.q, r.args...)
	defer rows.Close()
	if !rows.Next() {
		return sql.ErrNoRows
	}
	return rows.Scan(dests...)
}

// Pool is a few read-only connections, taken one at a time.
type Pool struct{ ch chan *Conn }

func NewPool(path string, n int) (*Pool, error) {
	p := &Pool{ch: make(chan *Conn, n)}
	for i := 0; i < n; i++ {
		c, err := OpenConn(path, false)
		if err != nil {
			return nil, err
		}
		p.ch <- c
	}
	return p, nil
}
func (p *Pool) Get() *Conn  { return <-p.ch }
func (p *Pool) Put(c *Conn) { p.ch <- c }

// Query on the pool: a reader for as long as the rows are read.
func (p *Pool) Query(q string, args ...any) (*Rows, error) {
	c := p.Get()
	s, err := c.prep(q)
	if err != nil {
		p.Put(c)
		panic(err)
	}
	s.BindAll(args)
	return &Rows{S: s, release: func() { p.Put(c) }}, nil
}
func (p *Pool) QueryRow(q string, args ...any) *PoolRow { return &PoolRow{p: p, q: q, args: args} }

type PoolRow struct {
	p    *Pool
	q    string
	args []any
}

func (r *PoolRow) Scan(dests ...any) error {
	rows, _ := r.p.Query(r.q, r.args...)
	defer rows.Close()
	if !rows.Next() {
		return sql.ErrNoRows
	}
	return rows.Scan(dests...)
}
