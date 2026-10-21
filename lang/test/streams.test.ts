// Live streams are bounded (gogen/rt/streams.go): with --max-streams 3 --max-streams-each 2, a
// person's third stream is refused (503, Retry-After), another person's is taken until three are
// open, then any is refused; one closed makes room again.
//   node lang/test/streams.test.ts
import { readFileSync } from "node:fs";
import { startApp } from "./go-app.ts";

let failed = 0;
const ok = (what: string, pass: boolean, detail?: unknown) => { console.log(`${pass ? "ok  " : "FAIL"} ${what}`); if (!pass) { failed++; if (detail !== undefined) console.log(JSON.stringify(detail)); } };

const app = await startApp("apps/campfire/campfire.crud", 13843, { args: ["--max-streams", "3", "--max-streams-each", "2"] });
try {
  const fixture = JSON.parse(readFileSync("apps/campfire/ui/fixture.json", "utf8"));
  await fetch(app.base + "/_test/fixture", { method: "POST", body: JSON.stringify(fixture) });
  const signIn = async (email: string, password: string) => {
    const r = await fetch(app.base + "/_do/sign_in", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ email, password }), redirect: "manual" });
    return r.headers.getSetCookie().find((x) => x.startsWith("session_token="))!.split(";")[0];
  };
  const ada = await signIn("ada@example.test", "fixture-pass-1"), bob = await signIn("bob@example.test", "fixture-pass-2");
  // a stream: its status, and a way to close it
  const open = async (cookie: string) => { const ac = new AbortController(); const r = await fetch(app.base + "/_events", { headers: { Cookie: cookie }, signal: ac.signal }); return { status: r.status, retry: r.headers.get("Retry-After"), close: () => ac.abort() }; };
  const a1 = await open(ada), a2 = await open(ada), a3 = await open(ada);
  ok("Ada's first two streams are taken", a1.status === 200 && a2.status === 200, [a1.status, a2.status]);
  ok("... her third is refused, 503 with Retry-After", a3.status === 503 && a3.retry === "30", [a3.status, a3.retry]);
  const b1 = await open(bob), b2 = await open(bob);
  ok("Bob's first is taken (three open in all)", b1.status === 200, b1.status);
  ok("... his second is refused: the server keeps three", b2.status === 503, b2.status);
  a1.close();
  await new Promise((r) => setTimeout(r, 300));   // the server sees it closed
  const b3 = await open(bob);
  ok("one closed makes room again", b3.status === 200, b3.status);
  for (const s of [a2, b1, b3]) s.close();
} finally { app.stop(); }
process.exit(failed ? 1 : 0);
