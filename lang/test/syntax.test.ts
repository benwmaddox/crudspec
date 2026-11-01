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
refusedWith("<if test={…}> is refused", screen(`<if test={true}><span>x</span></if>`), "UI_OLD_FORM", "if c { … } else { … }");
refusedWith("<let> is refused", screen(`<let name="x" value={1} />`), "UI_OLD_FORM", "let name = value");
refusedWith("<each> is refused", screen(`<each as="x" in={[1, 2]}><span>{x}</span></each>`), "UI_OLD_FORM", "for each x in xs");
refusedWith("a quoted name is refused, with the bare form", `${app}action a(title: Text) { }\nscreen s { route "/"  layout l <Main><Form action={a}><Field name="title" kind=text /></Form></Main> }`, "UI_NAME", "name=title");
refusedWith("list(E where p : e) is refused", `${app}fn f(): list of Text = list(User where true : .name)`, "PARSE_PROJECTION", "for User where");

// ---- v4: elements and components are capitalised
refusedWith("a lowercase built-in is refused, with its new name", screen(`<avatar>x</avatar>`), "UI_TAG_CASE", "<Avatar>");
refusedWith("a lowercase component name is refused", `${app}component note_row() { <span>x</span> }`, "UI_TAG_CASE", "NoteRow");
refusedWith("a component named like a built-in is refused", `${app}component Link() { <span>x</span> }`, "UI_TAG_CLASH", "Link");
const v3 = `${app.replace("<Main><Slot name=main /></Main>", "<main><slot name=main /></main>")}component note_row(u: User) { <div><richtext>{"x"}</richtext><field_display label="n">{u.name}</field_display></div> }
screen s { route "/"  layout l <main><list of={User where true} as=u><note_row u={u} /></list></main> }`;
const v4 = upgradeSyntax(v3).text;
ok("upgrade-syntax: tags and component names capitalised, renamed ones too", !refused(v4) && v4.includes("component NoteRow(u: User) { <div><RichText>") && v4.includes("<FieldDisplay label=\"n\">{u.name}</FieldDisplay></div>") && v4.includes("<List of={User where true} as=u><NoteRow u={u} /></List>") && v4.includes("<Main><Slot name=main /></Main>"), v4);

