// UI_ROWS_SCREEN_ONLY: agents call an app's views, never its screens, so a list that keeps or
// orders rows on its own (where=, order=, desc, or a query of an entity) shows people what agents
// can't get. The warning asks for it in a view; apps without an agent identity aren't warned.
//   node lang/test/screen-rows.test.ts
process.removeAllListeners("warning");
import { parse } from "../parser.ts";
import { check } from "../check.ts";

const base = `app demo { name "Demo"  actor Person }
entity Person { name: Text  active: Bool = true }
identity session: Person.name from cookie "session"
identity agent: Person from token
policy person_rows: true for rows of Person
layout l { <main><Slot name=main /></main> }
// everyone
view people() { rows Person  order by .name }
`;
let failed = 0;
const ok = (name: string, cond: boolean, info?: unknown) => { console.log(`${cond ? "ok  " : "FAIL"} ${name}`); if (!cond) { failed++; console.log(JSON.stringify(info, null, 2)); } };
const screen = (list: string) => `screen s { route "/s"  layout l <Fill name=main>${list}<span>{p.name}</span></List></Fill> }`;
const found = (src: string, b = base) => check(parse(b + src)).filter((f) => f.code === "UI_ROWS_SCREEN_ONLY");

ok("a view's rows kept with where=: warned", found(screen(`<List of={people()} as=p where={p.active}>`)).length === 1);
ok("a view's rows reordered with order=: warned", found(screen(`<List of={people()} as=p order={p.name}>`)).length === 1);
ok("a view's rows reversed with desc: warned", found(screen(`<List of={people()} as=p desc>`)).length === 1);
const q = found(screen(`<List of={Person where .active} as=p>`));
ok("a list of an entity query: warned, naming the entity", q.length === 1 && q[0].message.includes("Person where"), q);
ok("a view listed as it is: not warned", found(screen(`<List of={people()} as=p>`)).length === 0);
ok("no agent identity: not warned", found(screen(`<List of={people()} as=p where={p.active}>`), base.replace("identity agent: Person from token\n", "")).length === 0);
ok("a view agents can't call (callers people): not warned",
  found(`// only people\nview quiet() {\n  callers people\n  rows Person\n}\n` + screen(`<List of={quiet()} as=p where={p.active}>`)).length === 0);

if (failed) { console.log(`${failed} failed`); process.exit(1); }
console.log("all passed");
