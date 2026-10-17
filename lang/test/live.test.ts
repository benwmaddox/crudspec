// Live pages refresh only for changes they read, on the compiled Campfire over HTTP. Cy is in
// the lobby but not in Planning: a post in Planning must not reach Cy's lobby page; a post in
// the lobby must. Bob, in both, is told of a post in Planning (his sidebar marks it unread).
//   node lang/test/live.test.ts
import { readFileSync } from "node:fs";
import { startApp } from "./go-app.ts";

let failed = 0;
const ok = (what: string, pass: boolean, detail?: unknown) => { console.log(`${pass ? "ok  " : "FAIL"} ${what}`); if (!pass) { failed++; if (detail !== undefined) console.log(JSON.stringify(detail)); } };

const app = await startApp("apps/campfire/campfire.crud", 13841);
try {
  const fixture = JSON.parse(readFileSync("apps/campfire/ui/fixture.json", "utf8"));
  const fx = await (await fetch(app.base + "/_test/fixture", { method: "POST", body: JSON.stringify(fixture) })).json();
  const id = (k: string) => fx.keys[k].id ?? fx.keys[k].ID;
  const signIn = async (email: string, password: string) => {
    const r = await fetch(app.base + "/_do/sign_in", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ email, password }), redirect: "manual" });
    const c = r.headers.getSetCookie().find((x) => x.startsWith("session_token="));
    if (!c) throw new Error(`sign in failed for ${email}: ${r.status} ${r.headers.get("X-Crudspec-Outcome")}`);
    return c.split(";")[0];
  };
  const users = { ada: await signIn("ada@example.test", "fixture-pass-1"), bob: await signIn("bob@example.test", "fixture-pass-2"), cy: await signIn("cy@example.test", "fixture-pass-3") };
  // a page's version and the keys it read
  const page = async (who: string, path: string) => {
    const html = await (await fetch(app.base + path, { headers: { Cookie: (users as any)[who] } })).text();
    const m = /<script id="crudspec-page" type="application\/json">(.*?)<\/script>/s.exec(html);
    if (!m) throw new Error(`no page data on ${path}`);
    const pd = JSON.parse(m[1].replace(/<\\\//g, "</")) as { v: number; d: string[] };
    // what the page read: its own keys and its fragments' (<!--/f:ID HASH KEYS…-->)
    for (const f of html.matchAll(/<!--\/f:[0-9a-f]+ [0-9a-z]+([^>]*?)-->/g)) pd.d.push(...f[1].trim().split(" ").filter(Boolean));
    return pd;
  };
  const post = async (who: string, room: number, body: string) => {
    const r = await fetch(app.base + "/_do/post_message", { method: "POST", headers: { Cookie: (users as any)[who], "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ room: String(room), body, client_id: `c${Date.now()}${Math.random()}` }), redirect: "manual" });
    if (r.headers.get("X-Crudspec-Outcome") !== "ok") throw new Error(`post failed: ${r.headers.get("X-Crudspec-Outcome")}`);
  };
  // what the stream tells a page rendered at version v: the first message's keys
  const told = async (v: number): Promise<{ v: number; keys: string[] }> => {
    const ac = new AbortController();
    const r = await fetch(`${app.base}/_events?since=${v}`, { signal: ac.signal });
    const reader = r.body!.getReader(); let buf = "";
    for (;;) {
      const { value } = await reader.read(); buf += new TextDecoder().decode(value);
      const m = /data: (\d+)([^\n]*)\n\n/.exec(buf);
      if (m) { ac.abort(); return { v: Number(m[1]), keys: m[2].trim().split(" ").filter(Boolean) }; }
    }
  };
  const meets = (p: { d: string[] }, t: { keys: string[] }) => t.keys[0] === "*" || t.keys.some((k) => p.d.includes(k));
  const lobby = `/rooms/${id("lobby")}`;

  const cy1 = await page("cy", lobby), bob1 = await page("bob", lobby);
  ok(`the lobby page carries what it read (${cy1.d.length} keys)`, cy1.d.length > 0 && cy1.d.length < 2000);
  await post("ada", id("planning"), "only for the planners");
  const t1 = await told(cy1.v);
  ok("a post in Planning: Cy's lobby page is not told", !meets(cy1, t1), t1);
  ok("... Bob's is (his sidebar marks Planning unread)", meets(bob1, await told(bob1.v)));
  const cy2 = await page("cy", lobby);
  await post("ada", id("lobby"), "hello, lobby");
  ok("a post in the lobby: Cy's lobby page is told", meets(cy2, await told(cy2.v)));
  // a page rendered before several commits hears of them all
  const cy3 = await page("cy", lobby);
  await post("ada", id("planning"), "planning again");
  await post("bob", id("lobby"), "lobby again");
  ok("commits since the page's version count, not just the latest", meets(cy3, await told(cy3.v)));
  // no row ids or values in the clear
  ok("keys are hashed", ![...cy1.d, ...t1.keys].some((k) => /[#=]|Message|Room/.test(k)), cy1.d.slice(0, 5));
} finally { app.stop(); }
process.exit(failed ? 1 : 0);
