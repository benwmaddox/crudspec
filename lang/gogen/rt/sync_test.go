package rt

import (
	"path/filepath"
	"testing"
)

// The store syncs the log at checkpoints by default (SQLite's synchronous=NORMAL, 1); `--db-sync full` sets FULL (2).
func TestOpenSynchronous(t *testing.T) {
	keep := Synchronous
	defer func() { Synchronous = keep }()
	for _, c := range []struct {
		set  string
		want int
	}{{"NORMAL", 1}, {"FULL", 2}} {
		Synchronous = c.set
		w, err := OpenConn(filepath.Join(t.TempDir(), "app.sqlite"), true)
		if err != nil {
			t.Fatal(err)
		}
		if err := setPragmas(w); err != nil {
			t.Fatal(err)
		}
		var got int
		if err := w.QueryRow("PRAGMA synchronous").Scan(&got); err != nil {
			t.Fatal(err)
		}
		if got != c.want {
			t.Errorf("synchronous = %s: SQLite says %d, want %d", c.set, got, c.want)
		}
	}
	if keep != "NORMAL" {
		t.Errorf("the default is %s, want NORMAL", keep)
	}
}
