// The v3 syntax (lang/LANGUAGE.md): the old forms are refused with the new one in the message;
// text elements take raw text; markup has if, let, for each and match; a match covers every
// value of its enum; upgrade-syntax rewrites the old forms and keeps the program the same.
//   node lang/test/syntax.test.ts
import { parse, SpecError } from "../parser.ts";
import { typecheck } from "../types.ts";
import { upgradeSyntax } from "../syntax-upgrade.ts";

let failed = 0;
const ok = (what: string, pass: boolean, detail?: unknown) => { console.log(`${pass ? "ok  " : "FAIL"} ${what}`); if (!pass) { failed++; if (detail !== undefined) console.log(typeof detail === "string" ? detail : JSON.stringify(detail, null, 2)); } };
const refused = (src: string): SpecError | null => { try { parse(src); return null; } catch (e) { return e instanceof SpecError ? e : null; } };
const refusedWith = (what: string, src: string, code: string, says: string) => {
  const e = refused(src);
  ok(what, !!e && e.code === code && e.message.includes(says), e?.message ?? "parsed");
};

const app = `app t { name "T"  actor User }
entity User { name: Text  status: Status = active  mood: Mood? }
enum Status { active, away, gone }
enum Mood { glad, sad }
layout l { <Main><Slot name=main /></Main> }
`;
const screen = (body: string) => `${app}screen s { route "/"  layout l <Main>${body}</Main> }`;

// ---- the old forms, refused
refusedWith("if … then … else is refused", `${app}fn f(u: User): Text = if u.name == "a" then "x" else "y"`, "PARSE_IF", "if c { a } else { b }");
refusedWith("an expression's if needs an else", `${app}fn f(u: User): Text = if u.name == "a" { "x" }`, "PARSE_IF", "needs an else");
refusedWith("<if test={…}> is refused", screen(`<if test={true}><Text>x</Text></if>`), "UI_OLD_FORM", "if c { … } else { … }");
refusedWith("<let> is refused", screen(`<let name="x" value={1} />`), "UI_OLD_FORM", "let name = value");
refusedWith("<each> is refused", screen(`<each as="x" in={[1, 2]}><Text>{x}</Text></each>`), "UI_OLD_FORM", "for each x in xs");
refusedWith("a quoted name is refused, with the bare form", `${app}action a(title: Text) { }\nscreen s { route "/"  layout l <Main><Form action={a}><Field name="title" kind=text /></Form></Main> }`, "UI_NAME", "name=title");
refusedWith("list(E where p : e) is refused", `${app}fn f(): list of Text = list(User where true : .name)`, "PARSE_PROJECTION", "for User where");

// ---- v4: elements and components are capitalised
refusedWith("a lowercase built-in is refused, with its new name", screen(`<heading>x</heading>`), "UI_TAG_CASE", "<Heading>");
refusedWith("a lowercase component name is refused", `${app}component note_row() { <Text>x</Text> }`, "UI_TAG_CASE", "NoteRow");
refusedWith("a component named like a built-in is refused", `${app}component Row() { <Text>x</Text> }`, "UI_TAG_CLASH", "Row");
const v3 = `${app.replace("<Main><Slot name=main /></Main>", "<main><slot name=main /></main>")}component note_row(u: User) { <row><richtext>{"x"}</richtext><field_display label="n">{u.name}</field_display></row> }
screen s { route "/"  layout l <main><list of={User where true} as=u><note_row u={u} /></list></main> }`;
const v4 = upgradeSyntax(v3).text;
ok("upgrade-syntax: tags and component names capitalised, renamed ones too", !refused(v4) && v4.includes("component NoteRow(u: User) { <Row><RichText>") && v4.includes("<FieldDisplay label=\"n\">{u.name}</FieldDisplay></Row>") && v4.includes("<List of={User where true} as=u><NoteRow u={u} /></List>") && v4.includes("<Main><Slot name=main /></Main>"), v4);

