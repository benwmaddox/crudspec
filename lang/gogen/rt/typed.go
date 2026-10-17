package rt

import (
	"unicode/utf8"
	"strconv"
	"strings"
)

// Typed values, for the code the generator compiles from the type pass (lang/types.ts):
// Int is int64, Text and enum values are string, a row is Ref (ID 0 is none), times are
// Time, rich text is Rich. A value that may be none is Opt[T]. The semantics are the
// interpreter's: none equals only none, orders below everything, and reads as "".

type Opt[T any] struct {
	V  T
	Ok bool
}

func Some[T any](v T) Opt[T] { return Opt[T]{V: v, Ok: true} }

func (o Opt[T]) Val() Val {
	if !o.Ok {
		return nil
	}
	return o.V
}

// ---- from a dynamic value (a variable, a field slot, a builtin's result)

func AsInt(v Val) int64 {
	switch x := v.(type) {
	case int64:
		return x
	case nil:
		return 0
	}
	return Num(v)
}
func AsOptInt(v Val) Opt[int64] {
	if v == nil {
		return Opt[int64]{}
	}
	return Some(AsInt(v))
}
func AsBool(v Val) bool { b, ok := v.(bool); return ok && b }
func AsOptBool(v Val) Opt[bool] {
	if b, ok := v.(bool); ok {
		return Some(b)
	}
	return Opt[bool]{}
}
func AsStr(v Val) string {
	if s, ok := v.(string); ok {
		return s
	}
	return Plain(v)
}
func AsOptStr(v Val) Opt[string] {
	if v == nil {
		return Opt[string]{}
	}
	return Some(AsStr(v))
}
func AsTime(v Val) Time { t, _ := v.(Time); return t }
func AsOptTime(v Val) Opt[Time] {
	if t, ok := v.(Time); ok {
		return Some(t)
	}
	return Opt[Time]{}
}
func AsDur(v Val) Dur { d, _ := v.(Dur); return d }
func AsRich(v Val) Rich {
	switch x := v.(type) {
	case Rich:
		return x
	case string:
		return Rich{Text: x, Mentions: []int64{}}
	}
	return Rich{}
}
func AsOptRich(v Val) Opt[Rich] {
	if v == nil {
		return Opt[Rich]{}
	}
	return Some(AsRich(v))
}
func AsRef(v Val) Ref { r, _ := v.(Ref); return r }

// ---- to a dynamic value

func BoxRef(r Ref) Val {
	if r.ID == 0 {
		return nil
	}
	return r
}

// ---- operations

func RefEq(a, b Ref) bool { return a.ID == b.ID && (a.ID == 0 || a.E == b.E) }

func OptEq[T comparable](a, b Opt[T]) bool { return a.Ok == b.Ok && (!a.Ok || a.V == b.V) }
func OptIs[T comparable](a Opt[T], b T) bool { return a.Ok && a.V == b }

func TimeCmp(a, b Time) int {
	if a.T != b.T {
		return sign(a.T - b.T)
	}
	return sign(a.Seq - b.Seq)
}
func IntCmp(a, b int64) int { return sign(a - b) }
func StrCmp(a, b string) int { return strings.Compare(a, b) }

// optional values order none first, as the interpreter's compare
func OptCmp[T any](a, b Opt[T], cmp func(T, T) int) int {
	switch {
	case !a.Ok && !b.Ok:
		return 0
	case !a.Ok:
		return -1
	case !b.Ok:
		return 1
	}
	return cmp(a.V, b.V)
}

// text, as the interpreter's plain() writes a value
func IntText(n int64) string { return strconv.FormatInt(n, 10) }
func OptIntText(o Opt[int64]) string {
	if !o.Ok {
		return ""
	}
	return IntText(o.V)
}
func BoolText(b bool) string { return strconv.FormatBool(b) }

func Blank(s string) bool        { return strings.TrimSpace(s) == "" }
func OptBlank(o Opt[string]) bool { return !o.Ok || Blank(o.V) }

func DivInt(a, b int64) int64 {
	if b == 0 {
		return 0
	}
	return a / b
}
func TimePlus(t Time, d Dur) Time  { return Time{t.T + d.MS, t.Seq} }
func TimeMinus(t Time, d Dur) Time { return Time{t.T - d.MS, 0} }

func InSet(r Ref, s Set) bool { return r.ID != 0 && r.E == s.E && containsID(s.IDs, r.ID) }

// the typed SQL parameters
func PRef(r Ref) any {
	if r.ID == 0 {
		return nil
	}
	return r.ID
}
func PStr(s string) any { return s }
func POptStr(o Opt[string]) any {
	if !o.Ok {
		return nil
	}
	return o.V
}
func PInt(n int64) any { return n }
func POptInt(o Opt[int64]) any {
	if !o.Ok {
		return nil
	}
	return o.V
}
func PBool(b bool) any {
	if b {
		return int64(1)
	}
	return int64(0)
}

func AsSet(v Val) Set { s, _ := v.(Set); return s }

// ---- sizes (lang/sizes.ts): lengths in characters (code points), as SQLite's length() counts

func TextLen(s string) int { return utf8.RuneCountInString(s) }

// CheckSize refuses a text value outside its size (max or min of -1: none).
func CheckSize(v Val, max, min int, what string) {
	var s string
	switch x := v.(type) {
	case string:
		s = x
	case Rich:
		s = x.Text
	default:
		return
	}
	n := TextLen(s)
	if max >= 0 && n > max {
		Refuse("invalid", what+" is longer than "+strconv.Itoa(max)+" characters", "size")
	}
	if min >= 0 && n < min {
		Refuse("invalid", what+" is shorter than "+strconv.Itoa(min)+" characters", "size")
	}
}
