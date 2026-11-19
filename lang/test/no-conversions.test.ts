// No value changes kind by itself (lang/docs/expressions.md): each implicit conversion the type
// pass used to allow is an error that says the explicit one, and the explicit conversions work in
// the compiled app (rt/convert.go), as does the check of an Email, Url or Ip argument.
//   node lang/test/no-conversions.test.ts
process.removeAllListeners("warning");
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "../parser.ts";
import { check } from "../check.ts";
import { typecheck, formatOk } from "../types.ts";
import { withGenerated } from "../scaffold.ts";
import { startApp } from "./go-app.ts";

let failed = 0;
const ok = (what: string, pass: boolean, detail?: unknown) => { console.log(`${pass ? "ok  " : "FAIL"} ${what}`); if (!pass) { failed++; if (detail !== undefined) console.log("     ", JSON.stringify(detail)); } };
const head = `app t { name "T" actor User }
entity User { name: Text  token: Text?  unique (token) }
identity v: User.token from cookie "t"
policy pu: true for rows of User
enum Status { open, done }
entity Item { owner: User  title: Text  note: Text?  n: Int = 0  m: Int?  price: Decimal = 0  flag: Bool = false  status: Status = open  at: Time?  on: Date?  mail: Email?  site: Url?  ip: Ip?  out: Text = "" }
policy pi: true for rows of Item
fn want_int(x: Int): Int = x + 1
`;
const val = (e: string) => `view v(i: Item, u: User, t: Text, k: Int, d: Decimal, tm: Time, dt: Date) { value ${e} }`;
const act = (s: string) => `action a(i: Item, u: User, t: Text, k: Int, d: Decimal) { callers people  ${s} }`;
const errors = (body: string) => { const src = head + body + "\n"; const s = parse(src); return [...check(s, { source: src }), ...typecheck(withGenerated(s, parse)).findings].filter((f: any) => f.severity === "error"); };
const has = (body: string, code: string, text: string) => errors(body).some((f: any) => f.code === code && f.message.includes(text));
const clean = (body: string) => { const e = errors(body); return e.length === 0 || (console.log("      ", JSON.stringify(e.map((x: any) => x.message))), false); };

// + turns nothing into text
ok("Text + Int: + joins text with text, write it in the text", has(val(`i.title + i.n`), "TYPE_MISMATCH", `"…{n}…"`));
ok("Int + Text, Int + Bool, Text + enum: the same", has(val(`i.n + i.title`), "TYPE_MISMATCH", "+ joins text with text") && has(val(`text(i.n + i.flag)`), "TYPE_MISMATCH", "+ joins text with text") && has(val(`"x" + i.status`), "TYPE_MISMATCH", "given Status"));
ok("Text? + Text: say what none means", has(val(`i.note + "!"`), "TYPE_MAYBE_NONE", "text that may be none"));
ok("text + text, and a value in text, are fine", clean(val(`i.title + "!" + text(i.n) + "{i.n} {i.status} {i.note}"`)));

// numbers
ok("Int * Decimal: to_decimal(n)", has(val(`i.n * i.price`), "TYPE_MISMATCH", "to_decimal(n)"));
ok("Int == Decimal, Int < Decimal: to_decimal(n)", has(val(`i.n == i.price`), "TYPE_MISMATCH", "to_decimal") && has(val(`i.n < i.price`), "TYPE_MISMATCH", "to_decimal"));
ok("an Int into a Decimal field, or a Decimal parameter", has(act(`set i.price = k`), "TYPE_MISMATCH", "to_decimal(n) makes it one"));
ok("max of an Int and a Decimal", has(val(`max(i.n, i.price)`), "TYPE_MISMATCH", "to_decimal"));
ok("an if's branches an Int and a Decimal", has(val(`if i.flag { i.n } else { i.price }`), "TYPE_MISMATCH", "an Int and a Decimal"));
ok("a whole-number literal stands for a Decimal; to_decimal(n) is fine", clean(val(`i.price > 0 and i.price * 2 >= 1 and to_decimal(i.n) * i.price >= -5 and (if i.flag { 0 } else { i.price }) >= 0`)) && clean(act(`set i.price = 3`)));
ok("Int? + 1: an error now, say what none means", has(val(`i.m + 1`), "TYPE_OPTIONAL_ARITHMETIC", "say what none means"));
ok("... and checked first, fine", clean(val(`if i.m != none { i.m + 1 } else { 0 }`)));

// none into a required parameter
ok("Int? for an Int parameter: TYPE_MAYBE_NONE", has(val(`want_int(i.m)`), "TYPE_MAYBE_NONE", "x is required, but the value may be none"));
ok("none for one", has(val(`want_int(none)`), "TYPE_MAYBE_NONE", "none is given"));

