// The agent interface of a compiled app, over HTTP, on a small spec: dry runs count against
// rate limits, an unresolved delete needs confirmation, private fields stay private,
// read-only tokens can't write, idempotency keys are bound to their call, and the identity's
// where is rechecked on every call. And what makes it discoverable: /llms.txt, MCP instructions,
// descriptions from doc comments, refusals that name their rule (a hidden row's worded as a
// missing one's), a delete without confirm answering with its changes, and inline file uploads.
//   node lang/test/agent.test.ts      (needs Go: run it where `go` is installed)
process.removeAllListeners("warning");
import { writeFileSync, mkdtempSync, readdirSync, existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApp } from "./go-app.ts";

const SRC = `
app demo { name "Demo"  about "Notes, kept by people."  actor Person }
entity Person { name: Text  pin: Text private  active: Bool = true }
entity Note { owner: Person  text: Text  file: File? }
identity agent: Person from token where .active
permission read Person: true
permission read Note: true
predicate owner_of(p: Person, n: Note) = n.owner == p

action guess_pin(pin: Text) {
  rate_limit 3 per 1 min by actor.name else blocked
  require actor.pin == pin else invalid
}
// deletes every note the caller can name in a list: the target can't be resolved statically
action clear_listed(notes: set of Note) {
  for each n in list(it for Note where it in notes) { delete n }
}
// Adds a note of your own.
action add_note(text: Text) { create Note { owner: actor, text: text } }
action rename_note(note: Note, text: Text) {
  require owner_of(actor, note) else forbidden
  require length(text) < 20 else invalid "keep it under 20 letters"
  set note.text = text
}
action hide_note(note: Note) {
  require owner_of(actor, note) else not_found
  delete note
}
action add_file(file: File) { create Note { owner: actor, text: "file", file: file } as n  result n }
entity Doc { file: File }
permission read Doc: true
action file_note(note: Note, file: File) { delete note  create Doc { file: file } }
action agent_note(text: Text) {
  people no
  create Note { owner: actor, text: text }
}
view agent_view() {
  people no
  rows Note
}
view quiet_notes() {
  agents no
  rows Note
}
view my_note(note: Note) { require owner_of(actor, note) else not_found  rows Note where it == note }
view people() { rows Person }
view notes() { rows Note }
`;
const dir = mkdtempSync(join(tmpdir(), "agent-test-"));
writeFileSync(join(dir, "demo.crud"), SRC);
const app = await startApp(join(dir, "demo.crud"), 13821);
let failed = 0;
const ok = (name: string, cond: boolean, info?: unknown) => { console.log(`${cond ? "ok  " : "FAIL"} ${name}`); if (!cond) { failed++; console.log(JSON.stringify(info, null, 2)); } };
const person = (active: boolean) => ({ id: 1, seq: 1, created: 1, updated: 1, fields: { name: "Ada", pin: "4321", active } });
try {
  await app.post("/_test/load", { clock: 1_000_000, seq: 2, rows: { Person: [person(true)] } });
  const llms = await fetch(`${app.base}/llms.txt`);
  const llmsText = await llms.text();
  ok("/llms.txt is public and says how to get a token", llms.status === 200 && llmsText.includes("Notes, kept by people.") && llmsText.includes("/_agents"), llmsText);
  const anon = await fetch(`${app.base}/_agent/describe`);
  ok("a call without a token is a 401 with WWW-Authenticate", anon.status === 401 && (anon.headers.get("www-authenticate") ?? "").startsWith("Bearer"), anon.status);
  const full = (await app.post("/_test/agent_token", { entity: "Person", id: 1, scope: "full" })).token;
  const read = (await app.post("/_test/agent_token", { entity: "Person", id: 1, scope: "read" })).token;
  const call = (tok: string, name: string, body: unknown) => app.post(`/_agent/call/${name}`, body, { Authorization: `Bearer ${tok}` });
  const describe = await (await fetch(`${app.base}/_agent/describe`, { headers: { Authorization: `Bearer ${full}` } })).json();

  const outs = [];
  for (const i of [1, 2, 3, 4]) outs.push((await call(full, "guess_pin", { args: { pin: `000${i}` }, dry_run: true })).outcome);
  ok("dry runs count against the rate limit", outs.slice(0, 3).every((o) => o === "invalid") && outs[3] === "blocked", outs);

  const c = describe.callables.find((x: any) => x.name === "clear_listed");
  const r1 = await call(full, "clear_listed", { args: { notes: [] } });
  ok("an unresolved delete needs confirmation", c.confirm && c.effects.unknownDelete && r1.outcome === "confirm_required", { c: c.effects, r1 });

  const r2 = await call(full, "people", { args: {} });
  ok("private fields aren't sent", r2.outcome === "ok" && r2.rows[0].name === "Ada" && !("pin" in r2.rows[0]), r2);

  const r3 = await call(read, "add_note", { args: { text: "x" } });
  ok("a read-only token can't write", r3.outcome === "forbidden", r3);

  const a = await call(full, "add_note", { args: { text: "one" }, idempotency_key: "k" });
  const b = await call(full, "add_note", { args: { text: "one" }, idempotency_key: "k" });
  const d = await call(full, "add_note", { args: { text: "two" }, idempotency_key: "k" });
  const notes = await call(full, "notes", { args: {} });
  ok("idempotency: same call replays, a different call is refused", a.outcome === "ok" && b.replayed === true && notes.rows.length === 1 && d.outcome === "invalid", { a, b, d, notes });

  // discoverability: the overview, descriptions, refusals
  const init = await app.post("/_mcp", { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } }, { Authorization: `Bearer ${full}` });
  const ins = init.result?.instructions ?? "";
  ok("MCP initialize gives instructions: records, rules, who the token acts as", ins.includes("- Note: owner → Person") && ins.includes("owner_of(p, n) = n.owner == p") && ins.includes("acts as Ada"), ins);
  const add = describe.callables.find((x: any) => x.name === "add_note"), ren = describe.callables.find((x: any) => x.name === "rename_note");
  ok("a description starts with the doc comment; rules are listed", add.description.startsWith("Adds a note of your own.") && ren.description.includes("forbidden unless owner_of(actor, note)") && ren.rules.length === 2, { add: add.description, ren });

  const bob = { id: 2, seq: 2, created: 1, updated: 1, fields: { name: "Bob", pin: "1", active: true } };
  const bobNote = { id: 1, seq: 3, created: 1, updated: 1, fields: { owner: { ref: "Person", id: 2 }, text: "bob's", file: null } };
  await app.post("/_test/load", { clock: 1_000_000, seq: 4, rows: { Person: [person(true), bob], Note: [bobNote] } });
  const f1 = await call(full, "rename_note", { args: { note: 1, text: "mine" } });
  ok("forbidden names the rule, and the hint spells out the predicate", f1.outcome === "forbidden" && f1.error.message === "this needs owner_of(actor, note)" && f1.error.hint === "owner_of(actor, note) means note.owner == actor", f1);
  const mineNote = await call(full, "add_note", { args: { text: "ada's" } });
  const ids = (await call(full, "notes", { args: {} })).rows.map((r: any) => r.id);
  const own = ids.find((i: number) => i !== 1);
  const f2 = await call(full, "rename_note", { args: { note: own, text: "a much too long name for it" } });
  ok("a require's own reason is its message", f2.outcome === "invalid" && f2.error.message === "keep it under 20 letters", { mineNote, f2 });
  const hidden = await call(full, "hide_note", { args: { note: 1 }, dry_run: true });
  const missing = await call(full, "hide_note", { args: { note: 99 }, dry_run: true });
  ok("a hidden row's not_found reads as a missing row's", hidden.outcome === "not_found" && JSON.stringify(hidden).replace("Note 1", "Note 99") === JSON.stringify(missing), { hidden, missing });
  const vh = await call(full, "my_note", { args: { note: 1 } }), vm = await call(full, "my_note", { args: { note: 99 } });
  ok("a view's not_found reads as a missing row's too", vh.outcome === "not_found" && JSON.stringify(vh).replace("Note 1", "Note 99") === JSON.stringify(vm), { vh, vm });
  const nc = await call(full, "hide_note", { args: { note: 1 } });
  ok("a delete without confirm still refuses first", nc.outcome === "not_found" && !("dry_run" in nc), nc);
  const ask = await call(full, "hide_note", { args: { note: own } });
  const apply = await call(full, "hide_note", { args: { note: own }, confirm: ask.confirm });
  const after = (await call(full, "notes", { args: {} })).rows.map((r: any) => r.id);
  ok("a delete without confirm returns its changes and the confirm value, which applies it", ask.outcome === "confirm_required" && ask.changes?.Note?.deleted?.[0] === own && apply.outcome === "ok" && !after.includes(own), { ask, apply, after });
  const up = await call(full, "add_file", { args: { file: { filename: "hi.txt", data: Buffer.from("hello").toString("base64") } } });
  const got = (await call(full, "notes", { args: {} })).rows.find((r: any) => r.id === up.result?.id);
  ok("a file argument is sent inline and stored", up.outcome === "ok" && got?.file?.filename === "hi.txt" && got.file.size === 5 && got.file.content_type.startsWith("text/plain"), { up, got });
  const bad = await call(full, "add_file", { args: { file: { filename: "x", data: "%%%" } } });
  ok("a file that isn't base64 is invalid", bad.outcome === "invalid", bad);
  // a delete taking a file: asked without confirm, nothing is stored; the confirm value still applies it
  const big = Buffer.alloc(3000, 7).toString("base64");
  const target = (await call(full, "notes", { args: {} })).rows.find((r: any) => r.owner.id === 1).id;
  const local = process.platform !== "win32";   // the app's data directory is readable from here
  const files = () => (local && existsSync(`${app.dir}/data/files`) ? readdirSync(`${app.dir}/data/files`).length : 0);
  const before = files();
  const ask2 = await call(full, "file_note", { args: { note: target, file: { filename: "d.bin", data: big } } });
  const mid = files();
  const apply2 = await call(full, "file_note", { args: { note: target, file: { filename: "d.bin", data: big } }, confirm: ask2.confirm });
  ok("a file on a confirm-gated call: not stored when asked, applied by the confirm value", ask2.outcome === "confirm_required" && apply2.outcome === "ok" && (!local || (mid === before && files() === before + 1)), { ask2, apply2, before, mid, after: files() });
  if (local) {
    const db = new DatabaseSync(`${app.dir}/data/app.sqlite`, { readOnly: true });
    const audited = db.prepare("SELECT args FROM crudspec_audit").all().map((r: any) => String(r.args));
    db.close();
    ok("the audit keeps a file's name and size, not its contents", audited.some((a) => a.includes("d.bin")) && !audited.some((a) => a.includes(big.slice(0, 40))), audited.filter((a) => a.includes("d.bin")));
  }

  // who may call: agents no is withheld from agents; people no is refused to people
  const names = describe.callables.map((x: any) => x.name);
  const quiet = await call(full, "quiet_notes", { args: {} });
  ok("an agents-no view isn't described, and calling it is unknown", !names.includes("quiet_notes") && quiet.outcome === "unknown", { names, quiet });
  const byAgent = await call(full, "agent_note", { args: { text: "by agent" } });
  ok("a people-no action is described and callable by an agent", names.includes("agent_note") && byAgent.outcome === "ok", byAgent);
  const form = (path: string, method = "POST") => fetch(app.base + path, { method, redirect: "manual", headers: { Origin: app.base, "Content-Type": "application/x-www-form-urlencoded" }, body: method === "POST" ? "text=x" : undefined }).then((r) => r.status);
  const [doAgent, doPerson, viewAgent, viewPerson] = [await form("/_do/agent_note"), await form("/_do/add_note"), await form("/_view/agent_view", "GET"), await form("/_view/notes", "GET")];
  ok("a person's request for a people-no action or view is a 404", doAgent === 404 && viewAgent === 404 && doPerson !== 404 && viewPerson !== 404, { doAgent, doPerson, viewAgent, viewPerson });

  await app.post("/_test/load", { clock: 1_000_000, seq: 2, rows: { Person: [person(false)] } });
  const r4 = await call(full, "people", { args: {} });
  ok("the identity's where is rechecked: an inactive person's agent is refused", r4.outcome === "forbidden", r4);
} finally { app.stop(); }
console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
