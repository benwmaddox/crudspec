package rt

// Upgrading the app's database to this build, by the app itself: `app migrate --data <dir>`,
// `app migrate --data <dir> --plan` (a rehearsal only, safe while the app runs), and on start
// (main.go), so a server needs nothing but the binary. A port of lang/runtime/upgrade.ts:
//
//  1. The plan: the schema the database recorded against this build's (upgradediff.go).
//     Anything the spec must say more about blocks it, before anything is touched.
//  2. A rehearsal on a copy: renames and drops, new tables and columns, defaults for new
//     fields, the spec's pending `migration` blocks, then every check (required fields, sizes,
//     enum values, references, unique keys and invariants) on every row, then the tables
//     rebuilt as the spec wants them (STRICT, size checks, foreign keys).
//  3. Only if all of that passes: the original is copied to <data>/backups, and the copy takes
//     its place in one rename, so a crash at any moment leaves a whole database.
//
// Nothing prompts: every decision is in the spec. The plan is recorded in crudspec_versions.

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

// ExitBlocked is the exit code of an upgrade the app refuses (on start, or app migrate): the
// database is untouched, and restarting won't help (systemd: RestartPreventExitStatus=3).
const ExitBlocked = 3

type planVersion struct {
	Version int    `json:"version"`
	Schema  string `json:"schema"`
}

// Plan is what an upgrade does or did; its JSON is lang/runtime/upgrade.ts' Plan.
type Plan struct {
	Status     string         `json:"status"` // created, current, ready, applied, blocked
	From       *planVersion   `json:"from"`
	To         planVersion    `json:"to"`
	Steps      []UpStep       `json:"steps"`
	Migrations []migrationRun `json:"migrations"`
	Checks     []Violation    `json:"checks"`
	Notes      []string       `json:"notes"`
	Backup     string         `json:"backup,omitempty"`
	// the upgrade was refused for something outside the plan (its backup couldn't be made or
	// sent, the file couldn't be replaced): trying again later may work, so it exits 1, not 3
	retry bool
}

var upgradeMeta = map[string]bool{"crudspec_meta": true, "crudspec_versions": true, "crudspec_migrations": true, "crudspec_agent_tokens": true, "crudspec_audit": true, "crudspec_idempotency": true, "crudspec_history": true}

func qid(n string) string  { return `"` + strings.ReplaceAll(n, `"`, `""`) + `"` }
func qstr(s string) string { return `'` + strings.ReplaceAll(s, `'`, `''`) + `'` }

func readStored(db *Conn) (storedTables, error) {
	st := storedTables{Cols: map[string][]string{}}
	rows, err := db.Query(`SELECT name FROM sqlite_master WHERE type = 'table'`)
	if err != nil {
		return st, err
	}
	for rows.Next() {
		var n string
		rows.Scan(&n)
		if upgradeMeta[n] || strings.HasPrefix(n, "sqlite_") {
			continue
		}
		st.Names = append(st.Names, n)
	}
	rows.Close()
	for _, n := range st.Names {
		cols, err := tableColumns(db, n)
		if err != nil {
			return st, err
		}
		st.Cols[n] = cols
	}
	return st, nil
}

func tableColumns(db *Conn, t string) ([]string, error) {
	rows, err := db.Query(`SELECT name FROM pragma_table_info(?)`, t)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var c string
		rows.Scan(&c)
		out = append(out, c)
	}
	return out, nil
}

func hasTable(db *Conn, n string) bool {
	var k int
	db.QueryRow(`SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = ?`, n).Scan(&k)
	return k > 0
}

type recordedVersion struct {
	Version int
	Hash    string
	Schema  *schemaJSON
}

func lastVersion(db *Conn) (*recordedVersion, error) {
	if !hasTable(db, "crudspec_versions") {
		return nil, nil
	}
	var v recordedVersion
	var s string
	if err := db.QueryRow(`SELECT version, schema_hash, schema FROM crudspec_versions ORDER BY version DESC LIMIT 1`).Scan(&v.Version, &v.Hash, &s); err != nil {
		return nil, nil
	}
	v.Schema = &schemaJSON{}
	if err := json.Unmarshal([]byte(s), v.Schema); err != nil {
		return nil, fmt.Errorf("the recorded schema doesn't read: %w", err)
	}
	return &v, nil
}

func appliedMigrations(db *Conn) map[string]bool {
	done := map[string]bool{}
	if !hasTable(db, "crudspec_migrations") {
		return done
	}
	rows, err := db.Query(`SELECT name FROM crudspec_migrations`)
	if err != nil {
		return done
	}
	for rows.Next() {
		var n string
		rows.Scan(&n)
		done[n] = true
	}
	rows.Close()
	return done
}

