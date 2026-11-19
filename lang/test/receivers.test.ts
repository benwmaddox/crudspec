// Receiver calls and overloads: x.f(a) is the call f(x, a), for your functions and the built-ins
// alike, and either way of writing it is valid. One name may be declared for different
// first-parameter types (fn age(p: Person), fn age(p: Pet)): the first argument's type picks
// which runs, and a function of yours beside a built-in of the same name doesn't hide it.
//   node lang/test/receivers.test.ts
process.removeAllListeners("warning");
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "../parser.ts";
import { check } from "../check.ts";
import { typecheck } from "../types.ts";
import { proveAll } from "../invariants.ts";
import { startApp } from "./go-app.ts";

let failed = 0;
const ok = (what: string, pass: boolean, detail?: unknown) => { console.log(`${pass ? "ok  " : "FAIL"} ${what}`); if (!pass) { failed++; if (detail !== undefined) console.log("     ", JSON.stringify(detail)); } };

const HEAD = `app t { name "T" actor User }
entity User { name: Text  token: Text? }
identity login: User.token from cookie "login"
entity Person { name: Text  born: Date  note: Text = ""  score: Int = 0 }
entity Pet { name: Text  adopted: Date  note: Text = ""  score: Int = 0 }
policy person_rows: true for rows of Person
policy pet_rows: true for rows of Pet
policy user_rows: true for rows of User
`;
const findings = (src: string) => {
  const spec = parse(HEAD + src);
  return [...check(spec, { source: HEAD + src }), ...typecheck(spec).findings].filter((f: any) => f.severity === "error" || f.code === "DECL_UNUSED");
};
const strip = (x: any): any => (Array.isArray(x) ? x.map(strip) : x && typeof x === "object" ? Object.fromEntries(Object.entries(x).filter(([k]) => k !== "pos" && k !== "recv").map(([k, v]) => [k, strip(v)])) : x);
const bodyOf = (src: string, name: string) => strip(parse(HEAD + src).decls.find((d) => d.name === name)!.body);

// ---- the two ways of writing a call are one call
ok("x.f(a) is f(x, a): a built-in", JSON.stringify(bodyOf(`action a(p: Person) { callers people  set p.note = p.name.lower().trim() }`, "a")) === JSON.stringify(bodyOf(`action a(p: Person) { callers people  set p.note = trim(lower(p.name)) }`, "a")));
ok("... a function of yours, with more arguments", JSON.stringify(bodyOf(`fn tag(p: Person, s: Text): Text = s + p.name\naction a(p: Person) { callers people  set p.note = p.tag("x") }`, "a")) === JSON.stringify(bodyOf(`fn tag(p: Person, s: Text): Text = s + p.name\naction a(p: Person) { callers people  set p.note = tag(p, "x") }`, "a")));
ok("... on a field, a chain, and a row field in a query", findings(`query old(): Int = count(Person where .born.year() < 2000 and .name.lower().starts_with("a"))\naction a(p: Person) { callers people  set p.score = p.born.add_days(3).year() + old() }`).length === 0, findings(`fn old(): Int = count(Person where .born.year() < 2000 and .name.lower().starts_with("a"))\naction a(p: Person) { callers people  set p.score = p.born.add_days(3).year() + old() }`));
ok("a field is still a field: p.born without parentheses", findings(`action a(p: Person) { callers people  set p.score = p.born.year() + p.score }`).length === 0);

