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
layout l { <Main><Slot name=main /></Main> }
component NoteRow(n: Note) { <div><strong>{n.title}</strong> <Text>{n.body}</Text></div> }
screen s { route "/"  layout l  access public  <List of={notes()} as=n><NoteRow n={n} /></List> }
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
// assets: addressed by content, kept for good, gzipped, revalidated by ETag
{
  const { mkdirSync } = await import("node:fs");
  const adir = join(dir, "assets"); mkdirSync(adir, { recursive: true });
  writeFileSync(join(adir, "app.css"), "body { margin: 0; color: #222 }\n".repeat(80));
  const tdir = join(dir, "themed"); mkdirSync(tdir, { recursive: true });   // an app of its own
  writeFileSync(join(tdir, "themed.crud"), SPEC + `theme t { stylesheets ["app.css"] }\n`);
  const tapp = await startApp(join(tdir, "themed.crud"), 13903, { assets: adir });
  try {
    const head = (path: string, headers: Record<string, string> = {}) => new Promise<{ status: number; headers: any; body: Buffer }>((done, fail) => {
      const u = new URL(tapp.base + path);
      const r = request({ host: u.hostname, port: u.port, path: u.pathname + u.search, headers }, (res) => { const parts: Buffer[] = []; res.on("data", (d) => parts.push(d)); res.on("end", () => done({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(parts) })); });
      r.on("error", fail); r.end();
    });
    const html = (await head("/")).body.toString();
    const href = html.match(/href="(\/assets\/app\.css\?v=[0-9a-f]+)"/)?.[1];
    ok("a page names its stylesheet with the content's hash", !!href, html.slice(0, 400));
    const v = await head(href!, { "Accept-Encoding": "gzip" });
    ok("... that address is kept for good, gzipped", v.status === 200 && /immutable/.test(v.headers["cache-control"]) && v.headers["content-encoding"] === "gzip" && gunzipSync(v.body).toString().startsWith("body { margin: 0"), v.headers);
    const plain = await head("/assets/app.css");
    ok("the plain address: 5 minutes, and an ETag", /max-age=300/.test(plain.headers["cache-control"]) && !!plain.headers["etag"] && plain.body.length > 1000, plain.headers);
    ok("... revalidated: 304, nothing sent", (await head("/assets/app.css", { "If-None-Match": plain.headers["etag"] })).status === 304);
  } finally { tapp.stop(); }
}
process.exit(failed ? 1 : 0);
