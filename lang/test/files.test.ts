// Uploads in a compiled app: a form's file is kept in the file store and served at
// /files/<key> (inline for an image, with the uploads' locked-down headers), an avatar at
// /avatars/<Entity>/<id>, a thumbnail at /files/<key>?w=N, and url_of(file) is the address
// it is served at.
//   node lang/test/files.test.ts
process.removeAllListeners("warning");
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { startApp } from "./go-app.ts";

let failed = 0;
const ok = (what: string, pass: boolean, detail?: unknown) => { console.log(`${pass ? "ok  " : "FAIL"} ${what}`); if (!pass) { failed++; if (detail !== undefined) console.log("     ", JSON.stringify(detail)); } };

// a w×h opaque PNG
function png(w: number, h: number): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Buffer) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = y * (w * 3 + 1) + 1 + x * 3; raw[i] = x % 256; raw[i + 1] = y % 256; raw[i + 2] = 128; }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

const dir = mkdtempSync(join(tmpdir(), "crudspec-files-"));
writeFileSync(join(dir, "app.crud"), `app t { name "T" actor User }
entity User { name: Text  token: Text?  avatar: File?  unique (token) }
identity login: User.token from cookie "login"
policy pu: true for rows of User
show User { label: .name  picture: if .avatar != none { .avatar } else { initials(.name) } }
// Sets your picture.
action set_avatar(avatar: File) { callers people  require actor != none else unauthenticated  set actor.avatar = avatar }
layout l { <main><Slot name=main /></main> }
screen s(u: User) { route "/u/:u"  layout l  require public
  <Fill name=main>
    {if u.avatar != none { <Image thumb={200} class="t">{u.avatar}</Image> <Image thumb={400} class="e" eager={true}>{u.avatar}</Image> <a class="full" href={url_of(u.avatar)}>full</a> }}
  </Fill> }
`);
const app = await startApp(join(dir, "app.crud"), 14021);
try {
  await app.post("/_test/load", { clock: 1000, rows: { User: [{ id: 1, seq: 1, created: 1, updated: 1, fields: { name: "ann", token: null, avatar: null } }] } });
  const form = new FormData();
  form.append("avatar", new Blob([png(640, 320)], { type: "image/png" }), "me.png");
  const res = await fetch(app.base + "/_do/set_avatar", { method: "POST", headers: { "X-Test-Actor": "User:1" }, body: form, redirect: "manual" });
  ok("a form's upload is taken", res.headers.get("X-Crudspec-Outcome") === "ok", { status: res.status, outcome: res.headers.get("X-Crudspec-Outcome") });
  const html = await (await fetch(app.base + "/u/1")).text();
  const thumb = html.match(/<img class="t" src="([^"]+)"/)?.[1] ?? "";
  const full = html.match(/<a class="full" href="([^"]+)"/)?.[1] ?? "";
  ok("<Image thumb={200}> asks for the 200-pixel thumbnail", /^\/files\/[A-Za-z0-9_-]+\.png\?w=200$/.test(thumb), thumb);
  ok("<Image> loads lazily by default (the browser's own, no script)", /<img class="t"[^>]* loading="lazy" decoding="async"/.test(html), html.match(/<img class="t"[^>]*>/)?.[0]);
  ok("<Image eager={true}> loads with the page, first", /<img class="e"[^>]* fetchpriority="high"/.test(html) && !/<img class="e"[^>]*loading=/.test(html), html.match(/<img class="e"[^>]*>/)?.[0]);
  ok("<Image> carries the shown size, so the page keeps its space (640×320 at 200 wide)", /<img class="t" src="[^"]+" width="200" height="100"/.test(html), html.match(/<img class="t"[^>]*>/)?.[0]);
  ok("url_of(file) is its stored key's address, not its name", /\/files\/[A-Za-z0-9_-]+\.png$/.test(full) && !full.endsWith("/me.png"), full);
  const orig = await fetch(app.base + new URL(full).pathname);
  const ob = Buffer.from(await orig.arrayBuffer());
  ok("the original is served inline, locked down", orig.status === 200 && orig.headers.get("content-type") === "image/png" && orig.headers.get("content-security-policy") === "default-src 'none'; sandbox" && ob.readUInt32BE(16) === 640,
    { status: orig.status, type: orig.headers.get("content-type") });
  const t = await fetch(app.base + thumb);
  const tb = Buffer.from(await t.arrayBuffer());
  const jpegWidth = (b: Buffer) => { for (let i = 2; i < b.length - 9;) { if (b[i] !== 0xff) return 0; const m = b[i + 1], len = b.readUInt16BE(i + 2); if (m >= 0xc0 && m <= 0xc3) return b.readUInt16BE(i + 7); i += 2 + len; } return 0; };
  ok("the thumbnail is a JPEG 200 pixels wide", t.status === 200 && t.headers.get("content-type") === "image/jpeg" && jpegWidth(tb) === 200, { status: t.status, type: t.headers.get("content-type"), width: jpegWidth(tb) });
  const av = await fetch(app.base + "/avatars/User/1");
  ok("the avatar is served from the store too", av.status === 200 && Buffer.from(await av.arrayBuffer()).equals(ob), av.status);
  ok("an unknown key is not found", (await fetch(app.base + "/files/nope.png")).status === 404);
  ok("a key with a path is not found", (await fetch(app.base + "/files/..%2Fapp.sqlite")).status === 404);
  // (not files: a screen's address naming a row there isn't is not found, before its requires)
  ok("an address naming no row is not found: /u/999, /u/abc", (await fetch(app.base + "/u/999")).status === 404 && (await fetch(app.base + "/u/abc")).status === 404);
  ok("... and one naming a row renders", (await fetch(app.base + "/u/1")).status === 200);
} finally { app.stop(); rmSync(dir, { recursive: true, force: true }); }
// Files follow their row (lang/filereads.ts): a file is served to someone who may read a row that
// holds it, so a private space's picture is its owner's, and a deleted row's file is no one's.
const dir2 = mkdtempSync(join(tmpdir(), "crudspec-files-"));
writeFileSync(join(dir2, "app.crud"), `app t { name "T" actor User }
entity User { name: Text  token: Text?  unique (token) }
identity login: User.token from cookie "login"
entity Space { name: Text  owner: User  open: Bool }
entity Pic { space: Space  file: File }
policy pu: true for rows of User
policy spaces: space.open or space.owner == actor for rows in Space
policy signed_in: actor != none else unauthenticated for every action
// Adds a picture to a space.
action add_pic(space: Space, file: File) { callers people  create Pic { space: space, file: file } }
// Deletes a picture.
action drop_pic(pic: Pic with .space) { callers people  delete pic }
`);
const app2 = await startApp(join(dir2, "app.crud"), 14022);
try {
  await app2.post("/_test/load", { clock: 1000, rows: {
    User: [{ id: 1, seq: 1, created: 1, updated: 1, fields: { name: "ann", token: null } }, { id: 2, seq: 2, created: 1, updated: 1, fields: { name: "bo", token: null } }],
    Space: [{ id: 1, seq: 3, created: 1, updated: 1, fields: { name: "open", owner: { ref: "User", id: 1 }, open: true } }, { id: 2, seq: 4, created: 1, updated: 1, fields: { name: "closed", owner: { ref: "User", id: 1 }, open: false } }] } });
  const up = async (space: number) => {
    const form = new FormData();
    form.append("__arg_space", "#" + space);
    form.append("file", new Blob([png(40, 20)], { type: "image/png" }), "p.png");
    const res = await fetch(app2.base + "/_do/add_pic", { method: "POST", headers: { "X-Test-Actor": "User:1" }, body: form, redirect: "manual" });
    return res.headers.get("X-Crudspec-Outcome");
  };
  ok("pictures added to an open space and a closed one", (await up(1)) === "ok" && (await up(2)) === "ok");
  const keys = await app2.post("/_test/dump", {});
  const ks: string[] = (keys?.rows?.Pic ?? []).map((r: any) => { const f = r.fields?.file; return typeof f === "string" ? f : f?.stored ?? ""; });
  const get = async (k: string, actor?: string, w = "") => (await fetch(`${app2.base}/files/${k}${w}`, { headers: actor ? { "X-Test-Actor": actor } : {} })).status;
  if (ks.length === 2) {
    ok("an open space's picture is anyone's, signed in or not (an every-action gate doesn't hide it)", (await get(ks[0])) === 200 && (await get(ks[0], "User:2")) === 200);
    ok("a closed space's picture is its owner's", (await get(ks[1], "User:1")) === 200);
    ok("... not found for anyone else, and its thumbnails too", (await get(ks[1])) === 404 && (await get(ks[1], "User:2")) === 404 && (await get(ks[1], undefined, "?w=100")) === 404);
    await fetch(app2.base + "/_do/drop_pic", { method: "POST", headers: { "X-Test-Actor": "User:1", "Content-Type": "application/x-www-form-urlencoded" }, body: "__arg_pic=%231", redirect: "manual" });
    ok("a deleted row's file is no one's", (await get(ks[0])) === 404 && (await get(ks[0], "User:1")) === 404);
  } else ok("the stored keys are read back", false, keys);
} finally { app2.stop(); rmSync(dir2, { recursive: true, force: true }); }

process.exit(failed ? 1 : 0);
