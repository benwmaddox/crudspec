// node lang/cli.ts watch <app>: builds the app, runs it, and builds and restarts it again on
// every change, for an agent (or a person) changing an app and looking at the result.
//
// The app runs behind a small proxy on --port. A change to a spec file (or anything else in the
// app's folder outside assets/) is built; while it builds, the last good build keeps serving. A
// change under assets/ only restarts the app (it reads them at start). A build that fails leaves
// the last good one running, says why (here, at /_watch/status, and in a banner on every page),
// and the next change tries again. A change to the stored schema migrates the watch's own data
// (node lang/cli.ts migrate, which keeps a backup) before the new build starts.
//
// For an agent:
//   GET /_watch/wait    returns once every change made before the call is built and serving (or
//                       failed): {"version", "state", "errors", "changed", "took_ms"}. It looks at
//                       the files itself, so it can be called the moment an edit is written.
//   GET /_watch/status  the same, at once
// For a person: pages reload themselves when a new version is live.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer, request, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as netServer } from "node:net";
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export type WatchOptions = { port: number; out?: string; data?: string; json?: boolean };
type State = "building" | "live" | "failed";
type Status = { version: number; state: State; url: string; changed: string[]; errors: string[]; took_ms: number; at: string };

const CLI = fileURLToPath(new URL("./cli.ts", import.meta.url));
const ROOT = resolve(dirname(CLI), "..");
const EXE = process.platform === "win32" ? "app.exe" : "app";
const SKIP = new Set(["node_modules", "build", "data", "target"]);

