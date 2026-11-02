[← the language guide](../LANGUAGE.md)

## Extending with Go

The language is small on purpose. When an app needs something it doesn't have (a check against a standard, a call to a provider, a custom piece of a page), the app brings Go. There are three ways, from the lightest; the examples below are one app, built and run as written by `test/go-examples.test.ts`.

| You need | Use | Where the Go lives |
| --- | --- | --- |
| A function from Go's standard library or a published module | an `extern fn … = go "pkg".Func` | the library, pinned with `import go "module@version"` |
| Your own logic: a parser, a checksum, a call to a provider | an `extern fn … = go Func` | `ext.go`, beside the spec |
| Your own piece of a page | a `widget` | `widgets.go`, beside the spec |

### A function from a library

```
extern fn shout(t: Text): Text effect pure = go "strings".ToUpper
```

`call shout(note)` now runs Go's `strings.ToUpper`. For a module outside the standard library, pin it once and name its packages:

```
import go "github.com/google/uuid@v1.6.0"
extern fn valid_id(t: Text): Text? effect pure = go "github.com/google/uuid".Validate
```

`node lang/cli.ts bind "github.com/google/uuid"` prints the `extern` lines for a package's functions, and why it can't bind the others. It writes `effect TODO`, which the checker refuses until you choose the effect.

### Your own functions: `ext.go`

A file called `ext.go` beside the spec (`package main`) is compiled into the app. A binding without a package names a function in it:

```
extern fn vat_problem(id: Text): Text? effect pure = go VatProblem
extern fn to_cents(price: Text): Int? effect pure = go ToCents
extern fn slug(t: Text): Text effect pure = go Slug
```
```go
// ext.go
package main

import ("errors"; "regexp"; "strconv"; "strings")

var vat = regexp.MustCompile(`^[A-Z]{2}[0-9]{8,12}$`)

// an error: the spec sees Text?, none when it is nil
func VatProblem(id string) error {
	if !vat.MatchString(id) { return errors.New("not a VAT number") }
	return nil
}

// (value, error): the spec sees Int?, none when the error is not nil
func ToCents(price string) (int, error) {
	f, err := strconv.ParseFloat(strings.TrimSpace(price), 64)
	if err != nil || f < 0 { return 0, errors.New("not a price") }
	return int(f*100 + 0.5), nil
}

func Slug(s string) string { return strings.ReplaceAll(strings.ToLower(s), " ", "-") }
```

The spec then checks what Go answered, like any value:

```
action place(vat_id: Text, price: Text, note: Text) {
  require actor != none else unauthenticated
  require call vat_problem(vat_id) == none else invalid       // Go said the number is fine
  require call to_cents(price) != none else invalid           // and the price parses
  create Order { customer: actor, vat_id: vat_id, note: call shout(note), cents: call to_cents(price) } as o
  emit OrderPlaced(o)
}
```

### Choosing the effect

Every `extern` says what it does to the world. The effect decides where it may be called, so the checks and the change review can see it:

- **`pure`:** the same arguments always give the same result, and it reads and changes nothing outside the app (not the clock, not randomness, not a file). It may be called anywhere: an action, a view, a screen, a `where`.
- **`fetch`:** it only reads from outside. A value view may call it.
- **Any other name** (`mail`, `http`, `push`, … your word for it): it changes something outside. Only a workflow step may call it. A workflow runs after the action that emitted its event commits, and a step is retried until it succeeds, so **the function must be safe to run twice** (send with an idempotency key, or check first).

```
extern fn send_sms(to: Text, body: Text): Text? effect http = go SendSMS

after commit on OrderPlaced(o) {
  step text_customer: let r = call send_sms(o.customer.name, "order in: " + call slug(o.note))
}
```
```go
func SendSMS(to string, body string) error { /* call the provider */ return nil }
```

An effect function an action calls is an error (`EXTERN_OUTSIDE_WORKFLOW`). With `--offline`, a binding whose effect isn't `pure` or `fetch` isn't called and gives none, so tests and previews never reach the outside.

### Your own piece of a page: widgets

For markup the UI elements can't make, declare a widget in the spec and write it in Go:

```
widget badge(label: Text)
screen orders() { route "/orders"  layout l  require public
  <Fill name=main><List of={Order where true} as=o><Widget call={badge(o.note)} /></List></Fill>
}
```
```go
// widgets.go
package main

import "crudspec/gogen/rt"

var widgets = map[string]func([]rt.Val, rt.WidgetHelpers) string{
	"badge": func(a []rt.Val, h rt.WidgetHelpers) string {
		return `<span class="badge">` + rt.Esc(rt.Plain(rt.Arg(a, 0))) + `</span>`
	},
}
```

The function gets the call's arguments (`rt.Arg(a, 0)`) and helpers (`h.DC("button")` for the theme's class, `h.Display(ref)` for a row's name, `h.FileURL`, `h.Asset`). **Escape what you write into the markup** with `rt.Esc`: a widget is not checked, and a value from a user is untrusted. Give a widget the values it shows as arguments. `--widgets <file.go>` builds with a file from elsewhere.

### Types across the line

| In the spec | In Go |
| --- | --- |
| `Text`, `Email`, `Url` | `string` (or `[]byte`) |
| `Int` | any int type (a value that doesn't fit is refused) |
| `Bool` | `bool` |
| `Time`, `Duration` | `time.Time`, `time.Duration` |
| `list of Text` | `[]string` |

A result is nothing, or one value, or an `error` (seen as `Text?`: the message, none when nil), or `(value, error)` (seen as the value made optional). Anything else (a row, a map, several values) needs a small wrapper in `ext.go` that takes and returns these. A parameter can't be optional, so a function that takes "maybe a value" takes the value and a `Bool`.

### What is checked

- **At `check`:** the types above (`GO_TYPE`), a chosen effect (`GO_EFFECT`), a module outside the standard library having a pinned `import go` (`GO_IMPORT`), and where an extern is called (`EXTERN_OUTSIDE_WORKFLOW`).
- **When the app starts:** every binding's Go signature against the spec's, naming the spec's line (`app.crud:12: extern shout: parameter 1 is Int in the spec but string in Go`). A mismatch stops the app; it never runs with a wrong binding.
- **At `build`:** each `import go` module is fetched at its pinned version, and `go.sum` is kept beside the spec.

What is not checked is what the Go does. It runs with the app's privileges, outside the language's rules: it can read the clock, touch files, or open a socket whatever the effect says. The effect is a promise the spec relies on; keep it. And keep to the language where you can: a rule that can be a `require` should be one, because only a `require` is seen by `review`, the deep checks and the provers.