// ---- v4: content is text, {expression} and elements; code goes in braces
const kids = (src: string) => (parse(src).decls.find((d) => d.kind === "screen") as any).body[0].children;
const c1 = kids(screen(`<section>Hello {actor.name}!</section>`))[0].children;
ok("text and {…} among elements are one text, with no element of its own", c1.length === 1 && c1[0].name === "text" && c1[0].plain && c1[0].head.kind === "interp" && c1[0].head.parts[0].value === "Hello " && c1[0].head.parts[2].value === "!", c1);
const c2 = kids(screen(`<div>\n  <span>a</span>\n  <span>b</span> <span>c</span>\n</div>`))[0].children;
ok("only spaces and line breaks between elements: nothing", c2.length === 3 && c2.every((e: any) => !e.plain), c2.map((e: any) => e.name));
const c3 = kids(screen(`<div><span>a</span>{" "}<span>b</span></div>`))[0].children;
ok("a space between two elements is {\" \"}", c3.length === 3 && c3[1].plain && c3[1].head.value === " ");
const c4 = kids(screen(`<div>\n  Signed in as {actor.name}\n  // a note\n  <span>x</span>   // why x\n  see https://example.com/a\n</div>`))[0].children;
ok("// starts a comment at a line's start or after a space; an address is text", c4.length === 3 && c4[0].head.parts[0].value === "Signed in as " && c4[2].head.value === "see https://example.com/a", c4.map((e: any) => e.head));
const c5 = kids(screen(`<div>{if actor.name == "a" { yes <strong>!</strong> } else { no }}</div>`))[0].children;
ok("{if …}: its blocks are content", c5.length === 1 && c5[0].name === "if" && c5[0].children[0].plain && c5[0].children[0].head.value === "yes " && c5[0].children[1].name === "html" && c5[0].else[0].head.value === "no", c5);
const c6 = kids(screen(`<div>{let n = 2}{for each x in [1, n] { <span>{x}</span> }}<span>{n}</span></div>`))[0].children;
ok("{let …} names a value for the rest of the content", c6.map((e: any) => e.name).join(",") === "let,each,html", c6.map((e: any) => e.name));
refusedWith("an element right inside {…} is refused", screen(`<div>{if true { <span>a</span> } <span>b</span>}</div>`), "UI_CODE", "elements go in");
const { check: checkUI } = await import("../check.ts");
const textWarnings = (b: string) => checkUI(parse(screen(`<div>${b}</div>`))).filter((f) => f.code.startsWith("UI_TEXT")).map((f) => f.code);
ok("code without its braces shows as text: UI_TEXT_CODE", textWarnings(`\n  let n = 3\n  <span>x</span>`).includes("UI_TEXT_CODE") && !textWarnings(`Hello {actor.name}`).length);
ok("a block that is only a quoted string shows its quotes: UI_TEXT_QUOTED", textWarnings(`{if true { "Yes" } else { No }}`).join() === "UI_TEXT_QUOTED");
const bare = `${app}screen s { route "/"  layout l <Main>\n  let n = count(User where true)\n  if n > 0 { <span>{n}</span> }\n</Main> }`;
const ub = upgradeSyntax(bare).text;
ok("upgrade-syntax: bare code among elements goes in braces, not into text", ub.includes("{let n = count(User where true)}") && ub.includes("{if n > 0 { <span>{n}</span> }}") && !refused(ub), ub);

// ---- v4: lowercase is plain HTML
const hx = kids(screen(`<div class="a" data-id={actor.name} hidden><my-widget aria-label="x"></my-widget><br><img src="/a.png" /></div>`))[0];
ok("a lowercase element is HTML: its attributes as written, dashes and all", hx.name === "html" && hx.head.tag === "div" && hx.attrs["data-id"].kind === "field" && hx.attrs.hidden === true && hx.children.map((c: any) => c.head.tag).join() === "my-widget,br,img" && hx.children[0].head.custom, hx);
refusedWith("a built-in written lowercase that isn't HTML: refused with its name", screen(`<avatar>x</avatar>`), "UI_TAG_CASE", "<Avatar>");
ok("a built-in's name that is HTML too is the HTML element", kids(screen(`<section><p>x</p></section>`))[0].name === "html");
refusedWith("<style> is refused: styles go in stylesheets", screen(`<style>.a { color: red }</style>`), "UI_HTML_STYLE", "stylesheets");
const htmlFindings = (b: string) => checkUI(parse(screen(b))).filter((f) => f.code.startsWith("UI_HTML")).map((f) => f.code).sort().join();
ok("what could run script is refused: <script>, on… attributes, javascript: addresses", htmlFindings(`<script>x</script><a href="javascript:x" onclick="y">a</a>`) === "UI_HTML_HANDLER,UI_HTML_SCRIPT,UI_HTML_URL", htmlFindings(`<script>x</script><a href="javascript:x" onclick="y">a</a>`));
ok("a style that varies is refused; a data: image is fine", htmlFindings(`<p style={actor.name}>x</p><img src="data:image/png;base64,AA">`) === "UI_HTML_STYLE");
ok("a plain <form> is a warning", htmlFindings(`<form><input name="x"></form>`) === "UI_HTML_FORM");
const formSpec = `${app}action pin(pinned: Bool) { }\nscreen s2 { route "/x"  layout l <Main><Form action={pin}><input type="checkbox" name={"pinned"}><input name="bogus"><Submit label="Go" /></Form></Main> }`;
ok("a raw control's name in a <Form> must be a parameter", checkUI(parse(formSpec)).some((f) => f.code === "FIELD_NOT_A_PARAMETER" && f.message.includes("bogus")));
// the old lowercase habits that are HTML names too: caught, not shown as HTML that does nothing
const errs = (src: string) => checkUI(parse(src)).filter((f) => f.severity === "error").map((f) => f.code);
ok("<main> at a screen's top fills no slot: UI_HTML_SLOT, naming <Main>", errs(`${app}screen s2 { route "/x"  layout l <main><p>x</p></main> }`).includes("UI_HTML_SLOT"));
ok("plain HTML at a screen's top: UI_HTML_SLOT", errs(`${app}screen s2 { route "/x"  layout l <div>x</div> }`).includes("UI_HTML_SLOT"));
ok("<main> in a layout: UI_HTML_SLOT", errs(app.replace("<Main><Slot name=main /></Main>", "<main><Slot name=main /></main>")).includes("UI_HTML_SLOT"));
ok("<link to={…}>: UI_HTML_BUILTIN", errs(screen(`<link to={s()} label="x" />`)).includes("UI_HTML_BUILTIN"));
ok("<button action={…}>: UI_HTML_BUILTIN; a plain form's action=\"…\" is HTML", errs(`${app}action pin() { }\n` + screen(`<button action={pin()}>x</button>`).slice(app.length)).includes("UI_HTML_BUILTIN") && !errs(screen(`<p><a href="/x">x</a></p>`)).includes("UI_HTML_BUILTIN"));
refusedWith("<slot> and <title> are the built-ins, capitalised", `${app.replace("<Slot name=main />", "<slot name=main />")}`, "UI_TAG_CASE", "<Slot>");
refusedWith("a bare name as an HTML attribute's value: refused", screen(`<input kind=text>`), "UI_HTML_ATTR", "\"text\" or {value}");
const v4html = `${app}screen s { route "/"  layout l <Main><p>Hello {actor.name}, <b>welcome</b>!</p></Main> }`;
ok("upgrade-syntax leaves a current spec's HTML alone", upgradeSyntax(v4html).text === v4html);

