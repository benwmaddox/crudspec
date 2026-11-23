// A sign-in identity with a where (identity login: User.token from cookie "login" where .active):
// the where is read on the session's row (an account turned off is no one), and the session
// lookup's kept answers depend on what the where reads, worked out from it, not on anything at
// all. So signed-out pages are still kept whole, and a commit to what the where reads
// (deactivating someone) drops the kept answer: they're signed out at once.
//   node lang/test/identity-reads.test.ts          (NOCACHE=1: the same with the caches off)
process.removeAllListeners("warning");
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generate } from "../gogen/gen.ts";
import { startApp } from "./go-app.ts";

let failed = 0;
const ok = (what: string, pass: boolean, detail?: unknown) => { console.log(`${pass ? "ok  " : "FAIL"} ${what}`); if (!pass) { failed++; if (detail !== undefined) console.log("     ", JSON.stringify(detail)); } };

const SPEC = `app t { name "T"  actor User }
entity User { name: Text  token: Text?  active: Bool = true }
identity login: User.token from cookie "login" where .active
entity Note { title: Text }
policy note_rows: true for rows of Note
policy user_rows: true for rows of User
// turns an account off
action deactivate(u: User) { callers people  set u.active = false }
layout l { <main><Slot name=main /></main> }
screen home { route "/"  layout l  require public
  <Fill name=main>
    <span class="who">{actor.name.default("nobody")}</span>
    <List of={Note order by .title} as=n><span class="n">{n.title}</span></List>
  </Fill>
}
`;
const dir = mkdtempSync(join(tmpdir(), "identity-reads-"));
writeFileSync(join(dir, "app.crud"), SPEC);

const go = Object.values(generate(join(dir, "app.crud"))).join("\n");
ok("the lookup reads what its where reads (User), not anything", /u\.SessionReads = \[\]string\{"User"\}/.test(go), go.match(/u\.SessionReads = [^\n]*/)?.[0]);
const withFn = SPEC.replace(`where .active`, `where usable(it)`).replace(`entity Note`, `fn usable(u: User): Bool = u.active\nentity Note`);
writeFileSync(join(dir, "app.crud"), withFn);
ok("... and anything when it calls the spec's own function, which it doesn't follow", /u\.SessionReads = \[\]string\{"\*"\}/.test(Object.values(generate(join(dir, "app.crud"))).join("\n")));
writeFileSync(join(dir, "app.crud"), SPEC);

const app = await startApp(join(dir, "app.crud"), 14091, process.env.NOCACHE ? { env: { CRUDSPEC_NO_CACHE: "1" } } : {});
try {
  const row = (id: number, fields: Record<string, unknown>) => ({ id, seq: id, created: 100 + id, updated: 100 + id, fields });
  await app.post("/_test/load", { clock: 1000, rows: { User: [row(1, { name: "ada", token: "ta", active: true })], Note: [row(1, { title: "a" })] } });
  const hits = async () => (await app.post("/_test/cache-check", {})).page_hits as number;
  const page = async (cookie?: string) => await (await fetch(app.base + "/", { headers: cookie ? { Cookie: cookie } : {} })).text();
  const who = (html: string) => html.match(/<span class="who">([^<]*)<\/span>/)?.[1];
  await page();
  const h0 = await hits();
  await page();
  ok("a signed-out page is kept whole", (await hits()) === h0 + 1, { h0, now: await hits() });
  ok("ada, signed in, is herself", who(await page("login=ta")) === "ada");
  ok("... and again (the lookup's answer kept)", who(await page("login=ta")) === "ada");
  const out = await fetch(app.base + "/_do/deactivate", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Test-Actor": "User:1" }, body: new URLSearchParams({ u: "1" }), redirect: "manual" });
  ok("her account is turned off", out.headers.get("X-Crudspec-Outcome") === "ok");
  ok("... and she's signed out at once: the kept answer went with the commit", who(await page("login=ta")) === "nobody", who(await page("login=ta")));
} finally { app.stop(); rmSync(dir, { recursive: true, force: true }); }
process.exit(failed ? 1 : 0);
