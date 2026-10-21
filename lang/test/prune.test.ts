// Column pruning (gogen/rt/prune.go): every page of every app is the same with pruning on and
// off, and with the text fields it leaves out marked (X-Prune: check), no page shows a mark.
// Each page is rendered three times by one test app, so its signed values are the same.
//   node lang/test/prune.test.ts          (needs Go: on Windows, in WSL)
import { existsSync } from "node:fs";
import { parse } from "../parser.ts";
import { readSpec } from "../source.ts";
import { startApp } from "./go-app.ts";
import { loadFixture, screenPaths } from "./fixture.ts";

let failed = 0;
const ok = (what: string, pass: boolean, detail?: unknown) => { console.log(`${pass ? "ok  " : "FAIL"} ${what}`); if (!pass) { failed++; if (detail !== undefined) console.log(JSON.stringify(detail, null, 2).slice(0, 2000)); } };
const APPS: [string, number][] = [["apps/campfire", 13921], ["apps/tasks", 13922], ["apps/todomvc", 13923], ["app3", 13924]];
const MARK = "⟦pruned⟧";
// what differs from one render to the next whatever is read: links signed with the time (a
// session transfer and its QR code), and the fragment markers that hash them
const norm = (s: string) => s.replace(/<!--[^>]*-->/g, "").replace(/\/session\/transfers\/[A-Za-z0-9_.-]*/g, "/session/transfers/(link)").replace(/\/_qr\/[A-Za-z0-9_-]*/g, "/_qr/(qr)");
for (const [dir, port] of APPS) {
  const spec = parse(readSpec(dir));
  const assets = dir === "apps/campfire" && existsSync("/mnt/d/code/crudspec-assets/campfire") ? { assets: "/mnt/d/code/crudspec-assets/campfire" } : {};
  const app = await startApp(dir, port, assets);
  try {
    const headers = await loadFixture(app, spec);
    // (the fragment cache off, so each render reads the database)
    const page = async (path: string, prune: string) => { const r = await fetch(app.base + path, { headers: { ...headers, "X-No-Cache": "1", ...(prune ? { "X-Prune": prune } : {}) }, redirect: "manual" }); return `${r.status} ${r.headers.get("location") ?? ""}\n${await r.text()}`; };
    const differ: string[] = [], marked: string[] = [];
    let shown = 0;
    for (const [name, path] of screenPaths(spec)) {
      const off = await page(path, "0"), on = await page(path, ""), check = await page(path, "check");
      if (off.startsWith("200")) shown++;
      if (norm(on) !== norm(off)) differ.push(name);
      if (check.includes(MARK)) marked.push(name);
    }
    ok(`${dir}: every page (${shown} shown) the same with pruning on and off`, shown > 0 && differ.length === 0, differ);
    ok(`${dir}: no page shows a text field pruning left out`, marked.length === 0, marked);
  } finally { app.stop(); }
}
process.exit(failed ? 1 : 0);
