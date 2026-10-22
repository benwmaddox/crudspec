package rt

import (
	"testing"
)

// The live keys' hashes are kept up to a bound, then forgotten and made again: the same hash.
func TestLiveHashBounded(t *testing.T) {
	l := &Live{secret: []byte("s")}
	first := l.Hash(LK{K: 'r', E: "Message", ID: 1})
	for i := 2; i <= liveHashMax+10; i++ {
		l.Hash(LK{K: 'r', E: "Message", ID: int64(i)})
	}
	if n := l.nHashed.Load(); n > liveHashMax {
		t.Fatalf("%d keys kept, more than %d", n, liveHashMax)
	}
	kept := 0
	l.hashes.Range(func(any, any) bool { kept++; return true })
	if kept > liveHashMax {
		t.Fatalf("%d hashes kept, more than %d", kept, liveHashMax)
	}
	if again := l.Hash(LK{K: 'r', E: "Message", ID: 1}); again != first {
		t.Fatalf("hash made again differs: %s, %s", again, first)
	}
}
