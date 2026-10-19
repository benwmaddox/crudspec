// The change review's static parts: outcomes an action can now answer (and the forms that
// don't handle them), what screens read and views return, and the rows an upgrade touches.
//   node lang/test/review-diff.test.ts
import { DatabaseSync } from "node:sqlite";
import { parse } from "../parser.ts";
import { diff, schemaOf } from "../schema.ts";
import { dataAtRisk, exposureDiff, outcomesDiff, scheduleFirstRuns } from "../review.ts";

let failed = 0;
const ok = (what: string, pass: boolean, detail?: unknown) => { console.log(`${pass ? "ok  " : "FAIL"} ${what}`); if (!pass) { failed++; if (detail !== undefined) console.log(JSON.stringify(detail, null, 1).slice(0, 800)); } };
const BASE = `
app t { name "T" actor User }
entity User { name: Text  token: Text?  admin: Bool = false }
entity Ticket { subject: Text  note: Text?  legacy: Text? }
identity login: User.token from cookie "login"
layout l { <main><slot name="main" /></main> }
`;
const OLD = BASE + `
action rename(t: Ticket, subject: Text) { require actor != none else forbidden  set t.subject = subject }
screen ticket "/t/:t" (t: Ticket) layout l {
  <main>
    <heading>{t.subject}</heading>
    <form action={rename(t)}><field name="subject" kind="text" /><submit label="Save" /><on forbidden flash="No" /></form>
  </main>
}
`;
const NEW = OLD.replace("entity Ticket { subject: Text  note: Text?  legacy: Text? }", "entity Ticket { subject: Text  note: Text? }  drop Ticket.legacy")
  .replace("require actor != none else forbidden  set", "require actor != none else forbidden  require length(subject) > 2 else not_found  set")
  .replace("<heading>{t.subject}</heading>", "<heading>{t.subject}</heading>\n    <text>{t.note}</text>");

const a = parse(OLD), b = parse(NEW);
const outs = outcomesDiff(a, b);
ok("a new outcome is reported, with the form that doesn't handle it", outs.some((x) => x.startsWith("rename can now answer not_found; not handled by screen ticket")), outs);
ok("an outcome that was handled already isn't", !outs.some((x) => x.includes("forbidden")), outs);
const exp = exposureDiff(a, b);
ok("a field a screen now shows is reported", exp.includes("screen ticket now reads Ticket.note"), exp);
ok("no change, no exposure findings", exposureDiff(a, a).length === 0 && outcomesDiff(a, a).length === 0);

// rows at risk: the dropped field, counted in a database
const steps = diff(schemaOf(a), b, { User: new Set(["name", "token", "admin"]), Ticket: new Set(["subject", "note", "legacy"]) });
const db = new DatabaseSync(":memory:");
db.exec(`CREATE TABLE "Ticket" (id INTEGER, subject TEXT, note TEXT, legacy TEXT); INSERT INTO "Ticket" VALUES (1,'a',NULL,'x'),(2,'b',NULL,''),(3,'c',NULL,'y')`);
const risk = dataAtRisk(steps, (sql) => Number(Object.values(db.prepare(sql).get() as object)[0]));
ok("a dropped field counts the rows that have it set", risk.some((x) => x.includes("2 row(s) have Ticket.legacy set")), { steps, risk });
// a new schedule that runs for rows already due, on deploy
const withSched = parse(OLD.replace("entity Ticket { subject: Text  note: Text?  legacy: Text? }", "entity Ticket { subject: Text  note: Text?  legacy: Text?  due: Time? }")
  + `\nschedule nag for t in Ticket at t.due + 1 day past_due fire { set t.note = "late" }\n`);
db.exec(`ALTER TABLE "Ticket" ADD COLUMN due INTEGER; UPDATE "Ticket" SET due = 1000 WHERE id < 3`);
const first = scheduleFirstRuns(a, withSched, 1000 + 86_400_000, (sql) => Number(Object.values(db.prepare(sql).get() as object)[0]));
ok("a new past_due fire schedule says how many rows run on deploy", first.some((x) => x.includes("runs at once for 2 Ticket row(s)")), first);
process.exit(failed ? 1 : 0);
