// Who may call an action or view: `only people` withholds it from agents (describe, MCP, calls),
// `only api` keeps it from screens, API routes and channels. An action that manages browser
// sessions is withheld either way, and check asks the spec to say so.
//   node lang/test/callers.test.ts
process.removeAllListeners("warning");
import { parse } from "../parser.ts";
import { check } from "../check.ts";
import { describe } from "../describe.ts";
import { scaffold } from "../scaffold.ts";

const base = `app demo { name "Demo"  actor Person }
entity Person { name: Text }
entity Session { user: Person  token: Text }
identity session: Session.token from cookie "session_token"
identity agent: Person from token
permission read Person: true
layout l { <Main><Slot name=main /></Main> }
`;
let failed = 0;
const ok = (name: string, cond: boolean, info?: unknown) => { console.log(`${cond ? "ok  " : "FAIL"} ${name}`); if (!cond) { failed++; console.log(JSON.stringify(info, null, 2)); } };
const codes = (src: string) => check(parse(base + src)).map((f) => f.code);

ok("a people-no action a screen offers: PEOPLE_NO_OFFERED",
  codes(`action a() {\n  only api\n}\nscreen s { route "/s"  layout l <Main><Button action={a()} label="go" /></Main> }`).includes("PEOPLE_NO_OFFERED"));
ok("a people-no view a screen lists: PEOPLE_NO_OFFERED",
  codes(`view v() {\n  only api\n  rows Person\n}\nscreen s { route "/s"  layout l <Main><List of={v()} as=p><Text>{p.name}</Text></List></Main> }`).includes("PEOPLE_NO_OFFERED"));
const agentOnly = codes(`action a() {\n  only api\n}`);
ok("a people-no action nothing offers: no finding, and no generated screen", !agentOnly.includes("PEOPLE_NO_OFFERED") && !agentOnly.includes("ACTION_UNREACHABLE"), agentOnly);
ok("only people and only api together: CALLERS_NONE", codes(`action b() {\n  only people\n  only api\n}`).includes("CALLERS_NONE"));
ok("only api without an agent identity: PEOPLE_NO_WITHOUT_AGENTS",
  check(parse(base.replace("identity agent: Person from token\n", "") + `action a() {\n  only api\n}`)).some((f) => f.code === "PEOPLE_NO_WITHOUT_AGENTS"));
ok("set twice: OPTION_REPEATED", (() => { try { parse(base + `action a() {\n  only people\n  only people\n}`); return false; } catch (e: any) { return e.code === "OPTION_REPEATED"; } })());

const signIn = `action sign_in(name: Text) {\n  create Session { user: the(Person where .name == name), token: "t" }\n}`;
ok("a session action that doesn't say only people: AGENTS_NO_UNSTATED", codes(signIn).includes("AGENTS_NO_UNSTATED"));
ok("… and saying it settles it", !codes(signIn.replace("{\n", "{\n  only people\n")).includes("AGENTS_NO_UNSTATED"));

const d = describe(parse(base + signIn + `\naction hidden() {\n  only people\n}\nview quiet() {\n  only people\n  rows Person\n}\naction open_one() {\n  only api\n}`));
const names = d.callables.map((c) => c.name);
ok("describe withholds agents-no and session callables, and keeps people-no ones",
  !names.includes("sign_in") && !names.includes("hidden") && !names.includes("quiet") && names.includes("open_one")
  && d.withheld.map((w) => `${w.name}:${w.stated}`).sort().join(",") === "hidden:true,quiet:true,sign_in:false", { names, withheld: d.withheld });

const gen = scaffold(parse(base + `action agent_act() {
  only api
}
view agent_rows() {
  only api
  rows Person
}
action person_act() { }
view person_rows() { rows Person }`));
ok("default screens skip people-no actions and views, and keep the rest",
  !gen.includes("agent_act") && !gen.includes("agent_rows") && gen.includes("/_auto/actions/person_act") && gen.includes("/_auto/views/person_rows"), gen);

console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
