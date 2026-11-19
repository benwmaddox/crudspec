// Behaviors and declared elements (lang/behaviors.ts), as the checker and type pass see them: what
// each mistake is called. In a compiled app, in Chromium: lang/browser/behaviors.test.ts.
//   node lang/test/behaviors.test.ts
process.removeAllListeners("warning");
import { parse } from "../parser.ts";
import { check } from "../check.ts";
import { typecheck } from "../types.ts";
import { withGenerated } from "../scaffold.ts";
import { upgradeSyntax } from "../syntax-upgrade.ts";

let failed = 0;
const ok = (what: string, pass: boolean, detail?: unknown) => { console.log(`${pass ? "ok  " : "FAIL"} ${what}`); if (!pass) { failed++; if (detail !== undefined) console.log("     ", JSON.stringify(detail)); } };

const head = `app t { name "T" actor User }
enum Tone { calm, loud }
entity User { name: Text  token: Text?  age: Int = 0 }
identity login: User.token from cookie "login"
policy user_rows: true for rows of User
action rename(name: Text, done: Bool) { callers people  set actor.name = name }
layout l { <main><Slot name=main /></main> }
element tone-badge(tone: Tone, label: Text?, count: Int) from "tone-badge.js"
`;
const screen = (body: string) => `${head}screen s { route "/"  layout l  require public  <Fill name=main>${body}</Fill> }\n`;
const findings = (src: string) => {
  let spec;
  try { spec = parse(src); } catch (e: any) { return [{ code: e.code, message: e.message }]; }
  return [...check(spec), ...typecheck(withGenerated(spec, parse)).findings].filter((f: any) => f.severity !== "warning" || /^(BEHAVIOR|ELEMENT)/.test(f.code));
};
const codes = (src: string) => findings(src).map((f: any) => f.code);
const has = (src: string, code: string, text?: string) => findings(src).some((f: any) => f.code === code && (!text || f.message.includes(text)));

const GOOD = `<div cs:ref=box><textarea name="x"></textarea></div>
  <button type="button" cs:click={[prepend(box, "a"), append(box, "b"), focus(box), scroll_to(last(box))]}>x</button>
  <label tabindex="0" cs:dblclick={go("/")} cs:key_enter={go("/")} cs:key_arrowdown={focus(box)}>y</label>
  <button hidden cs:hidden_while_in_view={last(box)}>z</button>
  <tone-badge tone={calm} count={3} />
  <Form action={rename}><Field name=name kind=text cs:ref=nm cs:shown={focus(nm)} cs:key_escape={go("/")} cs:blur_unchanged={go("/")} /><Field name=done kind=checkbox /></Form>`;
ok("every behavior, a ref on plain HTML and on a <Field>, and a declared element: no errors", codes(screen(GOOD)).length === 0, findings(screen(GOOD)));

