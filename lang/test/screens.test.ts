// What cuts the repetition in a UI: a named access policy for screens (`policy staff: … else go …`,
// `access staff`), a form that navigates (`<Form to={screen}>`: a GET whose fields are the screen's
// parameters, for filters and reports), and a component that takes children.
//   node lang/test/screens.test.ts      (needs Go: on Windows, in WSL)
process.removeAllListeners("warning");
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "../parser.ts";
import { check } from "../check.ts";
import { startApp } from "./go-app.ts";

let failed = 0;
const ok = (what: string, pass: boolean, detail?: unknown) => { console.log(`${pass ? "ok  " : "FAIL"} ${what}`); if (!pass) { failed++; if (detail !== undefined) console.log(typeof detail === "string" ? detail.slice(0, 500) : JSON.stringify(detail)); } };

const HEAD = `
app t { name "T" actor User  sign_in_screen sign_in_screen }
enum Role { member, staff }
enum Kind { a, b }
entity User { name: Text  role: Role = member  token: Text? }
entity Login { who: User on delete cascade  token: Text = token(24)  unique (token) }
identity login: Login.token from cookie "login"
entity Item { title: Text  kind: Kind = a }
permission read Item: true
permission read User: true
fn is_staff(u: User?): Bool = u != none and u.role == staff
layout l { <Main><Slot name=main /></Main> }
screen sign_in_screen { route "/in"  layout l  access public  <Main><h1>Sign in</h1></Main> }
action sign_in(name: Text) { skip policy signed_in  let u = the_or_none(User where .name == name)  require u != none else unauthenticated  create Login { who: u } as l  result l }
action add_user(name: Text, role: Role) { skip policy signed_in  create User { name: name, role: role } }
action add_item(title: Text, kind: Kind) { skip policy signed_in  create Item { title: title, kind: kind } }
policy signed_in: actor != none else unauthenticated for every action
`;
const codes = (src: string) => check(parse(HEAD + src)).filter((f) => f.severity === "error").map((f) => f.code);

// ---- named access policies
ok("a policy and a screen that takes it check clean", codes(`
policy staff: is_staff(actor) else go sign_in_screen flash "Staff only."
screen desk { route "/desk"  layout l  access staff  <Main><h1>Desk</h1></Main> }`).length === 0, codes(`
policy staff: is_staff(actor) else go sign_in_screen flash "Staff only."
screen desk { route "/desk"  layout l  access staff  <Main><h1>Desk</h1></Main> }`));
ok("a policy nobody declared is an error, with the nearest name", (() => { const f = check(parse(HEAD + `policy staff: is_staff(actor) else go sign_in_screen\nscreen desk { route "/desk"  layout l  access stafff  <Main><h1>Desk</h1></Main> }`)).find((x) => x.code === "POLICY_UNKNOWN"); return !!f && f.message.includes("did you mean staff"); })());
ok("a policy's screen has to exist", codes(`policy staff: is_staff(actor) else go nowhere\nscreen desk { route "/desk"  layout l  access staff  <Main><h1>Desk</h1></Main> }`).length > 0);
ok("a policy's own condition is checked, though no screen takes it yet", codes(`policy staff: is_staf(actor) else go sign_in_screen`).length > 0);
{
  const spec = parse(HEAD + `policy staff: is_staff(actor) else go sign_in_screen flash "Staff only."\nscreen a { route "/a"  layout l  access staff  <Main><h1>A</h1></Main> }\nscreen b { route "/b"  layout l  access staff  require actor.name != "x" else forbidden  <Main><h1>B</h1></Main> }`);
  const a: any = spec.decls.find((d: any) => d.name === "a"), b: any = spec.decls.find((d: any) => d.name === "b");
  ok("the policy is the screen's first requirement, ahead of its own", a.requires.length === 1 && b.requires.length === 2 && b.requires[0].policy === "staff" && b.requires[1].outcome === "forbidden");
  ok("... each screen has its own copy", a.requires[0].cond !== b.requires[0].cond);
}

