// Replays oracle scenarios against a running crudspec runtime over HTTP, and compares with
// the Rails golden files: behaviour equity for the runtime, not just the interpreter.
//
//   node tools/src/v2/replay-runtime.ts <spec.crud> <base-url> <scenario-dir> <golden-dir>
// The runtime must run with --test. The driver builds each scenario's setup itself, in an
// plain row store (no spec code runs here), and loads the rows with /_test/load; it reads state back with
// /_test/dump and normalizes it here. So any runtime that speaks that protocol can be judged,
// the TypeScript one or a compiled binary; no app code runs inside the server. Every action
// and view goes through the normal HTTP paths, with the actor's own session cookie and IP.
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "../../../lang/parser.ts";
import { Store } from "../../../lang/rows.ts";
import { Keys, argsFor, KIND, CREATES, RENAME, ANONYMOUS, setup, normalized, world } from "./scenario.ts";

const [specPath, base, scenDir, goldenDir] = process.argv.slice(2);
const spec = parse(readFileSync(specPath, "utf8"));
const it = world(spec);   // for declarations only
const apiDecl = spec.decls.find((d) => d.kind === "api");

async function test(path: string, body: unknown) {
  const r = await fetch(base + path, { method: "POST", body: JSON.stringify(body) });
  return r.json();
}
function cookieFrom(res: Response): string | null {
  const all = res.headers.getSetCookie?.() ?? [];
  for (const c of all) { const m = c.match(/^session_token=([^;]*)/); if (m) return m[1]; }
  return null;
}

type Diff = { scenario: string; where: string; expected: unknown; actual: unknown };

