// The page cache (rt/pagecache.go): a screen's whole response kept under the data version and
// the request. The same request at the same version is sent from it; each session has its own;
// any commit makes the next request render afresh; a page that reads the clock or shows a flash
// is never kept.
//   node lang/test/pagecache.test.ts
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApp } from "./go-app.ts";

let failed = 0;
const ok = (what: string, pass: boolean, detail?: unknown) => { console.log(`${pass ? "ok  " : "FAIL"} ${what}`); if (!pass) { failed++; if (detail !== undefined) console.log(JSON.stringify(detail)); } };
const SPEC = `
app t { name "T" actor User }
entity User { name: Text  token: Text? }
identity login: User.token from cookie "login"
entity Note { title: Text }
permission read Note: true
action add(title: Text) { create Note { title: title } }
layout l { <main><slot name=main /></main> }
screen home { route "/"  layout l
  <main>
    <text class="who">{actor.name}</text>
    <list of={Note order by .title} as=n><text class="n">{n.title}</text></list>
  </main>
}
screen note_screen(n: Note) { route "/notes/:n"  layout l  remember last_note
  <main><text class="t">{n.title}</text></main>
}
screen clock { route "/clock"  layout l
  <main><text class="t">{now}</text></main>
}
`;
const dir = mkdtempSync(join(tmpdir(), "pagecache-"));
writeFileSync(join(dir, "app.crud"), SPEC);
const app = await startApp(join(dir, "app.crud"), 13911);
try {
  const row = (id: number, fields: Record<string, unknown>) => ({ id, seq: id, created: 100 + id, updated: 100 + id, fields });
  await app.post("/_test/load", { clock: 1000, rows: { User: [row(1, { name: "ada", token: "ta" }), row(2, { name: "bob", token: "tb" })], Note: [row(1, { title: "a" })] } });
  const page = async (path: string, token: string, extra: Record<string, string> = {}) => await (await fetch(app.base + path, { headers: { Cookie: `login=${token}`, ...extra } })).text();
  const names = (html: string, cls: string) => [...html.matchAll(new RegExp(`<span class="${cls}">([^<]*)</span>`, "g"))].map((m) => m[1]).join(",");
  const stats = async () => (await app.post("/_test/cache-check", {})).page_hits as number;
  const a1 = await page("/", "ta");
  const h0 = await stats();
  const a2 = await page("/", "ta");
  ok("the same request again is sent from the cache", (await stats()) === h0 + 1, { h0, h1: await stats() });
  ok("... the same page", a1 === a2);
  const b1 = await page("/", "tb");
  ok("another session has its own page", names(b1, "who") === "bob" && names(a1, "who") === "ada", [names(a1, "who"), names(b1, "who")]);
  const add = await fetch(app.base + "/_do/add", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Test-Actor": "User:1" }, body: new URLSearchParams({ title: "b" }), redirect: "manual" });
  ok("a commit", add.headers.get("X-Crudspec-Outcome") === "ok");
  const h1 = await stats();
  const a3 = await page("/", "ta");
  ok("... the next request renders afresh", (await stats()) === h1 && names(a3, "n") === "a,b", names(a3, "n"));
  const c0 = await stats();
  await page("/clock", "ta"); await page("/clock", "ta");
  ok("a page that reads the clock isn't kept", (await stats()) === c0);
  await page("/", "ta", { Cookie: "login=ta; flash=hello" }); await page("/", "ta", { Cookie: "login=ta; flash=hello" });
  ok("... nor one showing a flash", (await stats()) === c0);
  // a screen that remembers its parameter sets a cookie: kept with the page, and sent with it
  const get = async () => await fetch(app.base + "/notes/1", { headers: { Cookie: "login=ta" } });
  const r1 = await get(), h2 = await stats(), r2 = await get();
  ok("a page that sets its remembering cookie is kept", (await stats()) === h2 + 1);
  ok("... and sent with that cookie", r2.headers.get("set-cookie")?.startsWith("last_note=") === true && r2.headers.get("set-cookie") === r1.headers.get("set-cookie"), [r1.headers.get("set-cookie"), r2.headers.get("set-cookie")]);
} finally { app.stop(); }
process.exit(failed ? 1 : 0);
