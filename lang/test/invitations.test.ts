// Invitations (lang/invitations.ts): `invitations { into Membership  by can_invite }` lets whoever
// the predicate allows invite people by email to a team; the invited person accepts from the mailed
// link, signed in with that address, which makes the membership, with the role the inviter chose.
// The link works once; a withdrawn invitation's doesn't work; someone else's address is refused.
//   node lang/test/invitations.test.ts      (needs Go: on Windows, in WSL)
process.removeAllListeners("warning");
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "../parser.ts";
import { check } from "../check.ts";
import { typecheck } from "../types.ts";
import { withGenerated } from "../scaffold.ts";
import { startApp } from "./go-app.ts";

let failed = 0;
const ok = (what: string, pass: boolean, detail?: unknown) => { console.log(`${pass ? "ok  " : "FAIL"} ${what}`); if (!pass) { failed++; if (detail !== undefined) console.log("     ", typeof detail === "string" ? detail.slice(0, 600) : JSON.stringify(detail)?.slice(0, 600)); } };

const SPEC = `
app t {
  name "Teams"
  actor User
  sign_in_screen sign_in_screen
}
enum Role { member, owner }
entity User { name: Text max 40  email: Email  token: Text?  unique (email)  unique (token) }
entity Team { name: Text max 40 }
entity Membership { user: User on delete cascade  team: Team on delete cascade  role: Role = member  unique (user, team) }
identity login: User.token from cookie "login"
policy user_rows: true for rows of User
query member_of(u: User?, t: Team): Bool = exists(Membership where .user == u and .team == t)
policy team_rows: member_of(actor, it) for rows of Team
policy membership_rows: .user == actor for rows of Membership
policy signed_in: actor != none else unauthenticated for every action
query can_invite(u: User?, team: Team): Bool = exists(Membership where .user == u and .team == team and .role == owner)
invitations {
  into Membership
  by can_invite
}
layout l { <main><Slot name=main /></main><Flash /> }
screen sign_in_screen { route "/in"  layout l  require public  <Fill name=main><h1>Sign in</h1></Fill> }
screen home { route "/"  layout l  <Fill name=main><h1>Home</h1></Fill> }
screen team_screen(team: Team) {
  route "/teams/:team"
  layout l
  <Fill name=main><h1>{team.name}</h1><Link to={invitations_screen(team)}><span>Invite people</span></Link></Fill>
}
`;

const findings = (src: string) => { const s = parse(src); const f = check(s, { source: src }); return f.some((x) => x.severity === "error") ? f : [...f, ...typecheck(withGenerated(parse(src), parse)).findings]; };
const errs = (src: string) => findings(src).filter((f: any) => f.severity === "error").map((f: any) => f.code);
ok("the spec checks clean, the generated flow included, and the app links to its screen", errs(SPEC).length === 0, findings(SPEC).filter((f: any) => f.severity === "error"));
ok("a membership that doesn't refer to the actor and a team is refused", errs(SPEC.replace("into Membership", "into Team")).includes("INVITATIONS_INTO"));
ok("who may invite is a predicate of two", errs(SPEC.replace("by can_invite", "by nope")).includes("INVITATIONS_BY"));
ok("the actor needs an email that is a unique key", errs(SPEC.replace("  unique (email)", "")).includes("INVITATIONS_NO_EMAIL"));

