// Decimal in a compiled app: exact (0.1 + 0.2 is 0.3), kept to a field's places (half-even as it's
// written), mixed with Int through to_decimal, divided by zero refused, rounded with round/floor/ceil, shown with its
// places on a page and as text, summed, and posted from a form.
//   node lang/test/decimals.test.ts
process.removeAllListeners("warning");
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApp } from "./go-app.ts";

let failed = 0;
const ok = (what: string, pass: boolean, detail?: unknown) => { console.log(`${pass ? "ok  " : "FAIL"} ${what}`); if (!pass) { failed++; if (detail !== undefined) console.log("     ", JSON.stringify(detail)); } };

const SRC = `app t { name "T" actor User }
entity User { name: Text  token: Text? }
identity login: User.token from cookie "login"
entity Item { name: Text  price: Decimal places 2  qty: Int = 1  rate: Decimal places 4 = 0.1 }
policy item_rows: true for rows of Item
policy user_rows: true for rows of User
fn line_total(i: Item): Decimal = i.price * to_decimal(i.qty)
action add(name: Text, price: Decimal, qty: Int) { callers people  create Item { name: name, price: price, qty: qty } }
action reprice(i: Item, factor: Decimal places 4) { callers people  require factor > 0 and factor <= 2.5 else invalid  set i.price = i.price * factor }
action halve(i: Item) { callers people  set i.price = i.price / 2 }
action split(i: Item, ways: Int) { callers people  set i.price = i.price / to_decimal(ways) }
action exact(i: Item) { callers people  require 0.1 + 0.2 == 0.3 else invalid  set i.rate = i.rate + 0.2 }
action label(i: Item) { callers people  set i.name = text(line_total(i)) + " " + text(round(i.price)) + " " + text(floor(i.price)) + " " + text(ceil(i.price)) + " " + text(i.qty % 2) + " " + text(round(i.price / 3, 2)) + " " + text(abs(0 - i.price)) + " " + text(max(i.price, 20)) }
layout l { <main id="main-content"><Slot name=main /></main> }
screen home {
  route "/"
  layout l
  require public
  <Fill name=main>
    <List of={Item where .price > 9.99 order by .price} as=i><p class="item">{i.name}: {i.price} x {i.qty} = {line_total(i)}</p></List>
    <p class="total">Total {sum(.price for Item where true)}, mean {avg(.price for Item where true)}</p>
    <Form action={add}><Field name=name kind=text /><Field name=price kind=number /><Field name=qty kind=number /><Submit label="Add" /></Form>
  </Fill>
}
`;
const dir = mkdtempSync(join(tmpdir(), "decimals-"));
writeFileSync(join(dir, "app.crud"), SRC);
const app = await startApp(join(dir, "app.crud"), 13993);
const row = (id: number, f: any) => ({ id, seq: id, created: id, updated: id, fields: f });
const load = (items: any[]) => app.post("/_test/load", { clock: 1_000_000, rows: { Item: items } });
const item = (id: number, price: string, qty = 1) => row(id, { name: `i${id}`, price: { dec: price }, qty, rate: { dec: "0.1000" } });
const run = (call: string, args: any) => app.post("/_test/run", { call, args, actor: null, now: 2_000_000 });
const field = async (f: string) => (await app.post("/_test/dump", {})).rows.Item[0].fields[f];
try {
  await load([item(1, "19.99", 3)]);
  let r = await run("reprice", { i: { ref: "Item", id: 1 }, factor: "1.1" });
  ok("19.99 × 1.1 = 21.989, kept to 2 places half-even: 21.99", r.outcome === "ok" && (await field("price"))?.dec === "21.99", { r, p: await field("price") });
  r = await run("reprice", { i: { ref: "Item", id: 1 }, factor: "3" });
  ok("a Decimal parameter's require compares exactly (3 > 2.5 refused)", r.outcome === "invalid", r);
  r = await run("reprice", { i: { ref: "Item", id: 1 }, factor: "abc" });
  ok("text that isn't a number refuses the call", r.outcome === "invalid", r);
  await load([item(1, "0.25")]);
  await run("halve", { i: { ref: "Item", id: 1 } });
  ok("0.25 / 2 = 0.125, kept half-even: 0.12", (await field("price"))?.dec === "0.12", await field("price"));
  await load([item(1, "0.35")]);
  await run("halve", { i: { ref: "Item", id: 1 } });
  ok("0.35 / 2 = 0.175, kept half-even: 0.18", (await field("price"))?.dec === "0.18", await field("price"));
  await load([item(1, "10.00")]);
  r = await run("split", { i: { ref: "Item", id: 1 }, ways: 0 });
  ok("dividing a Decimal by zero refuses the action, and changes nothing", r.outcome === "invalid" && /division by zero/.test(r.detail) && (await field("price"))?.dec === "10.00", { r, p: await field("price") });
  r = await run("exact", { i: { ref: "Item", id: 1 } });
  ok("0.1 + 0.2 == 0.3, and a 4-place field keeps 4", r.outcome === "ok" && (await field("rate"))?.dec === "0.3000", { r, rate: await field("rate") });
  await load([item(1, "10.50", 3)]);
  await run("label", { i: { ref: "Item", id: 1 } });
  ok("as text: the total, round (half-even), floor, ceil, %, round to places, abs, max with an Int", (await field("name")) === "31.50 10 10 11 1 3.50 10.50 20", await field("name"));
  await load([item(1, "9.99"), item(2, "25.00", 2), item(3, "10.00")]);
  const html = await (await fetch(app.base + "/")).text();
  const items = [...html.matchAll(/<p class="item">([^<]*)<\/p>/g)].map((m) => m[1]);
  ok("a page shows a Decimal with its places, filters (> 9.99) and orders by it", JSON.stringify(items) === JSON.stringify(["i3: 10.00 x 1 = 10.00", "i2: 25.00 x 2 = 50.00"]), items);
  const total = /<p class="total">([^<]*)<\/p>/.exec(html)?.[1];
  ok("sum and avg are exact Decimals", total === "Total 44.99, mean 15.00", total);
  // a form posts the price as text
  const form = /<form[^>]*action="([^"]+)"[^>]*>([\s\S]*?)<\/form>/.exec(html);
  const step = /name="price"[^>]*step="([^"]+)"|step="([^"]+)"[^>]*name="price"/.exec(form?.[2] ?? "");
  ok("a number field for a Decimal steps by its places (0.01)", (step?.[1] ?? step?.[2]) === "0.01", form?.[2]?.slice(0, 300));
} finally { app.stop(); }
process.exit(failed ? 1 : 0);
