// A spec's own tests (docs/testing.md): the checks refuse a test that names what isn't there, and
// the runner, against the built app, passes a test that holds and fails one that doesn't, at the
// step that doesn't, saying why.
//   node lang/test/spec-tests.test.ts
process.removeAllListeners("warning");
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "../parser.ts";
import { check } from "../check.ts";
import { typecheck } from "../types.ts";
import { runTests } from "../spectest.ts";

let failed = 0;
const ok = (what: string, pass: boolean, detail?: unknown) => { console.log(`${pass ? "ok  " : "FAIL"} ${what}`); if (!pass) { failed++; if (detail !== undefined) console.log("     ", JSON.stringify(detail)); } };

const APP = `app t { name "T" actor User }
enum Kind { plain, urgent }
entity User { name: Text  token: Text?  unique (token) }
entity Note { owner: User  body: Text  kind: Kind = plain }
identity login: User.token from cookie "login"
policy pu: true for rows of User
policy pn: .owner == actor for rows of Note
// Writes a note.
action write(body: Text, kind: Kind?) { require actor != none else unauthenticated  create Note { owner: actor, body: body, kind: kind.default(plain) } as n  result n }
// Your notes.
view mine() { rows Note where .owner == actor }
query host_is(h: Text): Bool = request.host == h
`;
const codes = (tests: string) => { const s = parse(APP + tests); return [...check(s), ...typecheck(s).findings].filter((f) => f.severity === "error").map((f) => f.code); };

// ---- the checks
ok("a test that names what's there checks clean", codes(`test "fine" { create User { name: "A" } as a  run write("x", kind: urgent) by a as n  expect n.kind == urgent }`).length === 0, codes(`test "fine" { create User { name: "A" } as a  run write("x", kind: urgent) by a as n  expect n.kind == urgent }`));
ok("an unknown action: TEST_CALL", codes(`test "x" { run wrte("x") }`).includes("TEST_CALL"));
ok("a name the test didn't make: TEST_NAME", codes(`test "x" { run write("x") by bob }`).includes("TEST_NAME"));
ok("an unknown outcome: TEST_OUTCOME", codes(`test "x" { create User { name: "A" } as a  run write("x") by a expect forbiden }`).includes("TEST_OUTCOME"));
ok("an argument worked out: TEST_ARG", codes(`test "x" { create User { name: "A" } as a  run write(a.name) by a }`).includes("TEST_ARG"));
ok("an unknown field: TEST_FIELD", codes(`test "x" { create User { nme: "A" } as a }`).includes("TEST_FIELD"));
ok("rows of an action: TEST_ROWS", codes(`test "x" { create User { name: "A" } as a  run write("x") by a expect 1 row }`).includes("TEST_ROWS"));
ok("two tests of one name: TEST_DUPLICATE", codes(`test "x" { }\ntest "x" { }`).includes("TEST_DUPLICATE"));
ok("an expect is typed as code: a field the row hasn't", codes(`test "x" { create User { name: "A" } as a  expect a.nme == "A" }`).length > 0);

// ---- the runner, against the built app
const dir = mkdtempSync(join(tmpdir(), "crudspec-spectests-"));
writeFileSync(join(dir, "app.crud"), APP + `
test "notes are their writer's" {
  create User { name: "Ann" } as ann
  create User { name: "Bo" } as bo
  run write("hi") by ann as n
  run write("x") by none expect unauthenticated
  run mine() by bo expect 0 rows
  run mine() by ann expect 1 row
  expect n.body == "hi" and n.owner == ann and n.kind == plain
  wait Duration.minutes(5)
  expect host_is("wiki.example.com") on "Wiki.Example.com:8080"
}
test "a condition that doesn't hold fails" {
  create User { name: "Ann" } as ann
  run write("hi") by ann as n
  expect n.body == "nope"
  expect n.body == "hi"
}
test "an outcome that isn't the one expected fails" {
  create User { name: "Ann" } as ann
  run write("hi") by ann expect forbidden
}
test "a row count that isn't the one expected fails" {
  create User { name: "Ann" } as ann
  run write("hi") by ann
  run mine() by ann expect 3 rows
}
test "each test starts from an empty database" {
  expect count(Note where true) == 0 and count(User where true) == 0
}
test "a function's answer is a unit test" {
  expect host_is("x") == false
}
`);
try {
  const r = await runTests(join(dir, "app.crud"), { log: () => {} });
  const by = (n: string) => r.find((x) => x.name === n);
  ok("a test that holds passes", by("notes are their writer's")?.ok === true, by("notes are their writer's"));
  ok("a condition that doesn't hold fails at its line", by("a condition that doesn't hold fails")?.ok === false && by("a condition that doesn't hold fails")?.step === `expect n.body == "nope"`, by("a condition that doesn't hold fails"));
  ok("an unexpected outcome fails, saying which", /expected forbidden, got ok/.test(by("an outcome that isn't the one expected fails")?.message ?? ""), by("an outcome that isn't the one expected fails"));
  ok("an unexpected row count fails, saying how many", /expected 3 rows, got 1/.test(by("a row count that isn't the one expected fails")?.message ?? ""), by("a row count that isn't the one expected fails"));
  ok("each test starts from an empty database", by("each test starts from an empty database")?.ok === true, by("each test starts from an empty database"));
  ok("a test of conditions alone is a unit test, one that makes rows or runs actions an integration test", by("a function's answer is a unit test")?.kind === "unit" && by("each test starts from an empty database")?.kind === "unit" && by("notes are their writer's")?.kind === "integration", r.map((x) => [x.name, x.kind]));
  ok("unit tests run first", r.findIndex((x) => x.kind === "integration") > r.findLastIndex((x) => x.kind === "unit"), r.map((x) => x.kind));
} finally { rmSync(dir, { recursive: true, force: true }); }
process.exit(failed ? 1 : 0);
