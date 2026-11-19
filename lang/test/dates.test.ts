// Date in a compiled app: a calendar day, with the app's time zone deciding which day an instant
// is (today(), date_of(t)), and the calendar rules a real app needs (the Freestore survey): age in
// months, "18 or older", "more than a year ago", a weekday, a month's first and last day, a day's
// bounds as times, durations between times, a date shown by a pattern, and a date posted by a form.
//   node lang/test/dates.test.ts
process.removeAllListeners("warning");
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApp } from "./go-app.ts";

let failed = 0;
const ok = (what: string, pass: boolean, detail?: unknown) => { console.log(`${pass ? "ok  " : "FAIL"} ${what}`); if (!pass) { failed++; if (detail !== undefined) console.log("     ", JSON.stringify(detail)); } };

const SRC = `app t { name "T" actor User  time_zone "America/New_York" }
entity User { name: Text  token: Text? }
identity login: User.token from cookie "login"
entity Person { name: Text  born: Date  note: Text = ""  adult: Bool = false  last_bike: Date? }
entity Shift { person: Person  check_in: Time  check_out: Time?  hours: Decimal places 2 = 0 }
policy person_rows: true for rows of Person
policy shift_rows: true for rows of Shift
policy user_rows: true for rows of User
fn age_months(p: Person): Int = months_between(p.born, today())
fn can_have_bike(p: Person): Bool = p.last_bike == none or p.last_bike < add_years(today(), -1)
action add(name: Text, born: Date) { callers people  create Person { name: name, born: born } }
action grow_up(p: Person) { callers people  require years_between(p.born, today()) >= 18 else invalid  set p.adult = true }
action describe(p: Person) { callers people
  set p.note = text(age_months(p)) + " mo; " + text(weekday(p.born)) + "; " + format_date(p.born, "MM/DD/YY") + "; " + format_date(start_of_month(p.born), "D") + "-" + format_date(end_of_month(p.born), "D") + "; " + text(add_months(p.born, 1)) + "; " + text(today()) + "; " + (if can_have_bike(p) { "bike" } else { "no bike" }) }
action check_out(s: Shift) { callers people  require s.check_out == none else invalid  set s.check_out = now  set s.hours = (now - s.check_in).in_hours() }
action stamp(p: Person) { callers people  set p.note = text(start_of_day(p.born)) + " " + text(end_of_day(p.born) - start_of_day(p.born)) }
layout l { <main id="main-content"><Slot name=main /></main> }
screen home {
  route "/"
  layout l
  require public
  <Fill name=main>
    <List of={Person where .born < date(2010, 1, 1) order by .born} as=p><p class="person">{p.name} {p.born}</p></List>
    <Form action={add}><Field name=name kind=text /><Field name=born kind=date /><Submit label="Add" /></Form>
  </Fill>
}
`;
const dir = mkdtempSync(join(tmpdir(), "dates-"));
writeFileSync(join(dir, "app.crud"), SRC);
const app = await startApp(join(dir, "app.crud"), 13998);
const row = (id: number, f: any) => ({ id, seq: id, created: id, updated: id, fields: f });
// 2026-11-18 03:00 UTC: in New York it is still the 17th
const NOW = Date.UTC(2026, 10, 18, 3, 0, 0);
const person = (born: string, bike: string | null = null) => row(1, { name: "Ana", born: { date: born }, note: "", adult: false, last_bike: bike ? { date: bike } : null });
const run = (call: string, args: any, now = NOW) => app.post("/_test/run", { call, args, actor: null, now });
const dump = async () => (await app.post("/_test/dump", {})).rows;
try {
  await app.post("/_test/load", { clock: NOW, rows: { Person: [person("2008-11-18", "2025-11-18")] } });
  let r = await run("grow_up", { p: { ref: "Person", id: 1 } });
  ok("18 years old on the 18th in New York's calendar, not yet on the 17th (UTC's 18th)", r.outcome === "invalid", r);
  r = await run("grow_up", { p: { ref: "Person", id: 1 } }, NOW + 6 * 3600_000);
  ok("... and 18 once it's the 18th there", r.outcome === "ok" && (await dump()).Person[0].fields.adult === true, r);
  await app.post("/_test/load", { clock: NOW, rows: { Person: [person("2024-01-31", "2025-11-01")] } });
  await run("describe", { p: { ref: "Person", id: 1 } });
  const note = (await dump()).Person[0].fields.note;
  // born 2024-01-31 (a Wednesday), on 2026-11-17 (New York): 33 months; Jan 31 + 1 month = Feb 29 2024
  ok("age in months, weekday, a pattern, the month's first and last day, add_months clamped, today, a year ago", note === "33 mo; 3; 01/31/24; 1-31; 2024-02-29; 2026-11-17; bike", note);
  await app.post("/_test/load", { clock: NOW, rows: { Person: [person("2024-01-31", "2025-11-18")] } });
  await run("describe", { p: { ref: "Person", id: 1 } });
  ok("a bike on 2025-11-18 isn't more than a year before 2026-11-17 (New York's today): none yet", ((await dump()).Person[0].fields.note as string).endsWith("no bike"));
  await app.post("/_test/load", { clock: NOW, rows: { Person: [person("2026-03-08")] } });
  await run("stamp", { p: { ref: "Person", id: 1 } });
  ok("a day's bounds are in the app's zone (the day clocks go forward is 23 hours)", (await dump()).Person[0].fields.note === "2026-03-08T05:00:00.000Z 22 h 59 min 59 s 999 ms", (await dump()).Person[0].fields.note);
  await app.post("/_test/load", { clock: NOW, rows: { Person: [person("2000-01-01")], Shift: [row(1, { person: { ref: "Person", id: 1 }, check_in: { time: NOW - 9_000_000, seq: 0 }, check_out: null, hours: { dec: "0" } })] } });
  r = await run("check_out", { s: { ref: "Shift", id: 1 } });
  ok("now - a time is a Duration; in_hours() of 2 h 30 min is 2.50", r.outcome === "ok" && (await dump()).Shift[0].fields.hours?.dec === "2.50", { r, s: (await dump()).Shift[0] });
  // the page and the form
  await app.post("/_test/load", { clock: NOW, rows: { Person: [row(1, { name: "Old", born: { date: "1990-05-01" } }), row(2, { name: "Young", born: { date: "2015-05-01" } })] } });
  const html = await (await fetch(app.base + "/")).text();
  const people = [...html.matchAll(/<p class="person">([^<]*)<\/p>/g)].map((m) => m[1]);
  ok("a page shows a Date as ISO, and filters by date(…)", JSON.stringify(people) === JSON.stringify(["Old 1990-05-01"]), people);
  const field = /<input type="date"[^>]*name="born"[^>]*>|<input type="date"[^>]*>/.exec(html)?.[0] ?? "";
  ok("a date field for a Date is a plain date input (no zone script)", /type="date"/.test(field) && !/data-ms/.test(field), field);
  r = await run("add", { name: "New", born: "2019-07-04" });
  ok("a date posted as text is a Date", r.outcome === "ok" && (await dump()).Person.some((p: any) => p.fields.born?.date === "2019-07-04"), r);
  r = await run("add", { name: "Bad", born: "07/04/2019" });
  ok("text that isn't a date refuses the call", r.outcome === "invalid", r);
} finally { app.stop(); }
process.exit(failed ? 1 : 0);