func recordVersion(db *Conn, plan Plan, b *Build, ran []string, now int64) error {
	for _, q := range []string{
		`CREATE TABLE IF NOT EXISTS crudspec_versions (version INTEGER PRIMARY KEY, schema_hash TEXT NOT NULL, schema TEXT NOT NULL, plan TEXT NOT NULL, applied_at INTEGER NOT NULL)`,
		`CREATE TABLE IF NOT EXISTS crudspec_migrations (name TEXT PRIMARY KEY, version INTEGER NOT NULL, applied_at INTEGER NOT NULL)`,
	} {
		if err := db.Exec(q); err != nil {
			return err
		}
	}
	plan.Status = "applied"
	pj, _ := json.Marshal(plan)
	if err := db.Exec(`INSERT INTO crudspec_versions (version, schema_hash, schema, plan, applied_at) VALUES (?, ?, ?, ?, ?)`, int64(plan.To.Version), plan.To.Schema, b.SchemaJSON, string(pj), now); err != nil {
		return err
	}
	for _, m := range ran {
		if err := db.Exec(`INSERT INTO crudspec_migrations (name, version, applied_at) VALUES (?, ?, ?)`, m, int64(plan.To.Version), now); err != nil {
			return err
		}
	}
	return nil
}

func removeDB(p string) {
	for _, f := range []string{p, p + "-wal", p + "-shm", p + "-journal"} {
		os.Remove(f)
	}
}

