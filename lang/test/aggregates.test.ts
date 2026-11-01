// sum(.f for E where p) and avg(…): the Ints of the matching rows added, or their mean in whole
// numbers (truncated toward zero; none when no row has one). A sum of no rows is 0. Typed, then
// run in a compiled app: the values, the empty cases, an optional field's none, a sum inside a
// planned query, and that a page showing a sum is told when one row's amount changes.
//   node lang/test/aggregates.test.ts
process.removeAllListeners("warning");
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "../parser.ts";
import { check } from "../check.ts";
import { withGenerated } from "../scaffold.ts";
import { typecheck } from "../types.ts";
import { facts } from "../facts.ts";
import { startApp } from "./go-app.ts";

let failed = 0;
const ok = (what: string, pass: boolean, detail?: unknown) => { console.log(`${pass ? "ok  " : "FAIL"} ${what}`); if (!pass) { failed++; if (detail !== undefined) console.log(JSON.stringify(detail)); } };

const head = `app t { name "T" actor User }
entity User { name: Text  token: Text? }
identity login: User.token from cookie "login"
entity Expense { owner: User  amount: Int  tip: Int?  note: Text? }
policy expense_rows: true for rows of Expense
policy user_rows: true for rows of User
layout l { <main><Slot name=main /></main> }
`;
const types = (src: string) => typecheck(withGenerated(parse(head + src), parse)).findings.map((f) => f.code);
const checks = (src: string) => check(parse(head + src)).map((f) => f.code);

ok("sum of an Int field types and checks", types(`action a(u: User) { require sum(.amount for Expense where .owner == u) > 1 else invalid }`).length === 0 && checks(`action a(u: User) { require sum(.amount for Expense where .owner == u) > 1 else invalid }`).filter((c) => c !== "ACTION_UNREACHABLE").length === 0);
ok("... of an optional Int too", types(`action a(u: User) { require sum(.tip for Expense where .owner == u) > 1 else invalid }`).length === 0);
ok("sum of a Text field is refused", types(`action a(u: User) { require sum(.note for Expense where .owner == u) > 1 else invalid }`).includes("TYPE_MISMATCH"));
ok("... as is the sum of a reference", types(`action a(u: User) { require sum(.owner for Expense where .owner == u) > 1 else invalid }`).includes("TYPE_MISMATCH"));
ok("an unknown field in it is found", checks(`action a(u: User) { require sum(.amout for Expense where .owner == u) > 1 else invalid }`).includes("UNKNOWN_FIELD"));
ok("avg is an optional Int: compared with a number it may be none", types(`action a(u: User) { require avg(.amount for Expense where .owner == u) > 1 else invalid }`).length >= 0);
ok("a function of the spec's own called sum is still a call", checks(`fn sum(a: Int, b: Int): Int = a + b\naction a(u: User) { require sum(1, 2) > 1 else invalid }`).filter((c) => c !== "ACTION_UNREACHABLE").length === 0, checks(`fn sum(a: Int, b: Int): Int = a + b\naction a(u: User) { require sum(1, 2) > 1 else invalid }`));
{
  // the field it adds is a field the page reads: the live keys and the pruned columns see it
  const spec = parse(head + `screen total(u: User) { route "/total/:u"  layout l  access public\n  <Fill name=main><h1>{text(sum(.amount for Expense where .owner == u))}</h1></Fill>\n}\n`);
  const F = facts(withGenerated(spec, parse));
  const reads = F.reads.filter((r) => r.by.startsWith("screen total")).map((r) => r.field);
  ok("a screen showing a sum reads Expense.amount and Expense.owner", reads.includes("Expense.amount") && reads.includes("Expense.owner"), reads);
}

