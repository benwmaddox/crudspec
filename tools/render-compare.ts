// Render comparison: builds and runs an app at two revisions, GETs every routed screen on both
// (signed out, and signed in as the fixture's first identity row when the spec has one), and
// reports which pages differ after normalization. Use it to see what a change did to the pages
// before merging; it is not part of the test suite (it builds and runs apps, which takes minutes).
//
//   node tools/render-compare.ts --before <rev> --after <rev> [--app apps/tasks] [--app ...] [--diffs 3] [--port 13600]
//
// Run it from the repository root. Each revision is checked out into a temporary detached worktree
// (`git worktree add --detach`). Each side is captured by a child process started inside that
// worktree, so the build (lang/cli.ts), the spec parser, go-app.ts and fixture.ts all come from
// that revision. The before side runs on --port, the after side on --port + 1. Without --app, every
// apps/<name>/ folder holding a .crud file in either revision is compared. Exit code: 0 when every
// page matches, 1 when some page differs, 2 on error.
//
// Normalization (normalize() below), applied to the body of each page before comparing:
//   1. empty id="", class="" and title="" attributes are removed (they come and go with rendering, not with meaning)
//   2. fragment markers <!--f:...--> and <!--/f:...--> are removed
//   3. every other HTML comment is removed
//   4. opaque page ids in "d":["..."] become "d":["<ID>"]
//   5. the form token in __h value="<id>.<sig>" becomes "__h value=\"<H>.\""
//   6. any run of 40 or more letters, digits, "_" or "-" (session tokens, hashes) becomes <TOKEN>
//   7. 127.0.0.1:<port> (each run listens on its own port) becomes 127.0.0.1:<PORT>
//   7. ISO timestamps (2026-11-02T10:00:00Z) become <TS>
// Anything else is compared as is. The HTTP status and Location header are compared too.
//
// The page text is split at every "><" before diffing, so the unified diff shows one tag per line.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, existsSync, statSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export function normalize(html: string): string {
  return html
    .replace(/ (id|class|title)=""/g, "")
    .replace(/<!--\/?f:[^>]*-->/g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/"d":\["[^"]*"\]/g, '"d":["<ID>"]')
    .replace(/__h" value="[A-Za-z0-9_-]+\./g, '__h" value="<H>.')
    .replace(/[A-Za-z0-9_-]{40,}/g, "<TOKEN>")
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z?/g, "<TS>")
    .replace(/127\.0\.0\.1:\d+/g, "127.0.0.1:<PORT>");
}

export function splitTags(s: string): string {
  return s.replace(/></g, ">\n<");
}

export type Args = { before: string; after: string; apps: string[]; diffs: number; port: number };

const USAGE = "usage: node tools/render-compare.ts --before <rev> --after <rev> [--app apps/<name>]... [--diffs <n>] [--port <n>]";

