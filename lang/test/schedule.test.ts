// Schedules, in the compiled app over HTTP, driven by the test clock (/_test/clock runs what the
// new time makes due before it answers): a row runs once per time value; a moved time runs
// again; past_due skip leaves rows that were due before the deploy; a deleted row never runs;
// the where is read when the time comes; a daily schedule runs once per day in its zone, and
// only the latest of several missed days.
//   node lang/test/schedule.test.ts
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "../parser.ts";
import { check } from "../check.ts";
import { startApp } from "./go-app.ts";

let failed = 0;
const ok = (what: string, pass: boolean, detail?: unknown) => { console.log(`${pass ? "ok  " : "FAIL"} ${what}`); if (!pass) { failed++; if (detail !== undefined) console.log(JSON.stringify(detail).slice(0, 600)); } };
const errors = (src: string) => check(parse(src)).filter((f) => f.severity === "error");
const BASE = `
app t { name "T" actor User }
entity User { name: Text  token: Text? }
identity login: User.token from cookie "login"
`;
const SPEC = BASE + `
entity Reminder { text: Text  remind_at: Time?  sent: Int = 0  muted: Bool = false }
entity Room { name: Text  last_post: Time?  archived: Bool = false }
entity Log { what: Text }
schedule remind for r in Reminder where not r.muted at r.remind_at past_due fire { set r.sent = r.sent + 1 }
schedule archive for r in Room where not r.archived at r.last_post + 30 day past_due skip { set r.archived = true }
schedule morning every day at "08:00" in "America/New_York" { create Log { what: "morning" } }
action snooze(r: Reminder) { set r.remind_at = now + 1 h }
action post(r: Room) { set r.last_post = now }
action forget(r: Reminder) { delete r }
action mute(r: Reminder) { set r.muted = true }
action set_time(r: Reminder, at: Time) { set r.remind_at = at }
`;

// the checker
ok("the spec checks", !errors(SPEC).length, errors(SPEC));
ok("a schedule's body can't use the actor", errors(BASE + `entity N { at: Time? }\nschedule s for n in N at n.at past_due fire { require actor != none else forbidden }`).some((f) => f.code === "SCHEDULE_CONTEXT"));
ok("its time is a Time field of the row", errors(BASE + `entity N { at: Text? }\nschedule s for n in N at n.at past_due fire { }`).some((f) => f.code === "SCHEDULE_AT"));
ok("a zone must exist", errors(BASE + `schedule s every day at "08:00" in "Mars/Olympus" { }`).some((f) => f.code === "SCHEDULE_ZONE"));
let noPolicy = "";
try { parse(BASE + `entity N { at: Time? }\nschedule s for n in N at n.at { }`); } catch (e) { noPolicy = (e as Error).message; }
ok("rows already past due need a stated policy", noPolicy.includes("past_due fire"), noPolicy);

// the app
const dir = mkdtempSync(join(tmpdir(), "schedule-"));
writeFileSync(join(dir, "app.crud"), SPEC);
const app = await startApp(join(dir, "app.crud"), 13871);
try {
  const H = 3_600_000, DAY = 24 * H;
  const C0 = Date.UTC(2026, 0, 5, 12, 0);   // 07:00 in New York
  const t = (ms: number) => ({ time: ms, seq: 0 });
  const row = (id: number, fields: any) => ({ id, seq: id, created: C0 - DAY * 60, updated: C0 - DAY * 60, fields });
  await app.post("/_test/load", { clock: C0, rows: {
    Reminder: [row(1, { text: "soon", remind_at: t(C0 + H), sent: 0, muted: false }), row(2, { text: "overdue", remind_at: t(C0 - H), sent: 0, muted: false }), row(3, { text: "never", remind_at: null, sent: 0, muted: false }), row(4, { text: "deleted", remind_at: t(C0 + H), sent: 0, muted: false }), row(5, { text: "muted", remind_at: t(C0 + H), sent: 0, muted: false })],
    Room: [row(1, { name: "old", last_post: t(C0 - 40 * DAY), archived: false }), row(2, { name: "quiet", last_post: t(C0 - 29 * DAY), archived: false })],
  } });
  const dump = async () => (await app.post("/_test/dump", {})).rows;
  const f = (rows: any, e: string, id: number) => rows[e].find((r: any) => r.id === id)?.fields;
  const advance = (ms: number) => app.post("/_test/clock", { advance_ms: ms });
  const call = async (action: string, args: Record<string, string>) => {
    const r = await fetch(app.base + "/_do/" + action, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(args), redirect: "manual" });
    return r.headers.get("X-Crudspec-Outcome");
  };

  await advance(1);
  let d = await dump();
  ok("past_due fire: a row already due when deployed runs", f(d, "Reminder", 2).sent === 1, f(d, "Reminder", 2));
  ok("a row whose time hasn't come doesn't", f(d, "Reminder", 1).sent === 0);
  ok("past_due skip: a row due before the deploy doesn't run", f(d, "Room", 1).archived === false);
  ok("a period not yet reached doesn't run", (d.Log ?? []).length === 0, d.Log);

  ok("an action deletes a row", await call("forget", { r: "4" }) === "ok");
  ok("an action changes a row's condition", await call("mute", { r: "5" }) === "ok");
  await advance(2 * H);   // 09:00 in New York
  d = await dump();
  ok("its time comes: it runs once", f(d, "Reminder", 1).sent === 1, f(d, "Reminder", 1));
  ok("a row already run doesn't run again", f(d, "Reminder", 2).sent === 1);
  ok("a row with no time never runs", f(d, "Reminder", 3).sent === 0);
  ok("a deleted row never runs", !f(d, "Reminder", 4));
  ok("the where is read when the time comes", f(d, "Reminder", 5).sent === 0, f(d, "Reminder", 5));
  ok("the day's period runs once its time has passed", (d.Log ?? []).length === 1, d.Log);

  await advance(H);
  d = await dump();
  ok("nothing new: nothing runs", f(d, "Reminder", 1).sent === 1 && (d.Log ?? []).length === 1);
  ok("moving a row's time arms it again", await call("snooze", { r: "1" }) === "ok");
  await advance(2 * H);
  d = await dump();
  ok("... and it runs at the new time", f(d, "Reminder", 1).sent === 2, f(d, "Reminder", 1));

  await advance(3 * DAY);
  d = await dump();
  ok("a row after the deploy runs when its time comes (last post + 30 days)", f(d, "Room", 2).archived === true, f(d, "Room", 2));
  ok("missed days: only the latest runs", (d.Log ?? []).length === 2, d.Log);
  ok("a new post re-arms a room", await call("post", { r: "2" }) === "ok");

  // a datetime field: the browser's local time and its zone
  ok("a datetime form value binds", await call("set_time", { r: "3", at: "2026-01-20T08:00", at__tz: "America/Los_Angeles" }) === "ok");
  d = await dump();
  ok("... in the zone the browser sent", f(d, "Reminder", 3).remind_at?.time === Date.UTC(2026, 0, 20, 16, 0), f(d, "Reminder", 3));
  ok("an RFC 3339 value binds too", await call("set_time", { r: "3", at: "2026-01-21T09:30:00Z" }) === "ok" && f(await dump(), "Reminder", 3).remind_at?.time === Date.UTC(2026, 0, 21, 9, 30));
} finally { app.stop(); }
process.exit(failed ? 1 : 0);