// stricter kinds of text
ok("Text into an Email field: to_email(t)", has(act(`set i.mail = t`), "TYPE_MISMATCH", "to_email(t) checks it"));
ok("Text into a Url, an Ip: to_url, to_ip", has(act(`set i.site = t`), "TYPE_MISMATCH", "to_url(t)") && has(act(`set i.ip = t`), "TYPE_MISMATCH", "to_ip(t)"));
ok("a literal is checked as it compiles", clean(act(`set i.mail = "help@example.com"  set i.site = "https://example.com/x"  set i.ip = "10.0.0.1"`)) && has(act(`set i.mail = "nobody"`), "TYPE_MISMATCH", `"nobody" isn't one`));
ok("to_email(t) and the others are fine (none when not one)", clean(act(`set i.mail = to_email(t)  set i.site = to_url(t)  set i.ip = to_ip(t)`)));
ok("an Email read as text is fine", clean(act(`set i.out = "{i.mail}"`)) && clean(act(`set i.title = i.owner.name`)));
ok("Text into an enum: declare the parameter as the enum", has(act(`set i.status = t`), "TYPE_MISMATCH", "declare the parameter as Status") && clean(act(`set i.status = "done"`)) && has(act(`set i.status = "closed"`), "TYPE_MISMATCH", `"closed" is not a Status`));
ok("request.ip is an Ip; url_of(…) a Url", clean(`layout l { <main><Slot name=main /></main> }\nscreen s { route "/s"  layout l }\n` + act(`set i.ip = request.ip  set i.site = url_of(s())`)));

// built-ins take their kinds
ok("year(Time): date_of(t)", has(val(`year(tm)`), "TYPE_MISMATCH", "date_of(t)"));
ok("days_between(Time, Date), add_days(Date, Decimal), round(Text), abs(Bool)", has(val(`days_between(tm, dt)`), "TYPE_MISMATCH", "date_of(t)") && has(val(`add_days(dt, d)`), "TYPE_MISMATCH", "an Int") && has(val(`round(t)`), "TYPE_MISMATCH", "an Int or a Decimal") && has(val(`abs(i.flag)`), "TYPE_MISMATCH", "an Int or a Decimal"));
ok("text(row): TEXT_ROW", has(val(`text(u)`), "TEXT_ROW", "u.name"));
ok("formatOk: emails, urls and ips", formatOk("Email", "a@b.co") && !formatOk("Email", "a@b") && !formatOk("Email", "a b@c.de") && formatOk("Url", "https://x.org/p?q=1") && !formatOk("Url", "/relative") && !formatOk("Url", "javascript:x") && formatOk("Ip", "192.168.0.1") && formatOk("Ip", "::1") && !formatOk("Ip", "300.1.1.1"));

// the compiled app: the conversions, and an Email argument checked as it arrives
const SPEC = head + `action set_mail(i: Item, t: Text) { callers people  set i.mail = to_email(t) }
action given_mail(i: Item, e: Email) { callers people  set i.mail = e }
action given_site(i: Item, u: Url) { callers people  set i.site = u }
action price_of(i: Item) { callers people  set i.price = to_decimal(i.n) * i.price }
`;
const dir = mkdtempSync(join(tmpdir(), "noconv-"));
writeFileSync(join(dir, "app.crud"), SPEC);
const app = await startApp(join(dir, "app.crud"), 14003);
const row = (id: number, f: any) => ({ id, seq: id, created: 0, updated: 0, fields: f });
const load = () => app.post("/_test/load", { clock: 0, rows: { User: [row(1, { name: "A", token: null })], Item: [row(1, { owner: { ref: "User", id: 1 }, title: "x", note: null, n: 3, m: null, price: { dec: "1.10" }, flag: false, status: "open", at: null, on: null, mail: null, site: null, ip: null, out: "" })] } });
const run = (call: string, args: any) => app.post("/_test/run", { call, args: { i: { ref: "Item", id: 1 }, ...args }, actor: null, now: 0 });
const item = async () => (await app.post("/_test/dump", {})).rows.Item[0].fields;
try {
  await load(); await run("set_mail", { t: "ada@example.com" });
  ok("to_email(t) of an email: it", (await item()).mail === "ada@example.com", await item());
  await run("set_mail", { t: "not an email" });
  ok("... of text that isn't one: none", (await item()).mail === null, await item());
  await load(); let r = await run("given_mail", { e: "not an email" });
  ok("an Email argument that isn't one is refused as it arrives (it used to be stored)", r.outcome === "invalid" && /isn't an Email/.test(r.detail ?? ""), r);
  r = await run("given_mail", { e: "ada@example.com" });
  ok("... and one that is, stored", r.outcome === "ok" && (await item()).mail === "ada@example.com", r);
  r = await run("given_site", { u: "javascript:alert(1)" });
  ok("a Url argument that isn't http(s) is refused", r.outcome === "invalid", r);
  await load(); await run("price_of", {});
  ok("to_decimal(3) * 1.10 = 3.30, exact", (await item()).price.dec === "3.30", await item());
} finally { app.stop(); rmSync(dir, { recursive: true, force: true }); }
process.exit(failed ? 1 : 0);
