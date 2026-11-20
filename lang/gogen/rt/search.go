package rt

import (
	"fmt"
	"os"
	"strings"
	"unicode"
)

// The search index: each entity with searchable fields gets an SQLite FTS5 table of them,
// <Entity>__fts, kept in step with the entity's table by triggers. matches(.f, q) on a query's
// own row is a lookup in it (the planner writes rowid IN (SELECT … MATCH cs_ftsq('f', q))), so a
// search reads the rows that match, not every row. The app makes the table and its triggers as
// it starts, and fills it again whenever they are new or changed (a new searchable field, an
// upgrade that rebuilt the entity's table and so dropped its triggers). The app is built with
// SQLite's FTS5 (go build -tags sqlite_fts5, as lang/cli.ts build does).

var searchFields = map[string][]string{} // entity -> its searchable fields (generated: SetSearch)

// SetSearch says entity's fields are searched with matches().
func SetSearch(entity string, fields ...string) { searchFields[entity] = fields }

// EnsureSearch makes each search table and its triggers, filling the table again when either
// was missing or differs from what the spec says.
func EnsureSearch(db *DB) error {
	for entity, fields := range searchFields {
		t := entity + "__fts"
		cols := make([]string, len(fields))
		newCols, oldCols := make([]string, len(fields)), make([]string, len(fields))
		for i, f := range fields {
			cols[i] = Q(f)
			newCols[i] = "new." + Q(f)
			oldCols[i] = "old." + Q(f)
		}
		create := `CREATE VIRTUAL TABLE ` + Q(t) + ` USING fts5(` + strings.Join(cols, ", ") + `, content=` + sqlString(entity) + `, content_rowid='id', tokenize='unicode61')`
		triggers := map[string]string{
			t + "_ai": `CREATE TRIGGER ` + Q(t+"_ai") + ` AFTER INSERT ON ` + Q(entity) + ` BEGIN INSERT INTO ` + Q(t) + `(rowid, ` + strings.Join(cols, ", ") + `) VALUES (new.id, ` + strings.Join(newCols, ", ") + `); END`,
			t + "_ad": `CREATE TRIGGER ` + Q(t+"_ad") + ` AFTER DELETE ON ` + Q(entity) + ` BEGIN INSERT INTO ` + Q(t) + `(` + Q(t) + `, rowid, ` + strings.Join(cols, ", ") + `) VALUES ('delete', old.id, ` + strings.Join(oldCols, ", ") + `); END`,
			t + "_au": `CREATE TRIGGER ` + Q(t+"_au") + ` AFTER UPDATE ON ` + Q(entity) + ` BEGIN INSERT INTO ` + Q(t) + `(` + Q(t) + `, rowid, ` + strings.Join(cols, ", ") + `) VALUES ('delete', old.id, ` + strings.Join(oldCols, ", ") + `); INSERT INTO ` + Q(t) + `(rowid, ` + strings.Join(cols, ", ") + `) VALUES (new.id, ` + strings.Join(newCols, ", ") + `); END`,
		}
		have := map[string]string{}
		rows, err := db.R.Query(`SELECT name, sql FROM sqlite_master WHERE name = ? OR (type = 'trigger' AND tbl_name = ?)`, t, entity)
		if err != nil {
			return err
		}
		for rows.Next() {
			var n, s string
			rows.Scan(&n, &s)
			have[n] = s
		}
		rows.Close()
		same := have[t] == create
		for n, s := range triggers {
			same = same && have[n] == s
		}
		if same {
			continue
		}
		stmts := []string{"BEGIN IMMEDIATE"}
		for n := range triggers {
			stmts = append(stmts, `DROP TRIGGER IF EXISTS `+Q(n))
		}
		stmts = append(stmts, `DROP TABLE IF EXISTS `+Q(t), create)
		for _, s := range triggers {
			stmts = append(stmts, s)
		}
		stmts = append(stmts, `INSERT INTO `+Q(t)+`(`+Q(t)+`) VALUES ('rebuild')`, "COMMIT")
		db.mu.Lock()
		for _, s := range stmts {
			if err := db.W.Exec(s); err != nil {
				db.W.Exec("ROLLBACK")
				db.mu.Unlock()
				if strings.Contains(err.Error(), "no such module") {
					return fmt.Errorf("searching %s needs SQLite's FTS5: build the app with -tags sqlite_fts5 (node lang/cli.ts build does)", entity)
				}
				return fmt.Errorf("the search index of %s: %w", entity, err)
			}
		}
		db.mu.Unlock()
		fmt.Fprintf(os.Stderr, "search: indexed %s (%s)\n", entity, strings.Join(fields, ", "))
	}
	return nil
}

func sqlString(s string) string { return "'" + strings.ReplaceAll(s, "'", "''") + "'" }

// cs_ftsq(field, q): matches()'s query in FTS5's terms: each word of q starts a word of the field
// (field : "word"* AND …), in any case. With no words it matches nothing, as matches() does.
func ftsQuery(field, q string) string {
	words := strings.FieldsFunc(strings.ToLower(q), func(r rune) bool { return !unicode.IsLetter(r) && !unicode.IsDigit(r) && r != '_' })
	if len(words) == 0 {
		return `"` + field + `" : "cs0nothing0matches"`
	}
	parts := make([]string, len(words))
	for i, w := range words {
		parts[i] = `"` + field + `" : "` + strings.ReplaceAll(w, `"`, `""`) + `"*`
	}
	return strings.Join(parts, " AND ")
}