// ---- text
const head = (src: string) => (parse(src).decls.find((d) => d.kind === "screen") as any).body[0].children[0].head;
const h1 = head(screen(`<Text>{1} items left</Text>`));
ok("raw text and {…} make one text", h1.kind === "interp" && h1.parts.length === 2 && h1.parts[1].value === " items left", h1);
ok("plain text is a literal", head(screen(`<Heading>todos</Heading>`)).value === "todos");
ok("line breaks and spaces show as one space", head(screen(`<Text>\n   Hello,\n      world   \n</Text>`)).value === "Hello, world");
ok("an address is text, not a comment", head(screen(`<Text>see https://example.com/x</Text>`)).value === "see https://example.com/x");
ok("// starting a line is a comment", head(screen(`<Text>a\n  // a note\n  b</Text>`)).value === "a b");
ok("quotes and apostrophes are text", head(screen(`<Text>it's "fine" & done</Text>`)).value === `it's "fine" & done`);
ok("{\"literal\"} still works", head(screen(`<Text>{"x"}</Text>`)).value === "x");
refusedWith("a } in text is refused", screen(`<Text>a } b</Text>`), "UI_TEXT", `{"}"}`);
refusedWith("an element in text is refused", screen(`<Text>a <Strong>b</Strong></Text>`), "UI_TEXT", "not elements");

// ---- markup's control forms
const body = (src: string) => (parse(src).decls.find((d) => d.kind === "screen") as any).body[0].children;
const b1 = body(screen(`let n = count(User where true)\n<Text>{n}</Text>\nif n > 0 { <Text>some</Text> } else if n == 0 { <Text>none</Text> } else { <Text>?</Text> }\nfor each x in [1, 2] { <Text>{x}</Text> }`));
ok("let, if/else if/else and for each among elements", b1.map((e: any) => e.name).join(",") === "let,text,if,each" && b1[2].else[0].name === "if" && b1[2].else[0].else.length === 1, b1.map((e: any) => e.name));
ok("a let before an element doesn't swallow its <", b1[0].head.value.kind === "query");
ok("a comparison still compares", body(screen(`let small = 1 < 2\n<Text>{small}</Text>`))[0].head.value.op === "<");

// ---- match
const types = (src: string) => typecheck(parse(src)).findings.map((f) => `${f.code}: ${f.message}`);
const has = (fs: string[], code: string) => fs.some((f) => f.startsWith(code));
const m = (arms: string, subject = "u.status") => `${app}fn f(u: User): Text = match ${subject} { ${arms} }`;
ok("a match with every value: no finding", !types(m(`active { "a" } away, gone { "b" }`)).some((f) => f.startsWith("MATCH")), types(m(`active { "a" } away, gone { "b" }`)));
ok("a value without an arm: MATCH_MISSING, naming it", types(m(`active { "a" } away { "b" }`)).some((f) => f.startsWith("MATCH_MISSING") && f.includes("gone")));
ok("a name that isn't a value: MATCH_UNKNOWN", has(types(m(`active { "a" } away { "b" } gone { "c" } left { "d" }`)), "MATCH_UNKNOWN"));
ok("a value with two arms: MATCH_DUPLICATE", has(types(m(`active { "a" } away { "b" } gone, active { "c" }`)), "MATCH_DUPLICATE"));
ok("a match over text: MATCH_NOT_ENUM", has(types(m(`active { "a" }`, "u.name")), "MATCH_NOT_ENUM"));
ok("an optional subject needs a none arm", types(m(`glad { "a" } sad { "b" }`, "u.mood")).some((f) => f.startsWith("MATCH_MISSING") && f.includes("none")));
ok("with none, an optional subject is covered", !types(m(`glad { "a" } sad { "b" } none { "c" }`, "u.mood")).some((f) => f.startsWith("MATCH")));
ok("none on a subject that's never none: MATCH_UNKNOWN", has(types(m(`active { "a" } away { "b" } gone { "c" } none { "d" }`)), "MATCH_UNKNOWN"));
const grown = m(`active { "a" } away, gone { "b" }`).replace("enum Status { active, away, gone }", "enum Status { active, away, gone, busy }");
ok("a value added to the enum makes an old match fail", types(grown).some((f) => f.startsWith("MATCH_MISSING") && f.includes("busy")));
refusedWith("a match has no else", m(`active { "a" } else { "b" }`), "MATCH_ELSE", "no else");
ok("match as a statement", !types(`${app}action a(u: User) { match u.status { active { set u.name = "a" } away, gone { set u.name = "b" } } }`).some((f) => f.startsWith("MATCH")));
const mk = body(screen(`match actor.status { active { <Text>here</Text> } away { <Text>away</Text> } gone { <Text>gone</Text> } }`));
ok("match among elements: an if per arm, the last the else", mk.length === 1 && mk[0].name === "if" && mk[0].else[0].name === "if" && mk[0].else[0].else[0].name === "text", mk);

