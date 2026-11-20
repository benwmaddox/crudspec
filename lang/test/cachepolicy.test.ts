// What the caches keep, and for how long (rt/pagecache.go, rt/cache.go, rt/cachelimits.go):
// - a page is one for every signed-out reader of its address: not kept per visitor's address or
//   browser, unless it reads them (request.ip, request.user_agent), when it isn't kept at all;
// - a commit drops the pages that read what it wrote, and keeps the rest (by key, the default);
// - an entry older than --cache-max-age isn't used;
// - /_metrics says the caches' sizes and budgets.
//   node lang/test/cachepolicy.test.ts      (needs Go: on Windows, in WSL)
process.removeAllListeners("warning");
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApp } from "./go-app.ts";

let failed = 0;
const ok = (what: string, pass: boolean, detail?: unknown) => { console.log(`${pass ? "ok  " : "FAIL"} ${what}`); if (!pass) { failed++; if (detail !== undefined) console.log(JSON.stringify(detail)); } };
const SPEC = `
app t { name "T"  actor User  admin actor.admin }
entity User { name: Text  token: Text?  admin: Bool = false }
identity login: User.token from cookie "login"
entity Note { title: Text }
entity Tag { name: Text }
policy note_rows: true for rows of Note
policy tag_rows: true for rows of Tag
// Adds a note.
action add_note(title: Text) { create Note { title: title } }
// Adds a tag.
action add_tag(name: Text) { create Tag { name: name } }
layout l { <main><Slot name=main /></main> }
screen notes { route "/"  layout l  require public
  <Fill name=main><List of={Note order by .title} as=n><span class="n">{n.title}</span></List></Fill>
}
screen tags { route "/tags"  layout l  require public
  <Fill name=main><List of={Tag order by .name} as=t><span class="t">{t.name}</span></List></Fill>
}
screen where { route "/where"  layout l  require public
  <Fill name=main><span class="ip">{request.ip}</span></Fill>
}
`;
const dir = mkdtempSync(join(tmpdir(), "cachepolicy-"));
writeFileSync(join(dir, "app.crud"), SPEC);

// the defaults: shared pages, by key
{
  const app = await startApp(join(dir, "app.crud"), 13971);
  try {
    const row = (id: number, fields: Record<string, unknown>) => ({ id, seq: id, created: 100 + id, updated: 100 + id, fields });
    await app.post("/_test/load", { clock: 1000, rows: { User: [row(1, { name: "root", token: "tr", admin: true })], Note: [row(1, { title: "a" })], Tag: [row(1, { name: "x" })] } });
    const hits = async () => (await app.post("/_test/cache-check", {})).page_hits as number;
    const visit = (path: string, ip: string, ua: string) => fetch(app.base + path, { headers: { "X-Forwarded-For": ip, "User-Agent": ua } }).then((r) => r.text());
    await visit("/", "198.51.100.1", "browser one");
    const h0 = await hits();
    await visit("/", "198.51.100.2", "browser two");
    ok("another reader (another address, another browser) is sent the same kept page", (await hits()) === h0 + 1, { h0, h1: await hits() });
    const w1 = await visit("/where", "198.51.100.1", "b"), h1 = await hits(), w2 = await visit("/where", "198.51.100.2", "b");
    ok("a page that reads the visitor's address isn't kept: each sees their own", (await hits()) === h1 && w1.includes("198.51.100.1") && w2.includes("198.51.100.2"), [w1.match(/ip">[^<]*/)?.[0], w2.match(/ip">[^<]*/)?.[0]]);
    await visit("/tags", "198.51.100.1", "b");
    const post = (action: string, body: Record<string, string>) => fetch(app.base + "/_do/" + action, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Test-Actor": "User:1" }, body: new URLSearchParams(body), redirect: "manual" });
    await post("add_note", { title: "b" });
    const h2 = await hits();
    const tags = await visit("/tags", "198.51.100.3", "b");
    ok("a commit keeps the pages that didn't read what it wrote (by key)", (await hits()) === h2 + 1 && tags.includes(">x<"), { h2, h3: await hits() });
    const h3 = await hits();
    const notes = await visit("/", "198.51.100.3", "b");
    ok("... and drops those that did: the next one is made afresh", (await hits()) === h3 && notes.includes(">a<") && notes.includes(">b<"));
    const m = await (await fetch(app.base + "/_metrics", { headers: { Cookie: "login=tr" } })).json();
    ok("/_metrics says the caches' sizes, budgets and age limit", m.page_cache?.pages >= 1 && m.page_cache.budget >= 16 << 20 && m.fragment_cache?.budget >= 16 << 20 && m.cache_max_age_hours === 24 && typeof m.memory_pressure?.times === "number", m);
  } finally { app.stop(); }
}

// --cache-max-age: an entry past it isn't used
{
  const app = await startApp(join(dir, "app.crud"), 13972, { args: ["--cache-max-age", "1s"] });
  try {
    await app.post("/_test/load", { clock: 1000, rows: { Note: [{ id: 1, seq: 1, created: 1, updated: 1, fields: { title: "a" } }] } });
    const hits = async () => (await app.post("/_test/cache-check", {})).page_hits as number;
    await fetch(app.base + "/");
    const h0 = await hits();
    await fetch(app.base + "/");
    ok("--cache-max-age 1s: kept within it", (await hits()) === h0 + 1);
    await new Promise((r) => setTimeout(r, 1300));
    const h1 = await hits();
    await fetch(app.base + "/");
    ok("... and made afresh past it", (await hits()) === h1);
  } finally { app.stop(); }
}
process.exit(failed ? 1 : 0);
