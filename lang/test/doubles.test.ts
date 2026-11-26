// Test doubles (docs/testing.md): in a spec test no extern reaches outside the app. `fake <extern>
// returns <value>` says what one gives for the rest of the test; one not faked gives none (a pure
// one runs as it is); `calls("name")` counts the test's calls. A run's workflows run in the test,
// before the next step, so what an action sets going is tested as the action is.
//   node lang/test/doubles.test.ts      (needs Go: on Windows, in WSL)
process.removeAllListeners("warning");
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "../parser.ts";
import { check } from "../check.ts";
import { typecheck } from "../types.ts";
import { runTests } from "../spectest.ts";

let failed = 0;
const ok = (what: string, pass: boolean, detail?: unknown) => { console.log(`${pass ? "ok  " : "FAIL"} ${what}`); if (!pass) { failed++; if (detail !== undefined) console.log("     ", JSON.stringify(detail)?.slice(0, 600)); } };

const APP = `app t { name "T" }
entity Sub { endpoint: Url  last: Text? }
policy subs: true for rows of Sub
extern fn web_push(endpoint: Url, p256dh: Text?, auth: Text?, title: Text, body: Text, path: Url, badge: Int): Text effect push
// Pings a subscription.
action ping(s: Sub) { emit Pinged(s) }
// Notes a subscription, pinging nobody.
action quiet(s: Sub) { set s.last = "quiet" }
after commit on Pinged(s) {
  step push:
    let r = call web_push(s.endpoint, none, none, title: "Hi", body: "there", path: "https://t.example.test/", badge: 1)
    if r == "expired" { delete s } else { set s.last = r }
}
`;
const codes = (tests: string) => { const s = parse(APP + tests); return [...check(s), ...typecheck(s).findings].filter((f) => f.severity === "error").map((f) => f.code); };

// ---- the checks
ok("a fake of an extern, with a value of its result's type, checks clean", codes(`test "x" { fake web_push returns "expired"  expect calls("web_push") == 0 }`).length === 0, codes(`test "x" { fake web_push returns "expired"  expect calls("web_push") == 0 }`));
ok("a fake of no extern: TEST_FAKE", codes(`test "x" { fake web_psh returns "x" }`).includes("TEST_FAKE"));
ok("a fake's value of another type is an error", codes(`test "x" { fake web_push returns 3 }`).length > 0);
ok("calls of no extern: TEST_CALLS", codes(`test "x" { expect calls("nope") == 0 }`).includes("TEST_CALLS"));
ok("calls outside a test: TEST_CALLS", codes(`fn n(): Int = calls("web_push")`).includes("TEST_CALLS"));

// ---- the runner, against the built app
const dir = mkdtempSync(join(tmpdir(), "crudspec-doubles-"));
writeFileSync(join(dir, "app.crud"), APP + `
test "an expired subscription is removed" {
  fake web_push returns "expired"
  create Sub { endpoint: "https://push.example.test/1" } as s
  run ping(s)
  expect count(Sub where true) == 0
  expect calls("web_push") == 1
}
test "a sent push is kept, with what it said" {
  fake web_push returns "sent"
  create Sub { endpoint: "https://push.example.test/1" } as s
  run ping(s)
  run ping(s)
  expect s.last == "sent"
  expect calls("web_push") == 2
}
test "an extern not faked gives none, and reaches nothing" {
  create Sub { endpoint: "https://push.example.test/1" } as s
  run ping(s)
  expect s.last != "sent" and count(Sub where true) == 1
  expect calls("web_push") == 1
}
test "a fake holds from its step on" {
  create Sub { endpoint: "https://push.example.test/1" } as s
  run ping(s)
  fake web_push returns "expired"
  run ping(s)
  expect count(Sub where true) == 0
}
test "counts start again in each test" {
  create Sub { endpoint: "https://push.example.test/1" } as s
  run quiet(s)
  expect calls("web_push") == 0
}
test "a wrong count fails" {
  create Sub { endpoint: "https://push.example.test/1" } as s
  run ping(s)
  expect calls("web_push") == 2
}
`);
try {
  const r = await runTests(join(dir, "app.crud"), { log: () => {} });
  const by = (n: string) => r.find((x) => x.name === n);
  for (const n of ["an expired subscription is removed", "a sent push is kept, with what it said", "an extern not faked gives none, and reaches nothing", "a fake holds from its step on", "counts start again in each test"])
    ok(n, by(n)?.ok === true, by(n));
  ok("a wrong count fails at its line", by("a wrong count fails")?.ok === false && by("a wrong count fails")?.step === `expect calls("web_push") == 2`, by("a wrong count fails"));
} finally { rmSync(dir, { recursive: true, force: true }); }
if (failed) { console.log(`${failed} FAILED`); process.exit(1); }
console.log("all passed");
