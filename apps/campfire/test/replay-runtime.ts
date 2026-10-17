// Replays oracle scenarios against a running crudspec runtime over HTTP, and compares with
// the Rails golden files: behaviour equity for the runtime, not just the interpreter.
//
//   node tools/src/v2/replay-runtime.ts <spec.crud> <base-url> <scenario-dir> <golden-dir>
// The runtime must run with --test. The driver builds each scenario's setup itself, in an
// plain row store (no spec code runs here), and loads the rows with /_test/load; it reads state back with
// /_test/dump and normalizes it here. So any runtime that speaks that protocol can be judged,
// the TypeScript one or a compiled binary; no app code runs inside the server. Every action
// and view goes through the normal HTTP paths, with the actor's own session cookie and IP.
import { readFileSync, readdirSync } from "node:fs";
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
process.exit(failed ? 1 : 0);