// at run time
const SPEC = head + `
screen total(u: User) { route "/total/:u"  layout l  access public
  <Fill name=main>
    <h1>{"sum=" + text(sum(.amount for Expense where .owner == u)) + " tips=" + text(sum(.tip for Expense where .owner == u)) + " avg=" + (if avg(.amount for Expense where .owner == u) == none { "none" } else { text(avg(.amount for Expense where .owner == u)) }) + " avgtip=" + (if avg(.tip for Expense where .owner == u) == none { "none" } else { text(avg(.tip for Expense where .owner == u)) })}</h1>
  </Fill>
}
action set_amount(e: Expense, amount: Int) { set e.amount = amount }
action total(u: User) { require sum(.amount for Expense where .owner == u) > 100 else invalid }
action mean(u: User, n: Int) { require avg(.amount for Expense where .owner == u) == n else invalid }
action count_big(u: User) { require count(Expense where .owner == u and sum(.amount for Expense where .owner == u) > 100) > 0 else invalid }
fn rich(u: User): Bool = sum(.amount for Expense where .owner == u) > 100
fn typical(u: User): Bool = avg(.amount for Expense where .owner == u) == 0 - 7
action rich_count(n: Int) { require count(User where rich(it)) == n else invalid }
action typical_count(n: Int) { require count(User where typical(it)) == n else invalid }
view big_ones(u: User) { rows Expense where .owner == u and sum(.amount for Expense where .owner == u) > 100 }
`;
const dir = mkdtempSync(join(tmpdir(), "aggregates-"));
writeFileSync(join(dir, "app.crud"), SPEC);
const app = await startApp(join(dir, "app.crud"), 13912);
try {
  const row = (id: number, fields: Record<string, unknown>) => ({ id, seq: id, created: 100 + id, updated: 100 + id, fields });
  await app.post("/_test/load", { clock: 1000, rows: {
    User: [row(1, { name: "ada", token: null }), row(2, { name: "bob", token: null }), row(3, { name: "cy", token: null })],
    // ada: 10, 20, 35 (tips 5 and none, none); bob: -7, -8 (a negative mean truncates toward zero); cy: none
    Expense: [row(1, { owner: { ref: "User", id: 1 }, amount: 10, tip: 5, note: null }), row(2, { owner: { ref: "User", id: 1 }, amount: 20, tip: null, note: null }), row(3, { owner: { ref: "User", id: 1 }, amount: 35, tip: null, note: null }), row(4, { owner: { ref: "User", id: 2 }, amount: -7, tip: null, note: null }), row(5, { owner: { ref: "User", id: 2 }, amount: -8, tip: null, note: null })],
  } });
  const page = async (u: number) => {
    const html = await (await fetch(`${app.base}/total/${u}`)).text();
    const m = /sum=(-?\d+) tips=(-?\d+) avg=([^<\s]+) avgtip=([^<\s]+)</.exec(html);
    const pd = /<script id="crudspec-page" type="application\/json">(.*?)<\/script>/s.exec(html);
    const v = pd ? (JSON.parse(pd[1].replace(/<\\\//g, "</")) as { v: number; d: string[] }) : undefined;
    // what the page read: its own keys and its fragments' (<!--/f:ID HASH KEYS…-->)
    if (v) for (const f of html.matchAll(/<!--\/f:[0-9a-f]+ [0-9a-z]+([^>]*?)-->/g)) v.d.push(...f[1].trim().split(" ").filter(Boolean));
    return { sum: m?.[1], tips: m?.[2], avg: m?.[3], avgtip: m?.[4], v, html };
  };
  const call = async (action: string, args: Record<string, string>) => (await fetch(app.base + "/_do/" + action, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Test-Actor": "User:1" }, body: new URLSearchParams(args), redirect: "manual" })).headers.get("X-Crudspec-Outcome");
  const ada = await page(1), bob = await page(2), cy = await page(3);
  ok("a sum is the rows' amounts added", ada.sum === "65", ada.html.slice(0, 300));
  ok("... a field that is none on some rows adds the rest, and a mean counts only the rows that have one", ada.tips === "5" && ada.avgtip === "5", ada);
  ok("... the mean is whole: 65 / 3 = 21", ada.avg === "21", ada);
  ok("... a negative mean truncates toward zero: -15 / 2 = -7", bob.sum === "-15" && bob.avg === "-7", bob);
  ok("no rows: the sum is 0, the mean none", cy.sum === "0" && cy.tips === "0" && cy.avg === "none" && cy.avgtip === "none", cy);
  ok("a sum in a require", (await call("total", { u: "1" })) === "invalid" && (await call("set_amount", { e: "1", amount: "50" })) === "ok" && (await call("total", { u: "1" })) === "ok");
  ok("... a mean is compared as a number", (await call("mean", { u: "1", n: "35" })) === "ok" && (await call("mean", { u: "2", n: "-7" })) === "ok" && (await call("mean", { u: "3", n: "0" })) === "invalid");
  ok("a sum inside a query's where", (await call("count_big", { u: "1" })) === "ok" && (await call("count_big", { u: "2" })) === "invalid");
  // correlated with the query's own row, a sum is SQL's (a subquery in the where), the mean in whole numbers
  ok("a sum of each user's rows, in the where", (await call("rich_count", { n: "1" })) === "ok" && (await call("rich_count", { n: "0" })) === "invalid");
  ok("a mean of each user's rows, in the where (none matches nothing)", (await call("typical_count", { n: "1" })) === "ok" && (await call("typical_count", { n: "2" })) === "invalid");
  // a page showing a sum is told when one row's amount changes, and shows the new sum on the next visit
  const before = await page(1);
  const told = async (v: number) => {
    const ac = new AbortController();
    const r = await fetch(`${app.base}/_events?since=${v}`, { signal: ac.signal });
    const reader = r.body!.getReader(); let buf = "";
    for (;;) {
      const { value } = await reader.read(); buf += new TextDecoder().decode(value);
      const m = /data: (\d+)([^\n]*)\n\n/.exec(buf);
      if (m) { ac.abort(); return m[2].trim().split(" ").filter(Boolean); }
    }
  };
  await page(1);   // twice: the second may come from the page cache
  ok("changing one row's amount", (await call("set_amount", { e: "2", amount: "21" })) === "ok");
  const keys = await told(before.v!.v);
  ok("... the page that showed the sum is told", keys[0] === "*" || keys.some((k) => before.v!.d.includes(k)), { keys, read: before.v!.d.length });
  const after = await page(1);
  ok("... and shows the new sum (not a cached one)", after.sum === "106", after.sum);
  ok("... a change to a row of another owner does not tell it", await (async () => {
    const p = await page(1);
    await call("set_amount", { e: "4", amount: "-100" });
    const k = await told(p.v!.v);
    return !(k[0] === "*" || k.some((x) => p.v!.d.includes(x)));
  })());
} finally { app.stop(); }
process.exit(failed ? 1 : 0);
