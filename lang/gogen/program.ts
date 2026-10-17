// The compiled app as a program the CLI runs: an upgrade's data step (`app migrate-data`).
// Built on first use, once per spec and compiler version, under the temp directory. On
// Windows, where Go lives in WSL, it is built and run there.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type Program = {
  path(p: string): string;   // a file path as the program sees it
  run(args: string[], input: string): { status: number | null; stdout: string; stderr: string };
};

const LANG = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const wsl = process.platform === "win32";
const wslPath = (p: string) => resolve(p).replace(/^([A-Za-z]):/, (_m, d) => `/mnt/${d.toLowerCase()}`).replace(/\\/g, "/");

// what the build depends on: the spec, files beside it (widgets) and the compiler's sources
function key(specPath: string): string {
  const h = createHash("sha256");
  const add = (dir: string, re: RegExp, deep: boolean) => {
    for (const f of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(dir, f.name);
      if (f.isDirectory()) { if (deep && f.name !== "node_modules") add(p, re, deep); }
      else if (re.test(f.name)) h.update(p.slice(LANG.length)).update(readFileSync(p));
    }
  };
  h.update(readFileSync(specPath));
  for (const f of readdirSync(dirname(resolve(specPath)))) if (f.endsWith(".go")) h.update(f).update(readFileSync(join(dirname(resolve(specPath)), f)));
  add(LANG, /\.ts$/, false);
  add(join(LANG, "gogen"), /\.(ts|go|mod|sum)$/, true);
  return h.digest("hex").slice(0, 16);
}

export function compiledApp(specPath: string): Program {
  let bin = "";
  const build = () => {
    if (bin) return bin;
    const k = key(specPath);
    if (wsl) {
      const dir = `/tmp/crudspec-bin/${k}`;
      if (spawnSync("wsl", ["-e", "test", "-x", `${dir}/app`]).status !== 0) {
        const r = spawnSync("wsl", ["-e", "bash", "-c", `export PATH=$PATH:/usr/local/go/bin GOFLAGS=-buildvcs=false; cd ${wslPath(join(LANG, ".."))} && node lang/cli.ts build ${wslPath(specPath)} --out ${dir}`], { encoding: "utf8" });
        if (r.status !== 0) throw new Error(`building the app failed:\n${r.stdout}\n${r.stderr}`);
      }
      bin = `${dir}/app`;
    } else {
      const dir = join(tmpdir(), "crudspec-bin", k);
      if (!existsSync(join(dir, "app"))) {
        const env = { ...process.env, PATH: `${process.env.PATH}:/usr/local/go/bin`, GOFLAGS: "-buildvcs=false" };
        const r = spawnSync(process.execPath, [join(LANG, "cli.ts"), "build", specPath, "--out", dir], { env, encoding: "utf8" });
        if (r.status !== 0 || !existsSync(join(dir, "app"))) throw new Error(`building the app failed:\n${r.stdout}\n${r.stderr}`);
      }
      bin = join(dir, "app");
    }
    return bin;
  };
  return {
    path: (p) => (wsl ? wslPath(p) : resolve(p)),
    run(args, input) {
      const b = build();
      const r = wsl ? spawnSync("wsl", ["-e", b, ...args], { input, encoding: "utf8", maxBuffer: 1 << 28 }) : spawnSync(b, args, { input, encoding: "utf8", maxBuffer: 1 << 28 });
      return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? String(r.error ?? "") };
    },
  };
}
