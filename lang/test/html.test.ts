// Plain HTML in a compiled app: lowercase elements as written, their attributes (a Bool value
// shows a bare attribute when true, none leaves it out, an address keeps to safe schemes),
// custom elements, text with {values} and {code} among them, and a raw control filling a
// <Form>'s parameter; after the action, the page shows the change.
//   node lang/test/html.test.ts      (needs Go: run it where `go` is installed)
process.removeAllListeners("warning");
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApp } from "./go-app.ts";

const SRC = `
app demo { name "Demo"  actor Person }
entity Person { name: Text  site: Text?  pinned: Bool = false  bio: Text? }
entity Session { user: Person  token: Text }
identity session: Session.token from cookie "s"
permission read Person: true
layout l { <Main><Slot name=main /></Main> }
// Pins or unpins you.
action pin(pinned: Bool) { set actor.pinned = pinned }
// Notes it.
action note(text: Text, done: Bool) { set actor.bio = text  set actor.pinned = done }
action rename(name: Text) { set actor.name = name }
screen home {
  route "/"
  layout l
  <Main>
    <div class="card" data-name={actor.name} hidden={actor.pinned}>
      <p>Hello {actor.name}!</p>
      <a href={actor.site} title={actor.bio}>site</a>
      <object data={actor.site}></object>
      <my-widget aria-label="Mine"></my-widget><br>
      {if actor.pinned { <strong>Pinned</strong> } else { Not pinned }}
    </div>
    <Form action={note}>
      <Field name=text kind=textarea label="Note" />
      <Field name=done kind=checkbox label="Done" />
      <Submit label="Add" />
    </Form>
    <Form action={rename}>
      <Field name=name kind=text label="Name" placeholder="Your name" label_hidden />
      <Submit label="Rename" />
    </Form>
    <Form action={pin}>
      <input type="checkbox" name="pinned" value="true">
      <Submit label="Save" />
      <On ok stay />
    </Form>
  </Main>
}
`;
const dir = mkdtempSync(join(tmpdir(), "html-test-"));
writeFileSync(join(dir, "demo.crud"), SRC);
const app = await startApp(join(dir, "demo.crud"), 13841);
let failed = 0;
const ok = (name: string, cond: boolean, info?: unknown) => { console.log(`${cond ? "ok  " : "FAIL"} ${name}`); if (!cond) { failed++; console.log(typeof info === "string" ? info : JSON.stringify(info, null, 2)); } };
const row = (id: number, fields: Record<string, unknown>) => ({ id, seq: id, created: 1, updated: 1, fields });
try {
  await app.post("/_test/load", { clock: 1_000_000, seq: 3, rows: { Person: [row(1, { name: "Ada <&>", site: "javascript:alert(1)", pinned: false, bio: null })], Session: [row(2, { user: { ref: "Person", id: 1 }, token: "tok" })] } });
  const get = async () => (await fetch(app.base + "/", { headers: { Cookie: "s=tok" } })).text();
  const html = await get();
  const main = html.slice(html.indexOf("<main"), html.indexOf("</main>"));
  ok("an element as written, text with a {value}, escaped", main.includes("<p>Hello Ada &lt;&amp;&gt;!</p>"), main);
  ok("attributes: a value escaped, a false Bool left out", /<div class="card" data-name="Ada &lt;&amp;&gt;">/.test(main), main);
  ok("an address that isn't safe becomes #, an <object>'s data too; none leaves the attribute out", main.includes(`<a href="#">site</a>`) && main.includes(`<object data="#"></object>`), main);
  ok("a custom element and a void one", main.includes(`<my-widget aria-label="Mine"></my-widget><br>`), main);
  ok("{if …} among the content: its block's text", main.includes("Not pinned") && !main.includes("<strong>"), main);

  // fields follow HTML: a visible label first, unless label_hidden; a textarea without rows; a checkbox
  ok("a field's label shows, before its control; a textarea without rows", main.includes(`<span>Note</span><textarea name="text"></textarea></label>`), main);
  ok("label_hidden: read out, not shown", /<input type="text" name="name"[^>]*><span class="visually-hidden">Name<\/span>/.test(main), main);
  ok("a checkbox field: a false sent when unchecked, then the box, then its label", main.includes(`<input type="hidden" name="done" value="false"><input type="checkbox" name="done" value="true"><span>Done</span>`), main);
  const post = async (formHtml: string, set: Record<string, string>) => {
    const action = /action="([^"]+)"/.exec(formHtml)?.[1] ?? "";
    const body = new URLSearchParams();
    for (const m of formHtml.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)"/g)) body.append(m[1], m[2].replace(/&#34;/g, '"').replace(/&amp;/g, "&"));
    for (const [k, v] of Object.entries(set)) body.append(k, v);
    return fetch(app.base + action, { method: "POST", redirect: "manual", headers: { Cookie: "s=tok", Origin: app.base, "Content-Type": "application/x-www-form-urlencoded" }, body });
  };
  const noteForm = main.slice(main.indexOf("<form"), main.indexOf("</form>"));
  const unchecked = await post(noteForm, { text: "hi" });
  ok("an unchecked checkbox sends false: the action runs", unchecked.status < 400 && noteForm.includes(`action="/_do/note"`), { status: unchecked.status, text: await unchecked.text() });

  // the form: the runtime's signed field, and the raw checkbox for the parameter
  const form = main.slice(main.lastIndexOf("<form"), main.lastIndexOf("</form>"));
  const action = /action="([^"]+)"/.exec(form)?.[1] ?? "";
  const body = new URLSearchParams();
  for (const m of form.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)"/g)) body.set(m[1], m[2].replace(/&#34;/g, '"').replace(/&amp;/g, "&"));
  body.set("pinned", "true");
  const r = await fetch(app.base + action, { method: "POST", redirect: "manual", headers: { Cookie: "s=tok", Origin: app.base, "Content-Type": "application/x-www-form-urlencoded" }, body });
  ok("a raw checkbox in a <Form> fills its parameter", r.status < 400 && action === "/_do/pin", { status: r.status, action, text: await r.text() });
  const after = await get();
  const main2 = after.slice(after.indexOf("<main"), after.indexOf("</main>"));
  ok("the page shows the change: a true Bool attribute is bare, the block switches", /<div class="card" data-name="[^"]*" hidden>/.test(main2) && main2.includes("<strong>Pinned</strong>") && !main2.includes("Not pinned"), main2);
} finally { app.stop(); }
console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
