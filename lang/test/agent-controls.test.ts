// The app's controls over its agent interface (docs/api-and-agents.md): agents_anonymous lets an
// agent with no token call the views as a signed-out visitor (never an action, never a row the
// policies hide), agent_calls_per_minute and agent_writes_per_minute refuse what's over them
// (blocked, 429), and agents_when switches the interface off (503) and on, from the app's data.
//   node lang/test/agent-controls.test.ts      (needs Go)
process.removeAllListeners("warning");
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApp } from "./go-app.ts";

let failed = 0;
const ok = (what: string, pass: boolean, detail?: unknown) => { console.log(`${pass ? "ok  " : "FAIL"} ${what}`); if (!pass) { failed++; if (detail !== undefined) console.log("     ", JSON.stringify(detail)); } };

const dir = mkdtempSync(join(tmpdir(), "crudspec-agentctl-"));
writeFileSync(join(dir, "app.crud"), `
app demo {
  name "Demo"  about "Notes."  actor Person
  agents_when Settings.agents_on
  agents_anonymous Settings.open_reads
  agent_calls_per_minute 6
  agent_writes_per_minute 2
}
singleton Settings { agents_on: Bool = true  open_reads: Bool = true }
entity Person { name: Text  token: Text?  unique (token) }
entity Note { owner: Person  text: Text  public: Bool = false }
identity login: Person.token from cookie "login"
identity agent: Person from token
policy person_rows: true for rows of Person
policy note_rows: .public or .owner == actor for rows of Note
// The notes you may see.
view notes() { rows Note }
// Adds a note of your own.
action add_note(text: Text) { require actor != none else unauthenticated  create Note { owner: actor, text: text } }
// Switches the agent interface on or off.
action set_agents(on: Bool) { set Settings.agents_on = on }
layout l { <main><Slot name=main /></main> }
screen home { route "/"  layout l  require public  <Fill name=main><Link href="/_agents" label="Agents" /></Fill> }
`);
const app = await startApp(join(dir, "app.crud"), 14031);
const call = async (name: string, args: any = {}, token?: string) => {
  const res = await fetch(app.base + "/_agent/call/" + name, { method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) }, body: JSON.stringify({ args }) });
  return { status: res.status, body: await res.json() as any };
};
try {
  await app.post("/_test/fixture", { rows: [
    { entity: "Settings", fields: {} },
    { entity: "Person", fields: { name: "Ann" }, save: "ann" },
    { entity: "Note", fields: { owner: "$ann", text: "open", public: true } },
    { entity: "Note", fields: { owner: "$ann", text: "secret" } },
  ] });
  // a minute's window starts on the minute: don't start a burst right before one ends
  if (new Date().getSeconds() > 50) await new Promise((r) => setTimeout(r, (61 - new Date().getSeconds()) * 1000));

  // ---- without a token
  const d = await (await fetch(app.base + "/_agent/describe")).json() as any;
  ok("without a token, describe lists the views only", d.callables?.length === 1 && d.callables[0].name === "notes" && /No token/.test(d.overview), d);
  const anon = await call("notes");
  ok("... and a view gives what a signed-out visitor sees (no hidden row)", anon.status === 200 && anon.body.rows?.length === 1 && anon.body.rows[0].text === "open", anon);
  const w = await call("add_note", { text: "x" });
  ok("... and an action is refused: unauthenticated", w.status === 401 && w.body.outcome === "unauthenticated", w);
  const mcp = await (await fetch(app.base + "/_mcp", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) })).json() as any;
  ok("... and MCP lists the views only", mcp.result?.tools?.map((t: any) => t.name).join() === "notes", mcp);
  const burst = [];
  for (let i = 0; i < 6; i++) burst.push((await call("notes")).status);
  ok("over its calls a minute an address is refused: blocked, 429", burst.slice(0, 3).every((s) => s === 200) && burst[burst.length - 1] === 429, burst);

  // ---- with a token
  const token = (await app.post("/_test/agent_token", { entity: "Person", id: 1, scope: "full" })).token;
  const mine = await call("notes", {}, token);
  ok("a token's own limit is its own, not its address's", mine.status === 200 && mine.body.rows?.length === 2, mine);
  const writes = [];
  for (let i = 0; i < 3; i++) writes.push((await call("add_note", { text: "n" + i }, token)).status);
  ok("over its actions a minute a token is refused: blocked", writes[0] === 200 && writes[1] === 200 && writes[2] === 429, writes);

  // ---- the switch
  const off = await fetch(app.base + "/_test/run", { method: "POST", body: JSON.stringify({ call: "set_agents", args: { on: false } }) });
  ok("(switched off)", off.ok);
  const offCall = await call("notes", {}, token);
  ok("switched off, a call answers 503", offCall.status === 503 && offCall.body.outcome === "unavailable", offCall);
  const llms = await fetch(app.base + "/llms.txt");
  ok("... and /llms.txt says it's off", llms.status === 503 && /switched off/.test(await llms.text()));
  ok("... and a person's own /_agents page is still there", (await fetch(app.base + "/_agents", { redirect: "manual" })).status !== 503);
  await fetch(app.base + "/_test/run", { method: "POST", body: JSON.stringify({ call: "set_agents", args: { on: true } }) });
  ok("switched on again, /llms.txt answers", (await fetch(app.base + "/llms.txt")).status === 200);
  ok("/_agents/all is for administrators only: not found to anyone else", (await fetch(app.base + "/_agents/all", { redirect: "manual" })).status === 404);
} finally { app.stop(); rmSync(dir, { recursive: true, force: true }); }
process.exit(failed ? 1 : 0);