// ---- one name for different first-parameter types
const AGES = `fn age(p: Person): Int = p.born.years_between(today())
fn age(p: Pet): Int = p.adopted.days_between(today())
`;
const ages = parse(HEAD + AGES + `action a(p: Person, q: Pet) { callers people  set p.score = p.age() + age(q) }`);
const names = JSON.stringify(ages.decls.find((d) => d.name === "a")!.body).match(/"name":"age\w*"/g);
ok("the first argument's type picks the function, in either form", JSON.stringify(names) === JSON.stringify(['"name":"age__Person"', '"name":"age__Pet"']), names);
ok("... and nothing is reported", findings(AGES + `action a(p: Person, q: Pet) { callers people  set p.score = p.age() + age(q) }`).length === 0);
let f = findings(AGES + `action a(p: Person) { callers people  set p.score = age("x") }`);
ok("a first argument of another type is an error naming the types it's declared for", f.some((x: any) => x.code === "FN_OVERLOAD" && /age is declared for Person, Pet: not for text/i.test(x.message)), f);
f = findings(`fn age(p: Person): Int = 1\nfn age(q: Person): Int = 2\naction a(p: Person) { callers people  set p.score = p.age() }`);
ok("two of one name on the same type are declared twice", f.some((x: any) => x.code === "DUPLICATE" && /different first parameter types/.test(x.message)), f);
f = findings(AGES + `action a(p: Person) { callers people  set p.score = p.age(1) }`);
ok("an error about one of them uses the name you wrote", f.some((x: any) => /x\.age\(…\) takes 0 arguments after/.test(x.message)) && !f.some((x: any) => /__/.test(x.message)), f);
f = findings(AGES + `action a(p: Person) { callers people  set p.score = p.age() }`);
ok("one of them used nowhere is reported by its name and type", f.some((x: any) => x.code === "DECL_UNUSED" && /function age \(for Pet\)/.test(x.message)), f);
f = findings(`fn round(p: Pet): Text = "r " + p.name\naction a(p: Pet) { callers people  set p.note = p.round() + " " + text(round(2.5)) + " " + text(2.25.round(1)) }`);
ok("a function of yours beside a built-in of its name: each type gets its own", f.length === 0, f);

// ---- the proof and the compiled app see plain calls
const SRC = HEAD + AGES + `fn round(p: Pet): Text = "round " + p.name
fn shout(t: Text): Text = t.trim().upper() + "!"
invariant scores_small: all(.score <= 1000 for Pet where true)
action describe(p: Person) { callers people  set p.note = p.name.shout() + " " + text(p.age()) + " " + p.born.add_days(1).format_date("MM/DD") + " " + shout(p.name) }
action pets(pet: Pet) { callers people  set pet.note = text(pet.age()) + " " + pet.round() + " " + text(round(2.5)) + " " + text(1.25.round(1))  set pet.score = if pet.age() > 1000 { 1000 } else { pet.age() } }
layout l { <main id="main-content"><Slot name=main /></main> }
screen home { route "/"  layout l  require public  <Fill name=main><List of={Person where in_app(.born.year() < 2010)} as=p><p class="person">{p.name.lower()} {p.age()}</p></List></Fill> }
`;
const dir = mkdtempSync(join(tmpdir(), "receivers-"));
writeFileSync(join(dir, "app.crud"), SRC);
const proofs = await proveAll(join(dir, "app.crud"), { timeoutMs: 20000 });
const v = proofs.find((r: any) => r.where === "action pets");
ok("the prover reads an overloaded call and a receiver call (pets keeps scores_small)", v?.status === "proven", proofs.map((r: any) => `${r.where} ${r.status}`));
const app = await startApp(join(dir, "app.crud"), 13997);
const row = (id: number, f: any) => ({ id, seq: id, created: id, updated: id, fields: f });
const NOW = Date.UTC(2026, 10, 18, 15, 0, 0);
try {
  await app.post("/_test/load", { clock: NOW, rows: { Person: [row(1, { name: " Ana ", born: { date: "2000-11-18" }, note: "", score: 0 })], Pet: [row(1, { name: "Rex", adopted: { date: "2026-11-08" }, note: "", score: -5 })] } });
  let r = await app.post("/_test/run", { call: "describe", args: { p: { ref: "Person", id: 1 } }, actor: null, now: NOW });
  let d = (await app.post("/_test/dump", {})).rows;
  ok("the app runs receiver calls: your function, then built-ins in a chain", r.outcome === "ok" && d.Person[0].fields.note === "ANA! 26 11/19 ANA!", { r, note: d.Person[0].fields.note });
  r = await app.post("/_test/run", { call: "pets", args: { pet: { ref: "Pet", id: 1 } }, actor: null, now: NOW });
  d = (await app.post("/_test/dump", {})).rows;
  ok("... and overloads: Pet's age, your round beside the built-in", r.outcome === "ok" && d.Pet[0].fields.note === "10 round Rex 2 1.2" && d.Pet[0].fields.score === 10, { r, pet: d.Pet[0].fields });
  const html = await (await fetch(app.base + "/")).text();
  ok("a page uses them too", /<p class="person">\s*ana\s*26\s*<\/p>/.test(html), html.match(/<p class="person">[^]*?<\/p>/)?.[0]);
} finally { app.stop(); }
process.exit(failed ? 1 : 0);
