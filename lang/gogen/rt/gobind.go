package rt

import (
	"errors"
	"fmt"
	"os"
	"reflect"
	"time"
)

// Go bindings: an extern declared `= go "pkg".Func` (or `= go Func`, a function in the app's own
// Go files) calls that Go function. The generated program passes the function values; Bind checks
// each one's signature against the spec's declared types when the app starts, so a mismatch stops
// every run (deep checks, probes, the server) before any request, and names the spec line.
//
// Spec types and the Go types they map to:
//   Text, Email, Url   string (or []byte)
//   Int                int, int8…int64, uint…uint64 (range-checked)
//   Bool               bool
//   Time               time.Time
//   Duration           time.Duration
//   List of Text       []string
// Results: nothing; one mapped value; `error` (the spec sees Text?, the message, none when it
// worked); or (value, error) (the spec sees the value, or none when it failed; the error is logged).

// GoBinding is one bound extern: the spec's parameter and result types, and the Go function.
type GoBinding struct {
	Name, Where string   // the extern's name and its spec position
	Params      []string // spec type names: "Text", "Int", "Bool", "Time", "Duration", "List"
	Returns     string   // a spec type name, or "" for none; Optional when it ends in "?"
	Fn          any
}

var (
	tTime  = reflect.TypeOf(time.Time{})
	tDur   = reflect.TypeOf(time.Duration(0))
	tError = reflect.TypeOf((*error)(nil)).Elem()
	tBytes = reflect.TypeOf([]byte(nil))
	tStrs  = reflect.TypeOf([]string(nil))
)

// fits says whether a Go type can carry a spec type, and if not, why.
func fits(spec string, t reflect.Type) bool {
	switch spec {
	case "Text", "Email", "Url":
		return t.Kind() == reflect.String || t == tBytes
	case "Int":
		return t != tDur && (t.Kind() >= reflect.Int && t.Kind() <= reflect.Uint64)
	case "Bool":
		return t.Kind() == reflect.Bool
	case "Time":
		return t == tTime
	case "Duration":
		return t == tDur
	case "List":
		return t == tStrs
	}
	return false
}

// bindGo checks every binding when the program starts, whatever it runs (the server, an upgrade's
// data step, a probe); a mismatch ends it. Pure bindings run from any context (Ctx.Extern).
func (a *App) bindGo(effects map[string]string) {
	a.bound, a.Pure = map[string]func([]Val) Val{}, map[string]func([]Val) Val{}
	var bad []string
	for _, b := range a.GoBindings {
		f, err := bindOne(b)
		if err != nil {
			bad = append(bad, fmt.Sprintf("%s: extern %s: %v", b.Where, b.Name, err))
			continue
		}
		a.bound[b.Name] = f
		if effects[b.Name] == "pure" {
			a.Pure[b.Name] = f
		}
	}
	if len(bad) > 0 {
		for _, m := range bad {
			fmt.Fprintln(os.Stderr, m)
		}
		os.Exit(1)
	}
}

// addBound adds the bindings to the server's externs. In test mode (replays, deep checks) an
// effect is recorded rather than made, so they stay offline; pure and fetch bindings still run.
func (a *App) addBound(ex map[string]func([]Val) Val, test bool, effects map[string]string) {
	for name, f := range a.bound {
		if test && effects[name] != "pure" && effects[name] != "fetch" {
			name := name
			f = func(args []Val) Val { TestCalls = append(TestCalls, Obj{"extern": name, "args": List(args)}); return nil }
		}
		ex[name] = f
	}
}

// TestCalls are the effect externs called in test mode, in order.
var TestCalls []Val

