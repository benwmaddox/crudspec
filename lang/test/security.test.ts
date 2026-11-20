// What keeps apps safe without the app saying it: protections the compiler and the runtime add.
//   node lang/test/security.test.ts
process.removeAllListeners("warning");
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generate } from "../gogen/gen.ts";

let failed = 0;
const ok = (what: string, pass: boolean, detail?: unknown) => { console.log(`${pass ? "ok  " : "FAIL"} ${what}`); if (!pass) { failed++; if (detail !== undefined) console.log(String(typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 600)); } };
const goOf = (spec: string) => { const dir = mkdtempSync(join(tmpdir(), "cs-sec-")); writeFileSync(join(dir, "app.crud"), spec); return Object.values(generate(join(dir, "app.crud"))).join("\n"); };

const ACCOUNTS = `
app t { name "T" actor User }
entity User { email: Email  password: Password }
entity Login { user: User  token: Text = token(24) }
identity login: Login.token from cookie "login"
policy user_rows: true for rows of User
policy login_rows: .user == actor for rows of Login
action sign_in(email: Email, password: Text) {
  callers people
  rate_limit 10 per Duration.minutes(3) by email else blocked
  let u = the_or_none(User where .email == email)
  require u != none and authenticates(u.password, password) else unauthenticated
  create Login { user: u } as l
  result l
}
`;

// a sign-in for an email no one has hashes a password anyway, so its time doesn't say whether the
// email has an account
{
  const go = goOf(ACCOUNTS);
  ok("user != none and authenticates(…): a missing user still hashes (rt.HashAnyway)", /rt\.HashAnyway\(/.test(go), go.split("\n").filter((l) => l.includes("CheckPassword") || l.includes("authenticates")).join("\n"));
}

process.exit(failed ? 1 : 0);
