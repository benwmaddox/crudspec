package rt

import (
	"fmt"
	"strings"
)

// Column codecs and SQL parameters. The generator picks the function for each column and
// each comparison from the field's type, so nothing chooses an encoding at run time.

func EncR(v Val) any {
	if r, ok := v.(Ref); ok {
		return r.ID
	}
	return nil
}
func EncT(v Val) any {
	if v == nil {
		return nil
	}
	return Plain(v)
}
func EncI(v Val) any {
	if v == nil {
		return nil
	}
	return Num(v)
}
func EncB(v Val) any {
	if v == nil {
		return nil
	}
	if Truthy(v) {
		return int64(1)
	}
	return int64(0)
}
func EncJ(v Val) any {
	if v == nil {
		return nil
	}
	if r, ok := v.(RawJSON); ok { // never read: stored back as it was
		return string(r)
	}
	return JSON(v)
}

func DecR(e string, v any) Val {
	if v == nil {
		return nil
	}
	return Ref{E: e, ID: toInt(v)}
}
func DecT(v any) Val {
	switch x := v.(type) {
	case nil:
		return nil
	case string:
		return x
	case []byte:
		return string(x)
	}
	return fmt.Sprint(v)
}
func DecI(v any) Val {
	if v == nil {
		return nil
	}
	return toInt(v)
}
func DecB(v any) Val {
	if v == nil {
		return nil
	}
	return toInt(v) == 1
}

// DecJ keeps a JSON column as text until the row's field is read (Row.Get): most reads of a
// row never look at its message body or attachment.
func DecJ(v any) Val {
	switch x := v.(type) {
	case string:
		return RawJSON(x)
	case []byte:
		return RawJSON(string(x))
	}
	return nil
}

type RawJSON string

// Get is a row's field, decoded on first read.
func (r *Row) Get(i int) Val {
	v := r.F[i]
	if raw, ok := v.(RawJSON); ok {
		v = FromJSON(string(raw))
		r.F[i] = v
	}
	return v
}

// SQL parameters compared with a column, as the planner encodes them: a value that can't
// equal the column becomes one that never matches.
const noMatch = "\x00no match"

func PR(v Val) any { // a reference or an id column
	if v == nil {
		return nil
	}
	if r, ok := v.(Ref); ok {
		return r.ID
	}
	return int64(-1)
}
func PT(v Val) any {
	switch x := v.(type) {
	case nil:
		return nil
	case string:
		return x
	case Rich:
		return x.Text
	}
	return noMatch
}
func PB(v Val) any {
	switch x := v.(type) {
	case nil:
		return nil
	case bool:
		if x {
			return int64(1)
		}
		return int64(0)
	}
	return int64(-1)
}
func PI(v Val) any {
	if v == nil {
		return nil
	}
	if isNum(v) {
		return Num(v)
	}
	return noMatch
}
func PX(v Val) any {
	if v == nil {
		return nil
	}
	return noMatch
}

// lists for `col IN (SELECT value FROM json_each(?))`
func PLRef(entity string, v Val) string {
	switch x := v.(type) {
	case Set:
		if x.E == entity {
			return JSON(nonNilIDs(x.IDs))
		}
		return "[]"
	case List:
		return plist(x, PR)
	}
	return "[]"
}
func PLText(v Val) string { return plistOf(v, PT) }
func PLInt(v Val) string  { return plistOf(v, PI) }
func PLBool(v Val) string { return plistOf(v, PB) }
func plistOf(v Val, p func(Val) any) string {
	if l, ok := v.(List); ok {
		return plist(l, p)
	}
	return "[]"
}
func plist(l List, p func(Val) any) string {
	out := []any{}
	for _, e := range l {
		x := p(e)
		if x == nil || x == noMatch || x == int64(-1) {
			continue
		}
		out = append(out, x)
	}
	return JSON(out)
}

