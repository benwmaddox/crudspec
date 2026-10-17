// Compile-time spike: generates a Go app package shaped like crudspec's planned output, at a
// chosen scale, plus a small runtime package. node gen.mjs <outdir> <scale>
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const [out, scaleArg] = process.argv.slice(2);
const S = Number(scaleArg ?? 2);   // 1 = Campfire's estimated size
const ENT = 14 * S, ACT = 45 * S, VIEW = 13 * S, SCREEN = 48 * S, SALT = Date.now();
mkdirSync(join(out, "rt"), { recursive: true }); mkdirSync(join(out, "app"), { recursive: true });

writeFileSync(join(out, "go.mod"), `module spike\n\ngo 1.27\n\nrequire modernc.org/sqlite v1.39.0\n`);
writeFileSync(join(out, "rt", "rt.go"), `package rt

import (
	"database/sql"
	"html"
	"net/http"
	"strings"
	"sync"
	_ "modernc.org/sqlite"
)

type ID int64
type Outcome int

const (OK Outcome = iota; NotFound; Forbidden; Invalid)

type Row interface{ RowID() ID }
type Table[T Row] struct {
	mu   sync.RWMutex
	rows map[ID]*T
	seq  []ID
	next ID
	refs map[string]map[ID][]ID
	uniq map[string]map[string]ID
}
func NewTable[T Row]() *Table[T] { return &Table[T]{rows: map[ID]*T{}, refs: map[string]map[ID][]ID{}, uniq: map[string]map[string]ID{}} }
func (t *Table[T]) Get(id ID) *T { return t.rows[id] }
func (t *Table[T]) Insert(r *T) ID { t.next++; t.rows[t.next] = r; t.seq = append(t.seq, t.next); return t.next }
func (t *Table[T]) Delete(id ID) { delete(t.rows, id) }
func (t *Table[T]) Ref(index string, key ID) []ID { return t.refs[index][key] }
func (t *Table[T]) Index(index string, key, id ID) { m := t.refs[index]; if m == nil { m = map[ID][]ID{}; t.refs[index] = m }; m[key] = append(m[key], id) }
func (t *Table[T]) Unique(index, key string) (ID, bool) { id, ok := t.uniq[index][key]; return id, ok }
func (t *Table[T]) Last(n int) []ID { if len(t.seq) < n { return t.seq }; return t.seq[len(t.seq)-n:] }

type Undo struct{ steps []func() }
func (u *Undo) Push(f func()) { u.steps = append(u.steps, f) }
func (u *Undo) Rollback() { for i := len(u.steps) - 1; i >= 0; i-- { u.steps[i]() } }

type Buf struct{ strings.Builder }
func (b *Buf) Text(s string) { b.WriteString(html.EscapeString(s)) }
func (b *Buf) Raw(s string)  { b.WriteString(s) }

type DB struct{ *sql.DB }
func Open(path string) (*DB, error) { d, err := sql.Open("sqlite", path); return &DB{d}, err }
func Serve(addr string, h http.Handler) error { return http.ListenAndServe(addr, h) }
`);

