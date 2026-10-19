// send mail: the checker's rules, and the compiled app's outbox delivered to a loopback SMTP
// server (in WSL beside the app on Windows): a refused action sends nothing, a schedule's mail
// goes once per run with its unsubscribe header, links use --base-url, headers are encoded.
//   node lang/test/mail.test.ts
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { parse } from "../parser.ts";
import { check } from "../check.ts";
import { describe } from "../describe.ts";
import { startApp } from "./go-app.ts";

let failed = 0;
const ok = (what: string, pass: boolean, detail?: unknown) => { console.log(`${pass ? "ok  " : "FAIL"} ${what}`); if (!pass) { failed++; if (detail !== undefined) console.log(JSON.stringify(detail).slice(0, 900)); } };
const errors = (src: string) => check(parse(src)).filter((f) => f.severity === "error");
const BASE = `
app t { name "T" actor User }
entity User { name: Text  email: Email  token: Text?  note: Text? private  digest: Bool = true }
identity login: User.token from cookie "login"
layout l { <main><slot name=main /></main> }
screen home { route "/"  layout l <main><heading>{"Home"}</heading></main> }
`;
const SPEC = BASE + `
action welcome(u: User) { send mail { to: u.email, subject: "Welcome, " + u.name + " ✓", text: "Hello " + u.name + "\\nStart here: " + url_of(home()) } }
action refused(u: User) { send mail { to: u.email, subject: "never", text: "never" }  require false else invalid }
schedule digest { every day at "08:00" in "UTC"
  for each u in User where .digest { send mail { to: u.email, subject: "Your digest", text: "Hi " + u.name, unsubscribe: url_of(home()) } }
}
`;

// the checker
ok("the spec checks", !errors(SPEC).length, errors(SPEC));
ok("a private field can't go in a message", errors(BASE + `action a(u: User) { send mail { to: u.email, subject: "x", text: u.note ?? "" } }`.replace(" ?? \"\"", "")).some((f) => f.code === "PRIVATE_FIELD"));
ok("a schedule's mail needs an unsubscribe link", errors(BASE + `schedule s { every day at "08:00" for each u in User where true { send mail { to: u.email, subject: "x", text: "y" } } }`).some((f) => f.code === "MAIL_UNSUBSCRIBE"));
ok("mail takes to, subject, text and unsubscribe, and needs the first three", errors(BASE + `action a(u: User) { send mail { to: u.email, subject: "x", cc: u.email } }`).filter((f) => f.code === "MAIL_FIELD").length === 2);
ok("to is an address", errors(BASE + `action a(u: User) { send mail { to: 5, subject: "x", text: "y" } }`).some((f) => f.code === "MAIL_TO"));
ok("a migration can't send mail", errors(BASE + `migration "m" { for each u in User where true { send mail { to: u.email, subject: "x", text: "y" } } }`).some((f) => f.code === "MIGRATION_EFFECT"));
const welcome = describe(parse(SPEC)).callables.find((c) => c.name === "welcome")!;
ok("agents are told it reaches outside and isn't idempotent", welcome.annotations.openWorldHint && !welcome.annotations.idempotentHint && welcome.outcomes.includes("invalid"), welcome.annotations);

// the app
const dir = mkdtempSync(join(tmpdir(), "mail-"));
writeFileSync(join(dir, "app.crud"), SPEC);
const wsl = process.platform === "win32";
const wslPath = (p: string) => resolve(p).replace(/^([A-Za-z]):/, (_m, d) => `/mnt/${d.toLowerCase()}`).replace(/\\/g, "/");
const SMTP = 12526, sinkFile = wsl ? "/tmp/crudspec-mail-sink.jsonl" : join(dir, "sink.jsonl");
const sink = wsl ? spawn("wsl", ["-e", "bash", "-c", `cd ${wslPath(".")} && exec node lang/test/smtp-sink.ts ${SMTP} ${sinkFile}`], { stdio: "ignore" })
  : spawn(process.execPath, ["lang/test/smtp-sink.ts", String(SMTP), sinkFile], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 1500));
const received = (): any[] => (wsl ? spawnSync("wsl", ["-e", "cat", sinkFile], { encoding: "utf8" }).stdout : require("node:fs").readFileSync(sinkFile, "utf8")).split("\n").filter(Boolean).map((l: string) => JSON.parse(l));
const app = await startApp(join(dir, "app.crud"), 13891, { env: { CRUDSPEC_SMTP: `127.0.0.1:${SMTP}`, CRUDSPEC_MAIL_FROM: "app@example.test" }, args: ["--base-url", "https://app.example.test"] });
try {
  await app.post("/_test/load", { clock: Date.UTC(2026, 0, 5, 7, 0), rows: { User: [
    { id: 1, seq: 1, created: 0, updated: 0, fields: { name: "Ada", email: "ada@example.test", token: null, note: "secret", digest: true } },
    { id: 2, seq: 2, created: 0, updated: 0, fields: { name: "Bob", email: "bob@example.test", token: null, note: null, digest: false } },
    { id: 3, seq: 3, created: 0, updated: 0, fields: { name: "Cy\r\nBcc: evil@x.test", email: "cy@example.test", token: null, note: null, digest: false } }] } });
  const call = async (action: string, args: Record<string, string>) => (await fetch(app.base + "/_do/" + action, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(args), redirect: "manual" })).headers.get("X-Crudspec-Outcome");
  ok("an action sends mail", await call("welcome", { u: "1" }) === "ok");
  ok("a refused action ...", await call("refused", { u: "1" }) === "invalid");
  ok("a subject with a line break is refused", await call("welcome", { u: "3" }) === "invalid");
  const box = (await app.post("/_test/outbox", { deliver: true })).messages;
  ok("... leaves nothing in the outbox; the welcome is there once", box.length === 1 && box[0].to === "ada@example.test", box);
  await new Promise((r) => setTimeout(r, 500));
  let got = received();
  const w = got.find((m) => m.to[0] === "ada@example.test");
  ok("it reaches the mail server", !!w && w.from === "app@example.test", got);
  ok("its subject is encoded (non-ASCII)", /^Subject: =\?utf-8\?q\?Welcome/im.test(w?.data ?? ""), w?.data);
  ok("its link uses the app's address", (w?.data ?? "").replace(/=\r\n/g, "").includes("https://app.example.test/"), w?.data);
  ok("the outbox marks it sent", (await app.post("/_test/outbox", {})).messages[0].status === "sent");
  await app.post("/_test/clock", { advance_ms: 2 * 3600_000 });   // 09:00 UTC: the digest's time has come
  got = received();
  const digests = got.filter((m) => /Subject: Your digest/.test(m.data));
  ok("a schedule's mail goes once, to those it's for", digests.length === 1 && digests[0].to[0] === "ada@example.test", got.map((m) => m.to));
  ok("with a one-click unsubscribe header", /List-Unsubscribe: <https:\/\/app\.example\.test\/>/.test(digests[0]?.data ?? "") && /List-Unsubscribe-Post: List-Unsubscribe=One-Click/.test(digests[0]?.data ?? ""), digests[0]?.data);
  await app.post("/_test/clock", { advance_ms: 3600_000 });
  ok("the next hour sends no more", received().filter((m) => /Subject: Your digest/.test(m.data)).length === 1);
  ok("no header was injected", !received().some((m) => /evil@x\.test/.test(m.data) || m.to.includes("evil@x.test")));
} finally { app.stop(); sink.kill(); if (wsl) spawnSync("wsl", ["-e", "bash", "-c", `pkill -f "smtp-sink.ts ${SMTP}" || true`]); }
process.exit(failed ? 1 : 0);
