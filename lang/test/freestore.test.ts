// apps/freestore: Freestore's rules, run at the times they're easy to get wrong (the evening of a
// month's last day, when it's already the next month in UTC; a bike's anniversary when the last
// one was finished late in the evening), and its invariants proven for every action.
//   node lang/test/freestore.test.ts
process.removeAllListeners("warning");
import { proveAll } from "../invariants.ts";
import { startApp } from "./go-app.ts";

let failed = 0;
const ok = (what: string, pass: boolean, detail?: unknown) => { console.log(`${pass ? "ok  " : "FAIL"} ${what}`); if (!pass) { failed++; if (detail !== undefined) console.log("     ", JSON.stringify(detail)); } };
const SPEC = "apps/freestore/freestore.crud";

const proofs = await proveAll(SPEC, { timeoutMs: 20000 });
const notProven = proofs.filter((r) => r.status !== "proven");
ok(`every invariant is proven for every action (${proofs.length} proofs)`, proofs.length === 30 && notProven.length === 0, notProven.map((r) => `${r.where} ${r.invariant}: ${r.status} ${r.reason ?? r.counterexample ?? ""}`));

const app = await startApp(SPEC, 13995);
const row = (id: number, f: any) => ({ id, seq: id, created: 0, updated: 0, fields: f });
const ET = (iso: string, behind: number) => Date.parse(iso + "Z") + behind * 3600_000;   // Eastern time, hours behind UTC
const run = (call: string, args: any, now: number) => app.post("/_test/run", { call, args, actor: null, now });
const dump = async () => (await app.post("/_test/dump", {})).rows;
const ref = (e: string, id: number) => ({ ref: e, id });
const base = (now: number, extra: any = {}) => app.post("/_test/load", { clock: now, rows: {
  Settings: [row(1, { shops_per_month: 1, bikes_enabled: true })],
  Household: [row(1, { name: "H", active: true, last_shopped: null })],
  Person: [row(1, { household: ref("Household", 1), name: "A", birthdate: { date: "2008-11-17" }, adult: false }), row(2, { household: ref("Household", 1), name: "B", birthdate: { date: "2026-02-28" }, adult: false })],
  Season: [row(1, { name: "Winter coat", start_month: 11, end_month: 2, adult_price: { dec: "12.00" }, child_price: { dec: "8.50" }, active: true })],
  Item: [row(1, { name: "Shirt", price: { dec: "1.10" } }), row(2, { name: "Winter coat", price: { dec: "0" } })],
  ...extra } });
try {
  // Oct 31, 8:30 pm EDT is Nov 1 in UTC; the household visited that morning
  const evening = ET("2026-10-31T20:30:00", 4);
  await base(evening, { Shop: [row(1, { household: ref("Household", 1), registered: { time: ET("2026-10-31T10:00:00", 4), seq: 0 }, month: { date: "2026-10-01" }, value: { dec: "0" } })] });
  let r = await run("register", { h: ref("Household", 1) }, evening);
  ok("Oct 31, 8:30 pm: still October in Cleveland, so a second visit is refused", r.outcome === "invalid", r);
  r = await run("give_seasonal", { sh: ref("Shop", 1), s: ref("Season", 1), p: ref("Person", 2), qty: 1 }, evening);
  ok("... and the Nov-Feb season hasn't started", r.outcome === "invalid", r);
  r = await run("register", { h: ref("Household", 1) }, ET("2026-11-01T09:00:00", 5));
  ok("Nov 1, 9 am: a new month, so the visit is allowed, and stored as November's", r.outcome === "ok" && (await dump()).Shop.some((s: any) => s.fields.month?.date === "2026-11-01"), r);
  // a bike finished Nov 17 2025 at 10 pm EST (Nov 18 in UTC)
  const noon = ET("2026-11-17T12:00:00", 5);
  await base(noon, { BikeRequest: [row(1, { person: ref("Person", 1), completed: { time: ET("2025-11-17T22:00:00", 5), seq: 0 } })] });
  r = await run("request_bike", { p: ref("Person", 1) }, noon);
  ok("a bike on the anniversary of the last one, in Cleveland's calendar", r.outcome === "ok", r);
  r = await run("request_bike", { p: ref("Person", 1) }, noon);
  ok("... and not a second while that one is open", r.outcome === "invalid", r);
  r = await run("grow_up", { p: ref("Person", 1) }, noon);
  ok("18 on the birthday itself", r.outcome === "ok", r);
  // money: exact, and at the price given
  await base(noon, { Shop: [row(1, { household: ref("Household", 1), registered: { time: noon, seq: 0 }, month: { date: "2026-11-01" }, value: { dec: "0" } })] });
  await run("give", { sh: ref("Shop", 1), item: ref("Item", 1), qty: 3 }, noon);
  await run("give_seasonal", { sh: ref("Shop", 1), s: ref("Season", 1), p: ref("Person", 2), qty: 1 }, noon);
  await run("set_price", { item: ref("Item", 1), price: "2.00" }, noon);
  await run("tally", { sh: ref("Shop", 1) }, noon);
  ok("a visit's value is exact and at the prices given: 3 x 1.10 + 8.50 = 11.80 (a later price change doesn't touch it)", (await dump()).Shop[0].fields.value.dec === "11.80", (await dump()).Shop[0]);
  r = await run("set_price", { item: ref("Item", 1), price: "-1.00" }, noon);
  ok("a negative price is refused", r.outcome === "invalid", r);
} finally { app.stop(); }
process.exit(failed ? 1 : 0);