export async function watch(specFile: string, appDir: string, o: WatchOptions): Promise<never> {
  appDir = resolve(appDir);
  // the builds go inside crudspec's own target/ (on the drive crudspec is on, which the build needs,
  // and ignored by an app repository that keeps crudspec/ out of git)
  const out = resolve(o.out ?? join(ROOT, "target", "watch", basename(appDir)));
  const data = resolve(o.data ?? join(out, "data"));
  const assets = join(appDir, "assets");
  mkdirSync(data, { recursive: true });
  mkdirSync(assets, { recursive: true });
  const inner = await freePort();
  const url = `http://localhost:${o.port}`;

  const say = (msg: string, extra: Record<string, unknown> = {}) =>
    console.log(o.json ? JSON.stringify({ watch: msg, ...extra }) : `watch: ${msg}`);

  // ---- what changed: a scan of the app's folder (a few files; cheap enough to do on every wait)
  let seen = scan(appDir, [out, data]);
  const changes = (): string[] => {
    const now = scan(appDir, [out, data]);
    const diff = [...new Set([...now.keys(), ...seen.keys()])].filter((f) => now.get(f) !== seen.get(f));
    seen = now;
    return diff.sort();
  };

  // ---- the running app
  let proc: ChildProcess | null = null, slot = "b", running = "";
  let status: Status = { version: 0, state: "building", url, changed: [], errors: [], took_ms: 0, at: new Date().toISOString() };
  const listeners = new Set<ServerResponse>();
  const publish = (s: Partial<Status>) => {
    status = { ...status, ...s, at: new Date().toISOString() };
    for (const l of listeners) l.write(`data: ${JSON.stringify(status)}\n\n`);
  };
  const stop = async () => {
    const p = proc;
    proc = null;
    if (!p || p.exitCode !== null) return;
    await new Promise<void>((r) => { p.once("exit", () => r()); p.kill(); });
  };
  // starts the build in dir; resolves with what it printed if it stops before it answers /up
  const start = async (dir: string): Promise<string | null> => {
    let log = "";
    const p = spawn(join(dir, EXE), ["--data", data, "--assets", assets, "--port", String(inner), "--no-gzip"], { cwd: appDir, stdio: ["ignore", "pipe", "pipe"] });
    p.stdout!.on("data", (b) => { log += b; });
    p.stderr!.on("data", (b) => { log += b; });
    proc = p;
    for (let i = 0; i < 300; i++) {
      if (p.exitCode !== null) { proc = null; return log.trim() || `the app stopped (exit ${p.exitCode})`; }
      try { if ((await fetch(`http://127.0.0.1:${inner}/up`)).ok) { running = dir; return null; } } catch { /* starting */ }
      await sleep(50);
    }
    await stop();
    return log.trim() || "the app didn't answer in 15 s";
  };
  const node = (args: string[]) => spawnSync(process.execPath, [CLI, ...args], { cwd: process.cwd(), encoding: "utf8" });
  const lines = (r: { stdout: string; stderr: string }) =>
    (r.stdout + r.stderr).split("\n").map((l) => l.trimEnd()).filter((l) => l && !/MODULE_TYPELESS|Reparsing as ES|eliminate this warning|trace-warnings/.test(l));

  // one change at a time: a change made while a build runs is built after it
  let pending: string[] | null = ["(start)"];
  let busy: Promise<void> = Promise.resolve();
  const settle = () => (busy = busy.then(async () => {
    while (pending) {
      const changed = pending;
      pending = null;
      const rebuild = !running || changed.some((f) => !f.startsWith("assets/"));
      const t0 = Date.now();
      publish({ state: "building", changed });
      say(rebuild ? `building (${changed.join(", ")})` : `restarting (${changed.join(", ")})`);
      let dir = running;
      if (rebuild) {
        // into the slot not running: the last good build keeps serving meanwhile, and Windows
        // can't replace a running program
        slot = slot === "a" ? "b" : "a";
        dir = join(out, slot);
        const b = node(["build", specFile, "--out", dir]);
        if (b.status !== 0) {
          const errors = lines(b).filter((l) => !/^\s*\d+ \|/.test(l));
          publish({ state: "failed", errors, took_ms: Date.now() - t0 });
          say(`build failed${running ? `; version ${status.version} still serving` : ""}`, { errors });
          if (!o.json) for (const e of errors) console.log(`  ${e}`);
          continue;
        }
      }
      const last = running;
      await stop();
      let err = await start(dir);
      if (err && /Upgrade it first/.test(err)) {
        say("the stored schema changed: migrating the watch's data");
        const m = node(["migrate", specFile, "--data", data]);
        err = m.status === 0 ? await start(dir) : lines(m).join("\n");
      }
      if (err) {
        const errors = err.split("\n");
        if (last && last !== dir) await start(last);
        publish({ state: "failed", errors, took_ms: Date.now() - t0 });
        say(`the new build didn't start${running ? `; version ${status.version} still serving` : ""}`, { errors });
        if (!o.json) for (const e of errors) console.log(`  ${e}`);
        continue;
      }
      publish({ version: status.version + 1, state: "live", errors: [], took_ms: Date.now() - t0 });
      say(`version ${status.version} live at ${url} in ${status.took_ms} ms`, { version: status.version, took_ms: status.took_ms });
    }
  }));
  const look = () => {
    const c = changes();
    if (c.length) { pending = [...new Set([...(pending ?? []), ...c])]; settle(); }
  };
  setInterval(look, 300).unref();

  // ---- the proxy
  const server = createServer(async (req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    if (path === "/_watch/wait") { look(); await busy; return sendJSON(res, status); }
    if (path === "/_watch/status") { look(); return sendJSON(res, status); }
    if (path === "/_watch/events") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store" });
      res.write(`data: ${JSON.stringify(status)}\n\n`);
      listeners.add(res);
      req.on("close", () => listeners.delete(res));
      return;
    }
    if (path === "/_watch/reload.js") { res.writeHead(200, { "Content-Type": "text/javascript", "Cache-Control": "no-store" }); return res.end(RELOAD); }
    const body = await readBody(req);
    for (let i = 0; ; i++) {
      // while the app restarts (a few hundred ms) a request waits for it rather than failing
      if (!proc && !running) return sendPage(res, status);
      try { return await forward(req, body, res, inner); }
      catch {
        if (res.headersSent) return void res.end();   // the app stopped partway through a reply
        if (i > 150) return sendPage(res, status);
        await sleep(100);
      }
    }
  });
  await new Promise<void>((r, j) => { server.once("error", j); server.listen(o.port, () => r()); });
  say(`watching ${relative(process.cwd(), appDir) || "."} on ${url} (builds in ${relative(process.cwd(), out)}, data in ${relative(process.cwd(), data)})`);
  const quit = async () => { await stop(); process.exit(0); };
  process.on("exit", () => { if (proc && proc.exitCode === null) proc.kill(); });   // never leave the app running
  process.on("SIGINT", quit);
  process.on("SIGTERM", quit);
  settle();
  return new Promise<never>(() => {});
}

