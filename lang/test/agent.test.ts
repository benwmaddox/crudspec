// The agent interface on a small spec, without HTTP: rate limits count dry runs, an
// unresolved delete needs confirmation, private fields stay private, read-only tokens can't
// write, and idempotency keys are bound to their call.
process.removeAllListeners("warning");
import { DatabaseSync } from "node:sqlite";
import { parse } from "../parser.ts";
import { check } from "../check.ts";
import { Interpreter } from "../interp.ts";
import { AgentApi } from "../runtime/agent.ts";

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
`;
const spec = parse(SRC);
const errors = check(spec).filter((f) => f.severity === "error");
if (errors.length) { console.log(errors); process.exit(1); }
const it = new Interpreter(spec);
it.clock = 1_000_000;
const ada = it.store.insert("Person", { name: "Ada", pin: "4321", active: true }, 1);
const api = new AgentApi({
  it, spec, source: SRC, db: new DatabaseSync(":memory:"), secret: "test-secret",
  commit: () => {}, version: () => 1, sessionActor: () => null,
  label: (r) => String(it.store.find(r)?.fields.name ?? r.id), fileUrl: () => "",
});
const caller = (scope: "read" | "full") => ({ tokenId: scope === "read" ? 2 : 1, actor: { ref: "Person", id: ada.id }, scope });
let failed = 0;
const ok = (name: string, cond: boolean, info?: unknown) => { console.log(`${cond ? "ok  " : "FAIL"} ${name}`); if (!cond) { failed++; console.log(JSON.stringify(info, null, 2)); } };

{ const outs = [1, 2, 3, 4].map((i) => api.invoke(caller("full"), "guess_pin", { args: { pin: `000${i}` }, dry_run: true }, "203.0.113.1").outcome);
  ok("dry runs count against the rate limit", outs.slice(0, 3).every((o) => o === "invalid") && outs[3] === "blocked", outs); }
{ const c = api.byName.get("clear_listed")!;
  const r = api.invoke(caller("full"), "clear_listed", { args: { notes: [] } }, "203.0.113.1");
  ok("an unresolved delete needs confirmation", c.confirm && c.effects.unknownDelete && r.outcome === "confirm_required", { c: c.effects, r }); }
{ const r = api.invoke(caller("full"), "people", { args: {} }, "203.0.113.1");
  ok("private fields aren't sent", r.outcome === "ok" && r.rows[0].name === "Ada" && !("pin" in r.rows[0]), r); }
{ const r = api.invoke(caller("read"), "add_note", { args: { text: "x" } }, "203.0.113.1");
  ok("a read-only token can't write", r.outcome === "forbidden", r); }
{ const a = api.invoke(caller("full"), "add_note", { args: { text: "one" }, idempotency_key: "k" }, "203.0.113.1");
  const b = api.invoke(caller("full"), "add_note", { args: { text: "one" }, idempotency_key: "k" }, "203.0.113.1");
  const c = api.invoke(caller("full"), "add_note", { args: { text: "two" }, idempotency_key: "k" }, "203.0.113.1");
  ok("idempotency: same call replays, a different call is refused", a.outcome === "ok" && b.replayed === true && it.store.rows("Note").length === 1 && c.outcome === "invalid", { a, b, c }); }
{ it.store.find({ ref: "Person", id: ada.id })!.fields.active = false;
  ok("the identity's where is rechecked: an inactive person's agent is refused", !api.allowed({ ref: "Person", id: ada.id })); }
process.exit(failed ? 1 : 0);
