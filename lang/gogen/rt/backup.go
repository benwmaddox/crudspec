package rt

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
)

// backupDB: app backup --data <dir> --out <file>
//
// A copy of the app's database, made while the app runs: SQLite's VACUUM INTO reads one consistent
// moment of it, beside the app's own reads and writes, and writes a compact database to <file>
// (which mustn't exist). The database's journal mode is left as it is, so a running app isn't
// disturbed. It writes {"out": file, "bytes": n} and exits 0, or {"error": "…"} and 1.
// Uploaded files aren't in it: they are in <data>/files, or the bucket.
func backupDB(args []string) int {
	fs := flag.NewFlagSet("backup", flag.ExitOnError)
	data := fs.String("data", "data", "the data directory")
	out := fs.String("out", "", "the file to write the copy to; it mustn't exist")
	fs.Parse(args)
	say := func(code int, v map[string]any) int {
		j, _ := json.Marshal(v)
		os.Stdout.Write(append(j, '\n'))
		return code
	}
	if *out == "" {
		return say(64, map[string]any{"error": "say where: app backup --data <dir> --out <file>"})
	}
	if _, err := os.Stat(*out); err == nil {
		return say(1, map[string]any{"error": fmt.Sprintf("%s exists: a backup is a new file", *out)})
	}
	path := filepath.Join(*data, "app.sqlite")
	if _, err := os.Stat(path); err != nil {
		return say(1, map[string]any{"error": fmt.Sprintf("no database at %s", path)})
	}
	if err := os.MkdirAll(filepath.Dir(*out), 0o755); err != nil {
		return say(1, map[string]any{"error": err.Error()})
	}
	conn, err := OpenConn(path, false) // read-only: the copy is all it makes
	if err != nil {
		return say(1, map[string]any{"error": err.Error()})
	}
	defer conn.Close()
	if err := conn.Exec(`VACUUM INTO ?`, *out); err != nil {
		os.Remove(*out)
		return say(1, map[string]any{"error": "the copy: " + err.Error()})
	}
	st, err := os.Stat(*out)
	if err != nil {
		return say(1, map[string]any{"error": err.Error()})
	}
	return say(0, map[string]any{"out": *out, "bytes": st.Size()})
}
