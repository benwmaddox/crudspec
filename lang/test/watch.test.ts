// node lang/cli.ts watch, over HTTP as an agent uses it: /_watch/wait after each edit says when
// the change is serving; a change that doesn't build is reported at its file and line while the
// last good version serves on; an asset change only restarts; a stored-schema change migrates the
// watch's data; pages get the reload script.
//   node lang/test/watch.test.ts      (needs Go: run it where `go` is installed)
process.removeAllListeners("warning");
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

let failed = 0;
const ok = (what: string, pass: boolean, detail?: unknown) => { console.log(`${pass ? "ok  " : "FAIL"} ${what}`); if (!pass) { failed++; if (detail !== undefined) console.log("     ", JSON.stringify(detail)); } };

// inside crudspec's target/: a build must be on the drive crudspec is on
const dir = resolve("target", "watch-test", "app");
rmSync(resolve("target", "watch-test"), { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
const spec = (heading: string, fields = "name: Text") => `app t { name "T" }
entity Game { ${fields} }
policy p: true for rows of Game
layout l { <main><Slot name=main /></main> }
screen home { route "/"  layout l  require public  <Fill name=main><h1>${heading}</h1></Fill> }
`;
const write = (src: string) => writeFileSync(join(dir, "home.crud"), src);
write(spec("one"));

const port = 13880, base = `http://127.0.0.1:${port}`;
const out = resolve("target", "watch-test", "out");
const w = spawn(process.execPath, ["lang/cli.ts", "watch", dir, "--port", String(port), "--out", out, "--json"], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PATH: `${process.env.PATH}:/usr/local/go/bin`, GOFLAGS: "-buildvcs=false" } });
let log = "";
w.stdout.on("data", (b) => { log += b; });
w.stderr.on("data", (b) => { log += b; });
const wait = async () => (await fetch(`${base}/_watch/wait`)).json();
const page = async (p = "/") => (await fetch(base + p)).text();
try {
  for (let i = 0; i < 100; i++) { try { await fetch(`${base}/_watch/status`); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  const s1 = await wait();
  const p1 = await page();
  ok("the first build serves the app", s1.state === "live" && s1.version === 1 && p1.includes("<h1>one</h1>"), { s1, log });
  ok("... and a page gets the reload script", p1.includes(`<script src="/_watch/reload.js"></script>`), p1.slice(-300));

  write(spec("two"));
  const s2 = await wait();   // at once after the edit: wait finds the change itself
  ok("an edit, then wait: the change is serving when it returns", s2.state === "live" && s2.version === 2 && (await page()).includes("<h1>two</h1>"), s2);

  write(spec("three").replace("</h1>", "</h2>"));
  const s3 = await wait();
  ok("an edit that doesn't build: failed, said at its file and line", s3.state === "failed" && s3.version === 2 && s3.errors.some((e: string) => /^home\.crud:5:\d+: error/.test(e)), s3);
  ok("... while the last good version serves on", (await page()).includes("<h1>two</h1>"));

  write(spec("four"));
  const s4 = await wait();
  ok("the next edit that builds is served", s4.state === "live" && s4.version === 3 && (await page()).includes("<h1>four</h1>"), s4);

  mkdirSync(join(dir, "assets"), { recursive: true });
  writeFileSync(join(dir, "assets", "x.css"), "h1 { color: teal }");
  const s5 = await wait();
  ok("an asset change restarts without a build", s5.state === "live" && s5.version === 4 && s5.changed.includes("assets/x.css") && (await page("/assets/x.css")).includes("teal"), s5);

  write(spec("five", "name: Text  year: Int?"));
  const s6 = await wait();
  ok("a stored-schema change migrates the watch's data, then serves", s6.state === "live" && s6.version === 5 && (await page()).includes("<h1>five</h1>"), { s6, log });

  const st = await (await fetch(`${base}/_watch/status`)).json();
  ok("/_watch/status says the same at once", st.version === 5 && st.state === "live", st);
} finally {
  w.kill("SIGINT");
}
await new Promise((r) => setTimeout(r, 500));
console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
