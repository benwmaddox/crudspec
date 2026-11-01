// What a person reads when a spec is wrong: a misspelled name gets "did you mean", a finding
// knows its column, and the CLI shows the line with a caret under it.
//   node lang/test/messages.test.ts
process.removeAllListeners("warning");
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { parse, SpecError } from "../parser.ts";
import { check } from "../check.ts";
import { closest } from "../didyoumean.ts";

let failed = 0;
const ok = (name: string, cond: boolean, info?: unknown) => { console.log(`${cond ? "ok  " : "FAIL"} ${name}`); if (!cond) { failed++; console.log(typeof info === "string" ? info : JSON.stringify(info, null, 2)); } };

ok("closest: a slip finds its name", closest("colour", ["color", "title"]) === "color" && closest("actr", ["actor", "action"]) === "actor" && closest("tilte", ["title"]) === "title");
ok("closest: nothing close is no suggestion", closest("scren", ["s"]) === undefined && closest("zebra", ["color", "title"]) === undefined);

const base = `app d { name "D"  actor User }
entity User { name: Text }
entity Note { title: Text  color: Text?  owner: User }
permission read Note: true
layout l { <Main><Slot name=main /></Main> }
`;
const find = (src: string, code: string) => check(parse(base + src)).find((f) => f.code === code);
const f1 = find(`action add(t: Text) { create Note { title: t, colour: "red", owner: actor } }\n`, "UNKNOWN_FIELD");
ok("a field that isn't: did you mean, at the field", !!f1 && f1.message.endsWith("did you mean color?") && f1.line === 6 && f1.col === 47, f1);
const f2 = find(`action add(t: Text) { create Note { title: t, owner: actr } }\n`, "UNKNOWN_NAME");
ok("a name that isn't: did you mean, at the name", !!f2 && f2.message.endsWith("did you mean actor?") && f2.col === 54, f2);
const f3 = find(`view mine() { rows Notes where .owner == actor }\n`, "UNKNOWN_ENTITY");
ok("an entity that isn't: did you mean", !!f3 && f3.message.endsWith("did you mean Note?"), f3);
const f4 = find(`screen s {\n  route "/"\n  layout l\n  <Main><Text>{actor.nmae}</Text></Main>\n}\n`, "UNKNOWN_FIELD");
ok("a field read in a screen: did you mean", !!f4 && f4.message.endsWith("did you mean name?"), f4);

const parseErr = (src: string) => { try { parse(base + src); return null; } catch (e) { return e as SpecError; } };
const e1 = parseErr(`screen s {\n  route "/"\n  layout l\n  <Main><Linc>x</Linc></Main>\n}\n`);
ok("an element that isn't: did you mean, without the whole list", !!e1 && e1.message.endsWith("did you mean Link?"), e1?.message);
const e2 = parseErr(`screen s {\n  route "/"\n  layout l\n  <Main><Text clas="x">x</Text></Main>\n}\n`);
ok("an attribute that isn't: did you mean", !!e2 && e2.message.endsWith("did you mean class?"), e2?.message);
const e3 = parseErr(`action a(t: Text) { require t != "" else forbiden }\n`);
ok("an outcome that isn't: did you mean", !!e3 && e3.message.endsWith("did you mean forbidden?"), e3?.message);

// a type that isn't: a slip suggests the type meant; an extern's result names a Go shape, so any goes
const types = check(parse(base + `entity Tag { name: Txt  note: Not? }\nview v(q: Bol) { rows Note }\nextern fn fetch_it(u: Url): Reply effect http\n`)).filter((f) => f.code === "UNKNOWN_TYPE");
ok("unknown types: each, at the type, with did you mean", types.length === 3 && types[0].message.endsWith("did you mean Text?") && types[0].line === 6 && types[0].col === 20 && types[1].message.endsWith("did you mean Note?") && types[2].message.endsWith("did you mean Bool?"), types);

