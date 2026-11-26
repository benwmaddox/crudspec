// Sign-in providers (gogen/rt/oidc.go): `sign_in_provider acme { issuer "…"  then act }` signs a
// person in with OpenID Connect. A stand-in provider here (discovery, authorize, token, keys) gives
// ID tokens signed with RS256; the app checks each (its signature by the published keys, issuer,
// audience, times, nonce, the state and the PKCE verifier) and runs the app's own action, whose
// session row it signs in. Every way a token can be wrong ends at the sign-in screen, signed out.
//   node lang/test/sign-in-provider.test.ts      (needs Go; run it in WSL on Windows: the app must reach the stand-in)
process.removeAllListeners("warning");
import { createServer } from "node:http";
import { createHash, generateKeyPairSync, createSign, randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "../parser.ts";
import { check } from "../check.ts";
import { typecheck } from "../types.ts";
import { startApp } from "./go-app.ts";

let failed = 0;
const ok = (what: string, pass: boolean, detail?: unknown) => { console.log(`${pass ? "ok  " : "FAIL"} ${what}`); if (!pass) { failed++; if (detail !== undefined) console.log("     ", typeof detail === "string" ? detail.slice(0, 500) : JSON.stringify(detail)?.slice(0, 500)); } };
if (process.platform === "win32") { console.log("run this test in WSL: the app it builds must reach the stand-in provider on this machine"); process.exit(1); }

const IDP = 13962, APP = 13961;
const ISSUER = `http://127.0.0.1:${IDP}`;
const SPEC = (issuer: string) => `
app t {
  name "T"
  actor User
  sign_in_screen sign_in_screen
}
entity User {
  name: Text max 80
  email: Email?
  subject: Text
  unique (email)
  unique (subject)
}
entity Login { who: User on delete cascade  token: Text = token(24)  unique (token) }
identity login: Login.token from cookie "login"
policy user_rows: it == actor for rows of User
policy login_rows: .who == actor for rows of Login
sign_in_provider acme {
  issuer "${issuer}"
  then sign_in_with_acme
}
// Signs in the person the provider names: the account it made for them, or a new one.
action sign_in_with_acme(email: Email?, name: Text?, subject: Text) {
  callers internal
  if not exists(User where .subject == subject) {
    create User { name: name.default("Someone"), email: email, subject: subject }
  }
  let u = the(User where .subject == subject)
  create Login { who: u } as l
  result l
}
layout l { <main><Slot name=main /></main><Flash /> }
screen sign_in_screen {
  route "/in"
  layout l
  require public
  <Fill name=main><h1>Sign in</h1><Link href="/_sign_in/acme" label="Sign in with Acme" /></Fill>
}
screen home {
  route "/"
  layout l
  <Fill name=main><h1>Hello {actor.name}</h1></Fill>
}
`;

// ---- the checks
const errs = (src: string) => { const s = parse(src); return [...check(s, { source: src }), ...typecheck(s).findings].filter((f: any) => f.severity === "error").map((f: any) => f.code); };
ok("the spec checks clean", errs(SPEC(ISSUER)).length === 0, errs(SPEC(ISSUER)));
ok("an issuer that isn't https (or localhost) is refused", errs(SPEC("http://idp.example.test")).includes("SIGN_IN_PROVIDER_ISSUER"));
ok("then must name an action", errs(SPEC(ISSUER).replace("then sign_in_with_acme", "then nope")).includes("SIGN_IN_PROVIDER_THEN"));
ok("... one only the sign-in may call (callers internal)", errs(SPEC(ISSUER).replace("  callers internal\n", "  callers people\n")).includes("SIGN_IN_PROVIDER_THEN"));
ok("... given email, name and subject, each as it may come", errs(SPEC(ISSUER).replace("email: Email?, name", "email: Email, name")).includes("SIGN_IN_PROVIDER_THEN") && errs(SPEC(ISSUER).replace("subject: Text) {", "subject: Text, role: Text) {")).includes("SIGN_IN_PROVIDER_THEN"));
ok("a provider needs a cookie session to sign into", errs(SPEC(ISSUER).replace('identity login: Login.token from cookie "login"', 'identity login: Login.token from token')).includes("SIGN_IN_PROVIDER_SESSION"));

// ---- the stand-in provider
const good = generateKeyPairSync("rsa", { modulusLength: 2048 }), other = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...good.publicKey.export({ format: "jwk" }), kid: "k1", use: "sig", alg: "RS256" };
const b64 = (x: Buffer | string) => Buffer.from(x).toString("base64url");
const codes = new Map<string, { nonce: string; challenge: string; redirect: string }>();
// what the next token is like: the test changes it to make a token wrong in one way
let next: Record<string, any> = {};
const sign = (claims: any, key = good.privateKey, alg = "RS256") => {
  const head = b64(JSON.stringify({ alg, kid: "k1", typ: "JWT" })), body = b64(JSON.stringify(claims));
  const sig = alg === "none" ? "" : createSign("RSA-SHA256").update(`${head}.${body}`).sign(key).toString("base64url");
  return `${head}.${body}.${sig}`;
};
const idp = createServer((req, res) => {
  const u = new URL(req.url!, ISSUER);
  const json = (x: any, code = 200) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(x)); };
  if (u.pathname === "/.well-known/openid-configuration") return json({ issuer: ISSUER, authorization_endpoint: `${ISSUER}/auth`, token_endpoint: `${ISSUER}/token`, jwks_uri: `${ISSUER}/jwks` });
  if (u.pathname === "/jwks") return json({ keys: [jwk] });
  if (u.pathname === "/auth") {
    const code = randomBytes(8).toString("hex");
    codes.set(code, { nonce: u.searchParams.get("nonce")!, challenge: u.searchParams.get("code_challenge")!, redirect: u.searchParams.get("redirect_uri")! });
    res.writeHead(302, { Location: `${u.searchParams.get("redirect_uri")}?code=${code}&state=${encodeURIComponent(next.state ?? u.searchParams.get("state")!)}` });
    return res.end();
  }
  if (u.pathname === "/token") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const f = new URLSearchParams(body), c = codes.get(f.get("code") ?? "");
      if (!c || f.get("client_secret") !== "shh" || f.get("client_id") !== "app-1" || f.get("redirect_uri") !== c.redirect) return json({ error: "invalid_grant" }, 400);
      if (createHash("sha256").update(f.get("code_verifier") ?? "").digest("base64url") !== c.challenge) return json({ error: "invalid_grant", why: "pkce" }, 400);
      codes.delete(f.get("code")!);
      const now = Math.floor(Date.now() / 1000);
      const claims = { iss: ISSUER, aud: "app-1", sub: "acme-42", email: "Ada@Example.test", email_verified: true, name: "Ada", iat: now, exp: now + 300, nonce: c.nonce, ...next.claims };
      json({ id_token: sign(claims, next.key ?? good.privateKey, next.alg ?? "RS256"), access_token: "x", token_type: "Bearer" });
    });
    return;
  }
  res.writeHead(404); res.end();
});
await new Promise<void>((r) => idp.listen(IDP, "127.0.0.1", r));

