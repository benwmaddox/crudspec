package rt

// The runtime's own text functions, registered in SQLite (each connection, as it opens), so a
// query's condition or order that uses them runs in the database and computes exactly what the
// app would: SQL calls these Go functions, not SQLite's built-ins (whose lower and upper know only
// ASCII). Each is deterministic, so SQLite can also index on one. The planner (lang/gogen/gen.ts)
// writes cs_lower(t0."name") and the like; docs/design/sql-first.md says why.

/*
#include <stdint.h>
#include <stdlib.h>
typedef struct sqlite3 sqlite3;
typedef struct sqlite3_context sqlite3_context;
typedef struct sqlite3_value sqlite3_value;
int sqlite3_create_function_v2(sqlite3*, const char*, int, int, void*, void (*)(sqlite3_context*, int, sqlite3_value**), void (*)(sqlite3_context*, int, sqlite3_value**), void (*)(sqlite3_context*), void (*)(void*));
void* sqlite3_user_data(sqlite3_context*);
const unsigned char* sqlite3_value_text(sqlite3_value*);
int sqlite3_value_bytes(sqlite3_value*);
int sqlite3_value_type(sqlite3_value*);
void sqlite3_result_text(sqlite3_context*, const char*, int, void (*)(void*));
void sqlite3_result_int64(sqlite3_context*, long long);
void sqlite3_result_null(sqlite3_context*);
extern void liteSQLFunc(sqlite3_context*, int, sqlite3_value**);
static void lite_fn(sqlite3_context* c, int n, sqlite3_value** v) { liteSQLFunc(c, n, v); }
// SQLITE_UTF8 | SQLITE_DETERMINISTIC: the same arguments always give the same result
static int lite_create(sqlite3* db, const char* name, int n, intptr_t id) { return sqlite3_create_function_v2(db, name, n, 1 | 0x800, (void*)id, lite_fn, 0, 0, 0); }
static intptr_t lite_id(sqlite3_context* c) { return (intptr_t)sqlite3_user_data(c); }
static sqlite3_value* lite_arg(sqlite3_value** v, int i) { return v[i]; }
static void lite_result_text(sqlite3_context* c, const char* p, int n) { sqlite3_result_text(c, p, n, (void (*)(void*))-1); }
// "" as text, not NULL (a NULL pointer would be SQL's NULL)
static void lite_result_empty(sqlite3_context* c) { sqlite3_result_text(c, "", 0, (void (*)(void*))0); }
*/
import "C"

import (
	"errors"
	"unsafe"
)

// SQLFuncs are the functions SQL may call, by the name the planner writes: each the builtin the
// app runs, so SQL's answer is the app's.
var SQLFuncs = []struct {
	Name string
	N    int
	F    func(a ...Val) Val
}{
	{"cs_lower", 1, func(a ...Val) Val { return B_lower(nil, a...) }},
	{"cs_upper", 1, func(a ...Val) Val { return B_upper(nil, a...) }},
	{"cs_trim", 1, func(a ...Val) Val { return B_trim(nil, a...) }},
	{"cs_contains", 2, func(a ...Val) Val { return B_contains(nil, a...) }},
	{"cs_starts_with", 2, func(a ...Val) Val { return B_starts_with(nil, a...) }},
	{"cs_matches", 2, func(a ...Val) Val { return B_matches(nil, a...) }},
	{"cs_ftsq", 2, func(a ...Val) Val { return ftsQuery(Plain(arg(a, 0)), Plain(arg(a, 1))) }}, // matches() as a search index's query (search.go)
	{"cs_words_only", 1, func(a ...Val) Val { return B_words_only(nil, a...) }},
}

// registerSQLFuncs gives a connection (a *C.sqlite3) the runtime's text functions.
func registerSQLFuncs(db unsafe.Pointer) error {
	for i, f := range SQLFuncs {
		name := C.CString(f.Name)
		rc := C.lite_create((*C.sqlite3)(db), name, C.int(f.N), C.intptr_t(i))
		C.free(unsafe.Pointer(name))
		if rc != 0 {
			return errors.New("registering " + f.Name)
		}
	}
	return nil
}

// sqlCall runs one function for SQLite: its arguments as text (NULL as none), its result as text,
// an integer (a Bool as 0 or 1) or NULL.
func sqlCall(ctxp unsafe.Pointer, n int, argvp unsafe.Pointer) {
	ctx := (*C.sqlite3_context)(ctxp)
	argv := (**C.sqlite3_value)(argvp)
	f := SQLFuncs[int(C.lite_id(ctx))]
	args := make([]Val, n)
	for i := 0; i < n; i++ {
		v := C.lite_arg(argv, C.int(i))
		if C.sqlite3_value_type(v) == 5 { // SQLITE_NULL
			continue
		}
		p := C.sqlite3_value_text(v)
		args[i] = C.GoStringN((*C.char)(unsafe.Pointer(p)), C.sqlite3_value_bytes(v))
	}
	switch r := f.F(args...).(type) {
	case nil:
		C.sqlite3_result_null(ctx)
	case bool:
		if r {
			C.sqlite3_result_int64(ctx, 1)
		} else {
			C.sqlite3_result_int64(ctx, 0)
		}
	case string:
		if len(r) == 0 {
			C.lite_result_empty(ctx)
			return
		}
		p := C.CString(r)
		C.lite_result_text(ctx, p, C.int(len(r)))
		C.free(unsafe.Pointer(p))
	default:
		C.lite_result_empty(ctx)
	}
}