// places names went unchecked before lang/test/mutants.ts found them: each slip is an error now
import { typecheck } from "../types.ts";
const slips: [string, string, string][] = [
  ["a signal carrying a type a page can't send", `signal s(n: Note) { to set(User where it == actor) carries { at: Time } }\n`, "signal s carries at: Time, but a page sends only Text, Int and Bool"],
  ["an indicator's signal without action", `signal s(n: Note) { to set(User where it == actor) carries { kind: Text } }\nscreen x {\n  route "/x"\n  layout l\n  <Main><Signal call={s(none)} indicator /></Main>\n}\n`, `signal s is shown as an indicator, which sends action "start" and "stop": it carries { action: Text }`],
  ["a runtime extern misspelled", `extern fn post_jsn(url: Url, body: Json, timeout: Duration): HttpReply effect http\n`, "the runtime has no extern post_jsn; did you mean post_json?"],
  ["a runtime extern that isn't", `extern fn charge(card: Text): Text effect http\n`, "write it in Go and declare it = go Charge"],
  ["a runtime extern's result misspelled", `extern fn opengraph(url: Url): OpenGraf? effect fetch\n`, "the runtime's opengraph gives OpenGraph, not OpenGraf: opengraph(url: Url): OpenGraph? effect fetch"],
  ["a runtime extern given too few parameters", `extern fn post_json(url: Url, body: Json): HttpReply effect http\n`, "the runtime's post_json takes 3 arguments, not 2: post_json(url: Url, body: Json, timeout: Duration): HttpReply effect http"],
  ["request's fields", `action a() { rate_limit 5 per 1 min by request.ipp else blocked }\n`, "request has no field ipp; did you mean ip?"],
  ["a view's order by", `view v() { rows Note order by lower(.titel) }\n`, "Note has no field titel; did you mean title?"],
  ["text with {…} in it", `screen s {\n  route "/"\n  layout l\n  <Main><Text>{actr.name} left</Text></Main>\n}\n`, "unknown name actr; did you mean actor?"],
  ["<Time as=…>", `screen s {\n  route "/"\n  layout l\n  <Main><Time as={dat}>{now}</Time></Main>\n}\n`, "<Time as=…> is {date} or {time}, not dat; did you mean date?"],
  ["a data row's fields", `data Size { name: Text  px: Int } rows [ { name: "s", pxx: 1 } ]\n`, "Size has no field pxx; did you mean px?"],
  ["... and its required ones", `data Size { name: Text  px: Int } rows [ { name: "s" } ]\n`, "a Size row without its required field px"],
  ["an identity's where", `identity key: User from param key where .nam == "x"\n`, "User has no field nam; did you mean name?"],
  ["a signal's carries", `signal ping(n: Note) { to set(User where true) carries { title: Txt } }\n`, "unknown type Txt; did you mean Text?"],
  ["a screen's theme", `screen s {\n  route "/"\n  layout l\n  <Main><Image>{theme.lgo}</Image></Main>\n}\n`, "theme has no field lgo; did you mean logo?"],
  ["input, in a form's reactions", `action go(email: Text) { }\nscreen s(e: Text?) {\n  route "/"\n  layout l\n  <Main><Form action={go()}><Field name=email kind=text label="E" /><Submit label="Go" /><On invalid go={s(input.emial)} /></Form></Main>\n}\n`, "input has no field emial; did you mean email?"],
];
for (const [what, src, msg] of slips) { const fs = check(parse(base + src)); ok(`checked: ${what}`, fs.some((f) => f.severity === "error" && f.message.endsWith(msg)), fs); }
const typed = (src: string) => typecheck(parse(base + src)).findings.filter((f) => f.code === "TYPE_NO_FIELD").map((f) => f.message);
ok("checked: a File's fields", typed(`entity Doc { f: File }\npermission read Doc: true\nfn n(d: Doc): Text = d.f.filname\n`).some((m) => m.endsWith("did you mean filename?")));
ok("checked: a runtime extern's result", typed(`extern fn post_json(url: Url, body: Json, timeout: Duration): HttpReply effect http\nfn ok_reply(u: Url): Bool = (call post_json(u, "", 5 s)).stauts == 200\n`).some((m) => m.endsWith("did you mean status?")));

