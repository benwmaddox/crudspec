// Two builds of the compiler give the same pages: every routed screen of every app, on the generic
// fixture, and Campfire's room page on the benchmark's snapshot, byte for byte. For changes that
// must not change what a page shows (speed, memory). Run in WSL, with each app built by both:
//   node bench/same-pages.ts <old root> <new root>      (a root holds <app>/app, e.g. campfire/app)
// Each build gets its own data, with the same secret, so signed values match.
import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parse } from "../lang/parser.ts";
import { readSpec } from "../lang/source.ts";
import { loadFixture, screenPaths } from "../lang/test/fixture.ts";
import type { App } from "../lang/test/go-app.ts";

const [oldRoot, newRoot] = process.argv.slice(2);
if (!oldRoot || !newRoot) { console.error("usage: node bench/same-pages.ts <old root> <new root>"); process.exit(64); }
const APPS: [string, string][] = [["campfire", "apps/campfire"], ["tasks", "apps/tasks"], ["todomvc", "apps/todomvc"], ["app3", "app3"]];
const ASSETS = "/mnt/d/code/crudspec-assets/campfire";
const SNAP = "/mnt/d/code/crudspec-run/bench-snap-nc5", ROOM = "/rooms/486777696";
const SECRET = "0".repeat(64);
// what differs from one render to the next whatever the build: links signed with the time, and
// a fragment's end marker's hash of its content (seeded per process; its id is kept), and the
// web push key (made for each data directory)
const norm = (s: string) => s.replace(/(<!--\/f:[0-9a-f]{16}) [0-9a-z]+/g, "$1 (hash)").replace(/data-push-key="[^"]*"/g, "data-push-key=(key)").replace(/\/session\/transfers\/[A-Za-z0-9_.-]*/g, "/session/transfers/(link)").replace(/\/_qr\/[A-Za-z0-9_-]*/g, "/_qr/(qr)");

async function run(bin: string, data: string, port: number, args: string[], f: (app: App) => Promise<void>) {
  const proc: ChildProcess = spawn(bin, ["--data", data, "--port", String(port), ...args], { stdio: "ignore", env: { ...process.env, TZ: "America/New_York" } });
  const base = `http://127.0.0.1:${port}`;
  let up = false;
  for (let i = 0; i < 300 && !up; i++) { try { up = (await fetch(`${base}/up`)).ok; } catch { /* starting */ } if (!up) await new Promise((r) => setTimeout(r, 100)); }
  if (!up) { proc.kill(); throw new Error(`${bin} didn't start`); }
  const post = async (path: string, body: unknown) => { const r = await fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); const t = await r.text(); try { return { status: r.status, ...JSON.parse(t) }; } catch { return { status: r.status, text: t }; } };
  try { await f({ base, dir: data, stop: () => proc.kill(), post }); }
  finally { proc.kill(); await new Promise((r) => setTimeout(r, 200)); }
}

let failed = 0, port = 13940;   // each app on its own port, the same for both builds (absolute links show it)
for (const [name, dir] of APPS) {
  const spec = parse(readSpec(dir));
  const assets = name === "campfire" && existsSync(ASSETS) ? ["--assets", ASSETS] : [];
  const pages: Record<string, string>[] = [];
  port++;
  for (const root of [oldRoot, newRoot]) {
    const data = mkdtempSync(join(tmpdir(), "same-pages-"));
    writeFileSync(join(data, "secret"), SECRET);
    const got: Record<string, string> = {};
    await run(join(root, name, "app"), data, port, ["--test", ...assets], async (app) => {
      const headers = await loadFixture(app, spec);
      for (const [screen, path] of screenPaths(spec)) {
        const r = await fetch(app.base + path, { headers: { ...headers, "X-No-Cache": "1" }, redirect: "manual" });
        got[screen] = `${r.status} ${r.headers.get("location") ?? ""}\n${norm(await r.text())}`;
      }
    });
    rmSync(data, { recursive: true, force: true });
    pages.push(got);
  }
  const differ = Object.keys(pages[0]).filter((k) => pages[0][k] !== pages[1][k]);
  const shown = Object.values(pages[0]).filter((p) => p.startsWith("200")).length;
  console.log(`${differ.length ? "FAIL" : "ok  "} ${name}: ${Object.keys(pages[0]).length} screens (${shown} shown) the same${differ.length ? `; differ: ${differ.join(", ")}` : ""}`);
  if (differ.length) {
    failed++;
    const k = differ[0], a = pages[0][k], b = pages[1][k];
    let i = 0; while (i < a.length && a[i] === b[i]) i++;
    console.log(`  ${k} first differs at ${i}:\n  old …${a.slice(Math.max(0, i - 120), i + 120)}\n  new …${b.slice(Math.max(0, i - 120), i + 120)}`);
  }
}
// Campfire's room page on the benchmark's snapshot (both builds on copies of it: the same secret and keys)
if (existsSync(SNAP)) {
  port++;
  const bodies: string[] = [];
  for (const root of [oldRoot, newRoot]) {
    const data = mkdtempSync(join(tmpdir(), "same-room-"));
    cpSync(SNAP, data, { recursive: true });
    rmSync(join(data, "app.lock"), { force: true });
    if (!existsSync(join(data, "secret"))) writeFileSync(join(data, "secret"), SECRET);
    const token = (new DatabaseSync(join(data, "app.sqlite")).prepare("select token from Session where id = 481019661").get() as any).token;
    await run(join(root, "campfire", "app"), data, port, ["--assets", ASSETS], async (app) => {
      const r = await fetch(app.base + ROOM, { headers: { Cookie: `session_token=${token}`, "X-No-Cache": "1" } });
      bodies.push(norm(await r.text()));
    });
    rmSync(data, { recursive: true, force: true });
  }
  const same = bodies[0] === bodies[1];
  console.log(`${same ? "ok  " : "FAIL"} campfire room page on the snapshot: ${bodies[0].length} and ${bodies[1].length} chars, ${same ? "the same" : "different"}`);
  if (!same) {
    failed++;
    const [a, b] = bodies; let i = 0; while (i < a.length && a[i] === b[i]) i++;
    console.log(`  first differs at ${i}:
  old …${a.slice(Math.max(0, i - 120), i + 120)}
  new …${b.slice(Math.max(0, i - 120), i + 120)}`);
  }
}
console.log(failed ? `${failed} FAILED` : "all the same");
process.exit(failed ? 1 : 0);