// ---- text
const head = (src: string) => (parse(src).decls.find((d) => d.kind === "screen") as any).body[0].children[0].head;
const h1 = head(screen(`<Title>{1} items left</Title>`));
ok("raw text and {…} make one text", h1.kind === "interp" && h1.parts.length === 2 && h1.parts[1].value === " items left", h1);
ok("plain text is a literal", head(screen(`<Title>todos</Title>`)).value === "todos");
ok("line breaks and spaces show as one space", head(screen(`<Title>\n   Hello,\n      world   \n</Title>`)).value === "Hello, world");
ok("an address is text, not a comment", head(screen(`<Title>see https://example.com/x</Title>`)).value === "see https://example.com/x");
ok("// starting a line is a comment", head(screen(`<Title>a\n  // a note\n  b</Title>`)).value === "a b");
ok("quotes and apostrophes are text", head(screen(`<Title>it's "fine" & done</Title>`)).value === `it's "fine" & done`);
ok("{\"literal\"} still works", head(screen(`<Title>{"x"}</Title>`)).value === "x");
refusedWith("a } in text is refused", screen(`<Title>a } b</Title>`), "UI_TEXT", `{"}"}`);
refusedWith("an element in text is refused", screen(`<Title>a <strong>b</strong></Title>`), "UI_TEXT", "not elements");