// what the swap mutants found the type pass let through
const tys = (src: string) => typecheck(parse(base + `enum Level { low, high }\nentity Job { level: Level  note: Text?  done: Bool  owner: User  at: Time }\npermission read Job: true\nwidget nudge(text: Text)\n` + src)).findings;
const has = (src: string, code: string, end: string) => { const fs = tys(src); ok(`types: ${end}`, fs.some((f) => f.code === code && f.message.includes(end)), fs); };
has(`fn p(j: Job): Bool = j.note == high\n`, "TYPE_ENUM_TEXT", "a Level compared with the text field note");
ok("types: ... while an enum with a Text parameter is fine (it is stored as the value's name)", !tys(`fn p(j: Job, s: Text): Bool = j.level == s\n`).some((f) => f.code === "TYPE_ENUM_TEXT" || f.code === "TYPE_NEVER_EQUAL"));
ok("types: ... while an enum with its own text value is fine", !tys(`fn p(j: Job): Bool = j.level == "high"\n`).some((f) => f.code === "TYPE_NEVER_EQUAL"));
has(`fn p(j: Job): Bool = j.owner == request.ip\n`, "TYPE_NEVER_EQUAL", "User and text are never equal");
has(`fn p(j: Job): Bool = j.at != none\n`, "TYPE_NEVER_NONE", "at is never none, so != none is always true");
const ui = (body: string) => `screen s(j: Job) {\n  route "/:j"\n  layout l\n  <Main>${body}</Main>\n}\n`;
has(ui(`<Button action={add("x")} label="x" selected={j.note} />`).replace("screen", `action add(t: Text) { }\nscreen`), "TYPE_NOT_BOOL", "Button's selected is text?");
has(ui(`<Time>{j.note}</Time>`), "TYPE_MISMATCH", "<Time> shows a Time, given text?");
has(ui(`<Avatar>{j.note}</Avatar>`), "TYPE_MISMATCH", "<Avatar> shows a row's avatar, given text?");
has(ui(`<Widget call={nudge(j.done)} />`), "TYPE_MISMATCH", "nudge()'s text");
has(ui(`<List of={Job where true} as=x where={match x.level { low { x.note } high { true } }}><Text>{x.note}</Text></List>`), "TYPE_NOT_BOOL", "the list's where is text?");

// values that show as [object Object] in text, a Password compared, arguments of builtins and externs
has(`fn t(j: Job): Text = "by " + j.owner\n`, "TYPE_MISMATCH", "User in text shows as [object Object]");
has(`fn t(j: Job): Time = j.at + 1\n`, "TYPE_MISMATCH", "a time takes a Duration");
has(`entity Acct { pw: Password }\npermission read Acct: true\nfn p(a: Acct, typed: Text): Bool = a.pw == typed\n`, "TYPE_NEVER_EQUAL", "check it with authenticates");
has(`fn t(j: Job): Text = plain(j.owner)\n`, "TYPE_MISMATCH", "plain() takes text");
has(`fn t(j: Job): Text = download(j.note)\n`, "TYPE_MISMATCH", "download() takes a File");
has(`extern fn ping(u: Url): Bool effect fetch\nfn t(j: Job): Bool = call ping(j.done)\n`, "TYPE_MISMATCH", "ping()'s u");
{
  const fs = typecheck(parse(base + `entity Job { note: Text? }\npermission read Job: true\nscreen s(j: Job) {\n  route "/:j"\n  layout l\n  <Main><Avatar>{j}</Avatar></Main>\n}\n`)).findings;
  ok("types: an <Avatar> of an entity with no avatar declared", fs.some((f) => f.code === "AVATAR_UNDECLARED" && f.message.includes("avatar Job: initials(.name)")), fs);
}

