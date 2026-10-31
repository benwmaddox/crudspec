package rt

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
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
	// indexes auto: the indexes the app's queries want (lang/cost.ts), made when it starts and
	// dropped when no longer wanted. They change speed, not data, so they aren't in the schema.
	AutoIndexes []string
}

// Main runs a compiled app: node lang/runtime/server.ts' flags, the same behaviour.
func Main(app *App, ui *UI, b *Build, widgets map[string]func([]Val, WidgetHelpers) string) {
	app.bindGo(ui.Externs)
	if len(os.Args) > 1 && os.Args[1] == "migrate-data" { // an upgrade step, run by node lang/cli.ts migrate
		os.Exit(migrateData(app, os.Args[2:]))
	}
	if len(os.Args) > 1 && os.Args[1] == "suggest-invariants" { // facts the data holds, by node lang/cli.ts suggest-invariants
		os.Exit(suggestInvariants(app, os.Args[2:]))
	}
	if len(os.Args) > 1 && os.Args[1] == "probe" { // the change report's runs, by node lang/cli.ts review
		os.Exit(probe(app, ui, b))
	}
	data := flag.String("data", "data", "the data directory")
	assets := flag.String("assets", "assets", "the assets directory")
	port := flag.Int("port", 3000, "the port, on 127.0.0.1")
	test := flag.Bool("test", false, "adds the /_test endpoints for the replay driver; never in production")
	flag.BoolVar(&CheckFragCache, "check-cache", false, "renders every cached fragment afresh too and reports any difference (/_test/cache-check); for tests, it halves the cache's gain")
	flag.BoolVar(&GzipOff, "no-gzip", false, "sends responses uncompressed (behind a proxy that compresses, or to measure)")
	offline := flag.Bool("offline", false, "effects aren't made: Go-bound externs with effects give none, and mail isn't delivered (/_test/outbox shows it)")
	flag.IntVar(&MaxStreams, "max-streams", MaxStreams, "live streams (open pages) the server keeps at most; past it, it refuses them (503)")
	flag.IntVar(&MaxStreamsEach, "max-streams-each", MaxStreamsEach, "live streams one person (a session, or an address signed out) keeps at most")
	baseURL := flag.String("base-url", os.Getenv("CRUDSPEC_BASE_URL"), "the app's public address, for absolute links (mail's): https://example.com")
	flag.Parse()
	NoFragCache = os.Getenv("CRUDSPEC_NO_CACHE") == "1" // benchmarks: every page rendered afresh
	NoPageCache = os.Getenv("CRUDSPEC_NO_PAGE_CACHE") == "1" // benchmarks: the fragment cache alone, as other servers cache
	PageKeys = os.Getenv("CRUDSPEC_PAGE_KEYS") == "1"         // pages kept across commits that don't touch them
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
		// pages allocate briefly: more headroom is less collecting (about 5% more pages served for
		// 15-35 MB, measured), with a soft limit so the heap is collected harder before it grows far
		debug.SetGCPercent(400)
		if os.Getenv("GOMEMLIMIT") == "" {
			debug.SetMemoryLimit(512 << 20)
		}
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
	if *test {
		if err := CheckLiveKeys(app.LiveKeyChecks); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(70)
		}
	}
	sv := NewServer(app, ui, *data, *assets, *test)
	sv.Vapid = LoadVapid(*data)
	sv.vapidPublic = sv.Vapid.PublicKey
	sv.Externs = sv.DefaultExterns()
	app.addBound(sv.Externs, *offline, ui.Externs)
	sv.Agents = NewAgents(sv)
	app.PublicBase = strings.TrimRight(*baseURL, "/")
	mailCfg, err := MailFromEnv(*offline)
	if err != nil {
		fmt.Fprintln(os.Stderr, "mail:", err)
		os.Exit(1)
	}
	if app.SendsMail && mailCfg.Mailer == nil && !*offline && !*test {
		fmt.Fprintln(os.Stderr, "mail: this app sends mail; set CRUDSPEC_SMTP (host:port) and CRUDSPEC_MAIL_FROM, or run --offline")
		os.Exit(1)
	}
	if app.SendsMail && app.PublicBase == "" && !*offline && !*test {
		fmt.Fprintln(os.Stderr, "mail: this app sends mail, whose links need the app's address: set --base-url (or CRUDSPEC_BASE_URL)")
		os.Exit(1)
	}
	sv.Mail = mailCfg
	app.prepareSchedules()
	sv.runSchedules()
	sv.runMail()
	if p := os.Getenv("CRUDSPEC_PPROF"); p != "" { // profiling, on loopback
		// the fragment cache's counts, for benchmarks
		http.HandleFunc("/debug/cache", func(w http.ResponseWriter, _ *http.Request) {
			c := &app.DB.Cache
			c.mu.Lock()
			fmt.Fprintf(w, `{"hits":%d,"misses":%d,"entries":%d,"bytes":%d,`, c.Hits, c.Misses, len(c.entries), c.bytes)
			c.mu.Unlock()
			p := &sv.Pages
			p.mu.Lock()
			fmt.Fprintf(w, `"page_hits":%d,"page_dropped":%d,"pages":%d}`, p.Hits, p.Dropped, len(p.m))
			p.mu.Unlock()
		})
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
		return syncAutoIndexes(db, b.AutoIndexes)
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
	return syncAutoIndexes(db, b.AutoIndexes)
}

// syncAutoIndexes makes the indexes the build wants (ax_…) and drops ones it no longer does.
func syncAutoIndexes(db *sql.DB, want []string) error {
	named := map[string]string{}
	for _, q := range want {
		if m := autoIndexName.FindStringSubmatch(q); m != nil {
			named[m[1]] = q
		}
	}
	have := map[string]bool{}
	rows, err := db.Query(`SELECT name FROM sqlite_master WHERE type = 'index' AND substr(name, 1, 3) = 'ax_'`)
	if err != nil {
		return err
	}
	for rows.Next() {
		var n string
		rows.Scan(&n)
		have[n] = true
	}
	rows.Close()
	for n := range have {
		if _, ok := named[n]; !ok {
			if _, err := db.Exec(`DROP INDEX "` + n + `"`); err != nil {
				return err
			}
			fmt.Fprintf(os.Stderr, "indexes auto: dropped %s\n", n)
		}
	}
	for n, q := range named {
		if have[n] {
			continue
		}
		t0 := time.Now()
		if _, err := db.Exec(q); err != nil {
			return fmt.Errorf("%s: %w", q, err)
		}
		fmt.Fprintf(os.Stderr, "indexes auto: made %s in %d ms\n", n, time.Since(t0).Milliseconds())
	}
	return nil
}

var autoIndexName = regexp.MustCompile(`^CREATE INDEX IF NOT EXISTS "(ax_[^"]+)"`)
