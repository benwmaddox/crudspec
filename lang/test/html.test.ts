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
screen home {
  route "/"
  layout l
  <Main>
    <div class="card" data-name={actor.name} hidden={actor.pinned}>
      <p>Hello {actor.name}!</p>
      <a href={actor.site} title={actor.bio}>site</a>
      <my-widget aria-label="Mine"></my-widget><br>
      {if actor.pinned { <strong>Pinned</strong> } else { Not pinned }}
    </div>
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
  ok("an address that isn't safe becomes #; none leaves the attribute out", main.includes(`<a href="#">site</a>`), main);
  ok("a custom element and a void one", main.includes(`<my-widget aria-label="Mine"></my-widget><br>`), main);
  ok("{if …} among the content: its block's text", main.includes("Not pinned") && !main.includes("<strong>"), main);

  // the form: the runtime's signed field, and the raw checkbox for the parameter
  const form = main.slice(main.indexOf("<form"), main.indexOf("</form>"));
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
