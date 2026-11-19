package rt

// liteSQLFunc is what SQLite calls for each of SQLFuncs (sqlfuncs.go); it is exported to C in a
// file of its own, since cgo allows only declarations beside an export.

/*
typedef struct sqlite3_context sqlite3_context;
typedef struct sqlite3_value sqlite3_value;
*/
import "C"

import "unsafe"

//export liteSQLFunc
func liteSQLFunc(ctx *C.sqlite3_context, n C.int, argv **C.sqlite3_value) {
	sqlCall(unsafe.Pointer(ctx), int(n), unsafe.Pointer(argv))
}
