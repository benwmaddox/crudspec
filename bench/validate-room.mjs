// The benchmark's room_show contract check (loadgen validation.rs), in Node: for checking a
// server's room page before a benchmark run. usage: node bench/validate-room.mjs <url> <cookie> <contract.json>
import { readFileSync } from "node:fs";
const [url, cookie, contractPath] = process.argv.slice(2);
const c = JSON.parse(readFileSync(contractPath, "utf8"));
const r = await fetch(url, { headers: { Cookie: cookie } });
const text = await r.text();
const fail = (m) => { console.log(`INVALID: ${m}`); process.exit(1); };
if (r.status !== 200) fail(`status ${r.status}`);
if ((r.headers.get("content-type") ?? "").split(";")[0].trim() !== c.content_type) fail(`content type ${r.headers.get("content-type")}`);
const missing = c.required.filter((m) => !text.includes(m));
if (missing.length) fail(`missing ${missing.length} required markers, e.g. ${missing.slice(0, 3).join(" ")}`);
if (!/^<!doctype html>/i.test(text.trimStart()) || !text.trimEnd().endsWith("</html>")) fail("incomplete HTML document");
const ids = [...text.matchAll(/<div\b[^>]*\sdata-message-id="(\d+)"[^>]*>/g)];
const got = ids.map((m) => Number(m[1]));
if (JSON.stringify(got) !== JSON.stringify(c.message_ids)) fail(`message window: got ${got.length} ids [${got.slice(0, 3)}…], expected ${c.message_ids.length} [${c.message_ids.slice(0, 3)}…]`);
for (const [i, tokens] of c.message_content.entries()) {
  const start = ids[i].index + ids[i][0].length, end = ids[i + 1]?.index ?? text.length;
  const seg = text.slice(start, end);
  const pres = seg.match(/<div\b[^>]*\sid="presentation_message_([^"]+)"[^>]*>/);
  if (!pres) fail(`message ${got[i]}: missing presentation`);
  const ident = ids[i][0].match(/\sid="message_([^"]+)"/)?.[1];
  if (pres[1] !== String(got[i]) && pres[1] !== ident) fail(`message ${got[i]}: presentation identity ${pres[1]}`);
  let k = pres.index + pres[0].length, depth = 1, content = null;
  for (const t of seg.slice(k).matchAll(/<(\/?)div\b[^>]*>/gi)) { if (t[1] === "/") { if (--depth === 0) { content = seg.slice(k, k + t.index); break; } } else depth++; }
  if (content === null) fail(`message ${got[i]}: incomplete presentation`);
  const words = content.replace(/<[^>]*>/g, " ").match(/[A-Za-z0-9_]+/g) ?? [];
  let j = 0; for (const tok of tokens) { while (j < words.length && words[j] !== tok) j++; if (j++ >= words.length) fail(`message ${got[i]}: missing "${tok}" in ${JSON.stringify(words.slice(0, 12))}`); }
}
console.log(`valid: ${got.length} messages, ${text.length} bytes`);
