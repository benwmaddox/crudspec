// Who may call an action or view: `agents no` withholds it from agents (describe, MCP, calls),
// `people no` keeps it from screens, API routes and channels. An action that manages browser
// sessions is withheld either way, and check asks the spec to say so.
//   node lang/test/callers.test.ts
process.removeAllListeners("warning");
import { parse } from "../parser.ts";
import { check } from "../check.ts";
import { describe } from "../describe.ts";

const base = `app demo { name "Demo"  actor Person }
entity Person { name: Text }
entity Session { user: Person  token: Text }
identity session: Session.token from cookie "session_token"
identity agent: Person from token
permission read Person: true
layout l { <main><slot name=main /></main> }
`;
let failed = 0;
const ok = (name: string, cond: boolean, info?: unknown) => { console.log(`${cond ? "ok  " : "FAIL"} ${name}`); if (!cond) { failed++; console.log(JSON.stringify(info, null, 2)); } };
const codes = (src: string) => check(parse(base + src)).map((f) => f.code);

ok("a people-no action a screen offers: PEOPLE_NO_OFFERED",
  codes(`action a() {\n  people no\n}\nscreen s { route "/s"  layout l <main><button action={a()} label="go" /></main> }`).includes("PEOPLE_NO_OFFERED"));
ok("a people-no view a screen lists: PEOPLE_NO_OFFERED",
  codes(`view v() {\n  people no\n  rows Person\n}\nscreen s { route "/s"  layout l <main><list of={v()} as=p><text>{p.name}</text></list></main> }`).includes("PEOPLE_NO_OFFERED"));
const agentOnly = codes(`action a() {\n  people no\n}`);
ok("a people-no action nothing offers: no finding, and no generated screen", !agentOnly.includes("PEOPLE_NO_OFFERED") && !agentOnly.includes("ACTION_UNREACHABLE"), agentOnly);
ok("agents no and people no together: CALLERS_NONE", codes(`action b() {\n  agents no\n  people no\n}`).includes("CALLERS_NONE"));
ok("people no without an agent identity: PEOPLE_NO_WITHOUT_AGENTS",
  check(parse(base.replace("identity agent: Person from token\n", "") + `action a() {\n  people no\n}`)).some((f) => f.code === "PEOPLE_NO_WITHOUT_AGENTS"));
ok("set twice: OPTION_REPEATED", (() => { try { parse(base + `action a() {\n  agents no\n  agents no\n}`); return false; } catch (e: any) { return e.code === "OPTION_REPEATED"; } })());

const signIn = `action sign_in(name: Text) {\n  create Session { user: the(Person where .name == name), token: "t" }\n}`;
ok("a session action that doesn't say agents no: AGENTS_NO_UNSTATED", codes(signIn).includes("AGENTS_NO_UNSTATED"));
ok("… and saying it settles it", !codes(signIn.replace("{\n", "{\n  agents no\n")).includes("AGENTS_NO_UNSTATED"));

const d = describe(parse(base + signIn + `\naction hidden() {\n  agents no\n}\nview quiet() {\n  agents no\n  rows Person\n}\naction open_one() {\n  people no\n}`));
const names = d.callables.map((c) => c.name);
ok("describe withholds agents-no and session callables, and keeps people-no ones",
  !names.includes("sign_in") && !names.includes("hidden") && !names.includes("quiet") && names.includes("open_one")
  && d.withheld.map((w) => `${w.name}:${w.stated}`).sort().join(",") === "hidden:true,quiet:true,sign_in:false", { names, withheld: d.withheld });

console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
