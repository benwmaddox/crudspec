// Compressed pages (rt/gzip.go): a client that takes gzip gets it, one that doesn't gets the page
// as it is, and the two are the same page, rendered afresh and from the fragment cache alike.
//   node lang/test/gzip.test.ts
import { request } from "node:http";
import { gunzipSync } from "node:zlib";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApp } from "./go-app.ts";

let failed = 0;
const ok = (what: string, pass: boolean, detail?: unknown) => { console.log(`${pass ? "ok  " : "FAIL"} ${what}`); if (!pass) { failed++; if (detail !== undefined) console.log(JSON.stringify(detail).slice(0, 400)); } };
const SPEC = `
app t { name "T" actor User }
entity User { name: Text  token: Text? }
identity login: User.token from cookie "login"
entity Note { title: Text  body: Text }
permission read Note: true
view notes() { rows Note where true order by .title }
layout l { <main><slot name=main /></main> }
component note_row(n: Note) { <row><strong>{n.title}</strong> <text>{n.body}</text></row> }
screen s { route "/"  layout l  access public  <list of={notes()} as=n><note_row n={n} /></list> }
`;
const dir = mkdtempSync(join(tmpdir(), "gzip-"));
writeFileSync(join(dir, "app.crud"), SPEC);
const app = await startApp(join(dir, "app.crud"), 13901);
// a raw GET: the body as sent, and its headers
const get = (path: string, enc?: string) => new Promise<{ headers: any; body: Buffer }>((done, fail) => {
  const u = new URL(app.base + path);
  const r = request({ host: u.hostname, port: u.port, path: u.pathname, headers: enc ? { "Accept-Encoding": enc } : {} }, (res) => { const parts: Buffer[] = []; res.on("data", (d) => parts.push(d)); res.on("end", () => done({ headers: res.headers, body: Buffer.concat(parts) })); });
  r.on("error", fail); r.end();
});
// the page's live data, which in --test lists its read keys in no fixed order, left out
const page = (b: Buffer | string) => b.toString().replace(/<script id="crudspec-page"[\s\S]*?<\/script>/, "");
try {
  const row = (id: number, fields: Record<string, unknown>) => ({ id, seq: id, created: 100 + id, updated: 100 + id, fields });
  await app.post("/_test/load", { clock: 1000, rows: { User: [], Note: Array.from({ length: 60 }, (_, i) => row(i + 1, { title: `note ${String(i).padStart(2, "0")}`, body: "lorem ipsum dolor sit amet ".repeat(4) })) } });
  const plain = await get("/");
  ok("no Accept-Encoding: the page as it is", !plain.headers["content-encoding"] && plain.body.toString().includes("note 00") && Number(plain.headers["content-length"]) === plain.body.length, plain.headers);
  const z1 = await get("/", "gzip, deflate, br");
  ok("gzip asked for: gzip, with its length", z1.headers["content-encoding"] === "gzip" && Number(z1.headers["content-length"]) === z1.body.length && /Accept-Encoding/i.test(String(z1.headers["vary"])), z1.headers);
  const page1 = gunzipSync(z1.body).toString();
  ok("... it is the same page", page(page1) === page(plain.body), { gz: page1.length, plain: plain.body.length });
  ok("... much smaller", z1.body.length < plain.body.length / 4, { gz: z1.body.length, plain: plain.body.length });
  const z2 = await get("/", "gzip");
  ok("again, from the fragment cache: the same page", page(gunzipSync(z2.body)) === page(plain.body));
  ok("gzip;q=0 is refused, so not gzip", !(await get("/", "gzip;q=0, br")).headers["content-encoding"]);
} finally { app.stop(); }
process.exit(failed ? 1 : 0);
