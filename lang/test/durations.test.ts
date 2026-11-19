// Durations compare by their length, typed or not, and a Time or Duration as text reads as one:
// Duration < and > were always false (rt.Num had no case for them: every duration counted as 0),
// and text(t) of a Time or a Duration was "[object Object]". In a compiled app.
//   node lang/test/durations.test.ts
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
entity Job { label: Text  took: Duration  at: Time  limit: Duration? }
policy job_rows: true for rows of Job
policy user_rows: true for rows of User
action over_hour(j: Job) { callers people  require j.took > 1 h else invalid  set j.label = "over" }
action under_limit(j: Job) { callers people  require j.limit != none and j.limit < 2 h else invalid  set j.label = "under" }
action equal_hour(j: Job) { callers people  require j.took == 2 h and j.took >= 2 h and j.took <= 2 h else invalid  set j.label = "equal" }
action show(j: Job) { callers people  set j.label = text(j.at) + " | " + text(j.took) }

`;
const dir = mkdtempSync(join(tmpdir(), "durations-"));
writeFileSync(join(dir, "app.crud"), SRC);
const app = await startApp(join(dir, "app.crud"), 13992);
const run = async (call: string, took: number, limit: number | null) => {
  const row = { id: 1, seq: 1, created: 1, updated: 1, fields: { label: "", took: { ms: took }, at: { time: 1_763_460_000_000, seq: 0 }, limit: limit === null ? null : { ms: limit } } };
  await app.post("/_test/load", { clock: 1_000_000, rows: { Job: [row] } });
  const r = await app.post("/_test/run", { call, args: { j: { ref: "Job", id: 1 } }, actor: null, now: 2_000_000 });
  return { outcome: r.outcome, label: (await app.post("/_test/dump", {})).rows.Job[0].fields.label };
};
try {
  const H = 3_600_000;
  ok("a typed Duration compares by length: 2 h > 1 h", (await run("over_hour", 2 * H, null)).outcome === "ok");
  ok("... and 30 min isn't > 1 h", (await run("over_hour", H / 2, null)).outcome === "invalid");
  ok("an optional Duration (untyped) compares too: 1 h < 2 h", (await run("under_limit", 0, H)).outcome === "ok");
  ok("... and 3 h isn't < 2 h", (await run("under_limit", 0, 3 * H)).outcome === "invalid");
  ok("==, >= and <= agree at the boundary", (await run("equal_hour", 2 * H, null)).outcome === "ok");
  const s = await run("show", 2 * H, null);
  ok("text of a Time is ISO 8601 in UTC, of a Duration as the language writes it", s.label === "2025-11-18T10:00:00.000Z | 2 h", s);
  const l = await run("show", 86_400_000 + 2 * H + 30 * 60_000 + 5_000 + 1, null);
  ok("a longer Duration lists each unit, largest first", l.label.endsWith(" | 1 day 2 h 30 min 5 s 1 ms"), l);
} finally { app.stop(); }
process.exit(failed ? 1 : 0);
