// default(x, fallback) and default(x): what none means, said in one call. The result is never
// none; one argument falls back on the kind's empty value (0, "", false). Checked by the type
// pass, run by the compiled app, and exact in the prover (an invariant that needs it is proven).
//   node lang/test/default.test.ts
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
const head = `app t { name "T" actor User }
entity User { name: Text  token: Text?  unique (token) }
identity v: User.token from cookie "t"
policy pu: true for rows of User
enum Status { open, done }
entity Item { owner: User  title: Text  note: Text?  n: Int = 0  m: Int?  price: Decimal = 0  cost: Decimal?  flag: Bool? status: Status?  on: Date?  out: Text = ""  total: Int = 0  amount: Decimal = 0 }
policy pi: true for rows of Item
fn want_int(x: Int): Int = x + 1
`;
const val = (e: string) => `view v(i: Item) { value ${e} }`;
const findings = (body: string) => { const src = head + body + "\n"; const s = parse(src); return [...check(s, { source: src }), ...typecheck(withGenerated(s, parse)).findings]; };
const errors = (body: string) => findings(body).filter((f: any) => f.severity === "error");
const has = (body: string, code: string, text?: string) => findings(body).some((f: any) => f.code === code && (!text || f.message.includes(text)));
const clean = (body: string) => { const e = errors(body); return e.length === 0 || (console.log("      ", JSON.stringify(e.map((x: any) => x.message))), false); };

ok("i.m.default(0) + 1, want_int(i.m.default(0)): fine, never none", clean(val(`i.m.default(0) + 1 + want_int(i.m.default(0))`)));
ok("one argument: 0, \"\" and false", clean(val(`i.m.default() + 1`)) && clean(val(`i.note.default() + "!"`)) && clean(val(`i.flag.default() or true`)) && clean(val(`i.cost.default() + i.price`)));
ok("... the empty value is written in, so later passes see two", (() => { const s = parse(head + val(`default(i.m)`) + "\n"); typecheck(withGenerated(s, parse)); let call: any; const walk = (x: any): void => { if (x && typeof x === "object") { if (x.kind === "call" && x.name === "default") call = x; Object.values(x).forEach(walk); } }; walk(s.decls); return call?.args?.length === 2 && call.args[1].value === 0; })());
ok("a kind with no empty value (a Date, an enum) needs a fallback: DEFAULT_NO_EMPTY", has(val(`i.on.default()`), "DEFAULT_NO_EMPTY") && has(val(`i.status.default()`), "DEFAULT_NO_EMPTY") && clean(val(`i.status.default(open)`)) && clean(val(`i.on.default(today())`)));
ok("a fallback of another kind: TYPE_MISMATCH", has(val(`i.m.default("none")`), "TYPE_MISMATCH", "default()'s fallback"));
ok("a fallback that may be none: TYPE_MAYBE_NONE", has(val(`i.m.default(i.m)`), "TYPE_MAYBE_NONE", "fallback may be none"));
ok("a whole-number literal stands for a Decimal fallback", clean(val(`i.cost.default(0) + i.price`)));
ok("default of a value that is never none: a warning", has(val(`i.n.default(0)`), "DEFAULT_NEVER_NONE"));
ok("the errors for none say default now", has(val(`i.m + 1`), "TYPE_OPTIONAL_ARITHMETIC", "n.default(0)") && has(val(`i.note + "!"`), "TYPE_MAYBE_NONE", `t.default("")`) && has(val(`want_int(i.m)`), "TYPE_MAYBE_NONE", "x.default(…)"));

// the prover reads it exactly: total = m with none as 0, so total >= 0 when m >= 0
const SPEC = head + `invariant totals_not_negative: all(.total >= 0 for Item where true)
action add(i: Item, k: Int?) { callers people  require k.default(0) >= 0 else invalid  set i.total = i.total + k.default(0) }
action add_note(i: Item, t: Text?) { callers people  set i.out = t.default("(none)") + "!" }
action add_cost(i: Item) { callers people  set i.amount = i.cost.default() + i.price }
`;
const dir = mkdtempSync(join(tmpdir(), "default-"));
writeFileSync(join(dir, "app.crud"), SPEC);
const proofs = await proveAll(join(dir, "app.crud"), { timeoutMs: 20000 });
ok("the prover reads default exactly: the invariant is proven for add", proofs.filter((r) => r.where === "action add").every((r) => r.status === "proven"), proofs.map((r) => `${r.where}: ${r.status} ${r.reason ?? r.counterexample ?? ""}`));
const mutant = join(mkdtempSync(join(tmpdir(), "default-m-")), "app.crud");
writeFileSync(mutant, SPEC.replace("require k.default(0) >= 0 else invalid  ", ""));
const broken = await proveAll(mutant, { timeoutMs: 20000 });
ok("... and without the guard, broken with a run", broken.some((r) => r.where === "action add" && r.status === "broken"), broken.map((r) => `${r.where}: ${r.status}`));

const app = await startApp(join(dir, "app.crud"), 14004);
const row = (id: number, f: any) => ({ id, seq: id, created: 0, updated: 0, fields: f });
const item = async () => (await app.post("/_test/dump", {})).rows.Item[0].fields;
try {
  await app.post("/_test/load", { clock: 0, rows: { User: [row(1, { name: "A", token: null })], Item: [row(1, { owner: { ref: "User", id: 1 }, title: "x", note: null, n: 0, m: null, price: { dec: "2.50" }, cost: null, flag: null, status: null, on: null, out: "", total: 5, amount: { dec: "0" } })] } });
  const run = (call: string, args: any) => app.post("/_test/run", { call, args: { i: { ref: "Item", id: 1 }, ...args }, actor: null, now: 0 });
  await run("add", { k: null });
  ok("the app: none adds 0", (await item()).total === 5, await item());
  await run("add", { k: 3 });
  ok("... and 3 adds 3", (await item()).total === 8, await item());
  await run("add_note", { t: null });
  ok("none text falls back on its fallback", (await item()).out === "(none)!", await item());
  await run("add_cost", {});
  ok("default() of a Decimal is 0: 0 + 2.50", (await item()).amount.dec === "2.50", await item());
} finally { app.stop(); rmSync(dir, { recursive: true, force: true }); }
process.exit(failed ? 1 : 0);
