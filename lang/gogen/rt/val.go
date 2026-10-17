// Package rt is the runtime that compiled crudspec apps link against. Values here mirror the
// reference interpreter's (lang/interp.ts) exactly: the same shapes, the same equality and
// ordering, the same text conversion, so a compiled app behaves as the spec says.
package rt

import (
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"
)

// Val is any spec value: nil, bool, int64, string, Ref, Time, Dur, Rich, Set, List, Obj, and the
// marker values below.
type Val = any

type Ref struct {
	E  string
	ID int64
}
type Time struct{ T, Seq int64 }
type Dur struct{ MS int64 }
type Rich struct {
	Text     string
	Mentions []int64
	Entity   string
	Embeds   []any
}
type Set struct {
	E   string
	IDs []int64
}
type List = []Val
type Obj = map[string]Val

// markers the interpreter uses for names that aren't values
type Singleton struct{ E string }
type EntityName struct{ E string }
type Reference struct{ Name string }
type ScreenRef struct {
	Name string
	Args []Val
}
type APIRef struct {
	Name string
	Args []Val
}
type OldRow struct{ F map[string]Val } // a deleted or previous row, in triggers
type Lazy struct {                     // an action's entity parameter, checked when used
	E        string
	ID       int64
	Null     bool
	Optional bool
}

const MaxSeq = int64(9007199254740991)

func Truthy(v Val) bool { b, ok := v.(bool); return ok && b }

func Plain(v Val) string {
	switch x := v.(type) {
	case nil:
		return ""
	case string:
		return x
	case Rich:
		return x.Text
	case bool:
		if x {
			return "true"
		}
		return "false"
	case int64:
		return strconv.FormatInt(x, 10)
	case int:
		return strconv.Itoa(x)
	case float64:
		return strconv.FormatFloat(x, 'f', -1, 64)
	case Ref:
		return "[object Object]"
	case List:
		parts := make([]string, len(x))
		for i, e := range x {
			parts[i] = Plain(e)
		}
		return strings.Join(parts, ",")
	}
	return "[object Object]"
}

func Num(v Val) int64 {
	switch x := v.(type) {
	case int64:
		return x
	case int:
		return int64(x)
	case float64:
		return int64(x)
	case bool:
		if x {
			return 1
		}
		return 0
	case string:
		n, err := strconv.ParseFloat(strings.TrimSpace(x), 64)
		if err != nil {
			return 0
		}
		return int64(n)
	case nil:
		return 0
	}
	return 0
}

func Equal(a, b Val) bool {
	if ra, ok := a.(Ref); ok {
		rb, ok := b.(Ref)
		return ok && ra.E == rb.E && ra.ID == rb.ID
	}
	if ta, ok := a.(Time); ok {
		tb, ok := b.(Time)
		return ok && ta.T == tb.T && ta.Seq == tb.Seq
	}
	_, ra := a.(Rich)
	_, rb := b.(Rich)
	if ra || rb {
		return Plain(a) == Plain(b)
	}
	if isObject(a) && isObject(b) {
		return JSON(a) == JSON(b)
	}
	switch x := a.(type) {
	case int64:
		switch y := b.(type) {
		case int64:
			return x == y
		case int:
			return x == int64(y)
		case float64:
			return float64(x) == y
		}
		return false
	case int:
		return Equal(int64(x), b)
	case float64:
		switch y := b.(type) {
		case int64:
			return x == float64(y)
		case float64:
			return x == y
		}
		return false
	}
	return a == b
}

func isObject(v Val) bool {
	switch v.(type) {
	case nil, bool, int64, int, float64, string:
		return false
	}
	return true
}

func Compare(a, b Val) int {
	if ta, ok := a.(Time); ok {
		if tb, ok := b.(Time); ok {
			if ta.T != tb.T {
				return sign(ta.T - tb.T)
			}
			return sign(ta.Seq - tb.Seq)
		}
	}
	if sa, ok := a.(string); ok {
		if sb, ok := b.(string); ok {
			return strings.Compare(sa, sb)
		}
	}
	if a == nil || b == nil {
		if a == nil && b == nil {
			return 0
		}
		if a == nil {
			return -1
		}
		return 1
	}
	return sign(Num(a) - Num(b))
}

func sign(n int64) int {
	if n < 0 {
		return -1
	}
	if n > 0 {
		return 1
	}
	return 0
}

func Add(l, r Val) Val {
	if t, ok := l.(Time); ok {
		if d, ok := r.(Dur); ok {
			return Time{t.T + d.MS, t.Seq}
		}
	}
	if sl, ok := l.(Set); ok {
		if sr, ok := r.(Set); ok {
			ids := append([]int64{}, sl.IDs...)
			for _, id := range sr.IDs {
				if !containsID(ids, id) {
					ids = append(ids, id)
				}
			}
			return Set{sl.E, ids}
		}
	}
	if ll, ok := l.(List); ok {
		out := append(List{}, ll...)
		if rl, ok := r.(List); ok {
			return append(out, rl...)
		}
		return append(out, r)
	}
	if isNum(l) && isNum(r) {
		return Num(l) + Num(r)
	}
	return Plain(l) + Plain(r)
}
func Sub(l, r Val) Val {
	if t, ok := l.(Time); ok {
		if d, ok := r.(Dur); ok {
			return Time{t.T - d.MS, 0}
		}
	}
	return Num(l) - Num(r)
}
func Mul(l, r Val) Val { return Num(l) * Num(r) }
func Div(l, r Val) Val {
	d := Num(r)
	if d == 0 {
		return int64(0)
	}
	return Num(l) / d
}
func Neg(v Val) Val { return -Num(v) }

