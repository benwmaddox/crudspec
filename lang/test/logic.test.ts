// How a changed condition relates to the old one (lang/logic.ts): fewer cases, more, the same or
// others, by trying every assignment of the comparisons inside them.
//   node lang/test/logic.test.ts
import { parse } from "../parser.ts";
import { relate, logicDiff } from "../logic.ts";

let failed = 0;
const ok = (what: string, pass: boolean, detail?: unknown) => { console.log(`${pass ? "ok  " : "FAIL"} ${what}`); if (!pass) { failed++; if (detail !== undefined) console.log(JSON.stringify(detail, null, 2)); } };
const cond = (s: string) => parse(`fn p(a: Bool, b: Bool, c: Bool, x: Int, y: Int): Bool = ${s}`).decls[0].body;
const cases: [string, string, string][] = [
  ["a or b", "a", "fewer"],
  ["a", "a or b", "more"],
  ["a and b", "b and a", "same"],
  ["x == y", "y == x", "same"],
  ["x != y", "not (x == y)", "same"],
  ["a implies b", "not a or b", "same"],
  ["a", "true", "more"],
  ["a", "b", "other"],
  ["x > 3", "x > 5", "other"],
  ["a and (b or c)", "a and b or a and c", "same"],
  ["if a { b } else { c }", "a and b or not a and c", "same"],
  ["not (a and b)", "not a", "fewer"],
];
for (const [was, now, want] of cases) { const got = relate(cond(was), cond(now)); ok(`${was} -> ${now}: ${want}`, got === want, got); }

// in a spec: a predicate that admits more is wider; a gate that blocks fewer is too
const base = `app t { actor U }
entity U { name: Text  admin: Bool }
policy g: actor != none else unauthenticated for every action
fn boss(u: U): Bool = u.admin and u.name != ""
`;
const d = (next: string) => logicDiff(parse(base), parse(next));
ok("a predicate made to admit more: wider", d(base.replace(`u.admin and u.name != ""`, "u.admin")).widened);
ok("a predicate made to admit fewer: not wider", !d(base.replace(`u.admin and u.name != ""`, `u.admin and u.name != "" and u.name != "x"`)).widened);
ok("a policy made to demand more (blocks more): not wider", !d(base.replace("actor != none", `actor != none and actor.name != ""`)).widened);
ok("a policy made to demand less (blocks fewer): wider", d(base.replace("actor != none", "actor != none or true")).widened);
ok("nothing changed: nothing said", d(base).lines.length === 0, d(base).lines);
process.exit(failed ? 1 : 0);