function count(flag: string, value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${flag} needs a whole number above 0, not "${value}"`);
  return n;
}

export function parseArgs(argv: string[]): Args {
  const out = { before: "", after: "", apps: [] as string[], diffs: 3, port: 13600 };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = (): string => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`${flag} needs a value\n${USAGE}`);
      return v;
    };
    switch (flag) {
      case "--before": out.before = value(); break;
      case "--after": out.after = value(); break;
      case "--app": out.apps.push(value().replace(/\/+$/, "")); break;
      case "--diffs": out.diffs = count(flag, value()); break;
      case "--port": out.port = count(flag, value()); break;
      default: throw new Error(`unknown argument ${flag}\n${USAGE}`);
    }
  }
  if (!out.before || !out.after) throw new Error(`--before and --after are required\n${USAGE}`);
  return out;
}

function git(args: string[], cwd: string, allowFail = false): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0 && !allowFail) throw new Error(`git ${args.join(" ")} failed:\n${r.stderr}`);
  return r.stdout;
}

function crudFile(appDir: string): string | null {
  if (!existsSync(appDir)) return null;
  const f = readdirSync(appDir).find((n) => n.endsWith(".crud"));
  return f ? join(appDir, f) : null;
}

// the folders apps/<name> that hold a .crud file
function appsIn(tree: string): string[] {
  const dir = join(tree, "apps");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((n) => `apps/${n}`)
    .filter((p) => statSync(join(tree, p)).isDirectory() && crudFile(join(tree, p)) !== null);
}

// Runs inside a revision's worktree (cwd = that tree). It imports that tree's own modules by absolute
// URL, builds and starts the app, seeds it, reads every screen, and writes the pages to a JSON file.
const CAPTURE_JS = `
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { existsSync } from "node:fs";
const [tree, spec, port, outFile] = process.argv.slice(2);
const lib = (p) => import(pathToFileURL(join(tree, p)).href);
const { startApp } = await lib("lang/test/go-app.ts");
const { parse } = await lib("lang/parser.ts");
const { loadFixture, screenPaths } = await lib("lang/test/fixture.ts");
const assets = join(tree, dirname(spec), "assets");
const a = await startApp(spec, Number(port), existsSync(assets) ? { assets } : {});
const pages = {};
try {
  const parsed = parse(readFileSync(spec, "utf8"));
  const signedIn = await loadFixture(a, parsed);
  const actors = [["anon", {}]];
  if (Object.keys(signedIn).length > 0) actors.push(["signed-in", signedIn]);
  for (const [label, headers] of actors) {
    for (const [screen, path] of screenPaths(parsed)) {
      const r = await fetch(a.base + path, { headers, redirect: "manual" });
      const loc = r.headers.get("location") ?? "";
      const body = await r.text();
      const slug = path.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_|_$/g, "") || "root";
      pages[label + "__" + screen + "__" + slug] = { status: r.status, location: loc, body };
    }
  }
} finally {
  a.stop();
}
writeFileSync(outFile, JSON.stringify(pages));
process.exit(0);
`;

type Pages = Map<string, string>;

// normalizes a captured page and returns it as one comparable string
function render(p: { status: number; location: string; body: string }): string {
  const loc = p.location ? ` location=${p.location}` : "";
  return `HTTP ${p.status}${loc}\n${splitTags(normalize(p.body))}\n`;
}

// captures one app at one revision; a note explains why nothing was captured
function capture(tree: string, app: string, port: number, tmp: string, tag: string): { note?: string; pages?: Pages } {
  const spec = crudFile(join(tree, app));
  if (!spec) return { note: `no .crud file in ${app}` };
  const driver = join(tmp, `capture-${tag}.mjs`);
  const out = join(tmp, `pages-${tag}.json`);
  writeFileSync(driver, CAPTURE_JS);
  const rel = spec.slice(tree.length + 1).replace(/\\/g, "/");
  const r = spawnSync("node", ["--no-warnings", driver, tree, rel, String(port), out], {
    cwd: tree,
    stdio: ["ignore", "inherit", "inherit"],
  });
  if (r.status !== 0 || !existsSync(out)) return { note: `capture failed with exit ${r.status}` };
  const raw = JSON.parse(readFileSync(out, "utf8")) as Record<string, { status: number; location: string; body: string }>;
  const pages: Pages = new Map();
  for (const [k, v] of Object.entries(raw)) pages.set(k, render(v));
  return { pages };
}

export async function main(argv: string[], root: string): Promise<number> {
  const args = parseArgs(argv);
  const tmp = mkdtempSync(join(tmpdir(), "render-compare-"));
  const trees = { before: join(tmp, "before"), after: join(tmp, "after") };
  const made: string[] = [];
  let differing = 0;
  try {
    for (const side of ["before", "after"] as const) {
      git(["worktree", "add", "--detach", trees[side], args[side]], root);
      made.push(trees[side]);
    }
    const apps = args.apps.length > 0 ? args.apps : [...new Set([...appsIn(trees.before), ...appsIn(trees.after)])].sort();
    const sha = (rev: string) => git(["rev-parse", "--short", rev], root).trim();
    console.log(`render-compare: before ${args.before} (${sha(args.before)}), after ${args.after} (${sha(args.after)})`);
    for (const app of apps) {
      const before = capture(trees.before, app, args.port, tmp, "before");
      const after = capture(trees.after, app, args.port + 1, tmp, "after");
      if (!before.pages || !after.pages) {
        console.log(`== ${app}: skipped (before: ${before.note ?? "ok"}; after: ${after.note ?? "ok"})`);
        continue;
      }
      const names = [...new Set([...before.pages.keys(), ...after.pages.keys()])].sort();
      const diffs = names.filter((n) => before.pages!.get(n) !== after.pages!.get(n));
      differing += diffs.length;
      console.log(`== ${app}: ${names.length} pages, ${diffs.length} differ`);
      for (const n of diffs.slice(0, args.diffs)) {
        const safe = `${app.replace(/\W+/g, "_")}-${n.replace(/\W+/g, "_")}`;
        const bf = join(tmp, `${safe}-before.html`);
        const af = join(tmp, `${safe}-after.html`);
        writeFileSync(bf, before.pages.get(n) ?? "");
        writeFileSync(af, after.pages!.get(n) ?? "");
        const d = spawnSync("git", ["diff", "--no-index", "-U3", "--", bf, af], { cwd: root, encoding: "utf8" });
        console.log(`--- ${n}\n${d.stdout}`);
      }
      if (diffs.length > args.diffs) console.log(`(${diffs.length - args.diffs} more differing pages not shown; raise --diffs)`);
      if (diffs.length > 0) console.log(`differing: ${diffs.join(", ")}`);
    }
    return differing > 0 ? 1 : 0;
  } finally {
    for (const t of made) git(["worktree", "remove", "--force", t], root, true);
    git(["worktree", "prune"], root, true);
    rmSync(tmp, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2), process.cwd()).then(
    (code) => process.exit(code),
    (e) => {
      console.error(e instanceof Error ? e.message : e);
      process.exit(2);
    },
  );
}
