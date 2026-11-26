// The built-in account flows (lang/accounts.ts): an app that lists them in `accounts [...]` gets a
// password reset by mailed link, a password change, and email verification, built from its actor's
// Email and Password fields and its cookie sessions. A reset link works once and for an hour; a reset
// or a change signs the person out of their other browsers; the app's "signed in" rule and the
// user's write policy don't stand in the way of a signed-out visitor holding a link.
//   node lang/test/accounts.test.ts      (needs Go: on Windows, in WSL)
process.removeAllListeners("warning");
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "../parser.ts";
import { check } from "../check.ts";
import { typecheck } from "../types.ts";
import { withGenerated } from "../scaffold.ts";
import { accountsSource } from "../accounts.ts";
import { startApp } from "./go-app.ts";

let failed = 0;
const ok = (what: string, pass: boolean, detail?: unknown) => { console.log(`${pass ? "ok  " : "FAIL"} ${what}`); if (!pass) { failed++; if (detail !== undefined) console.log("     ", typeof detail === "string" ? detail.slice(0, 600) : JSON.stringify(detail)?.slice(0, 600)); } };

const SPEC = `
app t {
  name "Tally"
  actor User
  sign_in_screen sign_in_screen
  accounts [password_reset, password_change, email_verification]
}
entity User {
  name: Text max 40
  email: Email private
  password: Password max 72
  email_verified: Bool = false
  unique (email)
}
entity Login { who: User on delete cascade  token: Text = token(24)  unique (token) }
identity login: Login.token from cookie "login"
policy user_rows: it == actor for rows of User
policy login_rows: .who == actor for rows of Login
policy own_user: it == actor else forbidden for writes to User
policy signed_in: actor != none else unauthenticated for every action
layout l { <nav><Slot name=nav /></nav><main><Slot name=main /></main> }
screen sign_in_screen { route "/in"  layout l  require public  <Fill name=main><h1>Sign in</h1></Fill> }
screen home { route "/"  layout l  <Fill name=main><h1>Home</h1></Fill> }
// Makes an account.
action sign_up(name: Text, email: Email, password: Text) {
  callers people
  skip policy signed_in
  create User { name: name, email: email, password: password }
}
// Signs in.
action sign_in(email: Email, password: Text) {
  callers people
  skip policy signed_in
  let u = the_or_none(User where .email == email)
  require u != none and authenticates(u.password, password) else unauthenticated
  create Login { who: u } as l
  result l
}
`;

const findings = (src: string) => { const s = parse(src); const f = check(s, { source: src }); return f.some((x) => x.severity === "error") ? f : [...f, ...typecheck(withGenerated(parse(src), parse)).findings]; };
const errors = (src: string) => findings(src).filter((f: any) => f.severity === "error").map((f: any) => f.code);

// ---- what the checker says
{
  ok("the spec with all three flows checks, generated source included", errors(SPEC).length === 0, findings(SPEC));
  const src = accountsSource(parse(SPEC));
  ok("the flows skip the app's signed-in rule where a signed-out visitor uses them", /action accounts_request_password_reset[\s\S]*?skip policy signed_in/.test(src) && /action accounts_reset_password[\s\S]*?skip policy own_user/.test(src), src.slice(0, 900));
  ok("... but not where the person is signed in (a change keeps every rule)", !/action accounts_change_password\([^)]*\) \{[^}]*skip policy/.test(src));
  ok("an unknown flow is refused", errors(SPEC.replace("email_verification]", "email_verification, magic_links]")).includes("ACCOUNTS_FLOW"));
  ok("accounts need an email that is a unique key", errors(SPEC.replace("  unique (email)\n", "")).includes("ACCOUNTS_NO_EMAIL"));
  ok("... and a password", errors(SPEC.replace("  password: Password max 72\n", "").replace("authenticates(u.password, password)", "true")).includes("ACCOUNTS_NO_PASSWORD"));
  ok("email verification needs email_verified: Bool", errors(SPEC.replace("  email_verified: Bool = false\n", "")).includes("ACCOUNTS_NO_VERIFIED"));
  ok("... which a spec without that flow doesn't", errors(SPEC.replace("  email_verified: Bool = false\n", "").replace(", email_verification]", "]")).length === 0);
  ok("accounts send people to sign in: the app needs a sign-in screen", errors(SPEC.replace("  sign_in_screen sign_in_screen\n", "")).includes("ACCOUNTS_NO_SIGN_IN"));
  ok("no accounts line, no flows", accountsSource(parse(SPEC.replace(/  accounts \[.*\]\n/, ""))) === "");
}