// Live pages (REPLAY_LIVE_CHECK=1): around each action, every room page of every signed-in
// user is rendered before and after, and refreshed as the live script would: whole when the
// commits' keys meet the page's own, else just the outermost fragments they meet (X-Live:
// frags), spliced in. The result must equal the page rendered afresh; a difference is a page
// that would have been left wrong. Also counted: what each refresh moved, against whole pages.
const liveCheck = !!process.env.REPLAY_LIVE_CHECK;
const liveStats = { pages: 0, changed: 0, whole: 0, partial: 0, untouched: 0, bytes: 0, wholeBytes: 0, wrong: [] as string[], stale: [] as string[] };
type LivePage = { raw: string; d: string[]; v: number; cookie: string; path: string };
const pageData = (html: string) => { const m = /<script id="crudspec-page" type="application\/json">(.*?)<\/script>/s.exec(html); return m ? { tag: m[0], data: JSON.parse(m[1].replace(/<\\\//g, "</")) } : null; };
// what a page shows: without its data, handler tokens and signed links
const shown = (html: string) => { const pd = pageData(html); return (pd ? html.replace(pd.tag, "") : html).replace(/name="__h" value="[^"]*"/g, "").replace(/\/_qr\/[A-Za-z0-9_-]+/g, "").replace(/session\/transfers\/[^"'<\s]+/g, "")
  // a fragment's hash is of its subtree: an ancestor of a refreshed fragment keeps its old one,
  // which only means it is sent whole if it is ever asked for
  .replace(/<!--\/f:([^ >]+) [0-9a-z]+/g, "<!--/f:$1"); };
async function livePages(cookies: Record<string, string>, keys: Keys) {
  const out = new Map<string, LivePage>();
  const rooms = [...(keys.by.get("room") ?? new Map()).values()];
  for (const [who, c] of Object.entries(cookies)) for (const room of rooms) {
    const path = `/rooms/${room}`;
    const r = await fetch(base + path, { headers: { Cookie: `session_token=${c}` }, redirect: "manual" });
    if (r.status !== 200) continue;
    const raw = await r.text(), pd = pageData(raw);
    if (!pd) continue;
    out.set(`${who} room ${room}`, { raw, d: pd.data.d ?? [], v: pd.data.v, cookie: c, path });
  }
  return out;
}
type FragAt = { id: string; open: number; stop: number; h: string; d: Set<string>; parent?: FragAt };
function fragsOf(html: string): FragAt[] {
  const out: FragAt[] = [], stack: FragAt[] = [];
  for (const m of html.matchAll(/<!--(\/?)f:([^ >-]+)([^>]*?)-->/g)) {
    if (!m[1]) { stack.push({ id: m[2], open: m.index!, stop: 0, h: "", d: new Set(), parent: stack.at(-1) }); continue; }
    const f = stack.pop(); if (!f || f.id !== m[2]) continue;
    const [h, ...d] = m[3].trim().split(" "); f.stop = m.index! + m[0].length; f.h = h; f.d = new Set(d); out.push(f);
  }
  return out;
}
async function liveCompare(scenario: string, step: string, before: Map<string, LivePage>, cookies: Record<string, string>, keys: Keys) {
  const after = await livePages(cookies, keys);
  for (const [page, b] of before) {
    const a = after.get(page);
    if (!a) continue;
    liveStats.pages++;
    const K: string[] = (await test("/_test/live", { since: b.v })).hashed;
    const meets = (d: Iterable<string>) => { const set = new Set(d); return K.some((k) => set.has(k)); };
    let result = b.raw;
    if (meets(b.d)) { liveStats.whole++; liveStats.bytes += a.raw.length; result = a.raw; }
    else {
      const F = fragsOf(b.raw), hit = F.filter((f) => meets(f.d));
      const pick = hit.filter((f) => { for (let q = f.parent; q; q = q.parent) if (hit.includes(q)) return false; return true; });
      if (!pick.length) liveStats.untouched++;
      else {
        liveStats.partial++;
        const r = await fetch(base + b.path, { headers: { Cookie: `session_token=${b.cookie}`, "X-Live": "frags", "X-Live-Frags": pick.map((f) => f.id).join(","), "X-Live-Known": F.map((f) => f.id + ":" + f.h).join(",") } });
        const text = await r.text(); liveStats.bytes += text.length;
        const j = JSON.parse(text);
        if (pick.some((f) => j.frags[f.id] == null)) { liveStats.bytes += a.raw.length; result = a.raw; }
        else {
          const byId = new Map(F.map((f) => [f.id, f]));
          for (const f of [...pick].sort((x, y) => y.open - x.open)) {
            const html = String(j.frags[f.id]).replace(/<!--keep:([^ >-]+)-->/g, (_m, id) => { const o = byId.get(id); return o ? b.raw.slice(o.open, o.stop) : "<!--lost-->"; });
            result = result.slice(0, f.open) + html + result.slice(f.stop);
          }
        }
      }
    }
    liveStats.wholeBytes += a.raw.length;
    // the fragment cache: the page rendered without it must be the same
    const fresh = await (await fetch(base + b.path, { headers: { Cookie: `session_token=${b.cookie}`, "X-No-Cache": "1" } })).text();
    if (shown(fresh) !== shown(a.raw)) {
      liveStats.stale.push(`${scenario} ${step}: ${page}`);
      if (process.env.REPLAY_LIVE_DUMP && liveStats.stale.length === 1) { writeFileSync(`${process.env.REPLAY_LIVE_DUMP}/cached.html`, a.raw); writeFileSync(`${process.env.REPLAY_LIVE_DUMP}/fresh.html`, fresh); }
    }
    if (shown(a.raw) !== shown(b.raw)) liveStats.changed++;
    if (shown(result) !== shown(a.raw)) {
      liveStats.wrong.push(`${scenario} ${step}: ${page}`);
      if (process.env.REPLAY_LIVE_DUMP && liveStats.wrong.length === 1) {
        const d = process.env.REPLAY_LIVE_DUMP;
        writeFileSync(`${d}/before.html`, b.raw); writeFileSync(`${d}/result.html`, result); writeFileSync(`${d}/after.html`, a.raw);
        writeFileSync(`${d}/keys.json`, JSON.stringify({ K: (await test("/_test/live", { since: b.v })).keys, page: pageData(b.raw)?.data.dk }));
      }
    }
  }
}

// Probes for `cli review` (REPLAY_PROBES=<file>, added to): each call with the state just
// before it, its arguments, actor and request as the interpreter's scenario runner made them.
const probesPath = process.env.REPLAY_PROBES;
const probes: any[] | null = probesPath ? (existsSync(probesPath) ? JSON.parse(readFileSync(probesPath, "utf8")) : []) : null;
async function record(scenarioId: string, name: string, action: any, args: any, ip: string, keys: Keys) {
  const dump = await test("/_test/dump", {});
  const rowsOf = (e: string): any[] => dump.rows[e] ?? [];
  const viaBot = action.do.startsWith("bot_");
  let actor: { ref: string; id: number } | null = null;
  if (viaBot) {
    const bot = rowsOf("User").find((r) => r.id === keys.id("user", action.actor));
    const [id, tok] = String(action.bot_key ?? `${bot?.id}-${bot?.fields.bot_token}`).split("-");
    const match = rowsOf("User").find((r) => r.id === Number(id) && r.fields.bot_token === tok && r.fields.role === "bot" && r.fields.status === "active");
    if (match) actor = { ref: "User", id: match.id };
  } else if (action.actor && !ANONYMOUS.has(name)) {
    const uid = keys.id("user", action.actor);
    if (rowsOf("Session").some((x) => x.fields.user?.id === uid)) actor = { ref: "User", id: uid };
  }
  const session = actor && !viaBot ? rowsOf("Session").find((x) => x.fields.user?.id === actor!.id)?.fields.token : undefined;
  probes!.push({ scenario: scenarioId, clock: dump.now, state: { tables: Object.entries(dump.rows), nextId: [], seq: dump.seq, counters: dump.counters }, name, args, actor,
    request: { ip, method: it.get("view", name) ? "get" : "write", identity: viaBot && actor ? "bot_key" : actor ? "session" : "", user_agent: "oracle", session_token: session },
    skips: viaBot && action.do !== "bot_ui_post" ? ["deny_bots"] : [] });
}

async function runScenario(scenario: any, golden: any): Promise<Diff[]> {
  const diffs: Diff[] = [];
  const cmp = (where: string, e: any, a: any) => {
    if (JSON.stringify(e) === JSON.stringify(a)) return;
    if ((where === "initial" || where === "final") && e && a && typeof e === "object") {
      for (const k of new Set([...Object.keys(e), ...Object.keys(a)])) if (JSON.stringify(e[k]) !== JSON.stringify(a[k])) diffs.push({ scenario: scenario.id, where: `${where}.${k}`, expected: e[k], actual: a[k] });
      return;
    }
    diffs.push({ scenario: scenario.id, where, expected: e, actual: a });
  };
  const v2 = scenario.v2 === true;
  // the setup, built here and loaded into the server
  const local = world(spec);
  const keys = new Keys();
  setup(local, scenario.setup, keys);
  const tokens = new Map(local.store.rows("User").map((u) => [u.id, u.fields.bot_token]));
  const stored = [...local.entities].filter(([, d]) => d.kind === "entity").map(([n]) => n);
  await test("/_test/load", { clock: local.clock, seq: local.store.seq, counters: [...local.counters], rows: Object.fromEntries(stored.map((n) => [n, local.store.rows(n)])) });
  // the server's state, normalized here with the app's own rules
  const state = async () => {
    const dump = await (await fetch(base + "/_test/dump", { method: "POST", body: "{}" })).json();
    const s = new Store();
    for (const [n, rows] of Object.entries(dump.rows as Record<string, any[]>)) s.tables.set(n, rows);
    local.store = s;
    return normalized(local, keys, v2, tokens);
  };
  const users: Record<string, any> = Object.fromEntries((scenario.setup.users ?? []).map((u: any) => [u.key, u]));
  // Each user with an address starts signed in, holding the session the setup made.
  const cookies: Record<string, string> = {};
  for (const u of scenario.setup.users ?? []) if (u.ip) cookies[u.key] = `session-${u.key}`;
  cmp("initial", golden.initial, await state());

  for (const [i, res] of golden.results.entries()) {
    const action = res.action;
    const name = RENAME[action.do] ?? action.do;
    await test("/_test/clock", { advance_ms: 1000 });
    if (action.do === "wait") { await test("/_test/clock", { advance_ms: action.seconds * 1000 }); continue; }
    const liveBefore = liveCheck ? await livePages(cookies, keys) : null;
    const ip = action.ip ?? users[action.actor]?.ip ?? "203.0.113.250";
    const headers: Record<string, string> = { "X-Forwarded-For": ip };
    const anon = ANONYMOUS.has(name) || action.do.startsWith("bot_");
    const query = action.do === "bot_ui_post" ? `?bot_key=${keys.id("user", action.actor)}-${users[action.actor].bot_token}` : "";
    if (!anon && action.actor && cookies[action.actor]) headers.Cookie = `session_token=${cookies[action.actor]}`;
    const created = CREATES[name];
    const before = created ? (await test("/_test/maxid", { entity: created })).id : 0;
    if (name === "transfer_session" && !action.link) {
      action.link = (await test("/_test/fn", { name: "transfer_link", refs: [["User", keys.id("user", action.user)]] })).value;
    }
    const args = argsFor(it, name, action, keys, users);
    if (probes) await record(scenario.id, name, action, args, ip, keys);
    let outcome = "", rows: string[] | undefined;

    if (action.do.startsWith("bot_") && action.do !== "bot_ui_post") {
      // through the bot API, keyed "<id>-<token>" in the path
      const bot = keys.id("user", action.actor);
      const key = action.bot_key ?? `${bot}-${users[action.actor].bot_token}`;
      const room = keys.id("room", action.room);
      const root = String(apiDecl!.route).replace(":room", String(room)).replace(":bot_key", key);
      const [method, path, body] =
        action.do === "bot_post" ? ["POST", "", action.body ?? ""] :
        action.do === "bot_edit" ? ["PUT", `/${keys.id("message", action.message)}`, action.body ?? ""] :
        action.do === "bot_delete" ? ["DELETE", `/${keys.id("message", action.message)}`, ""] :
        ["POST", `/${keys.id("message", action.message)}/boosts`, action.content ?? ""];
      const r = await fetch(base + root + path, { method, headers: { ...headers, "Content-Type": "text/plain" }, body: method === "DELETE" ? undefined : body });
      outcome = ({ 200: "ok", 201: "ok", 204: "ok", 401: "unauthenticated", 403: "forbidden", 404: "not_found", 422: "invalid", 429: "blocked" } as Record<number, string>)[r.status] ?? `http ${r.status}`;
    } else if (it.get("view", name)) {
      const q = new URLSearchParams();
      for (const [k, v] of Object.entries(args)) if (v !== null && v !== undefined) q.set(k, String(v));
      const r = await fetch(`${base}/_view/${name}?${q}`, { headers });
      const j = await r.json();
      outcome = j.outcome;
      if (res.rows !== undefined && outcome === "ok") rows = j.rows.map((id: number) => keys.key(name === "room_messages" || name === "search_results" ? "message" : "row", id));
    } else {
      const form = new URLSearchParams();
      for (const [k, v] of Object.entries(args)) {
        if (Array.isArray(v)) for (const x of v) form.append(`${k}[]`, String(x));
        else if (v !== null && v !== undefined) form.set(k, typeof v === "object" ? (v as any).rich ?? JSON.stringify(v) : String(v));
      }
      const r = await fetch(`${base}/_do/${name}${query}`, { method: "POST", headers: { ...headers, "Content-Type": "application/x-www-form-urlencoded" }, body: form, redirect: "manual" });
      outcome = r.headers.get("X-Crudspec-Outcome") ?? `http ${r.status}`;
      const c = cookieFrom(r);
      // whoever this request signed in now holds that session
      const who = name === "join" || name === "first_run" ? action.as : name === "transfer_session" ? action.user : action.actor;
      if (c && who) cookies[who] = c;
      if (c && who && (name === "join" || name === "first_run")) users[who] = { key: who, ip, email: action.email };
    }
    if (action.as && created) {
      const newest = (await test("/_test/maxid", { entity: created })).id;
      if (newest > before) keys.set(KIND[created], action.as, newest);
    }
    if (name === "first_run" && outcome === "ok" && !keys.has("room", "all_talk")) keys.set("room", "all_talk", 1);
    if (process.env.REPLAY_TRACE) console.log(`  ${scenario.id} ${i + 1} ${action.do} by ${action.actor}: expected ${res.outcome}, got ${outcome}`);
    if (liveBefore) await liveCompare(scenario.id, `${i + 1} ${action.do}`, liveBefore, cookies, keys);
    cmp(`action ${i + 1} ${action.do} by ${action.actor}: outcome`, res.outcome, outcome);
    if (rows) cmp(`action ${i + 1} ${action.do}: rows`, res.rows, rows);
  }
  cmp("final", golden.final, await state());
  return diffs;
}

let total = 0, failed = 0;
for (const f of readdirSync(goldenDir).filter((f) => f.endsWith(".json")).sort()) {
  const golden = JSON.parse(readFileSync(join(goldenDir, f), "utf8"));
  const scenario = JSON.parse(readFileSync(join(scenDir, f), "utf8"));
  total++;
  let d: Diff[];
  try { d = await runScenario(scenario, golden); } catch (e) { d = [{ scenario: scenario.id, where: "crash", expected: null, actual: String((e as Error).stack).split("\n").slice(0, 3).join(" | ") }]; }
  if (d.length) { failed++; for (const x of d) console.log(`DIFF ${x.scenario} — ${x.where}\n  expected ${JSON.stringify(x.expected)?.slice(0, 300)}\n  actual   ${JSON.stringify(x.actual)?.slice(0, 300)}`); }
}
console.log(`${total - failed}/${total} scenarios match the Rails oracle through the runtime over HTTP`);
if (probes) writeFileSync(probesPath!, JSON.stringify(probes));
if (liveCheck) console.log(`live: ${liveStats.pages} pages around actions, ${liveStats.changed} changed; refreshed whole ${liveStats.whole}, by fragment ${liveStats.partial}, left alone ${liveStats.untouched}; ${liveStats.wrong.length} left wrong; ${liveStats.stale.length} stale from the cache; moved ${liveStats.bytes} bytes against ${liveStats.wholeBytes} for whole pages${liveStats.wrong.length ? "\n  " + liveStats.wrong.slice(0, 20).join("\n  ") : ""}`);
process.exit(failed ? 1 : 0);