const dir = mkdtempSync(join(tmpdir(), "oidc-"));
writeFileSync(join(dir, "app.crud"), SPEC(ISSUER));
const app = await startApp(join(dir, "app.crud"), APP, { env: { CRUDSPEC_SIGN_IN_ACME_CLIENT_ID: "app-1", CRUDSPEC_SIGN_IN_ACME_CLIENT_SECRET: "shh" }, args: ["--base-url", `http://127.0.0.1:${APP}`] });
try {
  const dump = async (e: string) => ((await app.post("/_test/dump", {})).rows[e] ?? []) as any[];
  const cookiesOf = (r: Response) => r.headers.getSetCookie().map((c) => c.split(";")[0]);
  // the whole round: the app to the provider, back to the app's callback, and where it ends
  const round = async (start = "/_sign_in/acme", tamper?: (callback: string) => string, cookie?: (c: string) => string) => {
    const s = await fetch(app.base + start, { redirect: "manual" });
    const flow = cookiesOf(s).find((c) => c.startsWith("cs_sign_in=")) ?? "";
    const a = await fetch(s.headers.get("location")!, { redirect: "manual" });
    let cb = a.headers.get("location")!;
    if (tamper) cb = tamper(cb);
    const c = await fetch(cb, { redirect: "manual", headers: { Cookie: cookie ? cookie(flow) : flow } });
    return { to: c.headers.get("location") ?? "", cookies: cookiesOf(c), started: s.status, authorize: s.headers.get("location") ?? "" };
  };
  await app.post("/_test/load", { rows: {} });

  const r1 = await round("/_sign_in/acme?return=/");
  ok("starting goes to the provider, asking for a code with PKCE (S256), a state and a nonce", r1.started >= 300 && r1.started < 400 && /\/auth\?/.test(r1.authorize) && /code_challenge_method=S256/.test(r1.authorize) && /state=/.test(r1.authorize) && /nonce=/.test(r1.authorize), r1.authorize);
  const login = r1.cookies.find((c) => c.startsWith("login="));
  ok("the callback signs the person in and goes where they were going", !!login && r1.to === "/", r1);
  ok("... the app's action made their account, with the email the provider vouches for (lowercased), their name and the provider's id", (await dump("User")).length === 1 && (await dump("User"))[0].fields.email === "ada@example.test" && (await dump("User"))[0].fields.name === "Ada" && (await dump("User"))[0].fields.subject === "acme-42", await dump("User"));
  const home = await fetch(app.base + "/", { headers: { Cookie: login! } });
  ok("... and they're signed in", (await home.text()).includes("Hello Ada"));
  const r2 = await round();
  ok("signing in again finds the same account", !!r2.cookies.find((c) => c.startsWith("login=")) && (await dump("User")).length === 1 && (await dump("Login")).length === 2);

  const refused = async (what: string, set: Record<string, any>, tamper?: (cb: string) => string, cookie?: (c: string) => string) => {
    next = set;
    const before = (await dump("Login")).length;
    const r = await round("/_sign_in/acme", tamper, cookie);
    next = {};
    ok(what, r.to === "/in" && !r.cookies.some((c) => c.startsWith("login=")) && (await dump("Login")).length === before && r.cookies.some((c) => c.startsWith("flash=")), r);
  };
  await refused("a token signed by another key is refused", { key: other.privateKey });
  await refused("... and one not signed at all (alg none)", { alg: "none" });
  await refused("... and one for another app (aud)", { claims: { aud: "someone-else" } });
  await refused("... and one from another issuer", { claims: { iss: "https://evil.example.test" } });
  await refused("... and one that has expired", { claims: { exp: Math.floor(Date.now() / 1000) - 600 } });
  await refused("... and one with another nonce (a token replayed from another sign-in)", { claims: { nonce: "stolen" } });
  await refused("a callback with another state is refused (a sign-in started elsewhere)", { state: "forged" });
  await refused("a callback without the sign-in's cookie is refused", {}, undefined, () => "");
  await refused("... and with its cookie tampered", {}, undefined, (c) => c.replace(/\.[^.]*$/, ".bad"));
  await refused("a provider's error is refused, not followed", {}, (cb) => cb.replace(/code=[^&]*/, "error=access_denied"));

  next = { claims: { sub: "acme-77", email: "bo@example.test", email_verified: false, name: "Bo" } };
  await round();
  next = {};
  const bo = (await dump("User")).find((u: any) => u.fields.subject === "acme-77");
  ok("an email the provider doesn't vouch for isn't given to the app (Bo's account has none)", !!bo && bo.fields.email === null, bo);
  const away = await round("/_sign_in/acme?return=//evil.example.test/x");
  ok("a return address off the site goes home instead", away.to === "/", away.to);
  ok("an unknown provider is a 404", (await fetch(app.base + "/_sign_in/nope", { redirect: "manual" })).status === 404);
} finally {
  app.stop();
  idp.close();
}
if (failed) { console.log(`${failed} FAILED`); process.exit(1); }
console.log("all passed");