// ---- running
const dir = mkdtempSync(join(tmpdir(), "accounts-"));
writeFileSync(join(dir, "app.crud"), SPEC);
const app = await startApp(join(dir, "app.crud"), 13951, { args: ["--base-url", "https://tally.example.test"] });
try {
  const post = async (cookie: string | null, action: string, args: Record<string, string> = {}) => {
    const r = await fetch(`${app.base}/_do/${action}`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: app.base, ...(cookie ? { Cookie: cookie } : {}) }, body: new URLSearchParams(args), redirect: "manual" });
    return { outcome: r.headers.get("X-Crudspec-Outcome"), cookie: r.headers.getSetCookie().find((c) => c.startsWith("login="))?.split(";")[0] };
  };
  const get = async (cookie: string | null, path: string) => { const r = await fetch(app.base + path, { headers: cookie ? { Cookie: cookie } : {}, redirect: "manual" }); return { status: r.status, text: await r.text() }; };
  const dump = async (e: string) => ((await app.post("/_test/dump", {})).rows[e] ?? []) as any[];
  const outbox = async () => (await app.post("/_test/outbox", {})).messages as any[];
  const linkIn = (m: any, path: string) => { const x = new RegExp(`https://tally\\.example\\.test(${path}[^\\s]+)`).exec(m?.text ?? ""); return x?.[1]; };
  await app.post("/_test/load", { clock: Date.parse("2026-11-20T15:00:00Z"), rows: {} });

  ok("sign up", (await post(null, "sign_up", { name: "Ada", email: "ada@example.test", password: "first-pass" })).outcome === "ok");
  const a1 = (await post(null, "sign_in", { email: "ada@example.test", password: "first-pass" })).cookie!;
  const a2 = (await post(null, "sign_in", { email: "ada@example.test", password: "first-pass" })).cookie!;
  ok("... and sign in from two browsers", !!a1 && !!a2 && (await dump("Login")).length === 2);

  // password reset
  ok("the forgot-password screen opens for a signed-out visitor", (await get(null, "/_accounts/password/forgot")).status === 200);
  const none = await post(null, "accounts_request_password_reset", { email: "nobody@example.test" });
  ok("asking for an address with no account says ok too (it doesn't tell who has one)", none.outcome === "ok", none);
  ok("... and sends nothing", (await outbox()).length === 0);
  ok("asking for Ada's address says ok", (await post(null, "accounts_request_password_reset", { email: "ada@example.test" })).outcome === "ok");
  const reset = (await outbox())[0];
  const link = linkIn(reset, "/_accounts/password/reset/");
  ok("... and mails her a link to the reset screen, at the app's address", reset?.to === "ada@example.test" && !!link, reset);
  ok("the link's screen opens", (await get(null, link!)).status === 200);
  const token = decodeURIComponent(link!.split("/").pop()!);
  ok("a password shorter than 8 characters is refused", (await post(null, "accounts_reset_password", { link: token, password: "short" })).outcome === "invalid");
  ok("a tampered link is refused", (await post(null, "accounts_reset_password", { link: token.slice(0, -2) + "xx", password: "second-pass" })).outcome === "invalid");
  ok("the link sets a new password", (await post(null, "accounts_reset_password", { link: token, password: "second-pass" })).outcome === "ok");
  ok("... the old password no longer signs in, the new one does", (await post(null, "sign_in", { email: "ada@example.test", password: "first-pass" })).outcome === "unauthenticated" && (await post(null, "sign_in", { email: "ada@example.test", password: "second-pass" })).outcome === "ok");
  ok("... and both browsers that were signed in are signed out", (await dump("Login")).length === 1);
  ok("the link works once: used again, it's refused", (await post(null, "accounts_reset_password", { link: token, password: "third-pass1" })).outcome === "invalid");
  await post(null, "accounts_request_password_reset", { email: "ada@example.test" });
  const late = decodeURIComponent(linkIn((await outbox())[0], "/_accounts/password/reset/")!.split("/").pop()!);
  await app.post("/_test/clock", { advance_ms: 61 * 60_000 });
  ok("a link more than an hour old is refused", (await post(null, "accounts_reset_password", { link: late, password: "third-pass1" })).outcome === "invalid");
  const many = [];
  for (let i = 0; i < 4; i++) many.push((await post(null, "accounts_request_password_reset", { email: "ada@example.test" })).outcome);
  ok("asking again and again for one address is limited", many.includes("blocked"), many);

  // password change
  const b1 = (await post(null, "sign_in", { email: "ada@example.test", password: "second-pass" })).cookie!;
  const b2 = (await post(null, "sign_in", { email: "ada@example.test", password: "second-pass" })).cookie!;
  ok("the change-password screen opens when signed in", (await get(b1, "/_accounts/password")).status === 200);
  ok("... and a signed-out visitor is sent to sign in", (await get(null, "/_accounts/password")).status !== 200);
  ok("a signed-out visitor can't change a password", (await post(null, "accounts_change_password", { current: "second-pass", password: "fourth-pass" })).outcome === "unauthenticated");
  ok("the wrong current password is refused", (await post(b1, "accounts_change_password", { current: "nope-nope", password: "fourth-pass" })).outcome === "invalid");
  const before = (await dump("Login")).length;
  ok("the right one changes it", (await post(b1, "accounts_change_password", { current: "second-pass", password: "fourth-pass" })).outcome === "ok");
  const logins = await dump("Login");
  ok("... this browser stays signed in, the others are signed out", logins.length === 1 && before >= 2 && (await get(b1, "/_accounts/password")).status === 200 && (await get(b2, "/_accounts/password")).status !== 200, { before, after: logins.length });

  // email verification
  ok("the email screen says the address isn't confirmed", (await get(b1, "/_accounts/email")).text.includes("confirmed yet"));
  ok("ask for a confirmation link", (await post(b1, "accounts_send_email_verification")).outcome === "ok");
  const vlink = linkIn((await outbox())[0], "/_accounts/email/verify/");
  ok("... it's mailed", !!vlink);
  ok("the link's screen opens for anyone holding it", (await get(null, vlink!)).status === 200);
  const vtoken = decodeURIComponent(vlink!.split("/").pop()!);
  ok("the link confirms the address", (await post(null, "accounts_verify_email", { link: vtoken })).outcome === "ok" && (await dump("User"))[0].fields.email_verified === true);
  ok("... once", (await post(null, "accounts_verify_email", { link: vtoken })).outcome === "invalid");
  ok("a confirmed address isn't sent another link", (await post(b1, "accounts_send_email_verification")).outcome === "invalid");
  ok("the email screen says it's confirmed", (await get(b1, "/_accounts/email")).text.includes("is confirmed"));
} finally {
  app.stop();
}
if (failed) { console.log(`${failed} FAILED`); process.exit(1); }
console.log("all passed");
