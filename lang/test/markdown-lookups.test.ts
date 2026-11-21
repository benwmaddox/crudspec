// <Markdown include={page_text(w, _)} files={image_url(w, _)} known={page_exists(w, _)}>: lookups the element calls with each
// {{Name}} and [[File:Name]] in the text (lang/check.ts, lang/gogen/gen.ts; the rendering is
// lang/gogen/rt/markdown.go, tested in markdown_test.go).
//   node lang/test/markdown-lookups.test.ts
process.removeAllListeners("warning");
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "../parser.ts";
import { check } from "../check.ts";
import { generate } from "../gogen/gen.ts";
import { typecheck } from "../types.ts";

let failed = 0;
const ok = (what: string, pass: boolean, detail?: unknown) => { console.log(`${pass ? "ok  " : "FAIL"} ${what}`); if (!pass) { failed++; if (detail !== undefined) console.log(String(typeof detail === "string" ? detail : JSON.stringify(detail, null, 2)).slice(0, 800)); } };
const app = (md: string, extra = "") => `app t { name "T" }
entity Doc { name: Text  body: Text }
policy doc_rows: true for rows of Doc
query doc_text(name: Text): Text? = the_or_none(Doc where .name == name).body
fn shout(a: Text, b: Text): Text = a + b
layout l { <main><Slot name=main /></main> }
screen s(d: Doc) { route "/d/:d"  layout l  require public  <Fill name=main>${md}</Fill> }
${extra}`;
const codes = (src: string) => check(parse(src)).filter((f) => f.severity === "error").map((f) => `${f.code}: ${f.message}`);

ok("include={doc_text(_)}: fine", codes(app(`<Markdown include={doc_text(_)}>{d.body}</Markdown>`)).length === 0, codes(app(`<Markdown include={doc_text(_)}>{d.body}</Markdown>`)));
ok("files= too", codes(app(`<Markdown files={doc_text(_)}>{d.body}</Markdown>`)).length === 0);
ok("a lookup with no _: LOOKUP", codes(app(`<Markdown include={doc_text("x")}>{d.body}</Markdown>`)).some((c) => c.startsWith("LOOKUP")));
ok("_ not last: LOOKUP", codes(app(`<Markdown include={shout(_, "x")}>{d.body}</Markdown>`)).some((c) => c.startsWith("LOOKUP")));
ok("not a call: LOOKUP", codes(app(`<Markdown include={d.body}>{d.body}</Markdown>`)).some((c) => c.startsWith("LOOKUP")));
ok("_ anywhere else: UNKNOWN_NAME", codes(app(`<span>{shout(d.body, _)}</span>`)).some((c) => c.startsWith("UNKNOWN_NAME") && c.includes("_ is the name")));
const withExists = `query doc_exists(name: Text): Bool = exists(Doc where .name == name)`;
ok("known={doc_exists(_)}: fine", codes(app(`<Markdown known={doc_exists(_)}>{d.body}</Markdown>`, withExists)).length === 0, codes(app(`<Markdown known={doc_exists(_)}>{d.body}</Markdown>`, withExists)));
ok("known as a list of every name: still fine", codes(app(`<Markdown known={list(.name for Doc where true)}>{d.body}</Markdown>`)).length === 0, codes(app(`<Markdown known={list(.name for Doc where true)}>{d.body}</Markdown>`)));
ok("known with _ not last: LOOKUP", codes(app(`<Markdown known={shout(_, "x")}>{d.body}</Markdown>`)).some((c) => c.startsWith("LOOKUP") && c.includes("page_exists")));
const typeErrors = (src: string) => typecheck(parse(src)).findings.filter((f) => f.severity === "error").map((f) => f.code);
ok("_ is text: a lookup whose last parameter isn't text is a type error", typeErrors(app(`<Markdown include={num(_)}>{d.body}</Markdown>`, `fn num(n: Int): Text = text(n)`)).length > 0);
ok("... and one whose is: none", typeErrors(app(`<Markdown include={doc_text(_)}>{d.body}</Markdown>`)).length === 0, typeErrors(app(`<Markdown include={doc_text(_)}>{d.body}</Markdown>`)));

const dir = mkdtempSync(join(tmpdir(), "cs-lookup-"));
writeFileSync(join(dir, "app.crud"), app(`<Markdown include={doc_text(_)} files={doc_text(_)}>{d.body}</Markdown>`));
const go = Object.values(generate(join(dir, "app.crud"))).join("\n");
ok("generated: the lookups are functions of the name, given to rt.MarkdownWith", /rt\.MarkdownWith\([\s\S]*Include: func\(lookupName string\) \(string, bool\)[\s\S]*Files: func\(lookupName string\)/.test(go), go.split("\n").filter((l) => l.includes("MarkdownWith")).join("\n"));
writeFileSync(join(dir, "app.crud"), app(`<Markdown known={doc_exists(_)}>{d.body}</Markdown>`, withExists));
const goKnown = Object.values(generate(join(dir, "app.crud"))).join("\n");
ok("generated: known={…(_)} is a function of the name to a Bool, and no list", /rt\.MarkdownWith\([^\n]*, nil, rt\.MarkdownOpts\{[^\n]*Known: func\(lookupName string\) bool/.test(goKnown), goKnown.split("\n").filter((l) => l.includes("MarkdownWith")).join("\n"));

process.exit(failed ? 1 : 0);
