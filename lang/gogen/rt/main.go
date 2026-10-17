package rt

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"runtime/debug"
	"strconv"
	"strings"
	"time"

	"net/http"
	_ "net/http/pprof"
)

// Build is what the generator records about the spec: its storage schema, and the version
// the database must be at.
type Build struct {
	DDL        []string // tables and indexes for a new database
	SchemaHash string
	SchemaJSON string
	Migrations []string // the spec's data migrations, applied (or not needed) in a new database
	Spec       string   // the spec's path, for messages
}

// Main runs a compiled app: node lang/runtime/server.ts' flags, the same behaviour.
func Main(app *App, ui *UI, b *Build, widgets map[string]func([]Val, WidgetHelpers) string) {
	if len(os.Args) > 1 && os.Args[1] == "migrate-data" { // an upgrade step, run by node lang/cli.ts migrate
		os.Exit(migrateData(app, os.Args[2:]))
	}
	if len(os.Args) > 1 && os.Args[1] == "probe" { // the change report's runs, by node lang/cli.ts review
		os.Exit(probe(app, ui, b))
	}
	data := flag.String("data", "data", "the data directory")
	assets := flag.String("assets", "assets", "the assets directory")
	port := flag.Int("port", 3000, "the port, on 127.0.0.1")
	test := flag.Bool("test", false, "adds the /_test endpoints for the replay driver; never in production")
	flag.Parse()
	start := time.Now()
	os.MkdirAll(filepath.Join(*data, "files"), 0o755)
	secretPath := filepath.Join(*data, "secret")
	if _, err := os.Stat(secretPath); err != nil {
		k := make([]byte, 32)
		rand.Read(k)
		os.WriteFile(secretPath, []byte(hex.EncodeToString(k)), 0o600)
	}
	secret, _ := os.ReadFile(secretPath)
	app.Secret = secret
	app.FilesDir = filepath.Join(*data, "files")
	dbPath := filepath.Join(*data, "app.sqlite")
	if err := prepareDB(dbPath, b); err != nil {
		fmt.Fprintln(os.Stderr, "storage:", err)
		os.Exit(1)
	}
	db, err := Open(dbPath, app.Ents)
	if err != nil {
		fmt.Fprintln(os.Stderr, "storage:", err)
		os.Exit(1)
	}
	app.DB = db
	db.Live.secret = app.Secret // live keys are hashed with it
	if os.Getenv("GOGC") == "" {
		debug.SetGCPercent(150) // pages allocate briefly; a little headroom saves GC work
	}
	if app.Counters == nil {
		app.Counters = map[string][]int64{}
	}
	ui.Widgets = widgets
	for name := range ui.Declared {
		if widgets[name] == nil {
			fmt.Fprintf(os.Stderr, "widgets: %s is declared but not implemented\n", name)
		}
	}
	sv := NewServer(app, ui, *data, *assets, *test)
	sv.Vapid = LoadVapid(*data)
	sv.vapidPublic = sv.Vapid.PublicKey
	sv.Externs = sv.DefaultExterns()
	sv.Agents = NewAgents(sv)
	if p := os.Getenv("CRUDSPEC_PPROF"); p != "" { // profiling, on loopback
		go http.ListenAndServe("127.0.0.1:"+p, nil)
	}
	fmt.Printf("started in %d ms\n", time.Since(start).Milliseconds())
	if err := sv.Listen(*port); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

// A new database gets the spec's schema and its first version. An existing one must already
// be at this spec's version: upgrading is planned, rehearsed and applied by
// `node lang/cli.ts migrate <spec> --data <dir>`, which keeps a backup.
func prepareDB(path string, b *Build) error {
	_, statErr := os.Stat(path)
	fresh := statErr != nil
	if fresh {
		dir := filepath.Dir(path)
		if _, err := os.Stat(filepath.Join(dir, "backups")); err == nil {
			return fmt.Errorf("%s is missing, but backups are there; restore the database from %s instead of starting empty", path, filepath.Join(dir, "backups"))
		}
	}
	db, err := sql.Open("sqlite3", "file:"+path+"?_journal_mode=WAL&_busy_timeout=5000")
	if err != nil {
		return err
	}
	defer db.Close()
	var has int
	db.QueryRow(`SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = 'crudspec_versions'`).Scan(&has)
	if has == 0 {
		var tables int
		db.QueryRow(`SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`).Scan(&tables)
		if tables > 0 {
			return fmt.Errorf("the database has no recorded version; run: node lang/cli.ts migrate %s --data %s", b.Spec, filepath.Dir(path))
		}
		for _, q := range append([]string{
			`CREATE TABLE IF NOT EXISTS crudspec_meta (key TEXT PRIMARY KEY, value TEXT)`,
			`CREATE TABLE IF NOT EXISTS crudspec_versions (version INTEGER PRIMARY KEY, schema_hash TEXT NOT NULL, schema TEXT NOT NULL, plan TEXT NOT NULL, applied_at INTEGER NOT NULL)`,
			`CREATE TABLE IF NOT EXISTS crudspec_migrations (name TEXT PRIMARY KEY, version INTEGER NOT NULL, applied_at INTEGER NOT NULL)`,
		}, b.DDL...) {
			if _, err := db.Exec(q); err != nil {
				return fmt.Errorf("%s: %w", q, err)
			}
		}
		now := time.Now().UnixMilli()
		plan := `{"status":"applied","from":null,"to":{"version":1,"schema":"` + b.SchemaHash + `"},"steps":[],"migrations":[],"checks":[],"notes":["created by the compiled app"]}`
		if _, err := db.Exec(`INSERT INTO crudspec_versions (version, schema_hash, schema, plan, applied_at) VALUES (1, ?, ?, ?, ?)`, b.SchemaHash, b.SchemaJSON, plan, now); err != nil {
			return err
		}
		for _, m := range b.Migrations {
			db.Exec(`INSERT INTO crudspec_migrations (name, version, applied_at) VALUES (?, 1, ?)`, m, now)
		}
		return nil
	}
	var version int
	var hash string
	if err := db.QueryRow(`SELECT version, schema_hash FROM crudspec_versions ORDER BY version DESC LIMIT 1`).Scan(&version, &hash); err != nil {
		return err
	}
	pending := []string{}
	for _, m := range b.Migrations {
		var n int
		db.QueryRow(`SELECT count(*) FROM crudspec_migrations WHERE name = ?`, m).Scan(&n)
		if n == 0 {
			pending = append(pending, strconv.Quote(m))
		}
	}
	if hash != b.SchemaHash || len(pending) > 0 {
		why := fmt.Sprintf("the database is at version %d (schema %s); this build is for schema %s", version, hash, b.SchemaHash)
		if len(pending) > 0 {
			why += fmt.Sprintf(" with migrations %s to run", strings.Join(pending, ", "))
		}
		return fmt.Errorf("%s. Upgrade it first: node lang/cli.ts migrate %s --data %s", why, b.Spec, filepath.Dir(path))
	}
	return nil
}
