// A stand-in for an S3-compatible bucket service, for tests: PUT, GET, DELETE and ListObjectsV2,
// kept in a folder (one subfolder per bucket). Signatures aren't checked.
//   node lang/test/fake-s3.mjs <port> <folder>
import { createServer } from "node:http";
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";

const [port, root] = [Number(process.argv[2]), process.argv[3]];
const walk = (dir) => (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)])) : []);
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  const [bucket, ...rest] = decodeURIComponent(u.pathname).slice(1).split("/");
  const key = rest.join("/");
  const file = join(root, bucket, key);
  if (req.method === "PUT") {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, Buffer.concat(chunks)); res.end(); });
    return;
  }
  if (req.method === "GET" && !key) {
    const prefix = u.searchParams.get("prefix") ?? "";
    const items = walk(join(root, bucket)).map((f) => ({ key: relative(join(root, bucket), f).split("\\").join("/"), at: statSync(f).mtime })).filter((o) => o.key.startsWith(prefix));
    res.setHeader("Content-Type", "application/xml");
    res.end(`<?xml version="1.0"?><ListBucketResult><IsTruncated>false</IsTruncated>${items.map((o) => `<Contents><Key>${esc(o.key)}</Key><LastModified>${o.at.toISOString()}</LastModified></Contents>`).join("")}</ListBucketResult>`);
    return;
  }
  if (req.method === "GET") { if (!existsSync(file)) { res.statusCode = 404; res.end(); return; } res.end(readFileSync(file)); return; }
  if (req.method === "DELETE") { rmSync(file, { force: true }); res.statusCode = 204; res.end(); return; }
  res.statusCode = 405; res.end();
}).listen(port, "127.0.0.1", () => console.log("ready"));
