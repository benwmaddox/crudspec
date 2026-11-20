// A row's address (entity … { address slug }): routes name a row by that field, not its id. The
// checks hold it to a required, unique Text field; in the app, links write the field, an address
// with it finds the row, and one naming no row (or an id) is not found.
//   node lang/test/address.test.ts      (needs Go)
process.removeAllListeners("warning");
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "../parser.ts";
import { check } from "../check.ts";
import { startApp } from "./go-app.ts";

let failed = 0;
const ok = (what: string, pass: boolean, detail?: unknown) => { console.log(`${pass ? "ok  " : "FAIL"} ${what}`); if (!pass) { failed++; if (detail !== undefined) console.log("     ", JSON.stringify(detail)); } };

const BASE = (entity: string) => `app t { name "T" }
${entity}
policy p: true for rows of Game
layout l { <main><Slot name=main /></main> }
// Renames a game.
action rename(g: Game, name: Text) { set g.name = name }
screen game(g: Game) { route "/g/:g"  layout l  require public  <Fill name=main><h1 class="n">{g.name}</h1><Link to={game(g)} class="self"><span>me</span></Link></Fill> }
`;
const codes = (entity: string) => check(parse(BASE(entity))).filter((f) => f.severity === "error").map((f) => f.code);
ok("address names a unique Text field: clean", codes(`entity Game { name: Text  slug: Text  unique (slug)  address slug }`).length === 0, codes(`entity Game { name: Text  slug: Text  unique (slug)  address slug }`));
ok("no such field: ADDRESS_FIELD", codes(`entity Game { name: Text  slug: Text  unique (slug)  address slg }`).includes("ADDRESS_FIELD"));
ok("an optional field: ADDRESS_FIELD", codes(`entity Game { name: Text  slug: Text?  unique (slug)  address slug }`).includes("ADDRESS_FIELD"));
ok("not unique alone: ADDRESS_UNIQUE", codes(`entity Game { name: Text  slug: Text  address slug }`).includes("ADDRESS_UNIQUE"));
ok("a field called address is still a field", codes(`entity Game { name: Text  address: Text }`).length === 0);

const dir = mkdtempSync(join(tmpdir(), "crudspec-address-"));
writeFileSync(join(dir, "app.crud"), BASE(`entity Game { name: Text  slug: Text  unique (slug)  address slug }`));
const app = await startApp(join(dir, "app.crud"), 14041);
try {
  await app.post("/_test/fixture", { rows: [{ entity: "Game", fields: { name: "Hollow Depths", slug: "hollow-depths" } }, { entity: "Game", fields: { name: "Ember", slug: "ember" } }] });
  const res = await fetch(app.base + "/g/hollow-depths"), html = await res.text();
  ok("an address with the slug finds the row", res.status === 200 && html.includes(`<h1 class="n">Hollow Depths</h1>`), res.status);
  ok("links write the slug, not the id", html.includes(`href="/g/hollow-depths"`), html.match(/class="self"[^>]*>|href="\/g\/[^"]*"/g));
  ok("the other row, by its slug", (await (await fetch(app.base + "/g/ember")).text()).includes(">Ember</h1>"));
  ok("a slug naming no row is not found", (await fetch(app.base + "/g/nowhere")).status === 404);
  ok("an id is not an address now", (await fetch(app.base + "/g/1")).status === 404);
  // an action (or an agent) may name the row by its address too, looked up as it's bound
  const run = async (args: any) => (await (await fetch(app.base + "/_test/run", { method: "POST", body: JSON.stringify({ call: "rename", args }) })).json()).outcome;
  ok("an action's row named by its slug", await run({ g: "ember", name: "Ember Crown" }) === "ok" && (await (await fetch(app.base + "/g/ember")).text()).includes(">Ember Crown</h1>"));
  ok("... or by its id, as forms send it", await run({ g: 1, name: "Hollow" }) === "ok");
  ok("... and a slug no row has is not found", await run({ g: "nowhere", name: "x" }) === "not_found");
} finally { app.stop(); rmSync(dir, { recursive: true, force: true }); }
process.exit(failed ? 1 : 0);
