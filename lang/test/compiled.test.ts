// What the parser makes of the sample apps, the compiler reads: each property of the syntax tree
// is named somewhere in the compiler (lang/gogen and the modules it uses), or is listed below with
// why it needn't be. A clause the compiler never reads does nothing in the app, though the spec
// says it does (API headers and location, a channel's interval, were found so).
//   node lang/test/compiled.test.ts
import { readFileSync } from "node:fs";
import { parse } from "../parser.ts";
import { readSpec } from "../source.ts";

// read by the checks only, or kept for messages: not meant to change the app
const NOT_COMPILED: Record<string, string> = {
  "entity.fields.writeOnly": "the deep check holds the app to it (WRITE_ONLY_READ)",
  "data.fields.writeOnly": "as an entity's",
  "entity.fields.searchable": "says which fields matches() searches (MATCHES_UNSEARCHABLE); no index yet",
  "data.fields.searchable": "as an entity's",
  "el.head.custom": "a web component's tag, for the checks",
  "view.live": "every list is live; updates live says so in the spec",
};

let failed = 0;
const ok = (what: string, pass: boolean, detail?: unknown) => { console.log(`${pass ? "ok  " : "FAIL"} ${what}`); if (!pass) { failed++; if (detail !== undefined) console.log(JSON.stringify(detail, null, 2)); } };
const compiler = ["gogen/gen.ts", "gogen/program.ts", "schema.ts", "rows.ts", "scaffold.ts", "describe.ts", "cost.ts"]
  .map((f) => { try { return readFileSync(new URL(`../${f}`, import.meta.url), "utf8"); } catch { return ""; } }).join("\n");
const seen = new Set<string>();
const walk = (x: any, kind: string): void => {
  if (!x || typeof x !== "object") return;
  if (Array.isArray(x)) { x.forEach((y) => walk(y, kind)); return; }
  const k = x.kind ?? kind;
  for (const [key, v] of Object.entries(x) as [string, any][]) {
    if (key === "pos" || key === "kind" || !/^[a-z_][A-Za-z_]*$/.test(key)) continue;
    seen.add(`${k}.${key}`);
    // a map of names to values (fields, named arguments, attributes, settings): its values, under it
    if (["fields", "named", "attrs", "props"].includes(key) && v && typeof v === "object" && !Array.isArray(v)) for (const w of Object.values(v)) walk(w, `${k}.${key}`);
    else walk(v, `${k}.${key}`);
  }
};
for (const app of ["apps/campfire", "apps/tasks", "apps/todomvc", "app3"]) walk(parse(readSpec(app)).decls, "decl");
const B = String.fromCharCode(92) + "b";
const unread = [...seen].filter((id) => {
  const key = id.split(".").pop()!;
  return !new RegExp(`[.?]${key}${B}|"${key}"|'${key}'|${B}${key}:|${B}${key},|{ *${key}${B}`).test(compiler);
});
ok("every property the parser makes is read by the compiler, or listed with why not", unread.every((id) => id in NOT_COMPILED), unread.filter((id) => !(id in NOT_COMPILED)));
ok("... and each listed one is still made and still unread (the list is current)", Object.keys(NOT_COMPILED).every((id) => unread.includes(id)), Object.keys(NOT_COMPILED).filter((id) => !unread.includes(id)));
process.exit(failed ? 1 : 0);
