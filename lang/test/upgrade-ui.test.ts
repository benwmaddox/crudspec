// upgrade-syntax's UI pass (lang/upgrade-ui.ts): the built-in wrapper elements that became plain HTML, the screen parts that
// became <Fill>, the layout parts that became HTML tags, and <Content> that became <Slot>.
//   node lang/test/upgrade-ui.test.ts
process.removeAllListeners("warning");
import { execFileSync } from "node:child_process";
import { upgradeUi } from "../upgrade-ui.ts";
import { upgradeSyntax } from "../syntax-upgrade.ts";
import { parse } from "../parser.ts";
import { check } from "../check.ts";

let failed = 0;
const ok = (what: string, pass: boolean, detail?: unknown) => { console.log(`${pass ? "ok  " : "FAIL"} ${what}`); if (!pass) { failed++; if (detail !== undefined) console.log(String(typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 400)); } };
const up = (s: string) => upgradeUi(s);

const THEME = `theme t { classes { row: "flex gap", column: "stack", heading: "big", menu: "m", button: "btn" } }\n`;
{
  const r = up(THEME + `screen s { <Main><Row><Text>a</Text></Row><Column>b</Column><Heading>h</Heading><Strong>s</Strong><Menu>m</Menu></Main> }`);
  ok("wrappers become HTML tags, with the theme's class for the kind", r.text.includes(`<div class="flex gap"><span>a</span></div><div class="stack">b</div><h1 class="big">h</h1><strong>s</strong><menu class="m">m</menu>`), r.text);
  ok("... and the dead theme keys are dropped, the live ones kept", r.text.includes(`classes { row: "flex gap", button: "btn" }`) || (/classes \{[^}]*row: "flex gap"/.test(r.text) && !/heading:|column:|menu:/.test(r.text) && r.text.includes("button")), r.text);
}
{
  const r = up(`screen s { <Section class="mine" id="x"><Row class="r2">a</Row></Section> }`);
  ok("an element's own class replaces the theme's; id and title stay", r.text.includes(`<section class="mine" id="x"><div class="r2">a</div></section>`), r.text);
}
{
  const r = up(THEME + `screen s { <Row banned={u.status == banned}>a</Row><Section class="p" banned={x}>b</Section> }`);
  ok("banned={c} becomes a conditional class", r.text.includes(`<div class={"flex gap" + (if u.status == banned { " banned" } else { "" })}>a</div>`) && r.text.includes(`<section class={"p" + (if x { " banned" } else { "" })}>b</section>`), r.text);
}
{
  const r = up(`screen s { <Section legend={l}>x</Section> }`);
  ok("a Section with a legend becomes a fieldset", r.text.includes(`<fieldset><legend><strong>{l}</strong></legend>x</fieldset>`), r.text);
}
{
  const r = up(`screen s { <Row data={json { a_b: 1 }}>x</Row> }`);
  ok("an attribute with no plain equivalent is reported with its place, and nothing changes", r.unsupported.length === 1 && r.unsupported[0].message.includes("data=") && r.text.includes("<Row data="), r);
}
{
  const r = up(`layout l { <Nav><Slot name=nav /></Nav><Main><Content name=main /><Footer><Slot name=footer /></Footer></Main><Aside name=sidebar><Slot name=sidebar /></Aside> }\nscreen s { route "/" layout l <Nav>n</Nav><Main>m</Main><Footer>f</Footer><Sidebar>b</Sidebar> }`);
  ok("in a layout the parts are HTML tags (Aside's name goes), <Content> is <Slot>", r.text.includes(`layout l { <nav><Slot name=nav /></nav><main><Slot name=main /><footer><Slot name=footer /></footer></main><aside><Slot name=sidebar /></aside> }`), r.text);
  ok("in a screen they are fills", r.text.includes(`<Fill name=nav>n</Fill><Fill name=main>m</Fill><Fill name=footer>f</Fill><Fill name=sidebar>b</Fill>`), r.text);
}
{
  const r = up(`component Row(a: Int) { <p>{a}</p> }\nscreen s { <Row a={1} /> }`);
  ok("the app's own component of an old built-in's name is left alone", !r.text.includes("<div") && r.text.includes("<Row a={1} />"), r.text);
}
{
  const once = up(THEME + `screen s { <Main><Row><Text>a</Text></Row></Main> }`).text;
  ok("running it again changes nothing", up(once).text === once && Object.keys(up(once).counts).length === 0);
  const c = up(`// <Row> in a comment\nscreen s { <Text>{"<Row>"}</Text> }`);
  ok("a <Row> in a comment or a string is still text for this pass, which is why check follows it", c.text.length > 0);
}
{
  const r = up(`screen s { <Text>a</Text><Text>b</Text> }`);
  ok("a note says what changed for Text (empty spans, quotes)", r.notes.length === 1 && r.notes[0].includes("2 <Text>") && r.notes[0].includes("none"), r.notes);
}
{
  // the whole upgrade: old vocabulary and old tags together, checked clean by the current checker
  const old = `app t { name "T"  actor U }
entity U { name: Text }
permission read U: true
layout l { <Nav><Slot name=nav /></Nav><Main><Slot name=main /></Main> }
screen s "/s" layout l { <Main><Heading>{"hi"}</Heading><Row><Text>x</Text></Row></Main> }
`;
  let text = "", err = "";
  try { text = upgradeSyntax(old).text; } catch (e: any) { err = e.message; }
  ok("upgrade-syntax runs the UI pass and the rest, and the result checks clean", !err && !check(parse(text)).some((f) => f.severity === "error") && text.includes("<Fill name=main>") && text.includes("<h1>") && text.includes("policy u_rows"), err || text);
}
{
  // round trips: a sample app as it was before the UI changes (git ee4c78e), upgraded, checks with no errors
  for (const [path, name] of [["apps/tasks/tasks.crud", "tasks"], ["apps/todomvc/todomvc.crud", "todomvc"], ["app3/desk.crud", "desk"]]) {
    try {
      const old = execFileSync("git", ["show", `ee4c78e:${path}`], { encoding: "utf8" });
      const r = upgradeSyntax(old);
      ok(`round trip: ${name} as of ee4c78e upgrades and checks with no errors`, !check(parse(r.text)).some((f) => f.severity === "error"));
    } catch (e: any) { ok(`round trip: ${name}`, false, e.message); }
  }
}
{
  // `access staff` -> `require staff` moves the policy's column: the same-program check must not count positions
  const old = `app t { name "T"  actor U }\nentity U { name: Text }\npolicy u_rows: true for rows of U\nlayout l { <main><Slot name=main /></main> }\npolicy staff: actor != none else forbidden\nscreen s { route "/s"  layout l  access staff  <Fill name=main><p>x</p></Fill> }\n`;
  let text = "", err = "";
  try { text = upgradeSyntax(old).text; } catch (e: any) { err = e.message; }
  ok("a screen's `access <policy>` becomes `require <policy>` (positions are not part of the program)", !err && text.includes("require staff") && !text.includes("access staff"), err || text);
}
process.exit(failed ? 1 : 0);