// Upgrade plans the upgrade of the database at path to this build and, with apply, carries it
// out. The app's data steps (defaults, migrations, invariants) run in this process.
func Upgrade(path string, app *App, b *Build, apply bool, now int64) Plan {
	next := &schemaJSON{}
	info := &UpgradeInfo{}
	blockedEarly := func(note string) Plan {
		return Plan{Status: "blocked", To: planVersion{0, b.SchemaHash}, Steps: []UpStep{}, Migrations: []migrationRun{}, Checks: []Violation{}, Notes: []string{note}}
	}
	if err := json.Unmarshal([]byte(b.SchemaJSON), next); err != nil {
		return blockedEarly("this build's schema doesn't read: " + err.Error())
	}
	if b.Upgrade == "" {
		return blockedEarly("this build has no upgrade information; build it again with this crudspec")
	}
	if err := json.Unmarshal([]byte(b.Upgrade), info); err != nil {
		return blockedEarly("this build's upgrade information doesn't read: " + err.Error())
	}
	if apply {
		if pid := lockHolder(path); pid != 0 {
			return blockedEarly(fmt.Sprintf(`the app is running (%s) on this data; stop it first. "--plan" works while it runs`, holderText(pid)))
		}
	}

	// a new database: create it and record the first version, unless one should be there
	if _, err := os.Stat(path); err != nil {
		dir := filepath.Dir(path)
		_, bk := os.Stat(filepath.Join(dir, "backups"))
		unfinished := false
		if ents, err := os.ReadDir(dir); err == nil {
			for _, e := range ents {
				if strings.HasPrefix(e.Name(), "app.sqlite.upgrade-") {
					unfinished = true
				}
			}
		}
		if bk == nil || unfinished {
			return blockedEarly(fmt.Sprintf("%s is missing, but backups or an unfinished upgrade are there; restore the database from %s instead of starting empty", path, filepath.Join(dir, "backups")))
		}
		plan := Plan{Status: "created", To: planVersion{1, b.SchemaHash}, Steps: diffSchemas(nil, next, info, storedTables{Cols: map[string][]string{}}), Migrations: []migrationRun{}, Checks: []Violation{}, Notes: []string{}}
		if !apply {
			plan.Status = "ready"
			return plan
		}
		if err := createDB(path, b, plan, now); err != nil {
			removeDB(path)
			return blockedEarly("creating the database failed: " + err.Error())
		}
		return plan
	}

	db, err := OpenConn(path, true)
	if err != nil {
		return blockedEarly(err.Error())
	}
	prev, err := lastVersion(db)
	if err != nil {
		db.Close()
		return blockedEarly(err.Error())
	}
	if prev == nil {
		db.Close()
		return blockedEarly("the database has no recorded version: it wasn't made by a crudspec app")
	}
	if f := prev.Schema.Format; f == nil || *f < 5 {
		was := 1
		if f != nil {
			was = *f
		}
		db.Close()
		return blockedEarly(fmt.Sprintf("the database is at storage format %d; an app upgrades from format 5 on. Upgrade it once with crudspec v0.14's node lang/cli.ts migrate, then with this app", was))
	}
	stored, err := readStored(db)
	if err != nil {
		db.Close()
		return blockedEarly(err.Error())
	}
	done := appliedMigrations(db)
	steps := diffSchemas(prev.Schema, next, info, stored)
	pending := []string{}
	notes := []string{}
	for _, m := range b.Migrations {
		if done[m] {
			notes = append(notes, fmt.Sprintf(`migration "%s" has been applied; it can be removed from the spec`, m))
		} else {
			pending = append(pending, m)
		}
	}
	for _, d := range info.Drops {
		there := stored.has(d[0])
		what := "entity " + d[0]
		if d[1] != "" {
			there = stored.hasCol(d[0], d[1])
			what = d[0] + "." + d[1]
		}
		if !there {
			notes = append(notes, fmt.Sprintf(`"drop %s" has been applied; it can be removed from the spec`, what))
		}
	}
	hasStep := func(op, entity, field string) bool {
		for _, s := range steps {
			if s.Op == op && s.Entity == entity && (field == "" || s.Field == field) {
				return true
			}
		}
		return false
	}
	for _, e := range info.Entities {
		if e.Was != "" && !hasStep("rename_entity", e.Name, "") {
			notes = append(notes, fmt.Sprintf(`"entity %s was %s" has been applied; "was %s" can be removed`, e.Name, e.Was, e.Was))
		}
		for _, f := range e.Fields {
			if f.Was != "" && !hasStep("rename_field", e.Name, f.Name) {
				notes = append(notes, fmt.Sprintf(`"%s.%s was %s" has been applied; "was %s" can be removed`, e.Name, f.Name, f.Was, f.Was))
			}
		}
	}
	from := &planVersion{prev.Version, prev.Hash}
	plan := Plan{Status: "ready", From: from, To: planVersion{prev.Version + 1, b.SchemaHash}, Steps: steps, Migrations: []migrationRun{}, Checks: []Violation{}, Notes: notes}
	for _, s := range steps {
		if s.Class == "blocked" {
			db.Close()
			plan.Status = "blocked"
			return plan
		}
	}
	destructive := false
	for _, s := range steps {
		destructive = destructive || s.Class == "destructive"
	}
	if prev.Hash == b.SchemaHash && len(pending) == 0 && !destructive {
		db.Close()
		plan.Status = "current"
		plan.To = *from
		kept := []UpStep{}
		for _, s := range steps {
			if s.Class != "contract" {
				kept = append(kept, s)
			}
		}
		plan.Steps = kept
		return plan
	}

	// what each destructive step would lose
	for i, s := range plan.Steps {
		var n int64
		if s.Op == "drop_field" {
			db.QueryRow(`SELECT count(*) FROM ` + qid(s.Entity) + ` WHERE ` + qid(s.Field) + ` IS NOT NULL`).Scan(&n)
			plan.Steps[i].Detail += fmt.Sprintf(" (%d non-empty values)", n)
		}
		if s.Op == "drop_entity" {
			db.QueryRow(`SELECT count(*) FROM ` + qid(s.Entity)).Scan(&n)
			plan.Steps[i].Detail += fmt.Sprintf(" (%d rows)", n)
		}
	}

	// rehearse on a copy
	tmp := fmt.Sprintf("%s.upgrade-%d", path, now)
	removeDB(tmp)
	err = db.Exec(`VACUUM INTO ` + qstr(tmp))
	db.Close()
	blocked := func(note string) Plan {
		removeDB(tmp)
		plan.Status = "blocked"
		if note != "" {
			plan.Notes = append(plan.Notes, note)
		}
		return plan
	}
	if err != nil {
		return blocked("the rehearsal failed: " + err.Error())
	}
	if msg := rehearseSchema(tmp, plan.Steps, info); msg != "" {
		return blocked("the rehearsal failed: " + msg)
	}
	// the app: defaults for new fields (which may read the row's other fields, or 0 for an Int),
	// the pending data migrations in the spec's order, every invariant
	addFields := [][]string{}
	for _, s := range plan.Steps {
		if s.Op == "add_field" {
			addFields = append(addFields, []string{s.Entity, s.Field})
		}
	}
	hasInvariants := info.AppInvariants
	for _, e := range info.Entities {
		hasInvariants = hasInvariants || e.Invariants
	}
	invariantChecks := []Violation{}
	if len(addFields) > 0 || len(pending) > 0 || hasInvariants {
		runs, checks, msg := dataStep(app, tmp, now, addFields, pending)
		plan.Migrations = append(plan.Migrations, runs...)
		if msg != "" {
			return blocked(msg)
		}
		for _, m := range runs {
			if m.Error != "" {
				return blocked("")
			}
		}
		invariantChecks = checks
	}
	conn, err := OpenConn(tmp, true)
	if err != nil {
		return blocked("the rehearsal failed: " + err.Error())
	}
	checks, err := checkData(conn, info)
	if err != nil {
		conn.Close()
		return blocked("the rehearsal failed: " + err.Error())
	}
	plan.Checks = append(checks, invariantChecks...)
	if len(plan.Checks) > 0 {
		conn.Close()
		return blocked("")
	}
	if err := finishSchema(conn, info); err != nil {
		conn.Close()
		return blocked("the rehearsal failed: " + err.Error())
	}
	if err := recordVersion(conn, plan, b, pending, now); err != nil {
		conn.Close()
		return blocked("the rehearsal failed: " + err.Error())
	}
	conn.Exec("PRAGMA wal_checkpoint(TRUNCATE)")
	conn.Close()
	if !apply {
		removeDB(tmp)
		return plan
	}

	// Swap. The backup is copied from the original, which stays in place, and then a single
	// rename replaces it with the upgraded copy: a crash at any point leaves a whole database.
	backups := filepath.Join(filepath.Dir(path), "backups")
	backup := filepath.Join(backups, fmt.Sprintf("app-v%d-%d.sqlite", from.Version, now))
	swap := func() error {
		if err := os.MkdirAll(backups, 0o755); err != nil {
			return err
		}
		// the original's log into it first, so it's whole on its own if the swap stops here
		orig, err := OpenConn(path, true)
		if err != nil {
			return err
		}
		orig.Exec("PRAGMA wal_checkpoint(TRUNCATE)")
		orig.Close()
		// every upgrade is a backup checkpoint: copied, checked and (with a backup bucket) sent,
		// or the upgrade doesn't happen
		if err := upgradeCheckpoint(path, backup); err != nil {
			return fmt.Errorf("the backup before it: %w", err)
		}
		for _, ext := range []string{"-wal", "-shm"} {
			os.Remove(path + ext)
			os.Remove(tmp + ext)
		}
		return os.Rename(tmp, path)
	}
	if err := swap(); err != nil {
		removeDB(tmp)
		plan.Status = "blocked"
		plan.retry = true
		plan.Notes = append(plan.Notes, fmt.Sprintf("the upgrade was rehearsed but couldn't replace the database (%s); nothing changed", err))
		return plan
	}
	plan.Status = "applied"
	plan.Backup = backup
	return plan
}

