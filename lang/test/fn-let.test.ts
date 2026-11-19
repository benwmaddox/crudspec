// A fn's body with lets: fn f(x: T): R { let a = … let b = … expression }. The parser puts each
// let's value where its name is used, so the checks, the type pass, the Go app and the prover see
// a plain expression; this checks the parsing, the mistakes it names, and the compiled app.
//   node lang/test/fn-let.test.ts
process.removeAllListeners("warning");
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "../parser.ts";
import { check } from "../check.ts";
import { typecheck } from "../types.ts";
import { withGenerated } from "../scaffold.ts";
import { proveAll } from "../invariants.ts";
import { startApp } from "./go-app.ts";

let failed = 0;
const ok = (what: string, pass: boolean, detail?: unknown) => { console.log(`${pass ? "ok  " : "FAIL"} ${what}`); if (!pass) { failed++; if (detail !== undefined) console.log("     ", JSON.stringify(detail)); } };

const SPEC = `app shop { name "Shop" actor User }
entity User { name: Text  token: Text? }
identity login: User.token from cookie "login"
policy all_users: true for rows of User
singleton Settings { per_month: Int = 2 }
entity Household { name: Text }
entity Visit { household: Household  month: Int }
policy all_households: true for rows of Household
policy all_visits: true for rows of Visit

query visits_left(h: Household, month: Int): Int {
  let used = count(Visit where .household == h and .month == month)
  let limit = Settings.per_month.default(0)
  max(limit - used, 0)
}
query status_line(h: Household, month: Int): Text {
  let left = h.visits_left(month)
  let word = if left == 1 { "visit" } else { "visits" }
  if left <= 0 { "No visits left this month" } else { "{left} {word} left" }
}
query can_visit(h: Household, month: Int): Bool { let used = h.visits_in(month)  let limit = Settings.per_month  used < limit }

query visits_in(h: Household, month: Int): Int = count(Visit where .household == h and .month == month)
invariant within_limit: all(visits_in(.household, .month) <= Settings.per_month for Visit where true)

action register(h: Household, month: Int) {
  callers people
  require h.can_visit(month) else invalid
  create Visit { household: h, month: month }
}
view status(h: Household, month: Int) { value h.status_line(month) }
`;
const findings = (src: string) => { try { const s = parse(src); return [...check(s, { source: src }), ...typecheck(withGenerated(s, parse)).findings]; } catch (e: any) { return [{ code: e.code, message: e.message, severity: "error" }]; } };
const has = (src: string, code: string, text?: string) => findings(src).some((f: any) => f.code === code && (!text || f.message.includes(text)));
const head = SPEC.slice(0, SPEC.indexOf("fn visits_left"));

const errors = findings(SPEC).filter((f: any) => f.severity === "error");
ok("lets in fn bodies, a let using an earlier one, and a one-line body: no errors", errors.length === 0, errors);
const spec = parse(SPEC);
const fn = spec.decls.find((d: any) => d.name === "visits_left") as any;
ok("a let's value is put where its name is used: nothing past the parser sees a let", !JSON.stringify(fn.body).includes('"used"') && JSON.stringify(fn.body).includes('"kind":"query"') && !JSON.stringify(spec.decls).includes('"kind":"let"'), fn.body);
ok("= expression still works", findings(`${head}fn two(h: Household): Int = 2\nview v(h: Household) { value h.two() }\n`).filter((f: any) => f.severity === "error").length === 0);

ok("a let nobody reads is LET_UNUSED", has(`${head}fn two(h: Household): Int { let x = 1  2 }\nview v(h: Household) { value h.two() }\n`, "LET_UNUSED", "let x in two"));
ok("a let named like a parameter is FN_LET_NAME", has(`${head}fn two(h: Household): Int { let h = 1  2 }\n`, "FN_LET_NAME", "has a parameter h"));
ok("a let given twice is FN_LET_NAME", has(`${head}fn two(h: Household): Int { let x = 1  let x = 2  x }\n`, "FN_LET_NAME", "given twice"));
ok("lets with no value after them is FN_BODY", has(`${head}fn two(h: Household): Int { let x = 1 }\n`, "FN_BODY", "ends with the value it gives"));
ok("a statement in a fn is FN_BODY: a fn changes nothing", has(`${head}fn two(h: Household): Int { set h.name = "x"  2 }\n`, "FN_BODY", "changes nothing"));
ok("two expressions is FN_BODY", has(`${head}fn two(h: Household): Int { 1 2 }\n`, "FN_BODY", "one expression"));
ok("a let used before it is given is an unknown name", findings(`${head}fn two(h: Household): Int { let a = b  let b = 1  a }\nview v(h: Household) { value h.two() }\n`).some((f: any) => f.severity === "error" && /\bb\b/.test(f.message)));
ok("a let's value is type-checked where it is used", has(`${head}fn two(h: Household): Int { let a = h.name  a + 1 }\nview v(h: Household) { value h.two() }\n`, "TYPE_MISMATCH"));

const proofs = await proveAll((() => { const d = mkdtempSync(join(tmpdir(), "fnlet-")); writeFileSync(join(d, "app.crud"), SPEC); return join(d, "app.crud"); })(), { timeoutMs: 20000 });
ok("the prover reads through the lets: the limit is proven for register", proofs.length > 0 && proofs.every((r) => r.status === "proven"), proofs.map((r) => `${r.where} ${r.invariant}: ${r.status} ${r.reason ?? r.counterexample ?? ""}`));

const dir = mkdtempSync(join(tmpdir(), "fnlet-app-"));
writeFileSync(join(dir, "app.crud"), SPEC);
const app = await startApp(join(dir, "app.crud"), 13996);
try {
  const row = (id: number, f: any) => ({ id, seq: id, created: 0, updated: 0, fields: f });
  await app.post("/_test/load", { clock: 0, rows: { Settings: [row(1, { per_month: 2 })], Household: [row(1, { name: "H" })], Visit: [row(1, { household: { ref: "Household", id: 1 }, month: 11 })] } });
  const run = (call: string, args: any) => app.post("/_test/run", { call, args, actor: null, now: 0 });
  let r = await run("register", { h: { ref: "Household", id: 1 }, month: 11 });
  ok("the compiled app: one visit left, so a second is allowed", r.outcome === "ok", r);
  r = await run("register", { h: { ref: "Household", id: 1 }, month: 11 });
  ok("... and a third is refused", r.outcome === "invalid", r);
  const rows = (await app.post("/_test/dump", {})).rows;
  ok("two visits stored", rows.Visit.length === 2, rows.Visit);
} finally { app.stop(); rmSync(dir, { recursive: true, force: true }); }
process.exit(failed ? 1 : 0);