ok("a target no element names is BEHAVIOR_REF_UNKNOWN, with the name meant", has(screen(`<div cs:ref=composer></div><button cs:click={focus(composr)}>x</button>`), "BEHAVIOR_REF_UNKNOWN", "did you mean composer?"));
ok("a script given as text is BEHAVIOR_VALUE", has(screen(`<button cs:click={"alert(1)"}>x</button>`), "BEHAVIOR_VALUE", "a script can't be given as text"));
ok("an unknown action is BEHAVIOR_VALUE, with the one meant", has(screen(`<div cs:ref=b></div><button cs:click={focuss(b)}>x</button>`), "BEHAVIOR_VALUE", "did you mean focus?"));
ok("an action with the wrong arguments is BEHAVIOR_ARGS", has(screen(`<div cs:ref=b></div><button cs:click={prepend(b)}>x</button>`), "BEHAVIOR_ARGS"));
ok("a target that isn't a ref is BEHAVIOR_TARGET", has(screen(`<button cs:click={focus("box")}>x</button>`), "BEHAVIOR_TARGET"));
ok("a misspelled behavior is BEHAVIOR_UNKNOWN as it parses, with the one meant", has(screen(`<button cs:clik={go("/")}>x</button>`), "BEHAVIOR_UNKNOWN", "did you mean click?") && has(screen(`<input cs:key_esc={go("/")}>`), "BEHAVIOR_UNKNOWN", "key_escape"));
ok("... and on a <Field>", has(screen(`<Form action={rename}><Field name=name kind=text cs:shwon={go("/")} /></Form>`), "BEHAVIOR_UNKNOWN", "shown"));
ok("a behavior or ref without cs: is BEHAVIOR_PREFIX, saying how to write it", has(screen(`<button click={go("/")}>x</button>`), "BEHAVIOR_PREFIX", "write cs:click") && has(screen(`<div ref=box></div>`), "BEHAVIOR_PREFIX", "cs:ref") && has(screen(`<Form action={rename}><Field name=name kind=text shown={go("/")} /></Form>`), "BEHAVIOR_PREFIX", "cs:shown"));
ok("a misspelled bare behavior on HTML still points to the behavior", has(screen(`<button clik={go("/")}>x</button>`), "BEHAVIOR_UNKNOWN", "cs:click"));
{
  const before = screen(`<div ref=box></div><button type="button" click={focus(box)}>x</button><Form action={rename}><Field name=name kind=text ref=nm key_escape={go("/")} /><Field name=done kind=checkbox /></Form>`);
  const u = upgradeSyntax(before);
  ok("upgrade-syntax adds cs: to each, and the result reads as the same program", u.counts["cs: behaviors"] === 4 && u.text === before.replace(/ (ref|click|key_escape)=/g, " cs:$1=") && codes(u.text).length === 0, u);
}
ok("a behavior on another built-in is refused as it parses (UI_ATTR: behaviors go on plain HTML or a <Field>)", has(screen(`<Link to={s} label="x" cs:click={go("/")} />`), "UI_ATTR"));
ok("a behavior on a field people don't type in is BEHAVIOR_FIELD_KIND", has(screen(`<Form action={rename}><Field name=done kind=checkbox cs:ref=c /></Form>`), "BEHAVIOR_FIELD_KIND"));
ok("an onclick handler is still refused, pointing to the behavior", has(screen(`<button onclick="x()">x</button>`), "UI_HTML_HANDLER", "click={…}"));
ok("text a behavior puts in must be Text (TYPE_MISMATCH)", has(screen(`<div cs:ref=b></div><button cs:click={prepend(b, actor.age)}>x</button>`), "TYPE_MISMATCH", "prepend's text"));
ok("ref takes a name", has(screen(`<div cs:ref="box"></div>`), "UI_NAME"));

ok("a declared element's unknown attribute is ELEMENT_ATTR_UNKNOWN", has(screen(`<tone-badge tone={calm} count={1} colour="red" />`), "ELEMENT_ATTR_UNKNOWN", "it takes tone, label, count"));
ok("a required one missing is ELEMENT_ATTR_MISSING", has(screen(`<tone-badge tone={calm} />`), "ELEMENT_ATTR_MISSING", "count"));
ok("an attribute of the wrong type is TYPE_MISMATCH", has(screen(`<tone-badge tone={calm} count={actor.name} />`), "TYPE_MISMATCH", "<tone-badge>'s count"));
ok("a parameter an attribute can't carry is ELEMENT_PARAM_TYPE", has(`${head}element row-view(u: User) from "row-view.js"\n`, "ELEMENT_PARAM_TYPE"));
ok("an element's tag needs a hyphen (ELEMENT_NAME)", has(`${head}element badge() from "badge.js"\n`, "ELEMENT_NAME"));
ok("an element's script is a .js file beside the spec (ELEMENT_SCRIPT)", has(`${head}element my-x() from "../outside.js"\n`, "ELEMENT_SCRIPT"));
ok("an undeclared web component stays unchecked", codes(screen(`<other-thing whatever="1" />`)).length === 0);
ok("an app's own widget is gone: WIDGET_REMOVED", has(`${head}widget nudge(text: Text)\n`, "WIDGET_REMOVED"));
process.exit(failed ? 1 : 0);
