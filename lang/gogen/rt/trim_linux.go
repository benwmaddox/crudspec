//go:build linux

package rt

// glibc keeps memory C code freed (SQLite's caches, statements) for reuse rather than handing it
// back; malloc_trim returns what it can, for a quiet spell (cachelimits.go).

/*
#include <malloc.h>
static void trim_c_heap(void) { malloc_trim(0); }
*/
import "C"

func trimCHeap() { C.trim_c_heap() }
