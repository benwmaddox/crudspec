// Values in text: "{left} visits left". The parser joins the pieces with + and each value as
// text(value) (lang/parser.ts strValue); the type pass shows an enum value by its label and refuses
// a row. Checks the tokens, the mistakes, and the compiled app's text.
//   node lang/test/interp.test.ts
process.removeAllListeners("warning");
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "../parser.ts";
import { check, withoutText } from "../check.ts";
import { typecheck } from "../types.ts";
import { withGenerated } from "../scaffold.ts";
import { startApp } from "./go-app.ts";

let failed = 0;
const ok = (what: string, pass: boolean, detail?: unknown) => { console.log(`${pass ? "ok  " : "FAIL"} ${what}`); if (!pass) { failed++; if (detail !== undefined) console.log("     ", JSON.stringify(detail)); } };

const SPEC = `app shop { name "Shop" actor User }
entity User { name: Text  token: Text? }
identity login: User.token from cookie "login"
policy all_users: true for rows of User
enum Size { small, extra_large "Extra large" }
entity Item { name: Text  size: Size  price: Decimal  note: Text?  left: Int  sold: Date?  label: Text = "" }
policy all_items: true for rows of Item

fn plural(n: Int, word: Text): Text = if n == 1 { word } else { "{word}s" }
fn tag(i: Item): Text {
  let n = i.left
  "{i.name} ({i.size}): {n} {plural(n, "piece")} left at \${i.price}{if i.note == none { "" } else { " - {i.note}" }} \\{sic\\}"
}
action make_tag(i: Item) { callers people  set i.label = i.tag() }
`;
const findings = (src: string) => { try { const s = parse(src); return [...check(s, { source: src }), ...typecheck(withGenerated(s, parse)).findings]; } catch (e: any) { return [{ code: e.code, message: e.message, severity: "error" }]; } };
const has = (src: string, code: string, text?: string) => findings(src).some((f: any) => f.code === code && (!text || f.message.includes(text)));
const head = SPEC.slice(0, SPEC.indexOf("fn plural"));

const errs = findings(SPEC).filter((f: any) => f.severity === "error" || f.code === "DECL_UNUSED");
ok("values in text, text in a value in text, an if, a call and \\{ \\}: no errors, and plural (used only in text) isn't unused", errs.length === 0, errs);
const fnTag = parse(SPEC).decls.find((d: any) => d.name === "tag") as any;
ok("the parser joins the pieces with +, nothing past it sees interpolation", JSON.stringify(fnTag.body).includes('"op":"+"') && JSON.stringify(fnTag.body).includes('"interp":true') && !JSON.stringify(fnTag.body).includes('{i.'), fnTag.body);
ok("text without braces is a plain literal, as before", (() => { const b = (parse(`${head}fn a(i: Item): Text = "plain"\n`).decls.at(-1) as any).body; return b.kind === "lit" && b.value === "plain"; })());
ok("a row in text is TEXT_ROW, naming the field to write", has(`${head}fn a(i: Item): Text = "item {i}"\naction b(i: Item) { callers people  set i.label = a(i) }\n`, "TEXT_ROW", "{i.name}"));
ok("a value of the wrong kind inside is still checked", has(`${head}fn a(i: Item): Text = "{i.left.trim()}"\naction b(i: Item) { callers people  set i.label = a(i) }\n`, "TYPE_MISMATCH"));
ok("{} with nothing in it is an error saying how to write a brace", has(`${head}fn a(i: Item): Text = "x {} y"\n`, "PARSE_EXPECTED", "\\{"));
ok("a lone } is an error saying how to write one", has(`${head}fn a(i: Item): Text = "x } y"\n`, "LEX_STRING", "\\}"));
ok("text left open inside {…} is an error", has(`${head}fn a(i: Item): Text = "x {i.name"\n`, "LEX_STRING"));
ok("withoutText keeps the code in {…} and drops the text", withoutText(`a "x {f(y, "z {w}")} q" b`).replace(/\s+/g, " ") === `a "" f(y, "" w ) b`, withoutText(`a "x {f(y, "z {w}")} q" b`));

const dir = mkdtempSync(join(tmpdir(), "interp-app-"));
writeFileSync(join(dir, "app.crud"), SPEC);
const app = await startApp(join(dir, "app.crud"), 13997);
try {
  const row = (id: number, f: any) => ({ id, seq: id, created: 0, updated: 0, fields: f });
  await app.post("/_test/load", { clock: 0, rows: { Item: [
    row(1, { name: "Coat", size: "extra_large", price: { dec: "12.50" }, note: "warm", left: 1, sold: null, label: "" }),
    row(2, { name: "Hat", size: "small", price: { dec: "3" }, note: null, left: 4, sold: null, label: "" }),
  ] } });
  for (const id of [1, 2]) await app.post("/_test/run", { call: "make_tag", args: { i: { ref: "Item", id } }, actor: null, now: 0 });
  const items = (await app.post("/_test/dump", {})).rows.Item;
  ok("an enum shows its label, a Decimal its places, a call and an if inside, braces as written", items[0].fields.label === "Coat (Extra large): 1 piece left at $12.50 - warm {sic}", items[0].fields.label);
  ok("... none shows nothing, and a Decimal keeps its places (3 is 3.00)", items[1].fields.label === "Hat (Small): 4 pieces left at $3.00 {sic}", items[1].fields.label);
} finally { app.stop(); rmSync(dir, { recursive: true, force: true }); }
process.exit(failed ? 1 : 0);
