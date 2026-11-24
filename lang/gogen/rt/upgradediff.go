package rt

// The steps from the schema a database recorded to the one this build was made for: a port of
// lang/schema.ts' diff, so the compiled app plans its own upgrade (upgrade.go). It reads the
// two schemas (the previous one from the database, this build's from Build.SchemaJSON) and what
// the spec says about renames and drops (Build.Upgrade, from lang/upgrade-info.ts). The steps
// and their words are the same as the TypeScript planner's, in the same order.

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"
)

// oobj is a JSON object that keeps its keys' order, as the TypeScript planner iterates them.
type oobj struct {
	Keys []string
	M    map[string]json.RawMessage
}

func (o *oobj) UnmarshalJSON(b []byte) error {
	o.M = map[string]json.RawMessage{}
	o.Keys = nil
	if bytes.Equal(bytes.TrimSpace(b), []byte("null")) {
		return nil
	}
	dec := json.NewDecoder(bytes.NewReader(b))
	if _, err := dec.Token(); err != nil {
		return err
	}
	for dec.More() {
		t, err := dec.Token()
		if err != nil {
			return err
		}
		k, _ := t.(string)
		var raw json.RawMessage
		if err := dec.Decode(&raw); err != nil {
			return err
		}
		if _, seen := o.M[k]; !seen {
			o.Keys = append(o.Keys, k)
		}
		o.M[k] = raw
	}
	return nil
}
func (o oobj) Has(k string) bool { _, ok := o.M[k]; return ok }
func (o oobj) Get(k string, v any) bool {
	raw, ok := o.M[k]
	if !ok {
		return false
	}
	return json.Unmarshal(raw, v) == nil
}

type fieldSchema struct {
	Type     string `json:"type"`
	Optional bool   `json:"optional"`
	Default  bool   `json:"default"`
	Max      *int   `json:"max"`
	Min      *int   `json:"min"`
}
type entitySchema struct {
	Singleton  bool       `json:"singleton"`
	Fields     oobj       `json:"fields"`
	Uniques    [][]string `json:"uniques"`
	Invariants []string   `json:"invariants"`
	Indexes    [][]string `json:"indexes"`
}
type paramSchema struct {
	Name     string `json:"name"`
	Type     string `json:"type"`
	Optional bool   `json:"optional"`
}
type schemaJSON struct {
	Format     *int `json:"format"`
	Entities   oobj `json:"entities"`
	Enums      oobj `json:"enums"`
	Actions    oobj `json:"actions"`
	Views      oobj `json:"views"`
	Invariants oobj `json:"invariants"`
}

func (s *schemaJSON) entity(name string) *entitySchema {
	var e entitySchema
	if !s.Entities.Get(name, &e) {
		return nil
	}
	return &e
}
func (e *entitySchema) field(name string) *fieldSchema {
	if e == nil {
		return nil
	}
	var f fieldSchema
	if !e.Fields.Get(name, &f) {
		return nil
	}
	return &f
}
func (s *schemaJSON) enum(name string) []string {
	var v []string
	if !s.Enums.Get(name, &v) {
		return nil
	}
	return v
}
func (s *schemaJSON) params(kind, name string) ([]paramSchema, bool) {
	o := s.Actions
	if kind == "views" {
		o = s.Views
	}
	var v struct {
		Params []paramSchema `json:"params"`
	}
	if !o.Get(name, &v) {
		return nil, false
	}
	return v.Params, true
}
func (s *schemaJSON) invariant(name string) (string, bool) {
	var v string
	ok := s.Invariants.Get(name, &v)
	return v, ok
}

// UpgradeInfo is Build.Upgrade: lang/upgrade-info.ts.
type UpgradeInfo struct {
	Entities []struct {
		Name       string      `json:"name"`
		Was        string      `json:"was"`
		Table      string      `json:"table"`
		Rich       []string    `json:"rich"`
		Indexes    [][2]string `json:"indexes"`
		Uniques    [][]string  `json:"uniques"`
		Invariants bool        `json:"invariants"`
		Fields     []struct {
			Name     string      `json:"name"`
			Was      string      `json:"was"`
			Named    bool        `json:"named"`
			Type     string      `json:"type"`
			Optional bool        `json:"optional"`
			Kind     string      `json:"kind"`
			To       string      `json:"to"`
			Enum     string      `json:"enum"`
			Cols     [][2]string `json:"cols"`
			Max      *int        `json:"max"`
			Min      *int        `json:"min"`
			Sized    bool        `json:"sized"`
		} `json:"fields"`
	} `json:"entities"`
	Drops [][2]string `json:"drops"`
	Enums []struct {
		Name    string      `json:"name"`
		Values  []string    `json:"values"`
		Renames [][2]string `json:"renames"`
	} `json:"enums"`
	AppInvariants bool `json:"appInvariants"`
}