// createDB makes a new database: this build's tables and indexes, and its first version.
func createDB(path string, b *Build, plan Plan, now int64) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	db, err := OpenConn(path, true)
	if err != nil {
		return err
	}
	defer db.Close()
	if err := useWAL(db); err != nil {
		return err
	}
	for _, q := range append([]string{`CREATE TABLE IF NOT EXISTS crudspec_meta (key TEXT PRIMARY KEY, value TEXT)`}, b.DDL...) {
		if err := db.Exec(q); err != nil {
			return fmt.Errorf("%s: %w", q, err)
		}
	}
	return recordVersion(db, plan, b, b.Migrations, now) // nothing to migrate in a new database
}

// rehearseSchema makes the structural changes on the copy, in one transaction: renames, enum
// value renames, drops, then the tables and columns the spec wants.
func rehearseSchema(tmp string, steps []UpStep, info *UpgradeInfo) (msg string) {
	db, err := OpenConn(tmp, true)
	if err != nil {
		return err.Error()
	}
	defer db.Close()
	// foreign keys off: tables are created and rebuilt (a rebuild drops a table others refer
	// to); every reference is checked after (finishSchema)
	db.Exec("PRAGMA foreign_keys = OFF")
	if err := db.Exec("BEGIN"); err != nil {
		return err.Error()
	}
	fail := func(err error) string { db.Exec("ROLLBACK"); return err.Error() }
	for _, s := range steps {
		if s.Op == "rename_entity" {
			if err := db.Exec(`ALTER TABLE ` + qid(s.From) + ` RENAME TO ` + qid(s.To)); err != nil {
				return fail(err)
			}
		}
	}
	for _, s := range steps {
		if s.Op == "rename_field" {
			if err := db.Exec(`ALTER TABLE ` + qid(s.Entity) + ` RENAME COLUMN ` + qid(s.From) + ` TO ` + qid(s.To)); err != nil {
				return fail(err)
			}
		}
	}
	for _, s := range steps {
		if s.Op != "rename_value" {
			continue
		}
		for _, e := range info.Entities {
			for _, f := range e.Fields {
				if f.Named && f.Type == s.Entity {
					if err := db.Exec(`UPDATE `+qid(e.Name)+` SET `+qid(f.Name)+` = ? WHERE `+qid(f.Name)+` = ?`, s.To, s.From); err != nil {
						return fail(err)
					}
				}
			}
		}
	}
	for _, s := range steps {
		if s.Op != "drop_field" {
			continue
		}
		rows, err := db.Query(`SELECT name FROM pragma_index_list(?)`, s.Entity)
		if err != nil {
			return fail(err)
		}
		idx := []string{}
		for rows.Next() {
			var n string
			rows.Scan(&n)
			idx = append(idx, n)
		}
		rows.Close()
		for _, ix := range idx {
			var k int
			db.QueryRow(`SELECT count(*) FROM pragma_index_info(?) WHERE name = ?`, ix, s.Field).Scan(&k)
			if k > 0 {
				if err := db.Exec(`DROP INDEX ` + qid(ix)); err != nil {
					return fail(err)
				}
			}
		}
		if err := db.Exec(`ALTER TABLE ` + qid(s.Entity) + ` DROP COLUMN ` + qid(s.Field)); err != nil {
			return fail(err)
		}
	}
	for _, s := range steps {
		if s.Op == "drop_entity" {
			if err := db.Exec(`DROP TABLE ` + qid(s.Entity)); err != nil {
				return fail(err)
			}
		}
	}
	// tables and columns for every stored entity
	if err := db.Exec(`CREATE TABLE IF NOT EXISTS crudspec_meta (key TEXT PRIMARY KEY, value TEXT)`); err != nil {
		return fail(err)
	}
	for _, e := range info.Entities {
		for _, q := range e.Rich {
			if err := db.Exec(q); err != nil {
				return fail(err)
			}
		}
		if !hasTable(db, e.Name) {
			if err := db.Exec(e.Table); err != nil {
				return fail(err)
			}
			continue
		}
		have, err := tableColumns(db, e.Name)
		if err != nil {
			return fail(err)
		}
		for _, f := range e.Fields {
			for _, c := range f.Cols {
				if !hasString(have, c[0]) {
					if err := db.Exec(`ALTER TABLE ` + qid(e.Name) + ` ADD COLUMN ` + qid(c[0]) + ` ` + c[1]); err != nil {
						return fail(err)
					}
				}
			}
		}
	}
	// sets, mentions and Json values name their entity; a rename rewrites them too
	for _, s := range steps {
		if s.Op != "rename_entity" {
			continue
		}
		for _, e := range info.Entities {
			for _, f := range e.Fields {
				if f.Kind == "json" {
					col := qid(f.Name)
					set := col
					for _, k := range []string{"ref", "entity"} {
						set = fmt.Sprintf("replace(%s, %s, %s)", set, qstr(`"`+k+`":`+jsonStr(s.From)), qstr(`"`+k+`":`+jsonStr(s.To)))
					}
					if err := db.Exec(`UPDATE ` + qid(e.Name) + ` SET ` + col + ` = ` + set + ` WHERE ` + col + ` IS NOT NULL`); err != nil {
						return fail(err)
					}
				}
				if f.Kind == "rich" {
					if err := db.Exec(`UPDATE `+qid(e.Name+"__"+f.Name+"__mentions")+` SET entity = ? WHERE entity = ?`, s.To, s.From); err != nil {
						return fail(err)
					}
				}
			}
		}
	}
	if err := db.Exec("COMMIT"); err != nil {
		return fail(err)
	}
	return ""
}