// every file under the app's folder, by its path with / and its size and time
function scan(dir: string, skip: string[]): Map<string, string> {
  const found = new Map<string, string>();
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.name.startsWith(".") || skip.some((s) => p === s || p.startsWith(s + sep))) continue;
      if (e.isDirectory()) { if (!SKIP.has(e.name)) walk(p); continue; }
      try { const s = statSync(p); found.set(relative(dir, p).split(sep).join("/"), `${s.size}:${s.mtimeMs}`); } catch { /* gone */ }
    }
  };
  if (existsSync(dir)) walk(dir);
  return found;
}

function forward(req: IncomingMessage, body: Buffer, res: ServerResponse, port: number): Promise<void> {
  return new Promise((done, fail) => {
    const headers = { ...req.headers };
    delete headers["accept-encoding"];
    const up = request({ host: "127.0.0.1", port, method: req.method, path: req.url, headers }, (r) => {
      const type = String(r.headers["content-type"] ?? "");
      if (!type.startsWith("text/html")) { res.writeHead(r.statusCode ?? 502, r.headers); r.pipe(res); r.on("end", done); return; }
      const parts: Buffer[] = [];
      r.on("data", (b) => parts.push(b));
      r.on("end", () => {
        const html = inject(Buffer.concat(parts).toString("utf8"));
        const h = { ...r.headers };
        delete h["content-length"];
        delete h["etag"];   // the page sent isn't the app's page byte for byte
        res.writeHead(r.statusCode ?? 502, { ...h, "content-length": Buffer.byteLength(html) });
        res.end(html);
        done();
      });
    });
    up.on("error", fail);
    up.end(body);
  });
}

const TAG = `<script src="/_watch/reload.js"></script>`;
const inject = (html: string) => (html.includes("</body>") ? html.replace("</body>", `${TAG}</body>`) : html + TAG);

// before the first build is up, or when none ever started: the errors, on a page that reloads
function sendPage(res: ServerResponse, s: Status) {
  const esc = (t: string) => t.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
  const html = `<!doctype html><meta charset="utf-8"><title>watch: ${s.state}</title><body style="font:14px system-ui;margin:2rem"><h1>${s.state === "building" ? "Building…" : "The app isn't running"}</h1><pre>${esc(s.errors.join("\n"))}</pre>${TAG}</body>`;
  res.writeHead(503, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Retry-After": "1" });
  res.end(html);
}
function sendJSON(res: ServerResponse, v: unknown) {
  res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(v));
}
const readBody = (req: IncomingMessage) => new Promise<Buffer>((r) => { const p: Buffer[] = []; req.on("data", (b) => p.push(b)); req.on("end", () => r(Buffer.concat(p))); });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise<number>((r) => { const s = netServer(); s.listen(0, "127.0.0.1", () => { const p = (s.address() as any).port; s.close(() => r(p)); }); });

// a page reloads when a new version is live, and shows a failed build's errors in a banner
const RELOAD = `(() => {
  let seen = null;
  const show = (s) => {
    let d = document.getElementById("_watch");
    if (s.state !== "failed") { if (d) d.remove(); return; }
    if (!d) {
      d = document.createElement("pre");
      d.id = "_watch";
      d.style.cssText = "position:fixed;left:0;right:0;bottom:0;margin:0;max-height:45vh;overflow:auto;background:#3b0d0d;color:#ffe1e1;font:12px/1.45 ui-monospace,monospace;padding:10px 12px;z-index:2147483647;white-space:pre-wrap";
      document.body.appendChild(d);
    }
    d.textContent = "watch: the last change didn't build; version " + s.version + " is still serving.\\n\\n" + s.errors.join("\\n");
  };
  const es = new EventSource("/_watch/events");
  es.onmessage = (e) => {
    const s = JSON.parse(e.data);
    if (seen === null) seen = s.version;
    if (s.state === "live" && s.version !== seen) { location.reload(); return; }
    show(s);
  };
})();
`;