// ---- forms that navigate
const SEARCH = `
view found(typed: Text?, kind: Kind?) {
  rows Item where (typed == none or contains(lower(.title), lower(typed))) and (kind == none or .kind == kind)
  order by .title
}
screen search(typed: Text?, kind: Kind?) {
  route "/search"
  layout l
  access public
  <Main>
    <Form to={search}>
      <Field name=typed kind=text placeholder="Title" />
      <Field name=kind kind=choice from={[a, b]} />
      <Submit label="Search" />
    </Form>
    <List of={found(typed, kind)} as=i><Text>{i.title}</Text></List>
  </Main>
}
screen item_screen(item: Item) { route "/items/:item"  layout l  access public  <Main><Text>{item.title}</Text></Main> }
`;
ok("a form that navigates, its fields the screen's parameters, checks clean", codes(SEARCH).length === 0, codes(SEARCH));
ok("a screen's address part can't be a form's field", codes(SEARCH + `screen r1(item: Item, typed: Text?) { route "/r1/:item"  layout l  access public  <Main><Form to={r1}><Field name=typed kind=text /><Submit label="go" /></Form></Main> }`).includes("FORM_TO_ROUTE"));
ok("... but the call may fix it", !codes(SEARCH + `screen r2(item: Item, typed: Text?) { route "/r2/:item"  layout l  access public  <Main><Form to={r2(item)}><Field name=typed kind=text /><Submit label="go" /></Form></Main> }`).includes("FORM_TO_ROUTE"));
ok("a call can fix only an address part, since a GET's query is the form's own", codes(SEARCH + `screen r3(typed: Text?) { route "/r3"  layout l  access public  <Main><Form to={r3("x")}><Submit label="go" /></Form></Main> }`).includes("FORM_TO_ARGUMENT"));
ok("a parameter a field can't carry (a time) is refused", codes(SEARCH + `screen r4(when: Time) { route "/r4"  layout l  access public  <Main><Form to={r4}><Field name=when kind=datetime /><Submit label="go" /></Form></Main> }`).includes("FORM_TO_TYPE"));
ok("a field that is no parameter is refused", codes(SEARCH + `screen r5(typed: Text?) { route "/r5"  layout l  access public  <Main><Form to={r5}><Field name=other kind=text /><Submit label="go" /></Form></Main> }`).length > 0);
ok("<On> has no place in it", codes(SEARCH + `screen r6(typed: Text?) { route "/r6"  layout l  access public  <Main><Form to={r6}><Field name=typed kind=text /><Submit label="go" /><On ok stay /></Form></Main> }`).includes("FORM_TO_ON"));

// ---- components that take children
const CARD = `
component Card(title: Text, note: Text?) {
  <section class="card">
    <h1>{title}</h1>
    {if note != none { <Text class="muted">{note}</Text> }}
    <Slot />
    <div class="actions"><Slot name=actions /></div>
  </section>
}
component Panel(heading: Text) {
  <Card title={heading + "!"}>
    <Text>inside the panel</Text>
    <Slot />
  </Card>
}
`;
const CARDS = `screen cards { route "/cards"  layout l  access public
  <Main>
    <Card title="Hello" note="n1">
      <Text>body one</Text>
      <Fill name=actions><Text>an action</Text></Fill>
    </Card>
    {let title = "outer"}
    <Card title={title + " card"}><Text>{title}</Text></Card>
    <Panel heading="P"><Text>panel body</Text></Panel>
  </Main>
}`;
ok("a component with a <Slot /> and the screens that use it check clean", codes(CARD + CARDS).length === 0, codes(CARD + CARDS));
ok("a <Slot /> outside a component is an error", codes(`screen s { route "/s"  layout l  access public  <Main><Slot /></Main> }`).includes("UI_SLOT"));
ok("a <Fill> outside a component's tags is an error", codes(`screen s { route "/s"  layout l  access public  <Main><Fill name=x><Text>a</Text></Fill></Main> }`).includes("UI_FILL"));
const parseError = (src: string) => { try { parse(HEAD + src); return ""; } catch (e) { return (e as any).code + " " + (e as Error).message; } };
ok("a <Fill> for a place the component hasn't is an error that names it", /UI_FILL.*Card has no <Slot name=nope>/.test(parseError(CARD + `screen s { route "/s"  layout l  access public  <Main><Card title="x"><Fill name=nope><Text>a</Text></Fill></Card></Main> }`)));
ok("a missing required parameter is an error", /UI_PROP.*needs title/.test(parseError(CARD + `screen s { route "/s"  layout l  access public  <Main><Card><Text>a</Text></Card></Main> }`)));
ok("an unknown parameter is an error, with the nearest", /UI_PROP.*no parameter 'titel'.*did you mean title/.test(parseError(CARD + `screen s { route "/s"  layout l  access public  <Main><Card titel="x"><Text>a</Text></Card></Main> }`)));
ok("a component that uses itself is an error", /UI_COMPONENT_RECURSION/.test(parseError(`component Loop(n: Text) { <section><Slot /><Loop n={n}><Text>again</Text></Loop></section> }
screen s { route "/s"  layout l  access public  <Main><Loop n="a"><Text>x</Text></Loop></Main> }`)));
{
  const spec: any = parse(HEAD + CARD + CARDS);
  const card = spec.decls.find((d: any) => d.name === "Card");
  ok("an expanded component keeps its declaration (for its parameters) with no body of its own", card.macro === true && card.body.length === 0 && card.uses >= 3, { macro: card.macro, uses: card.uses });
  const lets = JSON.stringify(spec.decls.find((d: any) => d.name === "cards").body).match(/"name":"title__\d+"/g) ?? [];
  ok("... its parameters are lets with names of their own, so the user's own title is not shadowed", new Set(lets).size >= 3, lets);
}