// ---- markup's control forms
const body = (src: string) => (parse(src).decls.find((d) => d.kind === "screen") as any).body[0].children;
const b1 = body(screen(`{let n = count(User where true)}\n<span>{n}</span>\n{if n > 0 { <span>some</span> } else if n == 0 { <span>none</span> } else { <span>?</span> }}\n{for each x in [1, 2] { <span>{x}</span> }}`));
ok("let, if/else if/else and for each among elements", b1.map((e: any) => e.name).join(",") === "let,html,if,each" && b1[2].else[0].name === "if" && b1[2].else[0].else.length === 1, b1.map((e: any) => e.name));
ok("a let before an element doesn't swallow its <", b1[0].head.value.kind === "query");
ok("a comparison still compares", body(screen(`{let small = 1 < 2}\n<span>{small}</span>`))[0].head.value.op === "<");

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
const mk = body(screen(`{match actor.status { active { <span>here</span> } away { <span>away</span> } gone { <span>gone</span> } }}`));
ok("match among elements: an if per arm, the last the else", mk.length === 1 && mk[0].name === "if" && mk[0].else[0].name === "if" && mk[0].else[0].else[0].name === "html", mk);

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
refusedWith("screen name \"route\" … layout L is refused", `${app}screen s2 "/x" layout l { <Main><span>x</span></Main> }`, "PARSE_OPTIONS", "route");
refusedWith("view … live is refused", `${app}view v() live { rows User }`, "PARSE_OPTIONS", "updates live");
refusedWith("a value view without braces is refused", `${app}view v() value 1`, "PARSE_OPTIONS", "value");
refusedWith("skip gate before the body is refused", `${app}action a() skip gate g { }`, "PARSE_OPTIONS", "skip gate");
refusedWith("touches is refused", `${app}entity R { u: User touches }`, "PARSE_FIELD", "on change touch");
refusedWith("sign_in_as is refused", `${app}action a() { }\nscreen s2 { route "/x"  layout l <Main><Form action={a}><On ok sign_in_as={actor} /></Form></Main> }`, "UI_REACTION", "sign_in=");
refusedWith("clear is refused", `${app}action a() { }\nscreen s2 { route "/x"  layout l <Main><Form action={a}><On ok clear /></Form></Main> }`, "UI_REACTION", "clear_form");
refusedWith("a setting twice is refused", `${app}screen s2 { route "/x"  layout l  layout l <Main></Main> }`, "OPTION_REPEATED", "layout");
refusedWith("a setting's value is public, signed_in or a policy's name (a number is none of them)", `${app}screen s2 { route "/x"  layout l  access 3 <Main></Main> }`, "PARSE_EXPECTED", "policy");
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
ok("upgrade-syntax: a comment beside a moved setting stays", up3.text.includes("action b(n: Text)   // why b skips it\n{\n  skip policy gg"), up3.text);

// ---- upgrade-syntax
const old = `${app}fn f(u: User): Text = if u.name == "a" then "x" else if u.name == "b" then "y" else "z"
fn names(): list of Text = list(User where true : .name)
action a(title: Text) { }
screen s "/" layout l {
  <Main>
    <let name="n" value={count(User where true)} />
    <if test={n > 0}>
      <Title>{"Some"}</Title>
    </if>
    <else test={n == 0}>
      <Title>{"None"}</Title>
    </else>
    <else><Title>{"?"}</Title></else>
    <each as="x" in={names()}><Title>{x}</Title></each>
    <Form action={a}><Field name="title" kind="text" /></Form>
  </Main>
}`;
const up = upgradeSyntax(old);
ok("upgrade-syntax: the current parser reads the result", !refused(up.text), refused(up.text)?.message);
ok("upgrade-syntax: no old form left", !/then|<if|<else|<let|<each|name="|kind="| : \.|\{"/.test(up.text), up.text);
ok("upgrade-syntax: else if stays else if", up.text.includes(`if u.name == "a" { "x" } else if u.name == "b" { "y" } else { "z" }`), up.text);
ok("upgrade-syntax: markup", up.text.includes("let n = count(User where true)") && up.text.includes("if n > 0 {") && up.text.includes("} else if n == 0 {") && up.text.includes("<Title>Some</Title>") && up.text.includes("for each x in names() {"), up.text);
ok("upgrade-syntax: a spec already current is left alone", upgradeSyntax(up.text).text === up.text);

process.exit(failed ? 1 : 0);