func bindOne(b GoBinding) (func([]Val) Val, error) {
	fv := reflect.ValueOf(b.Fn)
	ft := fv.Type()
	if ft.Kind() != reflect.Func {
		return nil, errors.New("not a function")
	}
	if ft.IsVariadic() {
		return nil, errors.New("Go function is variadic; wrap it in a function with fixed parameters")
	}
	if ft.NumIn() != len(b.Params) {
		return nil, fmt.Errorf("the spec gives %d parameters, the Go function takes %d", len(b.Params), ft.NumIn())
	}
	for i, p := range b.Params {
		if !fits(p, ft.In(i)) {
			return nil, fmt.Errorf("parameter %d is %s in the spec but %s in Go; %s", i+1, p, ft.In(i), wrapHint)
		}
	}
	ret := b.Returns
	opt := len(ret) > 0 && ret[len(ret)-1] == '?'
	if opt {
		ret = ret[:len(ret)-1]
	}
	// the result shape
	shape := ""
	switch {
	case ft.NumOut() == 0:
		shape = "none"
	case ft.NumOut() == 1 && ft.Out(0) == tError:
		shape = "error"
	case ft.NumOut() == 1:
		shape = "value"
	case ft.NumOut() == 2 && ft.Out(1) == tError:
		shape = "value,error"
	default:
		return nil, fmt.Errorf("Go function returns %d results; %s", ft.NumOut(), wrapHint)
	}
	switch shape {
	case "none":
		if ret != "" {
			return nil, fmt.Errorf("the spec says it returns %s but the Go function returns nothing", b.Returns)
		}
	case "error":
		if ret != "" && (ret != "Text" || !opt) {
			return nil, fmt.Errorf("the Go function returns error: declare the extern's result as Text? (the message, none when it worked) or none")
		}
	case "value", "value,error":
		if ret == "" {
			break // the result is dropped
		}
		if !fits(ret, ft.Out(0)) {
			return nil, fmt.Errorf("the spec returns %s but the Go function returns %s; %s", b.Returns, ft.Out(0), wrapHint)
		}
		if shape == "value,error" && !opt {
			return nil, fmt.Errorf("the Go function can fail (it returns an error): declare the result as %s? (none when it failed)", ret)
		}
	}
	params := b.Params
	return func(a []Val) Val {
		in := make([]reflect.Value, len(params))
		for i := range params {
			v, err := toGo(arg(a, i), ft.In(i))
			if err != nil {
				fmt.Fprintf(os.Stderr, "%s: extern %s: argument %d: %v\n", b.Where, b.Name, i+1, err)
				return nil
			}
			in[i] = v
		}
		out := fv.Call(in)
		switch shape {
		case "error":
			if e, _ := out[0].Interface().(error); e != nil {
				return e.Error()
			}
			return nil
		case "value":
			return fromGo(out[0])
		case "value,error":
			if e, _ := out[1].Interface().(error); e != nil {
				fmt.Fprintf(os.Stderr, "%s: extern %s: %v\n", b.Where, b.Name, e)
				return nil
			}
			return fromGo(out[0])
		}
		return nil
	}, nil
}

const wrapHint = "write a small Go function with plain types (string, int64, bool, time.Time, time.Duration, []string) in the app's Go file and bind that"

func toGo(v Val, t reflect.Type) (reflect.Value, error) {
	switch {
	case t == tTime:
		tm, _ := v.(Time)
		return reflect.ValueOf(time.UnixMilli(tm.T)), nil
	case t == tDur:
		d, _ := v.(Dur)
		return reflect.ValueOf(time.Duration(d.MS) * time.Millisecond), nil
	case t == tBytes:
		return reflect.ValueOf([]byte(Plain(v))), nil
	case t == tStrs:
		var ss []string
		if l, ok := v.(List); ok {
			for _, x := range l {
				ss = append(ss, Plain(x))
			}
		}
		return reflect.ValueOf(ss), nil
	}
	r := reflect.New(t).Elem()
	switch t.Kind() {
	case reflect.String:
		r.SetString(Plain(v))
	case reflect.Bool:
		r.SetBool(Truthy(v))
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		n := Num(v)
		if r.OverflowInt(n) {
			return r, fmt.Errorf("%d doesn't fit %s", n, t)
		}
		r.SetInt(n)
	default: // unsigned
		n := Num(v)
		if n < 0 || r.OverflowUint(uint64(n)) {
			return r, fmt.Errorf("%d doesn't fit %s", n, t)
		}
		r.SetUint(uint64(n))
	}
	return r, nil
}

func fromGo(v reflect.Value) Val {
	t := v.Type()
	switch {
	case t == tTime:
		return Time{T: v.Interface().(time.Time).UnixMilli()}
	case t == tDur:
		return Dur{MS: int64(v.Interface().(time.Duration) / time.Millisecond)}
	case t == tBytes:
		return string(v.Bytes())
	case t == tStrs:
		l := List{}
		for _, s := range v.Interface().([]string) {
			l = append(l, s)
		}
		return l
	}
	switch t.Kind() {
	case reflect.String:
		return v.String()
	case reflect.Bool:
		return v.Bool()
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		return v.Int()
	default:
		return int64(v.Uint())
	}
}
