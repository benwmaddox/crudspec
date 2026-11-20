// What keeps apps safe without the app saying it: protections the compiler and the runtime add.
//   node lang/test/security.test.ts
process.removeAllListeners("warning");
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generate } from "../gogen/gen.ts";
import { parse } from "../parser.ts";
import { deepCheck } from "../deep.ts";

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

// ---- deep checks for what the security review of the Game Wiki found (lang/deep.ts)
const codes = (src: string) => deepCheck(parse(src)).map((f) => f.code);
{
  ok("SIGN_IN_BY_ADDRESS_ONLY: a password check limited only by request.ip", codes(ACCOUNTS.replace("by email else blocked", "by request.ip else blocked")).includes("SIGN_IN_BY_ADDRESS_ONLY"));
  ok("... none when a limit is by the account", !codes(ACCOUNTS).includes("SIGN_IN_BY_ADDRESS_ONLY"));
}
const TENANT = `
app t { name "T" actor User }
entity User { name: Text }
entity Wiki { name: Text  owner: User }
entity Page { wiki: Wiki  title: Text  template: Template? }
entity Template { wiki: Wiki  name: Text }
enum Role { editor, blocked }
entity Member { wiki: Wiki  user: User  role: Role }
policy user_rows: true for rows of User
policy wiki_rows: wiki.owner == actor or exists(Member where .wiki == wiki and .user == actor) for rows in Wiki
query blocked_in(u: User?, w: Wiki): Bool = exists(Member where .wiki == w and .user == u and .role == blocked)
policy may_edit: not blocked_in(actor, .wiki) else forbidden for writes to Page
`;
{
  const use = `// Uses a template on a page.\naction use_template(page: Page, template: Template) {\n  REQ\n  set page.template = template\n}\n`;
  ok("ROWS_UNRELATED: a page and a template, both inside a wiki, never related", codes(TENANT + use.replace("REQ", "")).includes("ROWS_UNRELATED"));
  ok("... none once the action requires the same wiki", !codes(TENANT + use.replace("REQ", "require template.wiki == page.wiki else invalid")).includes("ROWS_UNRELATED"));
  ok("... nor through a function of both", !codes(TENANT + `fn same(p: Page, t: Template): Bool = p.wiki == t.wiki\n` + use.replace("REQ", "require same(page, template) else invalid")).includes("ROWS_UNRELATED"));
}
{
  const leave = `// Leaves a wiki.\naction leave(m: Member) {\n  require m.user == actor REQ else forbidden\n  delete m\n}\n`;
  ok("BLOCK_SELF_LIFT: someone deletes their own row of an entity whose rows restrict (not exists(… .role …))", codes(TENANT + leave.replace("REQ", "")).includes("BLOCK_SELF_LIFT"));
  ok("... none when the delete reads the restricting field", !codes(TENANT + leave.replace("REQ", "and m.role != blocked")).includes("BLOCK_SELF_LIFT"));
  ok("... nor with a delete policy that reads it", !codes(TENANT + `policy stays: .role != blocked else forbidden for deletes of Member\n` + leave.replace("REQ", "")).includes("BLOCK_SELF_LIFT"));
}

process.exit(failed ? 1 : 0);
