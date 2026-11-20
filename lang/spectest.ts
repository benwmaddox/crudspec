// Runs a spec's tests (docs/testing.md): builds the app, starts it in --test mode on a free port,
// and sends each test to its /_test/spec, which runs the steps in the app (lang/gogen/rt/
// spectest.go) on an empty database. The expect and wait conditions are functions the app was
// compiled with (lang/testdecls.ts), so a test checks the program that ships.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { request } from "node:http";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "./parser.ts";
import { at, readSource } from "./source.ts";

export type TestResult = { name: string; line: string; ok: boolean; step?: string; message?: string };

// plain http (fetch's pooled sockets trip a libuv assertion when the CLI exits on Windows)
const http = (url: string, body?: string) => new Promise<{ status: number; text: string }>((ok, fail) => {
  const req = request(url, { method: body === undefined ? "GET" : "POST", agent: false, headers: { connection: "close" } }, (res) => {
    let text = ""; res.setEncoding("utf8"); res.on("data", (c) => (text += c)); res.on("end", () => ok({ status: res.statusCode ?? 0, text }));
  });
  req.on("error", fail);
  req.end(body);
});

const freePort = () => new Promise<number>((ok, fail) => {
  const s = createServer(); s.unref(); s.on("error", fail);
  s.listen(0, "127.0.0.1", () => { const p = (s.address() as any).port; s.close(() => ok(p)); });
});

// a test value as the app takes it: a row the test made ({"$": name}), an enum value as text, a literal
function value(x: any, made: Set<string>): any {
  if (!x) return null;
  if (x.kind === "lit") return x.value;
  if (x.kind === "unary" && x.op === "neg" && x.arg?.kind === "lit") return -x.arg.value;
  if (x.kind === "name") return made.has(x.name) ? { $: x.name } : x.name;
  if (x.kind === "field") return x.name;   // Role.admin
  return null;
}

export function testsOf(file: string) {
  return parse(readSource(file).text).decls.filter((d) => d.kind === "test") as any[];
}

export async function runTests(file: string, opts: { filter?: string; log?: (s: string) => void } = {}): Promise<TestResult[]> {
  const log = opts.log ?? ((s: string) => console.log(s));
  const src = readSource(file);
  const spec = parse(src.text);
  const tests = (spec.decls.filter((d) => d.kind === "test") as any[]).filter((t) => !opts.filter || t.name.includes(opts.filter));
  if (!tests.length) return [];
  const targets = new Map(spec.decls.filter((d) => d.kind === "action" || d.kind === "view").map((d) => [d.name, d as any]));
  // built beside the language (target/ is ignored): Go's module paths can't cross drives on Windows
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const dir = join(root, "target", "spectest", basename(dirname(resolve(file))));
  rmSync(join(dir, "data"), { recursive: true, force: true });
  mkdirSync(join(dir, "data"), { recursive: true });
  const b = spawnSync(process.execPath, [join(root, "lang", "cli.ts"), "build", file, "--out", join(dir, "build")], { encoding: "utf8" });
  if (b.status !== 0) {
    log((b.stdout + b.stderr).split("\n").filter((l) => l && !/MODULE_TYPELESS|Reparsing|eliminate this|trace-warnings/.test(l)).join("\n"));
    throw new Error("the app didn't build, so its tests can't run");
  }
  const port = await freePort();
  const assets = join(dirname(resolve(file)), "assets");
  const exe = join(dir, "build", "app" + (process.platform === "win32" ? ".exe" : ""));
  const errLog = join(dir, "app.log");
  const proc = spawn(exe, ["--data", join(dir, "data"), "--assets", existsSync(assets) ? assets : join(dir, "data"), "--port", String(port), "--test", "--offline"], { stdio: ["ignore", "ignore", openSync(errLog, "w")] });
  const base = `http://127.0.0.1:${port}`;
  const results: TestResult[] = [];
  try {
    let up = false;
    for (let i = 0; i < 300 && !up; i++) { try { up = (await http(base + "/up")).status === 200; } catch { /* starting */ } if (!up) await new Promise((r) => setTimeout(r, 100)); }
    if (!up) throw new Error("the app didn't start");
    const lines = src.text.split("\n");
    for (const t of tests) {
      const made = new Set<string>();
      const steps = t.steps.map((s: any) => {
        if (s.kind === "create") {
          const out = { kind: "create", entity: s.entity, save: s.save, fields: Object.fromEntries(s.fields.map((f: any) => [f.name, value(f.value, made)])) };
          made.add(s.save); return out;
        }
        if (s.kind === "run") {
          const ps = (targets.get(s.call)?.params ?? []).map((p: any) => p.name);
          const args: Record<string, any> = {};
          s.args.forEach((a: any, i: number) => { args[ps[i]] = value(a, made); });
          for (const [k, v] of Object.entries(s.named)) args[k] = value(v, made);
          if (s.save) made.add(s.save);
          return { kind: "run", call: s.call, args, by: s.by ?? null, host: s.host, expect: s.expect, rows: s.rows, save: s.save };
        }
        return { kind: s.kind, fn: s.fn, refs: s.refs, host: s.host };
      });
      const resp = await http(base + "/_test/spec", JSON.stringify({ steps }));
      if (resp.status !== 200) throw new Error(`the app failed running test "${t.name}" (${resp.status}): ${readFileSync(errLog, "utf8").trim().split("\n").slice(-12).join("\n")}`);
      const res = JSON.parse(resp.text);
      const where = at(src, t.pos.line);
      if (res.failed < 0) { results.push({ name: t.name, line: where, ok: true }); log(`ok   ${t.name}`); continue; }
      const s = t.steps[res.failed];
      const step = lines[s.pos.line - 1]?.trim() ?? "";
      results.push({ name: t.name, line: where, ok: false, step, message: res.message });
      log(`FAIL ${t.name} (${where})\n     ${at(src, s.pos.line)}: ${step}\n     ${res.message}`);
    }
  } finally { proc.kill(); }
  return results;
}
