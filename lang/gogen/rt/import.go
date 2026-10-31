package rt

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"
)

// importRows: app import --data <dir> [--replace] [--dry-run] < rows.json
//
//	{"now": ms, "rows": {"Entity": [{"id": 7, "created": ms, "updated": ms, "fields": {"name": "x", "owner": {"ref": "User", "id": 1}}}]}}
//
// It loads rows into the app's database as they are: an id kept (what other rows refer to), the
// times it was made and last changed (now when left out), a Time as {"time": ms, "seq": 0} or just
// the ms, a Password as {"password": "plain text"} (hashed here). Entities are read in the spec's
// order. Nothing is kept unless everything fits: a size, a unique key, a required field and a
// type are the database's to refuse, and every reference must name a row that is there and every
// invariant of the spec hold (checked as an upgrade checks them). The database must be empty, or
// --replace says to replace what is there; --dry-run loads, checks and keeps nothing.
// It writes {"imported": {...}, "problems": [...], "error": "..."} and exits 0 only when the rows were fine.
func importRows(app *App, b *Build, args []string) int {
	fs := flag.NewFlagSet("import", flag.ExitOnError)
	data := fs.String("data", "data", "the data directory")
	replace := fs.Bool("replace", false, "replace the rows the database has")
	dry := fs.Bool("dry-run", false, "load and check, and keep nothing")
	fs.Parse(args)
	type inRow struct {
		ID      *int64         `json:"id"`
		Created *int64         `json:"created"`
		Updated *int64         `json:"updated"`
		Fields  map[string]any `json:"fields"`
	}
	var in struct {
		Now  int64               `json:"now"`
		Rows map[string][]inRow `json:"rows"`
	}
	raw, _ := io.ReadAll(os.Stdin)
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(&in); err != nil {
		fmt.Fprintln(os.Stderr, "import: the input:", err)
		return 64
	}
	out := struct {
		Imported map[string]int `json:"imported"`
		Problems []Violation    `json:"problems"`
		Error    string         `json:"error,omitempty"`
		Kept     bool           `json:"kept"`
	}{Imported: map[string]int{}, Problems: []Violation{}}
	write := func(code int) int {
		j, _ := json.Marshal(out)
		os.Stdout.Write(j)
		os.Stdout.Write([]byte("\n"))
		return code
	}
	fail := func(format string, a ...any) int { out.Error = fmt.Sprintf(format, a...); return write(1) }
	for name := range in.Rows {
		if e := app.Ents[name]; e == nil || !e.Stored {
			return fail("%s is no entity of this app (the entities: %v)", name, app.EntityOrder)
		}
	}
	if in.Now == 0 {
		in.Now = time.Now().UnixMilli()
	}
	if err := os.MkdirAll(*data, 0o755); err != nil {
		return fail("%v", err)
	}
	path := filepath.Join(*data, "app.sqlite")
	if err := prepareDB(path, b); err != nil {
		return fail("%v", err)
	}
	JournalMode = "DELETE"
	db, err := Open(path, app.Ents)
	if err != nil {
		return fail("storage: %v", err)
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
	c.NoTransitions = true

	// what the database has now
	have := 0
	for _, name := range app.EntityOrder {
		if e := app.Ents[name]; e != nil && e.Stored {
			var n int
			db.W.QueryRow(`SELECT count(*) FROM ` + Q(name)).Scan(&n)
			have += n
		}
	}
	if have > 0 && !*replace {
		return fail("the database already has %d rows: import into an empty one, or say --replace to replace them", have)
	}

	s.Begin()
	rollback := func(code int) int { s.Rollback(); return write(code) }
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
	if *replace {
		s.Clear()
	}
	type made struct {
		e   *Entity
		row *Row
	}
	var loaded []made
	for _, name := range app.EntityOrder {
		list := in.Rows[name]
		e := app.Ents[name]
		for i, x := range list {
			id := db.nextID[name]
			if x.ID != nil {
				id = *x.ID
			}
			created, updated := in.Now, in.Now
			if x.Created != nil {
				created, updated = *x.Created, *x.Created
			}
			if x.Updated != nil {
				updated = *x.Updated
			}
			for k := range x.Fields {
				if e.FieldIndex(k) < 0 {
					out.Error = fmt.Sprintf("%s row %d: %s has no field %s", name, i+1, name, k)
					return rollback(1)
				}
			}
			vals := make([]Val, len(e.Fields))
			for fi, f := range e.Fields {
				fv := x.Fields[f.Name]
				// a Time may be given as the ms alone
				if n, ok := fv.(json.Number); ok && f.Type == "Time" {
					fv = map[string]any{"time": n, "seq": json.Number("0")}
				}
				v := Lift(fv)
				if f.Type == "Password" {
					if o, ok := v.(Obj); ok {
						if pw, ok := o["password"]; ok {
							v = Hash(Plain(pw))
						}
					}
				}
				vals[fi] = v
			}
			row := &Row{ID: id, Seq: db.seq, Created: created, Updated: updated}
			var rec Rec
			if msg := step(func() { rec = e.NewRec(vals) }); msg != "" {
				out.Error = fmt.Sprintf("%s row %d (id %d): %s", name, i+1, id, msg)
				return rollback(1)
			}
			row.R = rec
			// a field the row leaves out takes the spec's default; one that is required and has none is refused
			if msg := step(func() {
				for fi, f := range e.Fields {
					fv, given := x.Fields[f.Name]
					if given && fv != nil {
						continue
					}
					if def := app.Migrate.Defaults[name+"."+f.Name]; def != nil && !given {
						rec.Set(fi, def(c.InvariantCtx(e, row), row))
					}
					if rec.Get(fi) == nil && !f.Optional && f.Kind != 'j' {
						if f.Type == "Int" {
							rec.Set(fi, int64(0))
							continue
						}
						panic(fmt.Sprintf("%s is required", f.Name))
					}
				}
			}); msg != "" {
				out.Error = fmt.Sprintf("%s row %d (id %d): %s", name, i+1, id, msg)
				return rollback(1)
			}
			if msg := step(func() { s.Load(e, row) }); msg != "" {
				out.Error = fmt.Sprintf("%s row %d (id %d): %s", name, i+1, id, msg)
				return rollback(1)
			}
			loaded = append(loaded, made{e, row})
			out.Imported[name]++
		}
	}
	// every reference names a row that is there
	found := map[string]*Violation{}
	order := []string{}
	problem := func(check, entity, detail string, id int64) {
		k := check + "|" + entity + "|" + detail
		v := found[k]
		if v == nil {
			v = &Violation{Check: check, Entity: entity, Detail: detail, Sample: []int64{}}
			found[k] = v
			order = append(order, k)
		}
		v.Count++
		if len(v.Sample) < 5 {
			v.Sample = append(v.Sample, id)
		}
	}
	for _, m := range loaded {
		for fi, f := range m.e.Fields {
			if f.Kind != 'r' {
				continue
			}
			ref, ok := m.row.R.Get(fi).(Ref)
			if !ok || ref.ID == 0 {
				continue
			}
			if target := app.Ents[f.Ref]; target != nil && target.Stored && s.Find(target, ref.ID) == nil {
				problem("reference", m.e.Name, fmt.Sprintf("%s.%s names %s %d, which is not there", m.e.Name, f.Name, f.Ref, ref.ID), m.row.ID)
			}
		}
	}
	// every invariant of the spec, as an upgrade checks them
	if app.Migrate != nil && app.Migrate.Invariants != nil {
		if msg := step(func() { app.Migrate.Invariants(c, func(entity, detail string, id int64) { problem("invariant", entity, detail, id) }) }); msg != "" {
			out.Error = "checking the invariants: " + msg
			return rollback(1)
		}
	}
	for _, k := range order {
		out.Problems = append(out.Problems, *found[k])
	}
	if len(out.Problems) > 0 {
		return rollback(1)
	}
	if *dry {
		s.Rollback()
		return write(0)
	}
	s.Commit()
	out.Kept = true
	return write(0)
}