// ---- running
const dir = mkdtempSync(join(tmpdir(), "screens-"));
writeFileSync(join(dir, "app.crud"), HEAD + SEARCH + `
policy staff: is_staff(actor) else go sign_in_screen flash "Staff only."
screen desk { route "/desk"  layout l  access staff  <Main><h1>Desk</h1></Main> }
` + CARD + CARDS);
const app = await startApp(join(dir, "app.crud"), 13950);
try {
  const post = async (cookie: string | null, action: string, args: Record<string, string> = {}) => { const r = await fetch(`${app.base}/_do/${action}`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", ...(cookie ? { Cookie: cookie } : {}) }, body: new URLSearchParams(args), redirect: "manual" }); return { outcome: r.headers.get("X-Crudspec-Outcome"), cookie: r.headers.getSetCookie().find((c) => c.startsWith("login="))?.split(";")[0] }; };
  const get = async (cookie: string | null, path: string) => { const r = await fetch(app.base + path, { headers: cookie ? { Cookie: cookie } : {}, redirect: "manual" }); return { status: r.status, location: r.headers.get("Location"), text: await r.text() }; };
  await post(null, "add_user", { name: "ann", role: "staff" });
  await post(null, "add_user", { name: "bob", role: "member" });
  const ann = (await post(null, "sign_in", { name: "ann" })).cookie!, bob = (await post(null, "sign_in", { name: "bob" })).cookie!;
  ok("the policy lets staff in", (await get(ann, "/desk")).status === 200);
  const refused = await get(bob, "/desk");
  ok("... and sends anyone else where it says (the sign-in screen, with its message)", refused.status >= 300 && refused.status < 400 && refused.location === "/in", { status: refused.status, to: refused.location });
  ok("... a signed-out visitor too", (await get(null, "/desk")).location === "/in");

  for (const [title, kind] of [["Apple pie", "a"], ["Apple tart", "b"], ["Banana", "a"]]) await post(null, "add_item", { title, kind });
  const page = await get(ann, "/search");
  ok("the form renders as a GET to the screen's own address", /<form method="get" action="\/search"/.test(page.text), page.text.replace(/\s+/g, " ").match(/<form[^>]*>/)?.[0]);
  ok("... and carries no action call (no hidden handler)", !/__h|__arg_|\/_do\//.test(page.text.slice(page.text.indexOf("<form"), page.text.indexOf("</form>"))));
  ok("with no query, every item shows", ["Apple pie", "Apple tart", "Banana"].every((t) => page.text.includes(t)));
  const filtered = await get(ann, "/search?typed=apple");
  ok("a query fills the parameter: text", filtered.text.includes("Apple pie") && filtered.text.includes("Apple tart") && !filtered.text.includes("Banana"));
  const both = await get(ann, "/search?typed=apple&kind=b");
  ok("... and a choice, together", both.text.includes("Apple tart") && !both.text.includes("Apple pie") && !both.text.includes("Banana"));
  const empty = await get(ann, "/search?typed=&kind=");
  ok("... an empty field is none: the filter is off", ["Apple pie", "Apple tart", "Banana"].every((t) => empty.text.includes(t)));
  const cards = (await get(ann, "/cards")).text.replace(/<!--.*?-->/gs, "");
  ok("a component's content is where its <Slot /> is, and a <Fill> goes to its place", /<h1[^>]*>Hello<\/h1><span[^>]*>n1<\/span><span[^>]*>body one<\/span><div class="actions"><span[^>]*>an action<\/span><\/div>/.test(cards), cards.replace(/\s+/g, " ").slice(cards.indexOf("<main"), cards.indexOf("<main") + 600));
  ok("... an optional parameter left out shows nothing", (cards.match(/class="muted"/g) ?? []).length === 1);
  ok("... a user's own variable called title is not captured by the component's title", cards.includes("<h1>outer card</h1><span class=\"\">outer</span>"));
  ok("... a component inside a component, with the user's content passed along", cards.includes("<h1>P!</h1><span class=\"\">inside the panel</span><span class=\"\">panel body</span>"));
} finally { app.stop(); }
process.exit(failed ? 1 : 0);
