// The agent interface end to end, over plain HTTP: a person issues a token at /_agents; the
// agent describes the app, reads, posts, previews and confirms a delete, and uses MCP; a
// read-only token can't write; the audit shows every call; deactivating the person cuts off
// their agents. Runs against a runtime whose data has Ada (administrator) and room 1.
const [base, email = "ada@example.test", password = "correct horse battery"] = process.argv.slice(2);
const out = (k, v) => console.log(`${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
async function signIn(e, p) {
  const r = await fetch(`${base}/_do/sign_in`, { method: "POST", redirect: "manual", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ email: e, password: p }) });
  return (r.headers.getSetCookie().find((c) => c.startsWith("session_token=")) ?? "").split(";")[0];
}
async function issue(cookie, label, scope) {
  const r = await fetch(`${base}/_agents/issue`, { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ label, scope }) });
  return (await r.text()).match(/<code>(cs_[^<]+)<\/code>/)?.[1];
}
const call = async (tok, name, body) => { const r = await fetch(`${base}/_agent/call/${name}`, { method: "POST", headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" }, body: JSON.stringify(body) }); return { status: r.status, ...(await r.json()) }; };
const mcp = async (tok, method, params, id = 1) => (await (await fetch(`${base}/_mcp`, { method: "POST", headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) })).json());

const ada = await signIn(email, password);
const full = await issue(ada, "e2e full", "full"), read = await issue(ada, "e2e read", "read");
out("tokens issued", !!full && !!read);
out("no token", (await call("nope", "room_messages", { args: { room: 1 } })).outcome);

const d = await (await fetch(`${base}/_agent/describe`, { headers: { Authorization: `Bearer ${full}` } })).json();
const pick = (n) => d.callables.find((c) => c.name === n);
out("describe", `${d.callables.length} callables, acting as ${d.actor}`);
out("post_message annotations", pick("post_message").annotations);
out("delete_message needs confirm", pick("delete_message").confirm);

const posted = await call(full, "post_message", { args: { room: 1, body: "hello from an agent" }, idempotency_key: "e2e-1" });
const again = await call(full, "post_message", { args: { room: 1, body: "hello from an agent" }, idempotency_key: "e2e-1" });
const mid = posted.changes?.Message?.created?.[0];
out("post", `${posted.outcome}, message ${mid}; same key again: ${again.outcome}, replayed ${again.replayed === true}, message ${again.changes?.Message?.created?.[0]}`);
const msgs = await call(full, "room_messages", { args: { room: 1 } });
const mine = msgs.rows?.find((m) => m.id === mid);
out("read back", mine ? `${mine.body.text} by ${mine.creator.label}` : "missing");
out("bad args", (await call(full, "post_message", { args: { room: "one" } })).error);

out("delete without confirm", (await call(full, "delete_message", { args: { message: mid } })).outcome);
const dry = await call(full, "delete_message", { args: { message: mid }, dry_run: true });
out("dry run", `${dry.outcome}, checked by ${dry.checked_by}, changes ${JSON.stringify(dry.changes)}, confirm given ${!!dry.confirm}`);
out("still there after the dry run", !!(await call(full, "room_messages", { args: { room: 1 } })).rows.find((m) => m.id === mid));
await call(full, "post_message", { args: { room: 1, body: "something changed" } });
out("confirm after the data changed", (await call(full, "delete_message", { args: { message: mid }, confirm: dry.confirm })).outcome);
const dry2 = await call(full, "delete_message", { args: { message: mid }, dry_run: true });
const del = await call(full, "delete_message", { args: { message: mid }, confirm: dry2.confirm });
out("confirmed delete", `${del.outcome}, ${JSON.stringify(del.changes)}`);

out("read-only token writes", (await call(read, "post_message", { args: { room: 1, body: "x" } })).outcome);
out("read-only token reads", (await call(read, "room_messages", { args: { room: 1 } })).outcome);

const init = await mcp(full, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "1" } });
const list = await mcp(full, "tools/list", {}, 2);
const tool = list.result.tools.find((t) => t.name === "delete_room");
out("mcp", `${init.result.serverInfo.name}, ${list.result.tools.length} tools; delete_room annotations ${JSON.stringify(tool.annotations)}, has confirm param ${!!tool.inputSchema.properties.confirm}`);
const viaMcp = await mcp(full, "tools/call", { name: "room_messages", arguments: { room: 1 } }, 3);
out("mcp call", `isError ${viaMcp.result.isError}, ${viaMcp.result.structuredContent.rows.length} rows`);
out("mcp read-only tools", (await mcp(read, "tools/list", {}, 4)).result.tools.every((t) => t.annotations.readOnlyHint));

const leaks = JSON.stringify(await call(full, "account_users", { args: {} }));
out("secrets in user rows", /bot_token|password|"token"/.test(leaks));

const page = await (await fetch(`${base}/_agents`, { headers: { Cookie: ada } })).text();
out("audit lists calls", (page.match(/<td>delete_message/g) ?? []).length >= 3);

// deactivating someone cuts off their agents
const roomPage = await (await fetch(`${base}/rooms/1`, { headers: { Cookie: ada } })).text();
const code = roomPage.match(/\/join\/([\w-]+)/)?.[1];
const newEmail = `agent-e2e-${Date.now()}@example.test`;
await fetch(`${base}/_do/join`, { method: "POST", redirect: "manual", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ join_code: code, name: "Nia Agent", email: newEmail, password: "nia-password-1" }) });
const nia = await signIn(newEmail, "nia-password-1");
const niaToken = await issue(nia, "nia's agent", "full");
const before = (await call(niaToken, "room_messages", { args: { room: 1 } })).outcome;
const niaId = (await call(full, "account_users", { args: {} })).rows.find((u) => u.email === newEmail)?.id;
const pre = await call(full, "deactivate_user", { args: { user: niaId }, dry_run: true });
const deact = await call(full, "deactivate_user", { args: { user: niaId }, confirm: pre.confirm });
const after = await call(niaToken, "room_messages", { args: { room: 1 } });
out("deactivation", `nia's agent before: ${before}; deactivated: ${deact.outcome}; nia's agent after: ${after.outcome} (${after.error?.message})`);

// an idempotency key reused for a different call is refused, not replayed
const k1 = await call(full, "post_message", { args: { room: 1, body: "first use" }, idempotency_key: "e2e-reuse" });
const k2 = await call(full, "post_message", { args: { room: 1, body: "different" }, idempotency_key: "e2e-reuse" });
out("key reused for a different call", `${k1.outcome}, then ${k2.outcome}: ${k2.error?.message}`);

// MCP calls carry the caller's address: a write from a banned address is blocked
const bannedIp = "198.51.100.77";
const zedEmail = `zed-${Date.now()}@example.test`;
await fetch(`${base}/_do/join`, { method: "POST", redirect: "manual", headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Forwarded-For": bannedIp }, body: new URLSearchParams({ join_code: code, name: "Zed Banned", email: zedEmail, password: "zed-password-1" }) });
const zedId = (await call(full, "account_users", { args: {} })).rows.find((u) => u.email === zedEmail)?.id;
const banDry = await call(full, "ban_user", { args: { user: zedId }, dry_run: true });
await call(full, "ban_user", { args: { user: zedId }, confirm: banDry.confirm });
const fromBanned = await (await fetch(`${base}/_mcp`, { method: "POST", headers: { Authorization: `Bearer ${full}`, "Content-Type": "application/json", "X-Forwarded-For": bannedIp }, body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "post_message", arguments: { room: 1, body: "from a banned address" } } }) })).json();
out("mcp write from a banned address", fromBanned.result.structuredContent.outcome);
out("GET /_mcp", (await fetch(`${base}/_mcp`, { headers: { Authorization: `Bearer ${full}` } })).status);
