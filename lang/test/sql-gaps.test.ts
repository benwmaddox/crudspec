// Conditions the planner now makes SQL (docs/design/sql-first.md), each checked two ways: the
// generator leaves nothing of it to the app (inApp), and the compiled app answers as the language
// says, none included: a Date or Decimal compared (stored as integers), present(.f), text(.id),
// if c { a } else { b } (CASE), all(p for E where q) (NOT EXISTS), and the runtime's text functions
// (lower, contains, matches…), which SQL calls as the app's own Go (rt/sqlfuncs.go), Unicode included.
//   node lang/test/sql-gaps.test.ts
process.removeAllListeners("warning");
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generate, inApp } from "../gogen/gen.ts";
import { startApp } from "./go-app.ts";

let failed = 0;
const ok = (what: string, pass: boolean, detail?: unknown) => { console.log(`${pass ? "ok  " : "FAIL"} ${what}`); if (!pass) { failed++; if (detail !== undefined) console.log("     ", JSON.stringify(detail)); } };

const SPEC = `app t { name "T" actor User }
entity User { name: Text  token: Text?  admin: Bool = false  unique (token) }
identity v: User.token from cookie "t"
policy pu: true for rows of User
entity Item { name: Text  due: Date?  price: Decimal  note: Text?  out: Text = ""  tags: Int = 0 }
entity Tag { item: Item  ok: Bool = true }
policy pi: true for rows of Item
policy pt: true for rows of Tag
fn names(xs: list of Item): Text = join(list(.name for Item where it in xs order by created), ",")
action due_on(d: Date) { callers people  set actor.name = names(list(Item where .due == d)) }
action due_before(d: Date) { callers people  set actor.name = names(list(Item where .due < d)) }
action pricier(p: Decimal) { callers people  set actor.name = names(list(Item where .price >= p)) }
action noted() { callers people  set actor.name = names(list(Item where present(.note))) }
action unnoted() { callers people  set actor.name = names(list(Item where blank(.note))) }
action by_id(t: Text) { callers people  set actor.name = names(list(Item where text(.id) == t)) }
action mine() { callers people  set actor.name = names(list(Item where if actor.admin { true } else { .price < 5 })) }
fn tags_ok(i: Item): Bool = all(.ok for Tag where .item == i)
action all_ok() { callers people  set actor.name = names(list(Item where tags_ok(it))) }
entity Word { w: Text  body: RichText? }
policy pw: true for rows of Word
fn ws(xs: list of Word): Text = join(list(.w for Word where it in xs order by created), ",")
action has(t: Text?) { callers people  set actor.name = ws(list(Word where contains(lower(.w), lower(t)))) }
action starts(t: Text) { callers people  set actor.name = ws(list(Word where starts_with(upper(.w), t))) }
action trimmed(t: Text) { callers people  set actor.name = ws(list(Word where trim(.w) == t)) }
action search(q: Text) { callers people  set actor.name = ws(list(Word where matches(.body, words_only(q)))) }
`;
const dir = mkdtempSync(join(tmpdir(), "gaps-"));
writeFileSync(join(dir, "app.crud"), SPEC);
const go = generate(join(dir, "app.crud"))["app.go"];
ok("nothing of these conditions is left to the app", inApp().filter((x) => x.kind === "where").length === 0, inApp());
const hasSQL = (s: string) => go.includes(JSON.stringify(s).slice(1, -1));
ok("the text functions are SQL's calls of the runtime's own (lower(t) of the request worked out first, and bound)", hasSQL(`cs_contains(cs_lower(t0."w"), ?)`) && hasSQL(`cs_matches(t0."body", ?)`), go.match(/cs_\w+\([^)]*\)/g));

const app = await startApp(join(dir, "app.crud"), 14009);
const row = (id: number, f: any) => ({ id, seq: id, created: id, updated: 0, fields: f });
const ref = (e: string, id: number) => ({ ref: e, id });
try {
  await app.post("/_test/load", { clock: 0, rows: { User: [row(1, { name: "", token: "u", admin: false })], Item: [
    row(1, { name: "a", due: { date: "2026-11-19" }, price: { dec: "4.99" }, note: "x", out: "", tags: 0 }),
    row(2, { name: "b", due: { date: "2026-12-01" }, price: { dec: "5.00" }, note: "", out: "", tags: 0 }),
    row(3, { name: "c", due: null, price: { dec: "12.50" }, note: null, out: "", tags: 0 }),
  ], Tag: [row(1, { item: ref("Item", 1), ok: true }), row(2, { item: ref("Item", 2), ok: false }), row(3, { item: ref("Item", 2), ok: true })], Word: [
    row(1, { w: "École", body: { rich: "the quick brown fox" } }), row(2, { w: "  ecole ", body: { rich: "a fox_trot, quickly" } }), row(3, { w: "Straße", body: null }), row(4, { w: "   ", body: null }),
  ] } });
  const run = async (call: string, args: any = {}) => { await app.post("/_test/run", { call, args, actor: ref("User", 1), now: 0 }); return (await app.post("/_test/dump", {})).rows.User[0].fields.name; };
  ok("a Date ==: only that day (none is never equal)", (await run("due_on", { d: { date: "2026-11-19" } })) === "a");
  ok("a Date <: earlier days, and none isn't before anything", (await run("due_before", { d: { date: "2026-11-30" } })) === "a");
  ok("a Decimal >=: exact at the boundary (5.00 >= 5.00, 4.99 not)", (await run("pricier", { p: "5.00" })) === "b,c");
  ok("present(.note): there and not empty", (await run("noted")) === "a");
  ok("blank(.note): empty or none", (await run("unnoted")) === "b,c");
  ok("text(.id) == \"2\"", (await run("by_id", { t: "2" })) === "b");
  ok("if actor.admin { true } else { .price < 5 }: not an admin, so under 5 only", (await run("mine")) === "a");
  ok("all(.ok for Tag where .item == it): every tag ok, and no tags at all is all", (await run("all_ok")) === "a,c");
  ok("contains(lower(.w), lower(t)): Unicode lowering (ÉCOLE finds École), as Go's", (await run("has", { t: "ÉCOLE" })) === "École");
  ok("contains with none: lower(none) is \"\", which every text contains", (await run("has", { t: null })) === "École,  ecole ,Straße,   ");
  ok("starts_with(upper(.w), t): Go's upper (Straße is STRAßE)", (await run("starts", { t: "STRA" })) === "Straße");
  ok("trim(.w) == t", (await run("trimmed", { t: "ecole" })) === "  ecole ");
  ok("trim(.w) == \"\": the empty text SQL gets back is text, not NULL", (await run("trimmed", { t: "" })) === "   ");
  ok("matches(.body, words_only(q)): every word at a word's start, none of a missing body", (await run("search", { q: "Qui, fox!" })) === "École,  ecole ");
  ok("matches: \"trot\" is not at a word's start in fox_trot (_ is a word character)", (await run("search", { q: "trot" })) === "");
} finally { app.stop(); rmSync(dir, { recursive: true, force: true }); }
process.exit(failed ? 1 : 0);
