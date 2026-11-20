package rt

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

// exportTenant: app export --data <dir> --tenant <Entity>:<id> [--match <Entity>:<field> …]
//
// One tenant's rows (a wiki and everything in it), in the form `app import --add` reads, to move
// it to another install. They are the row and every row deleting it would delete: references
// marked `on delete cascade`, followed down. Their ids are the labels their references use.
//
// A row they refer to outside the tenant (a User who wrote a page) comes along when --match names
// its entity and a unique field (--match User:email): it's written with "match": "email", and
// import --add uses the row the other install has with the same value, or adds it. Any other
// reference outside the tenant is an error that names it. Sessions and agent tokens aren't the
// app's rows, and don't come.
//
// The rows go to stdout as JSON, with "files": the stored keys of the files they hold, to copy when
// files are kept in the data folder rather than a shared bucket.
func exportTenant(app *App, args []string) int {
	fs := flag.NewFlagSet("export", flag.ExitOnError)
	data := fs.String("data", "data", "the data directory")
	tenant := fs.String("tenant", "", "the row to export with what's inside it: Entity:id")
	var matches multiFlag
	fs.Var(&matches, "match", "an entity whose rows the tenant refers to, matched by a unique field: Entity:field (repeatable)")
	fs.Parse(args)
	fail := func(format string, a ...any) int {
		j, _ := json.Marshal(map[string]any{"error": fmt.Sprintf(format, a...)})
		os.Stdout.Write(append(j, '\n'))
		return 1
	}
	name, idText, _ := strings.Cut(*tenant, ":")
	id, err := strconv.ParseInt(idText, 10, 64)
	root := app.Ents[name]
	if root == nil || !root.Stored || err != nil {
		return fail("--tenant is Entity:id, with a stored entity (the entities: %v)", app.EntityOrder)
	}
	match := map[string]string{}
	for _, m := range matches {
		e, f, _ := strings.Cut(m, ":")
		ent := app.Ents[e]
		if ent == nil || ent.FieldIndex(f) < 0 {
			return fail("--match %s: no entity %s with a field %s", m, e, f)
		}
		unique := false
		for _, u := range ent.Uniques {
			if len(u) == 1 && u[0] == f {
				unique = true
			}
		}
		if !unique {
			return fail("--match %s: %s.%s isn't unique on its own, so it can't name one row", m, e, f)
		}
		match[e] = f
	}
	path := filepath.Join(*data, "app.sqlite")
	if _, err := os.Stat(path); err != nil {
		return fail("no database at %s", path)
	}
	db, err := Open(path, app.Ents)
	if err != nil {
		return fail("storage: %v", err)
	}
	app.DB = db
	s := db.Session(app.Ents)
	defer s.Done()

	// the tenant: the row, then every row a cascade from it reaches
	type key struct {
		e  string
		id int64
	}
	in := map[key]*Row{}
	order := []key{}
	add := func(e string, r *Row) bool {
		k := key{e, r.ID}
		if in[k] != nil {
			return false
		}
		in[k] = r
		order = append(order, k)
		return true
	}
	start := s.Find(root, id)
	if start == nil {
		return fail("no %s %d", name, id)
	}
	add(name, start)
	for i := 0; i < len(order); i++ {
		parent := order[i]
		for _, cn := range app.EntityOrder {
			ce := app.Ents[cn]
			if !ce.Stored {
				continue
			}
			for fi, f := range ce.Fields {
				if f.Kind != 'r' || f.Ref != parent.e || f.OnDelete != "cascade" {
					continue
				}
				for _, r := range s.Select(ce, "t0."+ce.FieldCols[fi][0]+" = ?", parent.id) {
					add(cn, r)
				}
			}
		}
	}
	// what they refer to outside: matched rows, or an error
	outside := map[key]*Row{}
	var problems []string
	for _, k := range order {
		e := app.Ents[k.e]
		for fi, f := range e.Fields {
			ref, ok := in[k].Get(fi).(Ref)
			if f.Kind != 'r' || !ok || ref.ID == 0 || in[key{ref.E, ref.ID}] != nil {
				continue
			}
			if _, ok := match[ref.E]; !ok {
				problems = append(problems, fmt.Sprintf("%s %d's %s is %s %d, outside the tenant: say --match %s:<a unique field>", k.e, k.id, f.Name, ref.E, ref.ID, ref.E))
				continue
			}
			if outside[key{ref.E, ref.ID}] == nil {
				if r := s.Find(app.Ents[ref.E], ref.ID); r != nil {
					outside[key{ref.E, ref.ID}] = r
				}
			}
		}
	}
	// a matched row's own references stay behind: optional ones are left out, others are an error
	for k, r := range outside {
		e := app.Ents[k.e]
		for fi, f := range e.Fields {
			if ref, ok := r.Get(fi).(Ref); f.Kind == 'r' && ok && ref.ID != 0 && in[key{ref.E, ref.ID}] == nil && outside[key{ref.E, ref.ID}] == nil && !f.Optional {
				problems = append(problems, fmt.Sprintf("%s %d (matched) needs %s %d, which isn't coming", k.e, k.id, ref.E, ref.ID))
			}
		}
	}
	if len(problems) > 0 {
		sort.Strings(problems)
		if len(problems) > 20 {
			problems = append(problems[:20], fmt.Sprintf("… and %d more", len(problems)-20))
		}
		return fail("%s", strings.Join(problems, "; "))
	}
	rows := map[string][]any{}
	files := map[string]bool{}
	write := func(e *Entity, r *Row, matchBy string) {
		j := rowJSON(e, r)
		delete(j, "seq")
		fields := j["fields"].(map[string]any)
		for fi, f := range e.Fields {
			if f.Type == "File" {
				if o, ok := r.Get(fi).(Obj); ok && Plain(o["stored"]) != "" {
					files[Plain(o["stored"])] = true
				}
			}
			// a matched row's references that stay behind: left out (they're optional)
			if ref, ok := r.Get(fi).(Ref); matchBy != "" && f.Kind == 'r' && ok && in[key{ref.E, ref.ID}] == nil && outside[key{ref.E, ref.ID}] == nil {
				delete(fields, f.Name)
			}
		}
		if matchBy != "" {
			j["match"] = matchBy
		}
		rows[e.Name] = append(rows[e.Name], j)
	}
	for _, name := range app.EntityOrder {
		e := app.Ents[name]
		ids := []int64{}
		for k := range in {
			if k.e == name {
				ids = append(ids, k.id)
			}
		}
		for k := range outside {
			if k.e == name {
				ids = append(ids, k.id)
			}
		}
		sort.Slice(ids, func(a, b int) bool { return ids[a] < ids[b] })
		for _, rid := range ids {
			if r := in[key{name, rid}]; r != nil {
				write(e, r, "")
			} else {
				write(e, outside[key{name, rid}], match[name])
			}
		}
	}
	keys := []string{}
	for k := range files {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	j, err := json.Marshal(map[string]any{"now": app.Clock(), "rows": rows, "files": keys})
	if err != nil {
		return fail("%v", err)
	}
	os.Stdout.Write(append(j, '\n'))
	return 0
}

type multiFlag []string

func (m *multiFlag) String() string     { return strings.Join(*m, ",") }
func (m *multiFlag) Set(v string) error { *m = append(*m, v); return nil }
