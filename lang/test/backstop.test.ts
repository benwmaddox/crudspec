// What the proofs can't settle, the app checks as it runs (gen.ts backstops, set by cli build): an
// action an invariant isn't proven for refuses a run that would break it; one it is proven for
// carries no check.
//   node lang/test/backstop.test.ts
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApp } from "./go-app.ts";
import { generate, setBackstops } from "../gogen/gen.ts";

let failed = 0;
const ok = (what: string, pass: boolean, detail?: unknown) => { console.log(`${pass ? "ok  " : "FAIL"} ${what}`); if (!pass) { failed++; if (detail !== undefined) console.log(JSON.stringify(detail)); } };
const SPEC = `
app t { name "T" actor User }
entity User { name: Text  token: Text? }
identity login: User.token from cookie "login"
entity Tag { name: Text }
policy tag_rows: true for rows of Tag
invariant loud: all(.name == upper(.name) for Tag where true)
action add_loud(n: Text) { create Tag { name: upper(n) } }
action add_mixed(n: Text) { create Tag { name: upper(n) + n } }
action add_none() { create Tag { name: "X" } }
layout l { <main><Slot name=main /></main> }
screen s { route "/"  layout l  access public  <List of={all_tags()} as=t><span class="t">{t.name}</span></List> }
view all_tags() { rows Tag where true order by .name }
`;
const dir = mkdtempSync(join(tmpdir(), "backstop-"));
writeFileSync(join(dir, "app.crud"), SPEC);
// what the build sets: the proofs can't follow upper(), so these two are unproven
setBackstops(new Set(["action add_loud|loud", "action add_mixed|loud"]));
const go = Object.values(generate(join(dir, "app.crud"))).join("\n");
setBackstops(new Set());
const fn = (name: string) => go.slice(go.indexOf(`func A_${name}(`), go.indexOf("\n}", go.indexOf(`func A_${name}(`)));
ok("an unproven action checks the invariant before it commits", /invariant loud would no longer hold/.test(fn("add_mixed")), fn("add_mixed"));
ok("a proven one carries no check", !/invariant loud/.test(fn("add_none")), fn("add_none"));
const app = await startApp(join(dir, "app.crud"), 13897);
try {
  const call = async (action: string, args: Record<string, string>) => (await fetch(app.base + "/_do/" + action, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(args), redirect: "manual" })).headers.get("X-Crudspec-Outcome");
  const names = async () => [...(await (await fetch(app.base + "/")).text()).matchAll(/<span class="t">([^<]*)<\/span>/g)].map((m) => m[1]).join(",");
  ok("a run that keeps it goes through", (await call("add_loud", { n: "ab" })) === "ok");
  ok("one that would break it is refused (invalid), and changes nothing", (await call("add_mixed", { n: "cd" })) === "invalid" && (await names()) === "AB", await names());
  ok("... the same action, kept by what it is given, goes through", (await call("add_mixed", { n: "EF" })) === "ok" && (await names()) === "AB,EFEF", await names());
} finally { app.stop(); }
process.exit(failed ? 1 : 0);