// A Time field is stored in two INTEGER columns: its milliseconds (UTC) and its order among
// times in the same millisecond (field and field__seq). Encode gives it as one TimeCol, so
// change tracking stays one value per field; Flat spreads it over its columns for SQL.
type TimeCol struct {
	T, Seq int64
	None   bool
}

func EncM(v Val) any {
	if t, ok := v.(Time); ok {
		return TimeCol{T: t.T, Seq: t.Seq}
	}
	return TimeCol{None: true}
}
func DecM(ms, seq any) Val {
	if ms == nil {
		return nil
	}
	return Time{T: toInt(ms), Seq: toInt(seq)}
}

// A Duration field is INTEGER milliseconds.
func EncD(v Val) any {
	if d, ok := v.(Dur); ok {
		return d.MS
	}
	return nil
}
func DecD(v any) Val {
	if v == nil {
		return nil
	}
	return Dur{MS: toInt(v)}
}

// Flat is encoded field values as SQL arguments: a TimeCol is its two columns.
func Flat(enc []any) []any {
	out := make([]any, 0, len(enc)+2)
	for _, v := range enc {
		if t, ok := v.(TimeCol); ok {
			if t.None {
				out = append(out, nil, nil)
			} else {
				out = append(out, t.T, t.Seq)
			}
			continue
		}
		switch x := v.(type) {
		case FileCol:
			if x.None {
				out = append(out, nil, nil, nil, nil)
			} else {
				out = append(out, x.Stored, x.Name, x.Type, x.Size)
			}
			continue
		case RichCol:
			if x.None {
				out = append(out, nil)
			} else {
				out = append(out, x.Text)
			}
			continue
		}
		out = append(out, v)
	}
	return out
}

// A Password field is TEXT: its scrypt hash, "scrypt:<salt>:<key>" (in memory {"scrypt": "<salt>:<key>"}).
func EncP(v Val) any {
	if o, ok := v.(Obj); ok {
		if s, ok := o["scrypt"].(string); ok {
			return "scrypt:" + s
		}
	}
	return nil
}
func DecP(v any) Val {
	s, ok := DecT(v).(string)
	if !ok || !strings.HasPrefix(s, "scrypt:") {
		return nil
	}
	return Obj{"scrypt": strings.TrimPrefix(s, "scrypt:")}
}

// A File field is four columns: field (the stored file's key), field__name, field__type and
// field__size. In memory it is {"file": name, "stored": key, "content_type": type, "size": n}.
type FileCol struct {
	Stored, Name, Type string
	Size               int64
	None               bool
}

func EncF(v Val) any {
	o, ok := v.(Obj)
	if !ok || Plain(o["stored"]) == "" {
		return FileCol{None: true}
	}
	return FileCol{Stored: Plain(o["stored"]), Name: Plain(o["file"]), Type: Plain(o["content_type"]), Size: Num(o["size"])}
}
func DecF(stored, name, typ, size any) Val {
	if stored == nil {
		return nil
	}
	return Obj{"stored": Plain(DecT(stored)), "file": Plain(DecT(name)), "content_type": Plain(DecT(typ)), "size": toInt(size)}
}

// A RichText field is its text in the field's column; its mentions and link previews are rows
// of two tables, <Entity>__<field>__mentions and <Entity>__<field>__embeds (RichField).
type RichCol struct {
	Text     string
	Mentions []int64
	Entity   string
	Embeds   []any
	None     bool
}

func EncH(v Val) any {
	switch r := v.(type) {
	case nil:
		return RichCol{None: true}
	case Rich:
		return RichCol{Text: r.Text, Mentions: r.Mentions, Entity: r.Entity, Embeds: r.Embeds}
	}
	return RichCol{Text: Plain(v)}
}
func DecH(v any) Val {
	if v == nil {
		return nil
	}
	return Rich{Text: Plain(DecT(v)), Mentions: []int64{}}
}

// RichField is where an entity's rich-text field keeps its mentions and previews.
type RichField struct {
	Idx              int
	Mentions, Embeds string // table names
}