// one slip, one error: a form whose action is misspelled doesn't also have its fields "outside a form"
{
  const fs = check(parse(base + `action add(t: Text) { create Note { title: t, owner: actor } }\nscreen s {\n  route "/"\n  layout l\n  <Main><Form action={ad()}><Field name=t kind=text label="T" /><Submit label="Add" /><On invalid go={s()} /></Form></Main>\n}\n`)).filter((f) => f.severity === "error");
  ok("a form's misspelled action: the one error", fs.length === 1 && fs[0].code === "UNKNOWN_ACTION" && fs[0].message.endsWith("did you mean add?"), fs);
}

// plain HTML (lowercase): its elements and attributes are HTML's (lang/std/html.crud)
{
  const fs = check(parse(base + `screen s {\n  route "/"\n  layout l\n  <Main><dvi>z</dvi><a hrf="/x">x</a><my-widget anything="1"></my-widget><div data-id="1" aria-label="x" hidden>y</div><svg viewBox="0 0 1 1"><path d="M0 0" stroke-width="2"></path></svg></Main>\n}\n`));
  const html = fs.filter((f) => f.code.startsWith("UI_HTML_"));
  ok("plain HTML: an element HTML hasn't, did you mean", html.some((f) => f.code === "UI_HTML_UNKNOWN" && f.message.endsWith("did you mean div?")), html);
  ok("plain HTML: an attribute its element hasn't, at the attribute, did you mean", html.some((f) => f.code === "UI_HTML_ATTR_UNKNOWN" && f.message.endsWith("did you mean href?") && f.col === 24), html);
  ok("plain HTML: a web component, data-*, aria-*, global attributes and SVG's are fine", html.length === 2, html);
}
{
  const { VOID, HTML_ELEMENTS } = await import("../parser.ts");
  ok("HTML's void elements come from html.crud (no Children parameter), with the head's", [...VOID].sort().join() === "area,base,br,col,embed,hr,img,input,link,meta,source,track,wbr" && HTML_ELEMENTS.size > 100);
}

// a keyword misspelled: the parse error names it, at the slip
{
  const pe = (src: string) => { try { parse(base + src); return null; } catch (e) { return e as SpecError; } };
  const k1 = pe(`entty Tag { name: Text }\n`), k2 = pe(`action a(t: Text) { requre present(t) else invalid }\n`), k3 = pe(`action a(t: Text) { require present(t) elze invalid }\n`);
  ok("keyword slips: a declaration's, a statement's, an expected one's", k1?.message.endsWith("did you mean entity?") === true && k2?.message.endsWith("did you mean require?") === true && k3?.message.endsWith("did you mean else?") === true, [k1?.message, k2?.message, k3?.message]);
  const k4 = pe(`entity Tag { owner: User onn delete cascade }\n`);
  ok("... one before the token the parse stopped at: there", k4?.message.includes("did you mean on? ('onn' before it)") === true && k4.pos.col === 26, [k4?.message, k4?.pos]);
  const k5 = pe(`action a(t: Text) { only peple  set t = t }\n`), k6 = pe(`action a(t: Text) { require present(t) else goo home }\n`);
  ok("... only peple, else goo", k5?.message.endsWith("did you mean people?") === true && k6?.message.endsWith("did you mean go?") === true, [k5?.message, k6?.message]);
  const k7 = pe(`view v() { rows Note  page 10 lst }\n`), k8 = pe(`api x {\n  route "/x"\n  identity login\n  gt "" -> v()\n}\n`);
  ok("... a window's end and an API route's method are checked", k7?.message.endsWith("did you mean last?") === true && k8?.message.endsWith("did you mean get?") === true, [k7?.message, k8?.message]);
  const k9 = pe(`api x {\n  route "/x"\n  get "" -> v()\n}\n`), k10 = pe(`action a(project: Text) { require present(project) andd present(project) else invalid }\n`);
  ok("... but no suggestion where the error isn't about a slip, nor for a name the spec uses again", !!k9 && !/did you mean/.test(k9.message) && k10?.message.endsWith("did you mean and?") === true, [k9?.message, k10?.message]);
}

