// What an operator runs an app with: /up (the database answers), /_metrics (administrators only:
// requests by kind and status, page time, the page cache's hits, nothing a request carried),
// agent limits that depend on the caller, and `app backup` (a copy made while the app runs).
//   node lang/test/ops.test.ts      (needs Go: on Windows, in WSL)
process.removeAllListeners("warning");
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { startApp } from "./go-app.ts";

let failed = 0;
const ok = (name: string, cond: boolean, info?: unknown) => { console.log(`${cond ? "ok  " : "FAIL"} ${name}`); if (!cond) { failed++; console.log(typeof info === "string" ? info : JSON.stringify(info)); } };

const dir = mkdtempSync(join(tmpdir(), "ops-"));
writeFileSync(join(dir, "app.crud"), `app ops { name "Ops"  actor User  admin actor.admin
  agent_writes_per_minute if actor != none and actor.admin { 50 } else { 2 }
}
entity User { name: Text  admin: Bool = false }
entity Login { user: User  token: Text  unique (token) }
entity Note { text: Text }
identity login: Login.token from cookie "login"
identity agent: User from token
policy rows: true for rows of Note
policy users: true for rows of User
layout l { <main><Slot name=main /></main> }
// Adds a note.
action add(text: Text) { require actor != none else unauthenticated  create Note { text: text } as n  result n }
// The notes.
view notes() { rows Note order by created }
screen home {
  route "/"
  layout l
  require public
  <Fill name=main><List of={notes()} as=n><p>{n.text}</p></List></Fill>
}
`);
const port = 13951;
const app = await startApp(join(dir, "app.crud"), port);
try {
  await app.post("/_test/load", { clock: 1000, seq: 3, rows: {
    User: [{ id: 1, seq: 1, created: 1, updated: 1, fields: { name: "Root", admin: true } }, { id: 2, seq: 2, created: 1, updated: 1, fields: { name: "Bo", admin: false } }],
    Login: [{ id: 1, seq: 3, created: 1, updated: 1, fields: { user: { ref: "User", id: 1 }, token: "root-login" } }, { id: 2, seq: 3, created: 1, updated: 1, fields: { user: { ref: "User", id: 2 }, token: "bo-login" } }],
  } });
  const up = await fetch(app.base + "/up");
  ok("/up: the database answers, and it isn't cached", up.status === 200 && (await up.text()) === "ok" && up.headers.get("cache-control") === "no-store", up.status);

  for (let i = 0; i < 3; i++) await fetch(app.base + "/?q=someone%40example.test");
  await fetch(app.base + "/nowhere");
  const anon = await fetch(app.base + "/_metrics");
  const bo = await fetch(app.base + "/_metrics", { headers: { cookie: "login=bo-login" } });
  ok("/_metrics: not found for anyone but an administrator", anon.status === 404 && bo.status === 404, [anon.status, bo.status]);
  const m = await fetch(app.base + "/_metrics", { headers: { cookie: "login=root-login" } });
  const text = await m.text();
  const j = JSON.parse(text || "{}");
  ok("/_metrics: for an administrator, requests by kind and status", m.status === 200 && j.by_kind?.page >= 4 && j.by_status?.["200"] >= 3 && j.by_status?.["404"] >= 1 && m.headers.get("cache-control") === "no-store", j);
  ok("... page times and the page cache's hits", j.page_ms?.p50 > 0 && j.page_ms_of >= 3 && j.page_cache_hits + j.page_cache_miss >= 3, j);
  ok("... and nothing a request carried (no query, no address)", !/example\.test|nowhere|q=/.test(text), text);

  // agent limits by caller: the administrator 50 writes a minute, anyone else 2
  const token = async (id: number) => (await app.post("/_test/agent_token", { entity: "User", id })).token;
  const call = async (t: string) => (await fetch(app.base + "/_agent/call/add", { method: "POST", headers: { authorization: `Bearer ${t}`, "content-type": "application/json" }, body: JSON.stringify({ args: { text: "x" } }) })).json();
  const tb = await token(2), tr = await token(1);
  const bos = [await call(tb), await call(tb), await call(tb)].map((r: any) => r.outcome);
  const roots = [await call(tr), await call(tr), await call(tr)].map((r: any) => r.outcome);
  ok("agent limits read the caller: 2 a minute for one, 50 for the administrator", bos.join() === "ok,ok,blocked" && roots.join() === "ok,ok,ok", { bos, roots });

  // a backup while the app runs, with a write landing beside it (the app's folder: app.dir, in WSL on Windows)
  const sh = (cmd: string) => { const r = process.platform === "win32" ? spawnSync("wsl", ["-e", "bash", "-c", cmd], { encoding: "utf8" }) : spawnSync("bash", ["-c", cmd], { encoding: "utf8" }); return { status: r.status, out: (r.stdout ?? "").trim() + (r.stderr ?? "").trim() }; };
  const out = `${app.dir}/backups/copy.sqlite`;
  const backup = () => sh(`${app.dir}/build/app backup --data ${app.dir}/data --out ${out}`);
  const writing = fetch(app.base + "/_agent/call/add", { method: "POST", headers: { authorization: `Bearer ${tr}`, "content-type": "application/json" }, body: JSON.stringify({ args: { text: "during" } }) });
  const b = backup();
  await writing;
  let bj: any = {};
  try { bj = JSON.parse(b.out.split("\n")[0]); } catch {}
  ok("app backup: a copy while the app runs", b.status === 0 && bj.bytes > 0, b);
  ok("... and the app keeps answering", (await fetch(app.base + "/up")).status === 200);
  const again = backup();
  ok("... a backup is a new file: it won't overwrite one", again.status !== 0 && /exists/.test(again.out), again);
  const count = sh(`node --no-warnings -e "const {DatabaseSync}=require('node:sqlite'); console.log(new DatabaseSync(process.argv[1], {readOnly: true}).prepare('SELECT count(*) AS n FROM Note').get().n)" ${out}`);
  ok("... and the copy is a database with the rows", Number(count.out) >= 5, count);
} finally { app.stop(); }

console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