func jsonStr(s string) string { b, _ := json.Marshal(s); return string(b) }

// finishSchema rebuilds the tables whose definition isn't the spec's (STRICT, with the size
// checks and foreign keys: the rows were checked first), makes the indexes the spec declares and
// drops the ones it no longer does, and has SQLite check every reference.
func finishSchema(db *Conn, info *UpgradeInfo) error {
	db.Exec("PRAGMA foreign_keys = OFF")
	if err := db.Exec("BEGIN"); err != nil {
		return err
	}
	fail := func(err error) error { db.Exec("ROLLBACK"); return err }
	base := map[string]bool{"id": true, "seq": true, "created": true, "updated": true}
	for _, e := range info.Entities {
		var sql string
		if err := db.QueryRow(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`, e.Name).Scan(&sql); err != nil {
			continue
		}
		have, err := tableColumns(db, e.Name)
		if err != nil {
			return fail(err)
		}
		declared := map[string]bool{}
		for _, f := range e.Fields {
			for _, c := range f.Cols {
				declared[c[0]] = true
			}
		}
		kept := []string{}
		for _, h := range have {
			if !base[h] && !declared[h] {
				kept = append(kept, h)
			}
		}
		want := e.Table
		if len(kept) > 0 {
			extra := ""
			for _, k := range kept {
				extra += ", " + qid(k) + " ANY"
			}
			want = strings.TrimSuffix(want, ") STRICT") + extra + ") STRICT"
		}
		body := func(s string) string { return s[strings.Index(s, "("):] }
		if body(sql) == body(want) {
			continue
		}
		copyCols := []string{"id", "seq", "created", "updated"}
		for _, f := range e.Fields {
			for _, c := range f.Cols {
				if hasString(have, c[0]) {
					copyCols = append(copyCols, c[0])
				}
			}
		}
		copyCols = append(copyCols, kept...)
		qc := make([]string, len(copyCols))
		for i, c := range copyCols {
			qc[i] = qid(c)
		}
		tmp := e.Name + "__rebuild"
		for _, q := range []string{
			`DROP TABLE IF EXISTS ` + qid(tmp),
			strings.Replace(want, `CREATE TABLE `+qid(e.Name)+` `, `CREATE TABLE `+qid(tmp)+` `, 1),
			`INSERT INTO ` + qid(tmp) + ` (` + strings.Join(qc, ", ") + `) SELECT ` + strings.Join(qc, ", ") + ` FROM ` + qid(e.Name),
			`DROP TABLE ` + qid(e.Name),
			`ALTER TABLE ` + qid(tmp) + ` RENAME TO ` + qid(e.Name),
		} {
			if err := db.Exec(q); err != nil {
				return fail(err)
			}
		}
	}
	// unique keys and reference indexes, exactly as the spec declares them
	for _, e := range info.Entities {
		want := map[string]bool{}
		for _, ix := range e.Indexes {
			want[ix[0]] = true
		}
		rows, err := db.Query(`SELECT name FROM pragma_index_list(?)`, e.Name)
		if err != nil {
			return fail(err)
		}
		drop := []string{}
		for rows.Next() {
			var n string
			rows.Scan(&n)
			if (strings.HasPrefix(n, "uq_") || strings.HasPrefix(n, "ix_")) && !want[n] {
				drop = append(drop, n)
			}
		}
		rows.Close()
		trs, err := db.Query(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ?`, e.Name)
		if err != nil {
			return fail(err)
		}
		dropTr := []string{}
		for trs.Next() {
			var n string
			trs.Scan(&n)
			if strings.HasPrefix(n, "sz_") {
				dropTr = append(dropTr, n) // size triggers, before sizes were CHECKs
			}
		}
		trs.Close()
		for _, n := range drop {
			if err := db.Exec(`DROP INDEX ` + qid(n)); err != nil {
				return fail(err)
			}
		}
		for _, n := range dropTr {
			if err := db.Exec(`DROP TRIGGER ` + qid(n)); err != nil {
				return fail(err)
			}
		}
		for _, ix := range e.Indexes {
			if err := db.Exec(ix[1]); err != nil {
				return fail(err)
			}
		}
	}
	// every reference names a row that exists (checkData looked; this is SQLite's own word on it)
	rows, err := db.Query(`PRAGMA foreign_key_check`)
	if err != nil {
		return fail(err)
	}
	n, first := 0, ""
	for rows.Next() {
		var table, parent string
		var id, fk int64
		rows.Scan(&table, &id, &parent, &fk)
		if n == 0 {
			first = fmt.Sprintf("%s#%d (a %s)", table, id, parent)
		}
		n++
	}
	rows.Close()
	if n > 0 {
		return fail(fmt.Errorf("%d references name rows that don't exist, such as %s", n, first))
	}
	return db.Exec("COMMIT")
}