// UpStep is one change an upgrade makes, classed: safe, checked (against the data), destructive
// (loses data the spec said to drop), blocked (needs the spec to say more) or contract (callers).
type UpStep struct {
	Op     string `json:"op"`
	Class  string `json:"class"`
	Entity string `json:"entity,omitempty"`
	Field  string `json:"field,omitempty"`
	From   string `json:"from,omitempty"`
	To     string `json:"to,omitempty"`
	Detail string `json:"detail"`
	Hint   string `json:"hint,omitempty"`
}

// storedTables is what the database holds: its tables, in order, and each one's columns.
type storedTables struct {
	Names []string
	Cols  map[string][]string
}

func (s storedTables) has(t string) bool { _, ok := s.Cols[t]; return ok }
func (s storedTables) hasCol(t, c string) bool {
	for _, x := range s.Cols[t] {
		if x == c {
			return true
		}
	}
	return false
}

var textLike = map[string]bool{"Text": true, "Email": true, "Url": true, "Ip": true}

func hasString(xs []string, x string) bool {
	for _, y := range xs {
		if y == x {
			return true
		}
	}
	return false
}

func diffSchemas(prev, next *schemaJSON, info *UpgradeInfo, stored storedTables) []UpStep {
	steps := []UpStep{}
	push := func(s UpStep) { steps = append(steps, s) }
	dropped := func(e, f string) bool {
		for _, d := range info.Drops {
			if d[0] == e && d[1] == f {
				return true
			}
		}
		return false
	}
	old := prev
	if old == nil {
		old = &schemaJSON{}
	}

	// entities: renamed, added, removed
	renamedFrom := map[string]string{} // new name -> old name
	renamedOld := map[string]bool{}
	for _, d := range info.Entities {
		if d.Was == "" {
			continue
		}
		if stored.has(d.Was) && !stored.has(d.Name) {
			renamedFrom[d.Name] = d.Was
			renamedOld[d.Was] = true
			push(UpStep{Op: "rename_entity", Class: "safe", Entity: d.Name, From: d.Was, To: d.Name, Detail: fmt.Sprintf("rename %s to %s; rows and references are kept", d.Was, d.Name)})
		}
	}
	oldNameOf := func(e string) string {
		if o, ok := renamedFrom[e]; ok {
			return o
		}
		return e
	}
	for _, name := range next.Entities.Keys {
		if stored.has(oldNameOf(name)) {
			continue
		}
		push(UpStep{Op: "create_entity", Class: "safe", Entity: name, Detail: "new entity " + name})
	}
	gone := []string{}
	for _, t := range stored.Names {
		if !next.Entities.Has(t) && !renamedOld[t] {
			gone = append(gone, t)
		}
	}
	for _, t := range gone {
		if dropped(t, "") {
			push(UpStep{Op: "drop_entity", Class: "destructive", Entity: t, Detail: fmt.Sprintf("drop %s and all its rows", t)})
		} else if old.Entities.Has(t) {
			push(UpStep{Op: "keep_entity", Class: "safe", Entity: t, Detail: fmt.Sprintf(`%s is no longer declared; its table is kept until "drop entity %s"`, t, t)})
		}
	}
	// an entity removed and another added with mostly the same fields looks like a rename
	for _, name := range next.Entities.Keys {
		if stored.has(oldNameOf(name)) || old.Entities.Has(name) {
			continue
		}
		for _, t := range gone {
			if dropped(t, "") || !old.Entities.Has(t) {
				continue
			}
			a, b := old.entity(t).Fields.Keys, next.entity(name).Fields.Keys
			shared := 0
			for _, f := range a {
				if hasString(b, f) {
					shared++
				}
			}
			if shared*2 >= max(len(a), len(b)) {
				push(UpStep{Op: "ambiguous_entity", Class: "blocked", Entity: name, From: t, Detail: fmt.Sprintf("%s was removed and %s added with mostly the same fields", t, name), Hint: fmt.Sprintf(`if %s is %s renamed, write "entity %s was %s"; if not, write "drop entity %s"`, name, t, name, t, t)})
			}
		}
	}

	// the storage format (the app upgrades only from format 5 on; upgrade.go refuses older ones)
	if prev != nil {
		was := 1
		if prev.Format != nil {
			was = *prev.Format
		}
		nf := 0
		if next.Format != nil {
			nf = *next.Format
		}
		if was != nf {
			parts := []string{}
			if was < 2 {
				parts = append(parts, "tables become STRICT (SQLite enforces each column's type) with size checks; each table is rebuilt and its rows checked")
			}
			if was < 3 {
				parts = append(parts, "Time fields become INTEGER milliseconds (UTC) with their order in a __seq column, Duration fields INTEGER milliseconds, Password fields plain TEXT, converted in place from their JSON")
			}
			if was < 4 {
				parts = append(parts, "File fields become four columns (the stored key, name, content type and size), RichText fields their text, with mentions and link previews in <Entity>__<field>__mentions and __embeds tables, converted in place from their JSON")
			}
			if was < 5 {
				parts = append(parts, "a reference to a stored entity becomes a foreign key (checked as each write commits); each table with one is rebuilt, after every reference is checked")
			}
			push(UpStep{Op: "storage_format", Class: "checked", Detail: strings.Join(parts, "; ")})
		}
	}

	// fields of entities that exist on both sides
	renamedTo := map[string]string{} // old name -> new name
	for n, o := range renamedFrom {
		renamedTo[o] = n
	}
	declOf := map[string]int{}
	for i, d := range info.Entities {
		declOf[d.Name] = i
	}
	for _, name := range next.Entities.Keys {
		ent := next.entity(name)
		before := old.entity(oldNameOf(name))
		if !stored.has(oldNameOf(name)) {
			continue
		}
		cols := oldNameOf(name)
		decl := info.Entities[declOf[name]]
		renamedField := map[string]string{} // new -> old
		renamedFieldOld := map[string]bool{}
		for _, f := range decl.Fields {
			if f.Was != "" && stored.hasCol(cols, f.Was) && !stored.hasCol(cols, f.Name) {
				renamedField[f.Name] = f.Was
				renamedFieldOld[f.Was] = true
				push(UpStep{Op: "rename_field", Class: "safe", Entity: name, Field: f.Name, From: f.Was, To: f.Name, Detail: fmt.Sprintf("rename %s.%s to %s; values are kept", name, f.Was, f.Name)})
			}
		}
		added := []string{}
		for _, fname := range ent.Fields.Keys {
			f := ent.field(fname)
			src := fname
			if o, ok := renamedField[fname]; ok {
				src = o
			}
			was := before.field(src)
			if !stored.hasCol(cols, src) {
				added = append(added, fname)
				if f.Optional || f.Default || f.Type == "Int" || f.Type == "Decimal" {
					how := ", 0 on existing rows"
					if f.Default {
						how = ", filled with its default on existing rows"
					} else if f.Optional {
						how = ", empty on existing rows"
					}
					push(UpStep{Op: "add_field", Class: "safe", Entity: name, Field: fname, Detail: fmt.Sprintf("new field %s.%s%s", name, fname, how)})
				} else {
					push(UpStep{Op: "add_required_field", Class: "checked", Entity: name, Field: fname, Detail: fmt.Sprintf("new required field %s.%s without a default", name, fname), Hint: "existing rows need a value: give it a default, or set it in a migration"})
				}
				continue
			}
			if was == nil {
				// a column kept from an earlier removal, declared again: its old values come back
				if _, ren := renamedField[fname]; prev != nil && !ren {
					push(UpStep{Op: "restore_field", Class: "checked", Entity: name, Field: fname, Detail: fmt.Sprintf("%s.%s is declared again; the values kept from before come back and are checked against its type", name, fname)})
				}
				continue
			}
			// the old type, in today's names: references and sets follow a renamed entity
			oldType := was.Type
			if strings.HasPrefix(oldType, "set of ") {
				t := oldType[7:]
				if n, ok := renamedTo[t]; ok {
					t = n
				}
				oldType = "set of " + t
			} else if n, ok := renamedTo[oldType]; ok {
				oldType = n
			}
			nextEnum := next.Enums.Has(f.Type)
			if oldType != f.Type && !(textLike[oldType] && textLike[f.Type]) && !(nextEnum && textLike[oldType]) && !(textLike[f.Type] && old.Enums.Has(oldType)) {
				push(UpStep{Op: "change_type", Class: "blocked", Entity: name, Field: fname, From: oldType, To: f.Type, Detail: fmt.Sprintf("%s.%s changes type from %s to %s", name, fname, oldType, f.Type), Hint: "add a new field, copy the values in a migration, then drop the old one"})
			} else if oldType != f.Type {
				what := " to be text (the language has no format rules, so formats aren't validated)"
				if nextEnum {
					what = fmt.Sprintf(" to be %s values", f.Type)
				}
				push(UpStep{Op: "change_type", Class: "checked", Entity: name, Field: fname, From: oldType, To: f.Type, Detail: fmt.Sprintf("%s.%s changes type from %s to %s; existing values are checked%s", name, fname, oldType, f.Type, what)})
			}
			// sizes: a tighter one is checked against the rows; a looser one is safe
			if (f.Max != nil && (was.Max == nil || *f.Max < *was.Max)) || (f.Min != nil && (was.Min == nil || *f.Min > *was.Min)) {
				parts := []string{}
				if f.Min != nil {
					parts = append(parts, fmt.Sprintf("min %d", *f.Min))
				}
				if f.Max != nil {
					parts = append(parts, fmt.Sprintf("max %d", *f.Max))
				}
				push(UpStep{Op: "tighten_size", Class: "checked", Entity: name, Field: fname, Detail: fmt.Sprintf("%s.%s gets a size (%s); existing values are checked", name, fname, strings.Join(parts, ", "))})
			} else if !sameIntPtr(was.Max, f.Max) || !sameIntPtr(was.Min, f.Min) {
				push(UpStep{Op: "loosen_size", Class: "safe", Entity: name, Field: fname, Detail: fmt.Sprintf("%s.%s's size is loosened", name, fname)})
			}
			if was.Optional && !f.Optional {
				push(UpStep{Op: "make_required", Class: "checked", Entity: name, Field: fname, Detail: fmt.Sprintf("%s.%s becomes required; existing empty values are checked", name, fname)})
			}
		}
		for _, c := range stored.Cols[cols] {
			if c == "id" || c == "seq" || c == "created" || c == "updated" || ent.Fields.Has(c) || renamedFieldOld[c] {
				continue
			}
			if dropped(name, c) {
				push(UpStep{Op: "drop_field", Class: "destructive", Entity: name, Field: c, Detail: fmt.Sprintf("drop %s.%s and its values", name, c)})
			} else if bf := before.field(c); bf != nil {
				push(UpStep{Op: "keep_field", Class: "safe", Entity: name, Field: c, Detail: fmt.Sprintf(`%s.%s is no longer declared; its values are kept until "drop %s.%s"`, name, c, name, c)})
				for _, a := range added {
					if ent.field(a).Type == bf.Type {
						push(UpStep{Op: "ambiguous_field", Class: "blocked", Entity: name, Field: a, From: c, Detail: fmt.Sprintf("%s.%s was removed and %s.%s added with the same type", name, c, name, a), Hint: fmt.Sprintf(`if it is a rename, write "%s: … was %s"; if not, write "drop %s.%s"`, a, c, name, c)})
						break
					}
				}
			}
		}
		// keys and rules: new ones are checked against the data
		key := func(u []string) string { return strings.Join(u, ",") }
		hasKey := func(list [][]string, u []string) bool {
			for _, b := range list {
				if key(b) == key(u) {
					return true
				}
			}
			return false
		}
		for _, u := range ent.Uniques {
			if before == nil || !hasKey(before.Uniques, u) {
				push(UpStep{Op: "add_unique", Class: "checked", Entity: name, Detail: fmt.Sprintf("new unique key (%s); existing rows are checked for duplicates", strings.Join(u, ", "))})
			}
		}
		if before != nil {
			for _, u := range before.Uniques {
				if !hasKey(ent.Uniques, u) {
					push(UpStep{Op: "remove_unique", Class: "safe", Entity: name, Detail: fmt.Sprintf("unique key (%s) removed", strings.Join(u, ", "))})
				}
			}
		}
		// indexes: new ones improve performance, removed ones are just dropped
		for _, ix := range ent.Indexes {
			if before == nil || !hasKey(before.Indexes, ix) {
				push(UpStep{Op: "add_index", Class: "safe", Entity: name, Detail: fmt.Sprintf("new index on (%s) to improve query performance", strings.Join(ix, ", "))})
			}
		}
		if before != nil {
			for _, ix := range before.Indexes {
				if !hasKey(ent.Indexes, ix) {
					push(UpStep{Op: "remove_index", Class: "safe", Entity: name, Detail: fmt.Sprintf("index on (%s) removed", strings.Join(ix, ", "))})
				}
			}
		}
		for _, inv := range ent.Invariants {
			if before == nil || !hasString(before.Invariants, inv) {
				push(UpStep{Op: "add_invariant", Class: "checked", Entity: name, Detail: fmt.Sprintf("new or changed invariant on %s; every row is checked", name)})
			}
		}
	}

	// the app's invariants: a new or changed one is checked against the data
	for _, name := range next.Invariants.Keys {
		inv, _ := next.invariant(name)
		was, had := old.invariant(name)
		if had && was == inv {
			continue
		}
		how := "new"
		if had && was != "" {
			how = "changed"
		}
		push(UpStep{Op: "add_invariant", Class: "checked", Detail: fmt.Sprintf("%s invariant %s; the data is checked", how, name)})
	}

	// enum values: renamed, removed
	for _, e := range info.Enums {
		before := old.enum(e.Name)
		if before == nil || !next.Enums.Has(e.Name) {
			continue
		}
		renamedValue := map[string]bool{}
		for _, r := range e.Renames {
			renamedValue[r[1]] = true
			if hasString(before, r[1]) && !hasString(before, r[0]) {
				push(UpStep{Op: "rename_value", Class: "safe", Entity: e.Name, From: r[1], To: r[0], Detail: fmt.Sprintf("%s value %s becomes %s in every row", e.Name, r[1], r[0])})
			}
		}
		for _, v := range before {
			if !hasString(e.Values, v) && !renamedValue[v] {
				push(UpStep{Op: "remove_value", Class: "checked", Entity: e.Name, From: v, Detail: fmt.Sprintf("%s value %s removed; rows still using it are checked", e.Name, v), Hint: fmt.Sprintf(`rewrite those rows in a migration, or write "<new> was %s"`, v)})
			}
		}
	}

	// the contract API and agent callers rely on
	for _, kind := range []string{"actions", "views"} {
		label := "action"
		keys := old.Actions.Keys
		if kind == "views" {
			label, keys = "view", old.Views.Keys
		}
		for _, n := range keys {
			a, _ := old.params(kind, n)
			b, ok := next.params(kind, n)
			if !ok {
				push(UpStep{Op: "remove_" + label, Class: "contract", Entity: n, Detail: fmt.Sprintf("%s %s removed; callers break", label, n)})
				continue
			}
			for _, p := range b {
				var q *paramSchema
				for i := range a {
					if a[i].Name == p.Name {
						q = &a[i]
						break
					}
				}
				if q == nil && !p.Optional {
					push(UpStep{Op: "add_param", Class: "contract", Entity: n, Field: p.Name, Detail: fmt.Sprintf("%s %s gains a required parameter %s; callers break", label, n, p.Name)})
				} else if q != nil && q.Type != p.Type {
					push(UpStep{Op: "change_param", Class: "contract", Entity: n, Field: p.Name, Detail: fmt.Sprintf("%s %s: %s changes type from %s to %s", label, n, p.Name, q.Type, p.Type)})
				}
			}
			for _, q := range a {
				found := false
				for _, p := range b {
					if p.Name == q.Name {
						found = true
						break
					}
				}
				if !found {
					push(UpStep{Op: "remove_param", Class: "contract", Entity: n, Field: q.Name, Detail: fmt.Sprintf("%s %s no longer takes %s; callers passing it break", label, n, q.Name)})
				}
			}
		}
	}
	return steps
}

func sameIntPtr(a, b *int) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}