const dir = mkdtempSync(join(tmpdir(), "invitations-"));
writeFileSync(join(dir, "app.crud"), SPEC);
const app = await startApp(join(dir, "app.crud"), 13991, { args: ["--base-url", "https://teams.example.test"] });
try {
  await app.post("/_test/load", { clock: Date.parse("2026-11-20T15:00:00Z"), rows: {
    User: [
      { id: 1, seq: 1, created: 0, updated: 0, fields: { name: "Ada", email: "ada@example.test", token: "ada" } },
      { id: 2, seq: 2, created: 0, updated: 0, fields: { name: "Bo", email: "bo@example.test", token: "bo" } },
      { id: 3, seq: 3, created: 0, updated: 0, fields: { name: "Cy", email: "cy@example.test", token: "cy" } }],
    Team: [{ id: 10, seq: 10, created: 0, updated: 0, fields: { name: "Crew" } }],
    Membership: [{ id: 20, seq: 20, created: 0, updated: 0, fields: { user: { ref: "User", id: 1 }, team: { ref: "Team", id: 10 }, role: "owner" } }],
  } });
  const post = async (who: string | null, action: string, args: Record<string, string> = {}) => {
    const r = await fetch(`${app.base}/_do/${action}`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: app.base, ...(who ? { Cookie: `login=${who}` } : {}) }, body: new URLSearchParams(args), redirect: "manual" });
    return r.headers.get("X-Crudspec-Outcome");
  };
  const get = async (who: string | null, path: string) => { const r = await fetch(app.base + path, { headers: who ? { Cookie: `login=${who}` } : {}, redirect: "manual" }); return { status: r.status, text: await r.text() }; };
  const dump = async (e: string) => ((await app.post("/_test/dump", {})).rows[e] ?? []) as any[];
  const outbox = async () => (await app.post("/_test/outbox", {})).messages as any[];
  const tokenIn = (m: any) => decodeURIComponent(/\/_invitations\/accept\/([^\s]+)/.exec(m?.text ?? "")?.[1] ?? "");

  ok("the team's owner opens the invite page", (await get("ada", "/_invitations/10")).status === 200 && (await get("ada", "/_invitations/10")).text.includes("Send the invitation"));
  ok("... someone who may not invite doesn't", !(await get("bo", "/_invitations/10")).text.includes("Send the invitation"));
  ok("someone who may not invite can't send one", (await post("bo", "invitations_send", { team: "10", email: "bo@example.test", role: "owner" })) !== "ok");
  ok("the owner invites Bo, as a member", (await post("ada", "invitations_send", { team: "10", email: "bo@example.test", role: "member" })) === "ok");
  const mail = (await outbox())[0];
  const link = tokenIn(mail);
  ok("... Bo is mailed a link to the accept page, at the app's address", mail?.to === "bo@example.test" && !!link && /https:\/\/teams\.example\.test\/_invitations\/accept\//.test(mail.text), mail);
  ok("... and the invitation is listed as not yet accepted", (await get("ada", "/_invitations/10")).text.includes("bo@example.test"));
  ok("the accept page asks a signed-out visitor to sign in first", (await get(null, `/_invitations/accept/${encodeURIComponent(link)}`)).text.includes("Sign in with the address"));
  ok("Cy, signed in, can't accept Bo's invitation", (await post("cy", "invitations_accept", { link })) === "forbidden");
  ok("Bo accepts it", (await post("bo", "invitations_accept", { link })) === "ok");
  const mine = (await dump("Membership")).find((m: any) => (m.fields.user?.id ?? m.fields.user) === 2);
  ok("... and is a member of the team, with the role chosen", (mine?.fields.team?.id ?? mine?.fields.team) === 10 && mine?.fields.role === "member", mine);
  ok("... the invitation is gone, so its link works once", (await dump("Invitation")).length === 0 && (await post("bo", "invitations_accept", { link })) === "invalid");
  await post("ada", "invitations_send", { team: "10", email: "bo@example.test", role: "owner" });
  ok("an invitation to someone in already is refused when accepted", (await post("bo", "invitations_accept", { link: tokenIn((await outbox())[0]) })) === "conflict");
  await post("ada", "invitations_send", { team: "10", email: "cy@example.test", role: "member" });
  const cyLink = tokenIn((await outbox())[0]);
  const cyInv = (await dump("Invitation")).find((i: any) => i.fields.email === "cy@example.test");
  ok("the owner withdraws Cy's invitation", (await post("ada", "invitations_withdraw", { invitation: String(cyInv?.id) })) === "ok");
  ok("... and its link no longer works", (await post("cy", "invitations_accept", { link: cyLink })) === "invalid");
  ok("someone who may not invite can't withdraw one", (await post("bo", "invitations_withdraw", { invitation: String((await dump("Invitation"))[0]?.id) })) !== "ok");
} finally { app.stop(); }
if (failed) { console.log(`${failed} FAILED`); process.exit(1); }
console.log("all passed");
