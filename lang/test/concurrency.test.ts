// Many requests at once: each holds a reader as its snapshot, and a page that links to rows named
// by an address (address slug) looks each address up beside it. Those lookups have readers of
// their own (DB.A): taken from the requests' pool, 32 requests at once held every reader and
// waited for another forever. Each page here links 600 teams, so each request holds its reader long
// enough for many to overlap, as a wiki page does.
//   node lang/test/concurrency.test.ts      (needs Go: on Windows, in WSL)
process.removeAllListeners("warning");
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApp } from "./go-app.ts";

let failed = 0;
const ok = (name: string, cond: boolean, info?: unknown) => { console.log(`${cond ? "ok  " : "FAIL"} ${name}`); if (!cond) { failed++; console.log(JSON.stringify(info)); } };

const dir = mkdtempSync(join(tmpdir(), "conc-"));
writeFileSync(join(dir, "app.crud"), `app c { name "C"  actor User }
entity User { name: Text }
entity Login { user: User  token: Text  unique (token) }
identity login: Login.token from cookie "login"
entity Team { slug: Text  name: Text  unique (slug)  address slug }
policy teams: true for rows of Team
layout l { <main><Slot name=main /></main> }
// The teams.
view teams() { rows Team order by .slug }
screen team_screen(team: Team) {
  route "/t/:team"
  layout l
  require public
  <Fill name=main><h1>{team.name}</h1><List of={teams()} as=t><Link to={team_screen(t)}><span>{t.name}</span></Link></List></Fill>
}
screen home {
  route "/"
  layout l
  require public
  <Fill name=main><p>Teams</p></Fill>
}
`);
const app = await startApp(join(dir, "app.crud"), 13961);
try {
  const teams = Array.from({ length: 600 }, (_, i) => ({ id: i + 1, seq: i + 1, created: 1, updated: 1, fields: { slug: `team-${i + 1}`, name: `Team ${i + 1}` } }));
  await app.post("/_test/load", { clock: 1000, seq: 601, rows: { Team: teams } });
  const one = await fetch(app.base + "/t/team-3");
  ok("a page named by an address, linking to rows by theirs", one.status === 200 && (await one.text()).includes("/t/team-600"), one.status);
  for (const n of [32, 96]) {
    const timeout = new Promise<string>((r) => setTimeout(() => r("timeout"), 20000));
    const all = Promise.all(Array.from({ length: n }, (_, i) => fetch(`${app.base}/t/team-${(i % 600) + 1}?n=${i}`).then((r) => r.status)));
    const got = await Promise.race([all, timeout]);
    ok(`${n} requests at once all answer (no reader is waited for forever)`, Array.isArray(got) && got.every((s) => s === 200), Array.isArray(got) ? got.filter((s) => s !== 200).length + " not ok" : got);
  }
  ok("... and the app still answers after", (await fetch(app.base + "/up")).status === 200);
} finally { app.stop(); }
console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
