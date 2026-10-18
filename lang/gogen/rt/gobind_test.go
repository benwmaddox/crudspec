package rt

import (
	"errors"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestBindGo(t *testing.T) {
	ok := func(b GoBinding) func([]Val) Val {
		f, err := bindOne(b)
		if err != nil {
			t.Fatalf("%s: %v", b.Name, err)
		}
		return f
	}
	bad := func(b GoBinding, want string) {
		if _, err := bindOne(b); err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("%s: want an error with %q, got %v", b.Name, want, err)
		}
	}
	// a value
	up := ok(GoBinding{Name: "upper", Params: []string{"Text"}, Returns: "Text", Fn: strings.ToUpper})
	if up([]Val{"hi"}) != "HI" {
		t.Error("strings.ToUpper")
	}
	// an int that isn't int64, and a list
	rep := ok(GoBinding{Name: "repeat", Params: []string{"Text", "Int"}, Returns: "Text", Fn: strings.Repeat})
	if rep([]Val{"ab", int64(3)}) != "ababab" {
		t.Error("strings.Repeat")
	}
	join := ok(GoBinding{Name: "join", Params: []string{"List", "Text"}, Returns: "Text", Fn: strings.Join})
	if join([]Val{List{"a", "b"}, "-"}) != "a-b" {
		t.Error("strings.Join")
	}
	// (value, error): none when it fails
	atoi := ok(GoBinding{Name: "atoi", Params: []string{"Text"}, Returns: "Int?", Fn: strconv.Atoi})
	if atoi([]Val{"42"}) != int64(42) || atoi([]Val{"x"}) != nil {
		t.Error("strconv.Atoi")
	}
	// error: the message, none when it worked
	check := ok(GoBinding{Name: "check", Params: []string{"Bool"}, Returns: "Text?", Fn: func(b bool) error {
		if b {
			return nil
		}
		return errors.New("no")
	}})
	if check([]Val{true}) != nil || check([]Val{false}) != "no" {
		t.Error("error result")
	}
	// times and durations
	later := ok(GoBinding{Name: "later", Params: []string{"Time", "Duration"}, Returns: "Time", Fn: func(t time.Time, d time.Duration) time.Time { return t.Add(d) }})
	if later([]Val{Time{T: 1000}, Dur{MS: 500}}).(Time).T != 1500 {
		t.Error("time and duration")
	}
	// an int out of range is refused, not wrapped
	small := ok(GoBinding{Name: "small", Params: []string{"Int"}, Returns: "Int", Fn: func(n int8) int8 { return n }})
	if small([]Val{int64(300)}) != nil {
		t.Error("an int8 parameter took 300")
	}
	// mismatches, each with a reason
	bad(GoBinding{Name: "arity", Params: []string{"Text"}, Returns: "Text", Fn: strings.Repeat}, "takes 2")
	bad(GoBinding{Name: "type", Params: []string{"Int"}, Returns: "Text", Fn: strings.ToUpper}, "parameter 1 is Int")
	bad(GoBinding{Name: "fails", Params: []string{"Text"}, Returns: "Int", Fn: strconv.Atoi}, "declare the result as Int?")
	bad(GoBinding{Name: "variadic", Params: []string{"Text"}, Returns: "", Fn: func(a ...string) {}}, "variadic")
	bad(GoBinding{Name: "struct", Params: []string{"Text"}, Returns: "Text", Fn: func(s struct{}) string { return "" }}, "small Go function")
	bad(GoBinding{Name: "none", Params: nil, Returns: "Text", Fn: func() {}}, "returns nothing")
}
