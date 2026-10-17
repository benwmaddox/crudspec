package rt

import "fmt"

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