// checkData checks every stored row against the spec's declarations, in SQL: required fields,
// whole numbers, sizes, enum values, references and unique keys (other types are SQLite's to
// enforce: every table is STRICT from storage format 2). The violations are grouped, with up to five row ids each, in
// the order the TypeScript planner finds them (row by row, field by field).
func checkData(db *Conn, info *UpgradeInfo) ([]Violation, error) {
	out := []Violation{}
	type group struct {
		v               Violation
		seq             int64
		field, checkOrd int
	}
	for _, e := range info.Entities {
		if !hasTable(db, e.Name) {
			continue
		}
		T := qid(e.Name)
		groups := []group{}
		// one group: the rows where cond holds
		add := func(check, field, detail, cond string, fi, ord int, args ...any) error {
			var n, seq int64
			if err := db.QueryRow(`SELECT count(*), coalesce(min(seq), 0) FROM `+T+` WHERE `+cond, args...).Scan(&n, &seq); err != nil {
				return err
			}
			if n == 0 {
				return nil
			}
			sample, err := sampleIDs(db, `SELECT id FROM `+T+` WHERE `+cond+` ORDER BY seq LIMIT 5`, args...)
			if err != nil {
				return err
			}
			groups = append(groups, group{Violation{Check: check, Entity: e.Name, Field: field, Detail: detail, Count: int(n), Sample: sample}, seq, fi, ord})
			return nil
		}
		for fi, f := range e.Fields {
			if !f.Named {
				continue
			}
			col := qid(f.Name)
			label := e.Name + "." + f.Name
			if !f.Optional {
				if err := add("required", f.Name, label+" is required but empty", col+` IS NULL`, fi, 0); err != nil {
					return nil, err
				}
			}
			// a whole number (an Int, a reference's id): a column kept from an earlier removal is
			// untyped (ANY), so a field declared again over it may hold anything
			if f.Kind == "int" || f.Kind == "ref" {
				what := "a whole number"
				if f.Kind == "ref" {
					what = "a " + f.Type
				}
				cond := fmt.Sprintf(`%[1]s IS NOT NULL AND typeof(%[1]s) <> 'integer' AND NOT (typeof(%[1]s) = 'real' AND %[1]s = CAST(%[1]s AS INTEGER)) AND NOT (typeof(%[1]s) = 'text' AND trim(%[1]s) <> '' AND ltrim(trim(%[1]s), '-') NOT GLOB '*[^0-9]*')`, col)
				if err := add("type", f.Name, fmt.Sprintf("%s holds a value that isn't %s", label, what), cond, fi, 1); err != nil {
					return nil, err
				}
			}
			if f.Sized && (f.Kind == "text" || f.Kind == "rich") {
				if f.Max != nil {
					if err := add("size", f.Name, fmt.Sprintf("%s is longer than %d characters", label, *f.Max), fmt.Sprintf("length(%s) > %d", col, *f.Max), fi, 2); err != nil {
						return nil, err
					}
				}
				if f.Min != nil {
					cond := fmt.Sprintf("length(%s) < %d", col, *f.Min)
					if f.Max != nil {
						cond += fmt.Sprintf(" AND length(%s) <= %d", col, *f.Max)
					}
					if err := add("size", f.Name, fmt.Sprintf("%s is shorter than %d characters", label, *f.Min), cond, fi, 2); err != nil {
						return nil, err
					}
				}
			}
			if f.Enum != "" {
				var values []string
				for _, en := range info.Enums {
					if en.Name == f.Enum {
						values = en.Values
					}
				}
				in := make([]string, len(values))
				for i, v := range values {
					in[i] = qstr(v)
				}
				cond := col + ` IS NOT NULL`
				if len(in) > 0 {
					cond += ` AND ` + col + ` NOT IN (` + strings.Join(in, ", ") + `)`
				}
				rows, err := db.Query(`SELECT DISTINCT ` + col + ` FROM ` + T + ` WHERE ` + cond)
				if err != nil {
					return nil, err
				}
				bad := []string{}
				for rows.Next() {
					var v string
					rows.Scan(&v)
					bad = append(bad, v)
				}
				rows.Close()
				for _, v := range bad {
					if err := add("enum", f.Name, fmt.Sprintf(`%s holds "%s", which %s no longer has`, label, v, f.Enum), col+` = ?`, fi, 3, v); err != nil {
						return nil, err
					}
				}
			}
			if f.To != "" && hasTable(db, f.To) {
				cond := fmt.Sprintf(`%s IS NOT NULL AND NOT EXISTS (SELECT 1 FROM %s r WHERE r.id = %s.%s)`, col, qid(f.To), T, col)
				if err := add("reference", f.Name, fmt.Sprintf("%s refers to a %s that doesn't exist", label, f.Type), cond, fi, 4); err != nil {
					return nil, err
				}
			}
		}
		sort.SliceStable(groups, func(i, j int) bool {
			a, b := groups[i], groups[j]
			if a.seq != b.seq {
				return a.seq < b.seq
			}
			if a.field != b.field {
				return a.field < b.field
			}
			return a.checkOrd < b.checkOrd
		})
		for _, g := range groups {
			out = append(out, g.v)
		}
		// unique keys: a row whose key an earlier row has (as SQL does, a key with an empty part
		// is never a duplicate)
		for _, u := range e.Uniques {
			cols := make([]string, len(u))
			notNull := make([]string, len(u))
			for i, c := range u {
				cols[i] = qid(c)
				notNull[i] = qid(c) + ` IS NOT NULL`
			}
			dups := `SELECT id, seq FROM (SELECT id, seq, row_number() OVER (PARTITION BY ` + strings.Join(cols, ", ") + ` ORDER BY seq) AS n FROM ` + T + ` WHERE ` + strings.Join(notNull, " AND ") + `) WHERE n > 1`
			var n int64
			if err := db.QueryRow(`SELECT count(*) FROM (` + dups + `)`).Scan(&n); err != nil {
				return nil, err
			}
			if n == 0 {
				continue
			}
			sample, err := sampleIDs(db, `SELECT id FROM (`+dups+`) ORDER BY seq LIMIT 5`)
			if err != nil {
				return nil, err
			}
			out = append(out, Violation{Check: "unique", Entity: e.Name, Detail: fmt.Sprintf("duplicate (%s)", strings.Join(u, ", ")), Count: int(n), Sample: sample})
		}
	}
	return out, nil
}

