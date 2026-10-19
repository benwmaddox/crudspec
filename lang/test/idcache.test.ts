// The session lookup's cache (rt/idcache.go): an answer is kept only until a commit changes the
// sessions, so a signed-out or deleted session stops working at once.
//   node lang/test/idcache.test.ts
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApp } from "./go-app.ts";

let failed = 0;
const ok = (what: string, pass: boolean, detail?: unknown) => { console.log(`${pass ? "ok  " : "FAIL"} ${what}`); if (!pass) { failed++; if (detail !== undefined) console.log(JSON.stringify(detail)); } };
const SPEC = `
app t { name "T" actor User }
entity User { name: Text }
entity Session { user: User on delete cascade  token: Text = token(24)  unique (token) }
identity session: Session.token from cookie "s"
action drop_my_sessions() { require actor != none else forbidden  delete Session where .user == actor }
action rename(name: Text) { require actor != none else forbidden  set actor.name = name }
layout l { <main><slot name=main /></main> }
screen s { route "/"  layout l  access public
  <main>
    if actor != none { <text class="who">{actor.name}</text> } else { <text class="who">nobody</text> }
  </main>
}
`;
const dir = mkdtempSync(join(tmpdir(), "idcache-"));
writeFileSync(join(dir, "app.crud"), SPEC);
const app = await startApp(join(dir, "app.crud"), 13899);
try {
  const row = (id: number, fields: Record<string, unknown>) => ({ id, seq: id, created: 100, updated: 100, fields });
  await app.post("/_test/load", { clock: 1000, rows: { User: [row(1, { name: "Ada" })], Session: [row(1, { user: { ref: "User", id: 1 }, token: "tok-ada" })] } });
  const cookie = { Cookie: "s=tok-ada" };
  const who = async () => (await (await fetch(app.base + "/", { headers: cookie })).text()).match(/<span class="who">([^<]*)<\/span>/)?.[1];
  ok("signed in", (await who()) === "Ada");
  ok("... again (from the cache)", (await who()) === "Ada");
  const call = async (action: string, args: Record<string, string> = {}) => (await fetch(app.base + "/_do/" + action, { method: "POST", headers: { ...cookie, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(args), redirect: "manual" })).headers.get("X-Crudspec-Outcome");
  ok("a commit to another entity keeps the session (and the page shows the change)", (await call("rename", { name: "Ada L" })) === "ok" && (await who()) === "Ada L");
  ok("the sessions deleted", (await call("drop_my_sessions")) === "ok");
  ok("... the same cookie no longer signs in", (await who()) === "nobody", await who());
  await app.post("/_test/load", { clock: 2000, rows: { User: [row(1, { name: "Ada" })], Session: [row(1, { user: { ref: "User", id: 1 }, token: "tok-ada" })] } });
  ok("a test load starts the cache again", (await who()) === "Ada");
} finally { app.stop(); }
process.exit(failed ? 1 : 0);