// ---- the current row: in for each u in E where …, the row is u
refusedWith("it in a loop that names its row is refused", `${app}action a() { for each u in User where it.name == "x" { set u.name = "y" } }`, "ROW_NAMED", "write u, not it");
const loop = (parse(`${app}action a() { for each u in User where u.name == "x" and .status == active { set u.name = "y" } }`).decls.find((d) => d.kind === "action") as any).body[0];
ok("u in the where is the row (as it was)", loop.where.left.left.target?.kind === "it", loop.where);
ok("a loop variable named like an enum value: ROW_NAME_SHADOWS", (await import("../check.ts")).check(parse(`${app}action a() { for each away in User where .status == active { set away.name = "y" } }`)).some((f) => f.code === "ROW_NAME_SHADOWS"));
ok("upgrade-syntax: it in a named loop becomes the loop's name", upgradeSyntax(`${app}action a(users: set of User) { for each u in User where it in users { set u.name = "y" } }`).text.includes("for each u in User where u in users"));

let refusedUpgrade = "";
try { upgradeSyntax(`${app}action a(m: User) { for each away in User where .status == away and it != m { set away.name = "y" } }`); } catch (e) { refusedUpgrade = (e as Error).message; }
ok("upgrade-syntax refuses a loop named like an enum value it compares with", /ROW|enum|rename/.test(refusedUpgrade), refusedUpgrade);

// ---- theme classes
refusedWith("classes json { … } is refused", `${app}theme th { classes json { button: "btn" } }`, "PARSE_THEME", "without json");
ok("upgrade-syntax: classes json becomes classes", upgradeSyntax(`${app}theme th { classes json { button: "btn" } }`).text.includes(`classes { button: "btn" }`));
const { check: checkSpec } = await import("../check.ts");
ok("a class nothing reads: THEME_CLASS_UNKNOWN", checkSpec(parse(`${app}theme th { classes { buton: "btn" } }`)).some((f) => f.code === "THEME_CLASS_UNKNOWN" && f.message.includes("buton")));
ok("a class the app's widgets read is known", !checkSpec(parse(`${app}theme th { classes { plain_button: "x" } }`), { widgetClasses: ["plain_button"] }).some((f) => f.code === "THEME_CLASS_UNKNOWN"));

