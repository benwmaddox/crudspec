// bind reads a Go package's exported functions and prints, for each one a spec can call, the
// extern line that binds it; for each it can't, why, so a small wrapper in the app's ext.go
// can bind it instead. The effect is for a person to choose: the lines say `effect pure`
// only for the packages known to be pure, and `effect TODO` otherwise.
//
//	go run ./bind net/smtp           (from lang/gogen)
//	go run ./bind ./path/to/app      (the app's own ext.go: its package main functions)
//	go run ./bind github.com/google/uuid@v1.6.0   (a module outside the standard library, at its version)
//	node lang/cli.ts bind <package or directory> [Func…]
package main

import (
	"fmt"
	"go/ast"
	"go/importer"
	"go/parser"
	"go/token"
	"go/types"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"unicode"
)

// standard-library packages whose functions have no effects outside the program
var purePkgs = map[string]bool{"strings": true, "strconv": true, "unicode": true, "unicode/utf8": true, "math": true,
	"path": true, "net/url": true, "html": true, "encoding/base64": true, "encoding/hex": true, "regexp": true, "sort": true,
	"bytes": true, "net/mail": true}

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: bind <package path or directory> [Func…]")
		os.Exit(64)
	}
	target, only := os.Args[1], os.Args[2:]
	fset := token.NewFileSet()
	var pkg *types.Package
	var err error
	if st, e := os.Stat(target); e == nil && st.IsDir() {
		pkg, err = dirPackage(fset, target)
	} else {
		// module@version: fetched into a scratch module first, so its packages resolve
		if at := strings.LastIndex(target, "@"); at > 0 {
			fmt.Printf("import go %q\n", target)
			target, err = fetch(target[:at], target[at+1:])
		}
		if err == nil {
			pkg, err = importer.ForCompiler(fset, "source", nil).Import(target)
		}
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "bind:", err)
		os.Exit(1)
	}
	pkgRef := fmt.Sprintf("%q.", pkg.Path())
	if pkg.Name() == "main" {
		pkgRef = "" // the app's own functions: = go Func
	}
	effect := "TODO"
	if purePkgs[pkg.Path()] {
		effect = "pure"
	}
	names := pkg.Scope().Names()
	sort.Strings(names)
	var skipped []string
	for _, n := range names {
		f, ok := pkg.Scope().Lookup(n).(*types.Func)
		if !ok || !f.Exported() || (len(only) > 0 && !contains(only, n)) {
			continue
		}
		line, why := externLine(f, pkgRef, effect)
		if why != "" {
			skipped = append(skipped, fmt.Sprintf("// %s: %s", n, why))
			continue
		}
		fmt.Println(line)
	}
	if len(skipped) > 0 {
		fmt.Println("\n// not bindable as is; wrap each in a function with plain types in the app's ext.go:")
		for _, s := range skipped {
			fmt.Println(s)
		}
	}
}

func contains(l []string, s string) bool {
	for _, x := range l {
		if x == s {
			return true
		}
	}
	return false
}

// externLine is the spec line for a function, or why there isn't one.
func externLine(f *types.Func, pkgRef, effect string) (string, string) {
	sig := f.Type().(*types.Signature)
	if sig.TypeParams().Len() > 0 {
		return "", "generic"
	}
	if sig.Variadic() {
		return "", "variadic"
	}
	var ps []string
	for i := 0; i < sig.Params().Len(); i++ {
		p := sig.Params().At(i)
		t, ok := specType(p.Type())
		if !ok {
			return "", fmt.Sprintf("parameter %s is %s", nameOr(p.Name(), i), p.Type())
		}
		ps = append(ps, fmt.Sprintf("%s: %s", snake(nameOr(p.Name(), i)), t))
	}
	ret := ""
	res := sig.Results()
	isErr := func(t types.Type) bool { return types.Identical(t, types.Universe.Lookup("error").Type()) }
	switch {
	case res.Len() == 0:
	case res.Len() == 1 && isErr(res.At(0).Type()):
		ret = ": Text?"
	case res.Len() == 1 || (res.Len() == 2 && isErr(res.At(1).Type())):
		t, ok := specType(res.At(0).Type())
		if !ok {
			return "", fmt.Sprintf("returns %s", res.At(0).Type())
		}
		ret = ": " + t
		if res.Len() == 2 {
			ret += "?"
		}
	default:
		return "", fmt.Sprintf("returns %d results", res.Len())
	}
	return fmt.Sprintf("extern fn %s(%s)%s effect %s = go %s%s", snake(f.Name()), strings.Join(ps, ", "), ret, effect, pkgRef, f.Name()), ""
}

func nameOr(n string, i int) string {
	if n == "" || n == "_" {
		return fmt.Sprintf("a%d", i+1)
	}
	return n
}

// specType is the spec type a Go type carries (rt/gobind.go's table).
func specType(t types.Type) (string, bool) {
	switch t.String() {
	case "string", "[]byte":
		return "Text", true
	case "bool":
		return "Bool", true
	case "int", "int8", "int16", "int32", "int64", "uint", "uint8", "uint16", "uint32", "uint64":
		return "Int", true
	case "time.Time":
		return "Time", true
	case "time.Duration":
		return "Duration", true
	case "[]string":
		return "list of Text", true
	}
	return "", false
}

// snake: ToUpper is to_upper, HTMLEscape is html_escape
func snake(s string) string {
	var b strings.Builder
	r := []rune(s)
	for i, c := range r {
		if unicode.IsUpper(c) {
			if i > 0 && (unicode.IsLower(r[i-1]) || (i+1 < len(r) && unicode.IsLower(r[i+1]) && unicode.IsUpper(r[i-1]))) {
				b.WriteByte('_')
			}
			c = unicode.ToLower(c)
		}
		b.WriteRune(c)
	}
	return b.String()
}

// dirPackage type-checks the Go files in a directory (an app's ext.go), on their own.
func dirPackage(fset *token.FileSet, dir string) (*types.Package, error) {
	files, _ := filepath.Glob(filepath.Join(dir, "ext.go"))
	if len(files) == 0 {
		return nil, fmt.Errorf("no ext.go in %s", dir)
	}
	return parseAndCheck(fset, files)
}

func parseAndCheck(fset *token.FileSet, paths []string) (*types.Package, error) {
	var files []*ast.File
	for _, p := range paths {
		f, err := parser.ParseFile(fset, p, nil, 0)
		if err != nil {
			return nil, err
		}
		files = append(files, f)
	}
	conf := types.Config{Importer: importer.ForCompiler(fset, "source", nil)}
	return conf.Check("main", fset, files, nil)
}

// fetch makes a scratch module that requires the module at that version, and works from it.
func fetch(path, version string) (string, error) {
	dir, err := os.MkdirTemp("", "crudspec-bind-")
	if err != nil {
		return "", err
	}
	os.WriteFile(filepath.Join(dir, "go.mod"), []byte("module bindscratch\n\ngo 1.27\n"), 0o644)
	cmd := exec.Command("go", "get", path+"@"+version)
	cmd.Dir, cmd.Stderr = dir, os.Stderr
	if err := cmd.Run(); err != nil {
		return "", fmt.Errorf("go get %s@%s: %v", path, version, err)
	}
	return path, os.Chdir(dir)
}
