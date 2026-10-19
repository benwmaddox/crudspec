package rt

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"sort"
)

// Migrate is what an upgrade runs in the compiled app, generated from the spec: the defaults
// of fields (for rows that predate them), the data migrations, and every invariant on every
// row. `node lang/cli.ts migrate` plans and rehearses the upgrade on a copy of the database
// and runs `app migrate-data` on the copy for these; nothing in the upgrade interprets the spec.
type Migrate struct {
	Defaults   map[string]func(c *Ctx, row *Row) Val // "Entity.field"
	Migrations map[string]func(c *Ctx)
	Invariants func(c *Ctx, bad func(entity, detail string, id int64)) // every row's invariants
}

// JournalMode is the database's journal mode. migrate-data uses DELETE: the copy it works on
// may be on a filesystem without shared memory (a Windows drive under WSL).
var JournalMode = "WAL"

// Violation is a check that rows fail, as the upgrade reports it.
type Violation struct {
	Check  string  `json:"check"`
	Entity string  `json:"entity"`
	Detail string  `json:"detail"`
	Count  int     `json:"count"`
	Sample []int64 `json:"sample"`
}

type migrationRun struct {
	Name    string                    `json:"name"`
	Changed map[string]map[string]int `json:"changed"`
	Error   string                    `json:"error,omitempty"`
}

// migrateData: app migrate-data --db <copy> < {"now", "defaults": [[entity, field]], "migrations": [names]}
// It writes {"migrations": [...], "checks": [...]} and commits unless a migration failed.
func migrateData(app *App, args []string) int {
	fs := flag.NewFlagSet("migrate-data", flag.ExitOnError)
	dbPath := fs.String("db", "", "the database copy to upgrade")
	fs.Parse(args)
	var in struct {
		Now        int64      `json:"now"`
		Defaults   [][]string `json:"defaults"`
		Migrations []string   `json:"migrations"`
	}
	raw, _ := io.ReadAll(os.Stdin)
	if err := json.Unmarshal(raw, &in); err != nil {
		fmt.Fprintln(os.Stderr, "migrate-data: the input:", err)
		return 64
	}
	JournalMode = "DELETE"
	db, err := Open(*dbPath, app.Ents)
	if err != nil {
		fmt.Fprintln(os.Stderr, "storage:", err)
		return 1
	}
	app.DB = db
	app.SetClock(in.Now)
	if app.Counters == nil {
		app.Counters = map[string][]int64{}
	}
	s := db.Session(app.Ents)
	defer s.Done()
	c := app.ctx(s, map[string]Val{}, nil, &Request{Method: "write", Now: in.Now})
	c.NoTriggers = true
	out := struct {
		Migrations []migrationRun `json:"migrations"`
		Checks     []Violation    `json:"checks"`
		Error      string         `json:"error,omitempty"`
	}{Migrations: []migrationRun{}, Checks: []Violation{}}
	write := func() int {
		b, _ := json.Marshal(out)
		os.Stdout.Write(b)
		return 0
	}
	s.Begin()
	// one step, with what went wrong as text
	step := func(f func()) (msg string) {
		defer func() {
			if r := recover(); r != nil {
				if o, ok := r.(*Outcome); ok {
					msg = o.O + ": " + o.Msg
				} else {
					msg = fmt.Sprint(r)
				}
			}
		}()
		f()
		return ""
	}
	// new fields: their default (which may read the row's other fields), or 0 for an Int
	if msg := step(func() {
		for _, d := range in.Defaults {
			e := app.Ents[d[0]]
			if e == nil {
				continue
			}
			i := e.FieldIndex(d[1])
			if i < 0 {
				continue
			}
			def := app.Migrate.Defaults[d[0]+"."+d[1]]
			f := e.Fields[i]
			if def == nil && !(f.Type == "Int" && !f.Optional) {
				continue
			}
			for _, row := range s.Select(e, "") {
				if def != nil {
					row.R.Set(i, def(c.InvariantCtx(e, row), row))
				} else {
					row.R.Set(i, int64(0))
				}
				s.Save(e, row, []string{f.Name})
			}
		}
	}); msg != "" {
		s.Rollback()
		out.Error = "the defaults of new fields: " + msg
		return write()
	}
	// the pending data migrations, in the spec's order
	for _, name := range in.Migrations {
		m := app.Migrate.Migrations[name]
		if m == nil {
			s.Rollback()
			out.Migrations = append(out.Migrations, migrationRun{Name: name, Changed: map[string]map[string]int{}, Error: "this build has no migration of that name"})
			return write()
		}
		mark := len(s.Log)
		if msg := step(func() { m(c) }); msg != "" {
			s.Rollback()
			out.Migrations = append(out.Migrations, migrationRun{Name: name, Changed: map[string]map[string]int{}, Error: msg})
			return write()
		}
		out.Migrations = append(out.Migrations, migrationRun{Name: name, Changed: changedBy(s.Log[mark:])})
	}
	// every invariant on every row
	found := map[string]*Violation{}
	order := []string{}
	if app.Migrate.Invariants != nil {
		app.Migrate.Invariants(c, func(entity, detail string, id int64) {
			k := entity + "|" + detail
			v := found[k]
			if v == nil {
				v = &Violation{Check: "invariant", Entity: entity, Detail: detail, Sample: []int64{}}
				found[k] = v
				order = append(order, k)
			}
			v.Count++
			if len(v.Sample) < 5 {
				v.Sample = append(v.Sample, id)
			}
		})
	}
	for _, k := range order {
		out.Checks = append(out.Checks, *found[k])
	}
	s.Commit()
	return write()
}

// changedBy counts the rows a migration created, updated and deleted, per entity: a row it
// created and then changed counts as created, one it created and deleted not at all.
func changedBy(log []Change) map[string]map[string]int {
	state := map[string]map[int64]string{}
	for _, ch := range log {
		m := state[ch.E]
		if m == nil {
			m = map[int64]string{}
			state[ch.E] = m
		}
		was := m[ch.ID]
		switch ch.Op {
		case "create":
			m[ch.ID] = "created"
		case "update":
			if was == "" {
				m[ch.ID] = "updated"
			}
		case "delete":
			if was == "created" {
				delete(m, ch.ID)
			} else {
				m[ch.ID] = "deleted"
			}
		}
	}
	out := map[string]map[string]int{}
	names := []string{}
	for e := range state {
		names = append(names, e)
	}
	sort.Strings(names)
	for _, e := range names {
		c := map[string]int{"created": 0, "updated": 0, "deleted": 0}
		any := false
		for _, st := range state[e] {
			c[st]++
			any = true
		}
		if any {
			out[e] = c
		}
	}
	return out
}

// FieldIndex is the position of the named field, or -1.
func (e *Entity) FieldIndex(name string) int {
	for i, f := range e.Fields {
		if f.Name == name {
			return i
		}
	}
	return -1
}

// Holds is whether a condition holds; one that fails to evaluate (a refusal, a missing row)
// doesn't.
func Holds(f func() bool) (ok bool) {
	defer func() {
		if r := recover(); r != nil {
			ok = false
		}
	}()
	return f()
}
