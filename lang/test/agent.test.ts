// The agent interface of a compiled app, over HTTP, on a small spec: dry runs count against
// rate limits, an unresolved delete needs confirmation, private fields stay private,
// read-only tokens can't write, idempotency keys are bound to their call, and the identity's
// where is rechecked on every call.
//   node lang/test/agent.test.ts      (needs Go: run it where `go` is installed)
process.removeAllListeners("warning");
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApp } from "./go-app.ts";

const SRC = `
app demo { name "Demo"  actor Person }
entity Person { name: Text  pin: Text private  active: Bool = true }
entity Note { owner: Person  text: Text }
identity agent: Person from token where .active
permission read Person: true
permission read Note: note.owner == actor

action guess_pin(pin: Text) {
  rate_limit 3 per 1 min by actor.name else blocked
  require actor.pin == pin else invalid
}
// deletes every note the caller can name in a list: the target can't be resolved statically
action clear_listed(notes: set of Note) {
  for each n in list(Note where it in notes : it) { delete n }
}
action add_note(text: Text) { create Note { owner: actor, text: text } }
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

  await app.post("/_test/load", { clock: 1_000_000, seq: 2, rows: { Person: [person(false)] } });
  const r4 = await call(full, "people", { args: {} });
  ok("the identity's where is rechecked: an inactive person's agent is refused", r4.outcome === "forbidden", r4);
} finally { app.stop(); }
console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