// a Password shown: in a display, in text, as an element's content
{
  const pw = typecheck(parse(base + `entity Acct { name: Text  pw: Password }\npermission read Acct: true\ndisplay Acct: .pw\nscreen s(a: Acct) {\n  route "/:a"\n  layout l\n  <Main><Text>{a.pw}</Text><p>Key: {a.pw}</p></Main>\n}\n`)).findings.filter((f) => f.code === "TYPE_PASSWORD_SHOWN");
  ok("TYPE_PASSWORD_SHOWN: a display, an element's content, and text with {…}", pw.length === 3, pw);
  const pj = typecheck(parse(base + `entity Acct { pw: Password }
permission read Acct: true
fn acct_json(a: Acct): Json = json { pw: a.pw }
`)).findings.filter((f) => f.code === "TYPE_PASSWORD_SHOWN");
  ok("... and a JSON shape's field (an API would send the hash)", pj.length === 1, pj);
}

// an image's and rich text's content; a text field among enum values
{
  const fs = typecheck(parse(base + `enum Level { low, high }\nentity Job { done: Bool  note: Text  owner: User }\npermission read Job: true\nview odd() { rows Job where .note in {low, high} }\nscreen s(j: Job) {\n  route "/:j"\n  layout l\n  <Main><Image>{j.done}</Image><Image>{"logo.png"}</Image><RichText>{j.owner}</RichText></Main>\n}\n`)).findings;
  ok("<Image> of a Bool, <RichText> of a row: errors; an asset's path is fine", fs.filter((f) => f.code === "TYPE_MISMATCH" && /<Image> shows a File|<RichText> shows rich text/.test(f.message)).length === 2, fs);
  ok("a text field among enum values: TYPE_ENUM_TEXT", fs.some((f) => f.code === "TYPE_ENUM_TEXT" && f.message.includes("note among Level values")), fs);
}