func isNum(v Val) bool {
	switch v.(type) {
	case int64, int, float64:
		return true
	}
	return false
}
func containsID(ids []int64, id int64) bool {
	for _, x := range ids {
		if x == id {
			return true
		}
	}
	return false
}

func In(l, r Val) bool {
	switch s := r.(type) {
	case Set:
		ref, ok := l.(Ref)
		return ok && ref.E == s.E && containsID(s.IDs, ref.ID)
	case List:
		for _, x := range s {
			if Equal(l, x) {
				return true
			}
		}
	}
	return false
}

// field access on values that aren't rows (rows go through the store: Ctx.Field)
func ValueField(t Val, name string) Val {
	switch x := t.(type) {
	case OldRow:
		return x.F[name]
	case Time:
		switch name {
		case "time":
			return x.T
		case "seq":
			return x.Seq
		}
	case Dur:
		if name == "ms" {
			return x.MS
		}
	case Rich:
		switch name {
		case "rich":
			return x.Text
		case "mentions":
			return idsToList(x.Mentions)
		case "entity":
			return x.Entity
		case "embeds":
			return List(x.Embeds)
		}
	case Set:
		switch name {
		case "set":
			return idsToList(x.IDs)
		case "entity":
			return x.E
		}
	case Obj:
		if v, ok := x[name]; ok {
			return v
		}
		if f, ok := x["file"]; ok {
			ct := Plain(x["content_type"])
			switch name {
			case "filename":
				return f
			case "content_type":
				return x["content_type"]
			case "size":
				if s, ok := x["size"]; ok {
					return s
				}
				return int64(0)
			case "kind":
				return KindOf(ct)
			}
		}
	}
	return nil
}

func KindOf(ct string) string {
	switch {
	case ct == "":
		return "other"
	case strings.HasPrefix(ct, "image/"):
		return "image"
	case strings.HasPrefix(ct, "video/"):
		return "video"
	case strings.HasPrefix(ct, "audio/"):
		return "audio"
	}
	return "other"
}

func idsToList(ids []int64) List {
	out := make(List, len(ids))
	for i, id := range ids {
		out[i] = id
	}
	return out
}

// ---- JSON: the encoding the TypeScript store uses, so both runtimes share one database

func (r Ref) MarshalJSON() ([]byte, error) {
	return json.Marshal(map[string]any{"ref": r.E, "id": r.ID})
}
func (t Time) MarshalJSON() ([]byte, error) {
	return json.Marshal(map[string]any{"time": t.T, "seq": t.Seq})
}
func (d Dur) MarshalJSON() ([]byte, error) { return json.Marshal(map[string]any{"ms": d.MS}) }
func (r Rich) MarshalJSON() ([]byte, error) {
	m := map[string]any{"rich": r.Text, "mentions": nonNilIDs(r.Mentions)}
	if r.Entity != "" {
		m["entity"] = r.Entity
	}
	if r.Embeds != nil {
		m["embeds"] = r.Embeds
	}
	return json.Marshal(m)
}
func (s Set) MarshalJSON() ([]byte, error) {
	return json.Marshal(map[string]any{"set": nonNilIDs(s.IDs), "entity": s.E})
}
func (o OldRow) MarshalJSON() ([]byte, error) { return json.Marshal(map[string]any{"old": o.F}) }
func nonNilIDs(ids []int64) []int64 {
	if ids == nil {
		return []int64{}
	}
	return ids
}

func JSON(v Val) string {
	b, err := json.Marshal(v)
	if err != nil {
		return "null"
	}
	return string(b)
}

// FromJSON decodes a stored JSON value into spec values, recognising the shapes by their keys
// as the interpreter does.
func FromJSON(s string) Val {
	var x any
	d := json.NewDecoder(strings.NewReader(s))
	d.UseNumber()
	if err := d.Decode(&x); err != nil {
		return nil
	}
	return Lift(x)
}

func Lift(x any) Val {
	switch v := x.(type) {
	case json.Number:
		if n, err := v.Int64(); err == nil {
			return n
		}
		f, _ := v.Float64()
		return int64(f)
	case float64:
		return int64(v)
	case []any:
		out := make(List, len(v))
		for i, e := range v {
			out[i] = Lift(e)
		}
		return out
	case map[string]any:
		if s, ok := v["set"]; ok {
			return Set{E: str(v["entity"]), IDs: liftIDs(s)}
		}
		if r, ok := v["rich"]; ok {
			var embeds []any
			if e, ok := v["embeds"].([]any); ok {
				for _, x := range e {
					embeds = append(embeds, Lift(x))
				}
			}
			return Rich{Text: str(r), Mentions: liftIDs(v["mentions"]), Entity: str(v["entity"]), Embeds: embeds}
		}
		if t, ok := v["time"]; ok {
			return Time{T: Num(Lift(t)), Seq: Num(Lift(v["seq"]))}
		}
		if _, ok := v["ref"]; ok {
			if id, ok := v["id"]; ok {
				return Ref{E: str(v["ref"]), ID: Num(Lift(id))}
			}
		}
		if ms, ok := v["ms"]; ok && len(v) == 1 {
			return Dur{MS: Num(Lift(ms))}
		}
		out := Obj{}
		for k, e := range v {
			out[k] = Lift(e)
		}
		return out
	}
	return x
}

func str(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	return ""
}
func liftIDs(v any) []int64 {
	l, _ := v.([]any)
	out := []int64{}
	for _, e := range l {
		out = append(out, Num(Lift(e)))
	}
	return out
}

func Debug(v Val) string { return fmt.Sprintf("%#v", v) }

// SortRows orders by a key, then by seq, as the interpreter's select does.
func SortStable[T any](items []T, less func(a, b T) bool) { sort.SliceStable(items, func(i, j int) bool { return less(items[i], items[j]) }) }
