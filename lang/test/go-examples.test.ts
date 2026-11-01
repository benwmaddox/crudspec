// The examples in LANGUAGE.md's "Extending with Go", built and run as written: a standard-library
// binding, the app's own functions in ext.go (plain, with an error, with a value and an error), an
// effect function a workflow calls, and a widget in widgets.go.
//   node lang/test/go-examples.test.ts
process.removeAllListeners("warning");
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApp } from "./go-app.ts";

let failed = 0;
const ok = (what: string, pass: boolean, detail?: unknown) => { console.log(`${pass ? "ok  " : "FAIL"} ${what}`); if (!pass) { failed++; if (detail !== undefined) console.log(String(detail).slice(0, 600)); } };

const SPEC = `
app shop { name "Shop" actor User }
entity User { name: Text  token: Text? }
identity login: User.token from cookie "login"
entity Order { customer: User  vat_id: Text  note: Text  cents: Int? }
policy order_rows: true for rows of Order
policy user_rows: true for rows of User

// 1. the standard library
extern fn shout(t: Text): Text effect pure = go "strings".ToUpper

// 2. the app's own Go (ext.go beside this file)
extern fn vat_problem(id: Text): Text? effect pure = go VatProblem     // an error: none when it works
extern fn to_cents(price: Text): Int? effect pure = go ToCents         // (value, error): none when it fails
extern fn slug(t: Text): Text effect pure = go Slug

// 3. an effect: only a workflow step may call it
extern fn send_sms(to: Text, body: Text): Text? effect http = go SendSMS

action place(vat_id: Text, price: Text, note: Text) {
  require actor != none else unauthenticated
  require call vat_problem(vat_id) == none else invalid
  require call to_cents(price) != none else invalid
  create Order { customer: actor, vat_id: vat_id, note: call shout(note), cents: call to_cents(price) } as o
  emit OrderPlaced(o)
}
workflow on OrderPlaced(o) {
  step text_customer: let r = call send_sms(o.customer.name, "order in: " + call slug(o.note))
}

// 4. a widget: markup written in Go (widgets.go)
widget badge(label: Text)
layout l { <main><Slot name=main /></main> }
screen orders() { route "/orders"  layout l  access public
  <Fill name=main><List of={Order where true} as=o><Widget call={badge(o.note)} /></List></Fill>
}
`;
const EXT = `package main

import (
	"errors"
	"regexp"
	"strconv"
	"strings"
)

var vat = regexp.MustCompile(\`^[A-Z]{2}[0-9]{8,12}$\`)

// VatProblem returns an error, which the spec sees as Text?: none when it is nil.
func VatProblem(id string) error {
	if !vat.MatchString(id) {
		return errors.New("not a VAT number")
	}
	return nil
}

// ToCents returns (value, error), which the spec sees as Int?: none when the error is not nil.
func ToCents(price string) (int, error) {
	f, err := strconv.ParseFloat(strings.TrimSpace(price), 64)
	if err != nil || f < 0 {
		return 0, errors.New("not a price")
	}
	return int(f*100 + 0.5), nil
}

func Slug(s string) string { return strings.ReplaceAll(strings.ToLower(s), " ", "-") }

// SendSMS stands in for a call to a provider; an effect runs only in a workflow step.
func SendSMS(to string, body string) error { return nil }
`;
const WIDGETS = `package main

import "crudspec/gogen/rt"

var widgets = map[string]func([]rt.Val, rt.WidgetHelpers) string{
	"badge": func(a []rt.Val, h rt.WidgetHelpers) string {
		return \`<span class="badge">\` + rt.Esc(rt.Plain(rt.Arg(a, 0))) + \`</span>\`
	},
}
`;
const dir = mkdtempSync(join(tmpdir(), "go-examples-"));
writeFileSync(join(dir, "app.crud"), SPEC);
writeFileSync(join(dir, "ext.go"), EXT);
writeFileSync(join(dir, "widgets.go"), WIDGETS);
const app = await startApp(join(dir, "app.crud"), 13913);
try {
  const row = (id: number, fields: Record<string, unknown>) => ({ id, seq: id, created: 100 + id, updated: 100 + id, fields });
  await app.post("/_test/load", { clock: 1000, rows: { User: [row(1, { name: "ada", token: null })] } });
  const place = async (args: Record<string, string>) => (await fetch(app.base + "/_do/place", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Test-Actor": "User:1" }, body: new URLSearchParams(args), redirect: "manual" })).headers.get("X-Crudspec-Outcome");
  ok("an error from Go is a refusal the spec checks (bad VAT number)", (await place({ vat_id: "nope", price: "9.99", note: "a b" })) === "invalid");
  ok("a (value, error) is none when it fails (bad price)", (await place({ vat_id: "DE12345678", price: "free", note: "a b" })) === "invalid");
  ok("both good: the order is placed", (await place({ vat_id: "DE12345678", price: "9.99", note: "a b" })) === "ok");
  const o = ((await app.post("/_test/dump", {})).rows.Order as any[])[0]?.fields;
  ok("the standard library and ext.go ran in the create", o?.note === "A B" && o?.cents === 999, o);
  const html = await (await fetch(app.base + "/orders")).text();
  ok("the widget's Go markup is on the page, escaped", html.includes('<span class="badge">A B</span>'), html.slice(0, 400));
} finally { app.stop(); }
process.exit(failed ? 1 : 0);