func sampleIDs(db *Conn, q string, args ...any) ([]int64, error) {
	rows, err := db.Query(q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []int64{}
	for rows.Next() {
		var id int64
		rows.Scan(&id)
		out = append(out, id)
	}
	return out, nil
}

// migrateCmd: app migrate --data <dir> [--plan] [--json]
// Plans the upgrade of the app's database to this build and applies it (--plan: rehearses it on
// a copy only, which is safe while the app runs). Exits 0; 3 when the upgrade is refused (the
// plan: trying again won't help); 1 when it couldn't be made for now (its backup couldn't be
// made or sent, the database couldn't be replaced).
func migrateCmd(app *App, b *Build, args []string) int {
	data, planOnly, asJSON := "data", false, false
	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "--data":
			if i+1 < len(args) {
				data = args[i+1]
				i++
			}
		case "--plan":
			planOnly = true
		case "--json":
			asJSON = true
		case "--now": // tests: the time the upgrade is recorded at
			if i+1 < len(args) {
				i++
			}
		default:
			fmt.Fprintln(os.Stderr, "usage: app migrate --data <dir> [--plan] [--json]")
			return 64
		}
	}
	now := time.Now().UnixMilli()
	for i := 0; i+1 < len(args); i++ {
		if args[i] == "--now" {
			if n, err := strconv.ParseInt(args[i+1], 10, 64); err == nil {
				now = n
			}
		}
	}
	path := filepath.Join(data, "app.sqlite")
	if !planOnly {
		if other, err := takeLock(path); err != nil {
			fmt.Fprintln(os.Stderr, err)
			return 1
		} else if other != 0 {
			p := Plan{Status: "blocked", To: planVersion{0, b.SchemaHash}, Steps: []UpStep{}, Migrations: []migrationRun{}, Checks: []Violation{}, Notes: []string{fmt.Sprintf(`the app is running (%s) on this data; stop it first. "--plan" works while it runs`, holderText(other))}}
			printPlan(os.Stdout, p, asJSON)
			return ExitBlocked
		}
		defer releaseLock(path)
	}
	p := Upgrade(path, app, b, !planOnly, now)
	printPlan(os.Stdout, p, asJSON)
	if p.Status == "blocked" && p.retry {
		return 1
	}
	if p.Status == "blocked" {
		return ExitBlocked
	}
	return 0
}