// ---- settings at the top of a body; the renamed words
refusedWith("screen name \"route\" … layout L is refused", `${app}screen s2 "/x" layout l { <Main><Text>x</Text></Main> }`, "PARSE_OPTIONS", "route");
refusedWith("view … live is refused", `${app}view v() live { rows User }`, "PARSE_OPTIONS", "updates live");
refusedWith("a value view without braces is refused", `${app}view v() value 1`, "PARSE_OPTIONS", "value");
refusedWith("skip gate before the body is refused", `${app}action a() skip gate g { }`, "PARSE_OPTIONS", "skip gate");
refusedWith("touches is refused", `${app}entity R { u: User touches }`, "PARSE_FIELD", "on change touch");
refusedWith("sign_in_as is refused", `${app}action a() { }\nscreen s2 { route "/x"  layout l <Main><Form action={a}><On ok sign_in_as={actor} /></Form></Main> }`, "UI_REACTION", "sign_in=");
refusedWith("clear is refused", `${app}action a() { }\nscreen s2 { route "/x"  layout l <Main><Form action={a}><On ok clear /></Form></Main> }`, "UI_REACTION", "clear_form");
refusedWith("a setting twice is refused", `${app}screen s2 { route "/x"  layout l  layout l <Main></Main> }`, "OPTION_REPEATED", "layout");
refusedWith("a setting's value is one of its own", `${app}screen s2 { route "/x"  layout l  access everyone <Main></Main> }`, "OPTION_VALUE", "public or signed_in");
refusedWith("updates live or none", `${app}view v() { updates sometimes  rows User }`, "OPTION_VALUE", "live or none");
refusedWith("a screen needs its layout", `${app}screen s2 { route "/x" <Main></Main> }`, "PARSE_SCREEN", "layout");
const scr = parse(`${app}screen s2(u: User) { access public  route "/u/:u"  layout l  remember last_u <Main></Main> }`).decls.find((d) => d.name === "s2") as any;
ok("settings in any order", scr.route === "/u/:u" && scr.layout === "l" && scr.public === true && scr.remember === "last_u", scr);
const oldHeads = `${app}action a() { }
action b(n: Text)   // why b skips it
  skip gate g
{
}
view v(u: User) live {   // a comment beside it
  rows User where .name == u.name
}
view w() value 1
entity R { u: User on delete cascade touches }
channel c(u: User)   // presence
  requires actor != none
  on open a()
signal t(u: User) to set(User where true) carries { n: Text }
screen s2 "/x/:u" (u: User) layout l public {
  <Main><Form action={a}><On ok sign_in_as={u} clear /></Form></Main>
}
schedule n for u in User at u.created past_due skip { }
schedule m every day at "08:00" { }
`;
const up3 = upgradeSyntax(oldHeads.replace("gate g", "gate gg").replace(app, app + "gate gg: false -> forbidden\n"));
ok("upgrade-syntax: every header form", !refused(up3.text) && /screen s2\(u: User\) \{\n  route "\/x\/:u"\n  layout l\n  access public/.test(up3.text) && up3.text.includes("view v(u: User) {   // a comment beside it\n  updates live") && up3.text.includes("view w() { value 1 }") && up3.text.includes("on change touch") && up3.text.includes("sign_in={u} clear_form") && up3.text.includes("channel c(u: User) {   // presence") && up3.text.includes("schedule n for u in User { at u.created  if missed skip") && up3.text.includes("schedule m { every day at \"08:00\""), up3.text);
ok("upgrade-syntax: a comment beside a moved setting stays", up3.text.includes("action b(n: Text)   // why b skips it\n{\n  skip gate gg"), up3.text);

// ---- upgrade-syntax
const old = `${app}fn f(u: User): Text = if u.name == "a" then "x" else if u.name == "b" then "y" else "z"
fn names(): list of Text = list(User where true : .name)
action a(title: Text) { }
screen s "/" layout l {
  <Main>
    <let name="n" value={count(User where true)} />
    <if test={n > 0}>
      <Heading>{"Some"}</Heading>
    </if>
    <else test={n == 0}>
      <Text>{"None"}</Text>
    </else>
    <else><Text>{"?"}</Text></else>
    <each as="x" in={names()}><Text>{x}</Text></each>
    <Form action={a}><Field name="title" kind="text" /></Form>
  </Main>
}`;
const up = upgradeSyntax(old);
ok("upgrade-syntax: the current parser reads the result", !refused(up.text), refused(up.text)?.message);
ok("upgrade-syntax: no old form left", !/then|<if|<else|<let|<each|name="|kind="| : \.|\{"/.test(up.text), up.text);
ok("upgrade-syntax: else if stays else if", up.text.includes(`if u.name == "a" { "x" } else if u.name == "b" { "y" } else { "z" }`), up.text);
ok("upgrade-syntax: markup", up.text.includes("let n = count(User where true)") && up.text.includes("if n > 0 {") && up.text.includes("} else if n == 0 {") && up.text.includes("<Heading>Some</Heading>") && up.text.includes("for each x in names() {"), up.text);
ok("upgrade-syntax: a spec already current is left alone", upgradeSyntax(up.text).text === up.text);

process.exit(failed ? 1 : 0);