const lines = [];
lines.push(`package app\n\nimport (\n\t"net/http"\n\t"strconv"\n\t"spike/rt"\n)\n\nconst salt = ${SALT}\nvar _ = http.NotFound\nvar _ = strconv.Itoa\n`);
for (let e = 0; e < ENT; e++) {
  lines.push(`type E${e} struct {\n\tID rt.ID\n\tSeq int64\n\tCreated, Updated int64\n${Array.from({ length: 8 }, (_, f) => `\tF${f} ${f % 3 === 0 ? "string" : f % 3 === 1 ? "rt.ID" : "int64"}\n`).join("")}}\nfunc (r E${e}) RowID() rt.ID { return r.ID }\nvar T${e} = rt.NewTable[E${e}]()\n`);
  lines.push(`func load${e}(db *rt.DB) error {\n\trows, err := db.Query("SELECT id, seq, created, updated, f0, f1, f2, f3, f4, f5, f6, f7 FROM e${e} ORDER BY seq")\n\tif err != nil { return err }\n\tdefer rows.Close()\n\tfor rows.Next() {\n\t\tvar r E${e}\n\t\tif err := rows.Scan(&r.ID, &r.Seq, &r.Created, &r.Updated, &r.F0, &r.F1, &r.F2, &r.F3, &r.F4, &r.F5, &r.F6, &r.F7); err != nil { return err }\n\t\tT${e}.Insert(&r)\n\t\tT${e}.Index("f1", r.F1, r.ID)\n\t\tT${e}.Index("f4", r.F4, r.ID)\n\t}\n\treturn rows.Err()\n}\n`);
}
for (let a = 0; a < ACT; a++) {
  const e = a % ENT, o = (a + 3) % ENT;
  lines.push(`func Action${a}(u *rt.Undo, actor rt.ID, id rt.ID, text string, n int64) rt.Outcome {
	r := T${e}.Get(id)
	if r == nil { return rt.NotFound }
	if len(T${o}.Ref("f1", r.F1)) == 0 && r.F4 != actor { return rt.Forbidden }
	if text == "" || len(text) > 280 { return rt.Invalid }
	old := *r
	r.F0 = text
	r.F2 = r.F2 + n
	u.Push(func() { *r = old })
	if _, taken := T${e}.Unique("f0", text); taken { u.Rollback(); return rt.Invalid }
	c := &E${o}{F0: text, F1: id, F4: actor, F2: n}
	cid := T${o}.Insert(c)
	c.ID = cid
	T${o}.Index("f1", c.F1, cid)
	u.Push(func() { T${o}.Delete(cid) })
	for _, k := range T${o}.Ref("f1", id) {
		if x := T${o}.Get(k); x != nil && x.F2 < 0 { u.Rollback(); return rt.Invalid }
	}
	return rt.OK
}
`);
}
for (let v = 0; v < VIEW; v++) {
  const e = v % ENT;
  lines.push(`func View${v}(actor rt.ID, key rt.ID, window int) []*E${e} {
	ids := T${e}.Ref("f1", key)
	if len(ids) > window { ids = ids[len(ids)-window:] }
	out := make([]*E${e}, 0, len(ids))
	for _, id := range ids {
		r := T${e}.Get(id)
		if r == nil { continue }
		if r.F4 != actor && len(T${(e + 1) % ENT}.Ref("f1", r.F1)) == 0 { continue }
		out = append(out, r)
	}
	return out
}
`);
}
for (let s = 0; s < SCREEN; s++) {
  const v = s % VIEW, e = v % ENT;
  const body = [];
  for (let k = 0; k < 12; k++) body.push(`\tb.Raw("<div class=\\"block-${s}-${k} flex gap\\"><h2>")\n\tb.Text("Section ${k} of screen ${s}")\n\tb.Raw("</h2>")\n\tif len(rows) > ${k} {\n\t\tb.Raw("<p class=\\"txt-small\\">")\n\t\tb.Text(rows[${k}].F0)\n\t\tb.Raw("</p>")\n\t} else {\n\t\tb.Raw("<p>Nothing yet</p>")\n\t}\n\tb.Raw("</div>")\n`);
  lines.push(`func Screen${s}(b *rt.Buf, actor rt.ID, key rt.ID) {
	rows := View${v}(actor, key, 40)
	b.Raw("<section id=\\"screen-${s}\\"><header><h1>")
	b.Text("Screen ${s}")
	b.Raw("</h1></header><ul class=\\"messages\\">")
	for _, r := range rows {
		b.Raw("<li id=\\"m-")
		b.Raw(strconv.FormatInt(int64(r.ID), 10))
		b.Raw("\\" class=\\"message\\"><strong>")
		b.Text(r.F0)
		b.Raw("</strong><span class=\\"meta\\">")
		b.Raw(strconv.FormatInt(r.F2, 10))
		b.Raw("</span><form method=\\"post\\" action=\\"/_do/action${s % ACT}\\"><button>Do it</button></form></li>")
	}
	b.Raw("</ul>")
${body.join("")}	b.Raw("</section>")
}
`);
}
lines.push(`func Handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var b rt.Buf
		key, _ := strconv.ParseInt(r.URL.Query().Get("k"), 10, 64)
		switch r.URL.Path {
${Array.from({ length: SCREEN }, (_, s) => `\t\tcase "/s${s}": Screen${s}(&b, 1, rt.ID(key))\n`).join("")}\t\tdefault:
			http.NotFound(w, r); return
		}
		w.Header().Set("Content-Type", "text/html")
		w.Write([]byte(b.String()))
	})
}
func Load(db *rt.DB) error {
${Array.from({ length: ENT }, (_, e) => `\tif err := load${e}(db); err != nil { return err }\n`).join("")}\treturn nil
}
`);
const src = lines.join("\n");
// split into a few files, as codegen would (parallel compile within the package)
const parts = src.split(/\n(?=func |type )/);
const header = parts.shift();
const chunk = Math.ceil(parts.length / 6);
for (let i = 0; i < 6; i++) writeFileSync(join(out, "app", `gen${i}.go`), (i === 0 ? header : `package app\n\nimport (\n\t"net/http"\n\t"strconv"\n\t"spike/rt"\n)\n\nvar _ = http.NotFound\nvar _ = strconv.Itoa\nvar _ rt.ID\n`) + "\n" + parts.slice(i * chunk, (i + 1) * chunk).join("\n") + "\n");
writeFileSync(join(out, "main.go"), `package main

import (
	"fmt"
	"os"
	"time"
	"spike/app"
	"spike/rt"
)

func main() {
	t0 := time.Now()
	db, err := rt.Open(os.Args[1])
	if err != nil { panic(err) }
	if len(os.Args) > 2 && os.Args[2] == "load-only" {
		if err := app.Load(db); err != nil { fmt.Println("load:", err) }
		fmt.Printf("loaded in %v\\n", time.Since(t0)); return
	}
	fmt.Printf("ready in %v\\n", time.Since(t0))
	rt.Serve("127.0.0.1:13890", app.Handler())
}
`);
console.log(`generated ${src.split("\n").length} lines (scale ${S}: ${ENT} entities, ${ACT} actions, ${VIEW} views, ${SCREEN} screens)`);