// printPlan says what an upgrade does, as `node lang/cli.ts migrate` does, or its JSON.
func printPlan(w io.Writer, p Plan, asJSON bool) {
	if asJSON {
		j, _ := json.MarshalIndent(p, "", "  ")
		fmt.Fprintln(w, string(j))
		return
	}
	from := "none"
	if p.From != nil {
		from = strconv.Itoa(p.From.Version)
	}
	backup := ""
	if p.Backup != "" {
		backup = " (backup " + p.Backup + ")"
	}
	fmt.Fprintf(w, "%s: version %s -> %d%s\n", p.Status, from, p.To.Version, backup)
	for _, s := range p.Steps {
		fmt.Fprintf(w, "  %-11s %s", s.Class, s.Detail)
		if s.Hint != "" {
			fmt.Fprintf(w, "\n              fix: %s", s.Hint)
		}
		fmt.Fprintln(w)
	}
	for _, m := range p.Migrations {
		if m.Error != "" {
			fmt.Fprintf(w, "  migration   \"%s\" failed: %s\n", m.Name, m.Error)
		} else {
			c, _ := json.Marshal(m.Changed)
			fmt.Fprintf(w, "  migration   \"%s\" %s\n", m.Name, c)
		}
	}
	for _, c := range p.Checks {
		ids := make([]string, len(c.Sample))
		for i, id := range c.Sample {
			ids[i] = strconv.FormatInt(id, 10)
		}
		fmt.Fprintf(w, "  violation   %s: %d row(s), e.g. ids %s\n", c.Detail, c.Count, strings.Join(ids, ", "))
	}
	for _, n := range p.Notes {
		fmt.Fprintf(w, "  note        %s\n", n)
	}
}
