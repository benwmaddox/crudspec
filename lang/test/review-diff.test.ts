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
layout l { <main><slot name=main /></main> }
`;
const OLD = BASE + `
action rename(t: Ticket, subject: Text) { require actor != none else forbidden  set t.subject = subject }
screen ticket(t: Ticket) { route "/t/:t"  layout l
  <main>
    <heading>{t.subject}</heading>
    <form action={rename(t)}><field name=subject kind=text /><submit label="Save" /><on forbidden flash="No" /></form>
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
// an export that writes a new column
{
  const ex = (cols: string) => parse(BASE + `view all_tickets() { rows Ticket where true }
export tickets { route "/tickets.csv"  format csv  of all_tickets() ${cols} }
`);
  const d = exposureDiff(ex(`"Subject": .subject`), ex(`"Subject": .subject, "Note": .note`));
  ok("an export's new column is reported", d.includes("export tickets now writes column Note"), d);
}
// a new schedule that runs for rows already due, on deploy
const withSched = parse(OLD.replace("entity Ticket { subject: Text  note: Text?  legacy: Text? }", "entity Ticket { subject: Text  note: Text?  legacy: Text?  due: Time? }")
  + `\nschedule nag for t in Ticket { at t.due + 1 day  if missed run set t.note = "late" }\n`);
db.exec(`ALTER TABLE "Ticket" ADD COLUMN due INTEGER; UPDATE "Ticket" SET due = 1000 WHERE id < 3`);
const first = scheduleFirstRuns(a, withSched, 1000 + 86_400_000, (sql) => Number(Object.values(db.prepare(sql).get() as object)[0]));
ok("a new past_due fire schedule says how many rows run on deploy", first.some((x) => x.includes("runs at once for 2 Ticket row(s)")), first);
// query costs, before and after (lang/cost.ts on each version's schema)
{
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { costReview } = await import("../review.ts");
  const dir = mkdtempSync(join(tmpdir(), "review-cost-"));
  const put = (name: string, src: string) => { const f = join(dir, name); writeFileSync(f, src); return f; };
  const Q = `
app t { name "T" actor User }
entity User { name: Text  token: Text? }
identity login: User.token from cookie "login"
entity Ticket { owner: User on delete cascade  subject: Text  status: Text }
permission read Ticket: true
view mine() { rows Ticket where .owner == actor }
`;
  const a = put("a.crud", Q);
  const b = put("b.crud", Q.replace("view mine() { rows Ticket where .owner == actor }", "view mine() { rows Ticket where .owner == actor }\nview open_ones() { rows Ticket where .status == \"open\" }"));
  const c = put("c.crud", Q.replace("view mine() { rows Ticket where .owner == actor }", "view mine() { rows Ticket where .subject == \"x\" }"));
  const same = await costReview(a, a);
  ok("the same spec: no cost change", !same.slower.length && !same.faster.length, same);
  const nw = await costReview(a, b);
  ok("a new view that reads every row: slower, marked new", nw.slower.some((x) => /^view open_ones \(new\) reads every Ticket row/.test(x)), nw);
  const ch = await costReview(a, c);
  ok("a view whose condition no index serves: slower", ch.slower.some((x) => /^view mine reads every Ticket row/.test(x)), ch);
  const back = await costReview(c, a);
  ok("... and back: faster", back.faster.some((x) => /^view mine no longer reads every Ticket row/.test(x)), back);
}

// who can see and change each field
{
  const { accessMatrix, accessDiff } = await import("../review.ts");
  const A = `
app t { name "T" actor User }
entity User { name: Text  token: Text?  admin: Bool = false  salary: Int = 0 }
identity login: User.token from cookie "login"
predicate is_admin(u: User?) = u != none and u.admin
action set_salary(u: User, n: Int) { require is_admin(actor) else forbidden  set u.salary = n }
layout l { <main><slot name=main /></main> }
screen people { route "/"  layout l  <list of={everyone()} as=p><text>{p.name}</text></list> }
view everyone() { rows User where true }
`;
  const m = accessMatrix(parse(A));
  ok("the matrix: who changes a field, with the action's requires", [...(m.get("User.salary")?.change ?? [])].some((x) => x === "action set_salary (is_admin(actor))"), [...(m.get("User.salary")?.change ?? [])]);
  ok("... who sees one, with the screen's access", [...(m.get("User.name")?.see ?? [])].some((x) => x === "screen people: signed in"), [...(m.get("User.name")?.see ?? [])]);
  const loose = accessDiff(m, accessMatrix(parse(A.replace("require is_admin(actor) else forbidden", "require actor != none else forbidden"))));
  ok("a loosened require: the field can now be changed by the action as it now is", loose.includes("User.salary can now be changed by action set_salary (actor != none)") && loose.includes("User.salary can no longer be changed by action set_salary (is_admin(actor))"), loose);
  const shown = accessDiff(m, accessMatrix(parse(A.replace("<text>{p.name}</text>", "<text>{p.name}</text><text>{p.salary}</text>"))));
  ok("a screen that now shows a field: it can now be seen there", shown.includes("User.salary can now be seen by screen people: signed in"), shown);
  ok("no change: nothing", accessDiff(m, accessMatrix(parse(A))).length === 0);
}
process.exit(failed ? 1 : 0);
