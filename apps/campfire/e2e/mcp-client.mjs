// The MCP endpoint with the official TypeScript SDK client (@modelcontextprotocol/sdk),
// over Streamable HTTP with a bearer token: connect, list tools, call a read and a preview.
// usage: node mcp-client.mjs <base> <token>   (run where the SDK is installed)
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const [base, token] = process.argv.slice(2);
const client = new Client({ name: "crudspec-e2e", version: "1.0.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/_mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
console.log("server:", JSON.stringify(client.getServerVersion()), "protocol:", client.transport?.protocolVersion ?? "(negotiated)");
const { tools } = await client.listTools();
const t = tools.find((x) => x.name === "delete_message");
console.log(`tools: ${tools.length}; delete_message annotations ${JSON.stringify(t.annotations)}`);
const read = await client.callTool({ name: "room_messages", arguments: { room: 1 } });
console.log(`room_messages: isError ${read.isError}, ${read.structuredContent.rows.length} rows`);
const posted = await client.callTool({ name: "post_message", arguments: { room: 1, body: "posted through the MCP SDK" } });
const id = posted.structuredContent.changes.Message.created[0];
const unconfirmed = await client.callTool({ name: "delete_message", arguments: { message: id } });
const preview = await client.callTool({ name: "delete_message", arguments: { message: id, dry_run: true } });
const done = await client.callTool({ name: "delete_message", arguments: { message: id, confirm: preview.structuredContent.confirm } });
console.log(`post ${posted.structuredContent.outcome}; delete without confirm: ${unconfirmed.structuredContent.outcome} (isError ${unconfirmed.isError}); preview ${preview.structuredContent.outcome}; confirmed ${done.structuredContent.outcome}`);
await client.close();
