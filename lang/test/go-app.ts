// Builds a spec into the Go program (node lang/cli.ts build) and runs it in --test mode, for
// tests that exercise the compiled app over HTTP. Needs Go (/usr/local/go/bin). On Windows,
// where Go lives in WSL, the build and the app run there (localhost reaches them).
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export type App = { base: string; dir: string; stop: () => void; post: (path: string, body: unknown, headers?: Record<string, string>) => Promise<any> };

const wsl = process.platform === "win32";
const wslPath = (p: string) => resolve(p).replace(/^([A-Za-z]):/, (_m, d) => `/mnt/${d.toLowerCase()}`).replace(/\\/g, "/");

export async function startApp(specPath: string, port: number, opts: { assets?: string; args?: string[]; env?: Record<string, string> } = {}): Promise<App> {
  const envs = Object.entries(opts.env ?? {}).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(" ");
  const base = `http://127.0.0.1:${port}`;
  let proc: ChildProcess, dir: string, stop: () => void;
  if (wsl) {
    // a working directory inside WSL, so the build and the data are on its filesystem
    dir = `$HOME/crudspec-app-${port}`;   // not /tmp: WSL clears it when it stops
    const cmd = [
      `set -e; export PATH=$PATH:/usr/local/go/bin GOFLAGS=-buildvcs=false; rm -rf ${dir}; mkdir -p ${dir}`,
      `cd ${wslPath(".")} && node lang/cli.ts build ${wslPath(specPath)} --out ${dir}/build > ${dir}/build.log 2>&1`,
      `exec env ${envs} CRUDSPEC_LIVE_TRACE=${process.env.CRUDSPEC_LIVE_TRACE ?? ""} CRUDSPEC_LIVE_TRACE_KEY=${process.env.CRUDSPEC_LIVE_TRACE_KEY ?? ""} ${dir}/build/app --data ${dir}/data --assets ${opts.assets ? wslPath(opts.assets) : `${dir}/assets`} --port ${port} --test ${(opts.args ?? []).join(" ")} 2>>${dir}/app.log`,
    ].join("\n");
    proc = spawn("wsl", ["-e", "bash", "-c", cmd], { stdio: "ignore" });
    stop = () => { spawnSync("wsl", ["-e", "bash", "-c", `pkill -f "${dir}/build/app" || true`]); proc.kill(); };
  } else {
    dir = mkdtempSync(join(tmpdir(), "crudspec-app-"));
    const env = { ...process.env, PATH: `${process.env.PATH}:/usr/local/go/bin`, GOFLAGS: "-buildvcs=false", ...(opts.env ?? {}) };
    const b = spawnSync(process.execPath, ["lang/cli.ts", "build", specPath, "--out", join(dir, "build")], { env, encoding: "utf8" });
    if (b.status !== 0) throw new Error(`build failed:\n${b.stdout}\n${b.stderr}`);
    mkdirSync(join(dir, "assets"), { recursive: true });
    proc = spawn(join(dir, "build", "app"), ["--data", join(dir, "data"), "--assets", opts.assets ?? join(dir, "assets"), "--port", String(port), "--test", ...(opts.args ?? [])], { stdio: "ignore", env });
    stop = () => proc.kill();
  }
  let up = false;
  for (let i = 0; i < 600 && !up; i++) { try { up = (await fetch(`${base}/up`)).ok; } catch { /* starting */ } if (!up) await new Promise((r) => setTimeout(r, 100)); }
  if (!up) { stop(); throw new Error(`the app didn't start on ${base}`); }
  const post = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
    const r = await fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
    const t = await r.text();
    try { return { status: r.status, ...JSON.parse(t) }; } catch { return { status: r.status, text: t }; }
  };
  return { base, dir, stop, post };
}