// a delimiter left open: the error says which, and where it opened
{
  const pe = (src: string) => { try { parse(base + src); return ""; } catch (e) { return (e as SpecError).message; } };
  ok("a } missing: the { left open, and its line", /the \{ at line 6 \(action a\(t: Text\) \{\) isn't closed; a \} is missing before line 8/.test(pe(`action a(t: Text) {\n  require present(t) else invalid\naction b() { }\n`)), pe(`action a(t: Text) {\n  require present(t) else invalid\naction b() { }\n`));
  ok("... at the end of the file too", /isn't closed; a \} is missing at the end/.test(pe(`action a(t: Text) {\n  require present(t) else invalid\n`)));
  ok("a ) missing: expected ',' or ')', and the ( left open", /expected ',' or '\)', found '\{': the \( at line 6, column 9 isn't closed/.test(pe(`action a(t: Text {\n}\n`)), pe(`action a(t: Text {\n}\n`));
  { const q = pe('screen s {\n  route "/"\n  layout l\n  <Main><Text class="muted>{"a"}"</Text></Main>\n}\n'); ok("a quote missing in an attribute: said, at the string", q.includes('is a " missing in "muted>{" before it'), q); }
  ok("a closing tag that isn't the one open: where that one opened", /expected <\/section> \(for the <section> at line 9\), found <\/Main>/.test(pe(`screen s {\n  route "/"\n  layout l\n  <Main><section>x</Main>\n}\n`)), pe(`screen s {\n  route "/"\n  layout l\n  <Main><section>x</Main>\n}\n`));
}

// one run reports every parse error: the reading goes on at the next declaration
{
  let all: string[] = [];
  try { parse(base + `entity Tag { name: Txt  owner: User\naction a(t: Text) { requre present(t) else invalid }\nview v() { rows Note where .title == }\n`); }
  catch (e) { all = [e, ...((e as any).more ?? [])].map((x: SpecError) => x.code); }
  ok("three parse errors in one spec: all three, each where it is", all.join() === "PARSE_EXPECTED,PARSE_STMT,PARSE_EXPR", all);
}

// a tag left open, an attribute without its name, a tag without its name
{
  const pe = (src: string) => { try { parse(base + src); return ""; } catch (e) { return (e as SpecError).message; } };
  const ui = (m: string) => `screen s {\n  route "/"\n  layout l\n  <Main>${m}</Main>\n}\n`;
  ok("a tag not closed with > or />", pe(ui(`<Text class="x"<p>y</p>`)).includes("the <Text> at line 9 isn't closed with > or />"), pe(ui(`<Text class="x"<p>y</p>`)));
  ok("an attribute's name missing", pe(ui(`<Text ="x">y</Text>`)).includes("an attribute's name is missing before its value"), pe(ui(`<Text ="x">y</Text>`)));
  ok("an = missing between an attribute and its value (built-in and HTML)", pe(ui(`<Text class"x">y</Text>`)).includes("need an = between them") && pe(ui(`<p class"x">y</p>`)).includes("need an = between them"));
  ok("a tag's name missing (<name=main />)", pe(ui(`< name=main />`)).includes("is the tag's name missing?"), pe(ui(`< name=main />`)));
}

// what other languages write: = and === for ==, <> for !=, && || ! for and or not, null for none
{
  const pe = (src: string) => { try { parse(base + src); return ""; } catch (e) { return (e as SpecError).message; } };
  const a = (cond: string) => pe(`action a(t: Text) { require ${cond} else invalid }\n`);
  ok("= in a comparison: == is meant", a("t = \"x\"").endsWith("a comparison is written == (= sets a field, in set x.f = …)"), a("t = \"x\""));
  ok("=== : ==", a("t === \"x\"").endsWith("== compares (there is no ===)"), a("t === \"x\""));
  ok("<> : !=", a("t <> \"x\"").endsWith("not equal is written !="), a("t <> \"x\""));
  ok("&& || ! : and, or, not", a("present(t) && true").includes("crudspec writes and") && a("present(t) || true").includes("crudspec writes or") && a("!present(t)").includes("crudspec writes not"), [a("present(t) && true"), a("!present(t)")]);
  const ty = check(parse(base + `entity Price { label: String  amount: Float  at: DateTime }\n`)).filter((f) => f.code === "UNKNOWN_TYPE").map((f) => f.message);
  ok("other languages' types: crudspec's (String Text, Float Int in cents, DateTime Time)", ty.length === 3 && ty[0].includes("did you mean Text?") && ty[1].includes("count in cents") && ty[2].includes("did you mean Time?"), ty);
  ok("... and declaration words (function: fn, class: entity)", pe(`function f() { }\n`).includes("did you mean fn?") && pe(`class C { }\n`).includes("did you mean entity?"), [pe(`function f() { }\n`), pe(`class C { }\n`)]);
  ok("... statements: insert create, return result, update set; for x in: for each", pe(`action a(t: Text) { insert Note { title: t, owner: actor } }\n`).includes("did you mean create?") && pe(`action a(t: Text) { return t }\n`).includes("did you mean result?") && pe(`action a(n: Note) { update n }\n`).includes("did you mean set?") && pe(`action a() { for n in Note where true { delete n } }\n`).includes("a loop is for each x in"));
  ok("... create Note(…) and commas between fields", pe(`action a(t: Text) { create Note(title: t) }\n`).includes("gives the fields in braces") && pe(`entity Tag { name: Text, color: Text }\n`).includes("not commas"));
  const ui = (m: string) => `screen s {\n  route "/"\n  layout l\n  <Main>${m}</Main>\n}\n`;
  ok("React's attributes: className class, onClick action (built-ins); and .map(…)", pe(ui(`<Text className="x">a</Text>`)).includes("did you mean class? (React's className)") && pe(`action go() { }\n` + ui(`<Button onClick={go()} label="Go" />`)).includes("did you mean action?") && pe(`view ns() { rows Note }\n` + ui(`{ns().map(n => <p>{n.title}</p>)}`)).includes("for each x in list"), [pe(ui(`<Text className="x">a</Text>`))]);
  const htmlReact = check(parse(base + ui(`<label htmlFor="x">a</label>`))).find((f) => f.code === "UI_HTML_ATTR_UNKNOWN");
  ok("... and on HTML: htmlFor for", !!htmlReact?.message.includes("did you mean for? (React's htmlFor)"), htmlReact);
  const n = check(parse(base + `action b(t: Text?) { require t != null else invalid }\n`)).find((f) => f.code === "UNKNOWN_NAME");
  ok("null: none", n?.message === "unknown name null: crudspec writes none", n);
}

// values that make nothing fit, nothing through, or nothing shown
{
  const codes = (src: string) => check(parse(base + src)).filter((f) => f.severity === "error").map((f) => f.code);
  ok("max 0, min above max: SIZE_IMPOSSIBLE; max on an Int: SIZE_NOT_TEXT", codes(`entity Tag { a: Text max 0  b: Text min 9 max 3  n: Int max 5 }\n`).join() === "SIZE_IMPOSSIBLE,SIZE_IMPOSSIBLE,SIZE_NOT_TEXT", codes(`entity Tag { a: Text max 0  b: Text min 9 max 3  n: Int max 5 }\n`));
  ok("a default longer than the max; two fields of a name; an enum value twice; a channel every 0 s", codes(`entity Tag { a: Text max 3 = "toolong"  b: Text  b: Text }\nenum Color { red, red }\nchannel c(n: Note) { require true  every 0 s refresh(n) }\ninternal action refresh(n: Note) { }\n`).sort().join() === "CHANNEL_EVERY,DUPLICATE_FIELD,ENUM_DUPLICATE,SIZE_LITERAL", codes(`entity Tag { a: Text max 3 = "toolong"  b: Text  b: Text }\nenum Color { red, red }\nchannel c(n: Note) { require true  every 0 s refresh(n) }\ninternal action refresh(n: Note) { }\n`));
  ok("two parameters of a name; an enum named as an entity", codes(`action a(x: Text, x: Int) { }
enum Note { a, b }
`).sort().join() === "DUPLICATE,DUPLICATE_PARAM", codes(`action a(x: Text, x: Int) { }
enum Note { a, b }
`));
  // what the fuzz test found passing check but not compiling
  ok("rate_limit … per min (no number): RATE_LIMIT_PERIOD", codes(`action a() { rate_limit 3 per min by actor else blocked }
`).includes("RATE_LIMIT_PERIOD"));
  ok("typed, back, home, query in an action: what a screen sees", ["typed", "home", "query.x"].every((n) => codes(`action a() { create Note { title: text(${n}), owner: actor } }\n`).includes("UNKNOWN_NAME")));
  ok("app, theme, client, input in an action: what a screen sees", codes(`action a() { create Note { title: app.name, owner: actor } }
`).includes("UNKNOWN_NAME"));
  { let m = ""; try { parse(base + `action a() { rate_limit = per 3 min by actor else blocked }
`); } catch (e) { m = (e as SpecError).message; } ok("rate_limit = …: a number is expected", m.includes("expected how many calls, a number, found '='"), m); }
  ok("rate_limit 0, per 0 s: RATE_LIMIT_NEVER; window 0: WINDOW_EMPTY", codes(`action a() { rate_limit 0 per 1 min by actor else blocked }\naction b() { rate_limit 3 per 0 s by actor else blocked }\nview v() { rows Note  page 0 last }\n`).join() === "RATE_LIMIT_NEVER,RATE_LIMIT_NEVER,WINDOW_EMPTY");
}

// a declaration nothing uses (a mention in a comment or a string isn't a use)
{
  const src = base + `fn shout(t: Text): Text = upper(t)\nfn whisper(t: Text): Text = lower(t)   // not shout\ncomponent Badge() { <p>"Badge"</p> }\nview loud() { rows Note where .title == shout("x") }\n`;
  const un = check(parse(src), { source: src }).filter((f) => f.code === "DECL_UNUSED").map((f) => f.message);
  ok("DECL_UNUSED: what nothing uses, not what something does", !un.some((m) => m.startsWith("function shout")) && un.some((m) => m.startsWith("function whisper")) && un.some((m) => m.startsWith("component Badge")), un);
}

// the CLI: the line, and a caret under the column
const dir = mkdtempSync(join(tmpdir(), "messages-"));
writeFileSync(join(dir, "app.crud"), base + `action add(t: Text) { create Note { title: t, colour: "red", owner: actor } }\n`);
const r = spawnSync(process.execPath, ["--no-warnings", "lang/cli.ts", "check", dir], { encoding: "utf8" });
const lines = r.stdout.split("\n");
const at = lines.findIndex((l) => l.startsWith("error UNKNOWN_FIELD"));
ok("check prints the line, and a caret under the field", at >= 0 && lines[at + 1] === ` 6 | action add(t: Text) { create Note { title: t, colour: "red", owner: actor } }` && lines[at + 2] === `   | ${" ".repeat(46)}^`, lines.slice(at, at + 3));
const quiet = spawnSync(process.execPath, ["--no-warnings", "lang/cli.ts", "check", dir], { encoding: "utf8", env: { ...process.env, NO_SNIPPET: "1" } });
ok("NO_SNIPPET=1: the findings alone", !quiet.stdout.includes(" | "), quiet.stdout);

// --json, for editors: each finding's file and its line there, in a many-file app too
const two = mkdtempSync(join(tmpdir(), "messages-"));
writeFileSync(join(two, "a.crud"), base);
writeFileSync(join(two, "b.crud"), `\naction add(t: Text) { create Note { title: t, colour: "red", owner: actor } }\n`);
const j = JSON.parse(spawnSync(process.execPath, ["--no-warnings", "lang/cli.ts", "check", two, "--json"], { encoding: "utf8" }).stdout);
const jf = j.findings.find((f: any) => f.code === "UNKNOWN_FIELD");
ok("--json: a finding's file, and its line in it", !!jf && jf.file.endsWith("b.crud") && jf.fileLine === 2 && jf.col === 47, j);
writeFileSync(join(two, "b.crud"), `\nscreen s {\n  route "/"\n  <Main></Main>\n}\n`);
const pj = JSON.parse(spawnSync(process.execPath, ["--no-warnings", "lang/cli.ts", "check", two, "--json"], { encoding: "utf8" }).stdout);
const pf = pj.findings[0];
ok("--json: a parse error has its code and place", pf.code === "PARSE_SCREEN" && pf.file.endsWith("b.crud") && pf.fileLine === 4 && pf.col === 3 && !/^\d/.test(pf.message), pf);

// --json gives a finding's fix when its message names one; --fix applies them
{
  const fx = mkdtempSync(join(tmpdir(), "messages-fix-"));
  writeFileSync(join(fx, "app.crud"), base + `entity Tag { name: Txt }\nview v() { rows Note where .titel == "x" }\n`);
  const jj = JSON.parse(spawnSync(process.execPath, ["--no-warnings", "lang/cli.ts", "check", fx, "--json"], { encoding: "utf8" }).stdout);
  const fixes = jj.findings.map((f: any) => f.fix).filter(Boolean);
  ok("--json: each named fix, with the name's columns and what replaces it", fixes.length === 2 && fixes.some((x: any) => x.replace === "Txt" && x.with === "Text" && x.endCol - x.col === 3) && fixes.some((x: any) => x.replace === "titel" && x.with === "title"), fixes);
  spawnSync(process.execPath, ["--no-warnings", "lang/cli.ts", "check", fx, "--fix"], { encoding: "utf8" });
  const again = spawnSync(process.execPath, ["--no-warnings", "lang/cli.ts", "check", fx], { encoding: "utf8" });
  ok("--fix: the fixes written, and the spec checks clean", again.status === 0 && (await import("node:fs")).readFileSync(join(fx, "app.crud"), "utf8").includes(`.title == "x"`), again.stdout);
}

console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
