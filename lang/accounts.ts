// Account flows: when an app lists them (app { accounts [password_reset, password_change,
// email_verification] }), the runtime adds their actions and screens under /_accounts, written as
// ordinary crudspec source (as admin.ts writes /_admin), so every rule of the app's holds in them.
// What they need is read from what the app already declares:
//   - the actor entity, its Email field (in a unique key) and its Password field;
//   - the session entity, named by the cookie identity, and its reference to the actor: a reset or
//     a change signs the person out of every other browser;
//   - email_verification sets the actor's email_verified: Bool.
// The links mailed are signed_once: an hour for a reset (spent when the password is set), two days
// for a verification. Flows a signed-out visitor uses skip each `for every action` policy that reads
// `actor` (the app's "signed in" rule); a reset and a verification also skip the write policies of
// the actor and session entities, since the signed link is what lets the visitor in.
//   - password_reset       /_accounts/password/forgot, /_accounts/password/reset/:link
//   - password_change      /_accounts/password
//   - email_verification   /_accounts/email, /_accounts/email/verify/:link
import type { Spec, Decl } from "./parser.ts";
import { shell } from "./scaffold.ts";
import { stampsByEntity, weaveStamps } from "./rules.ts";

const q = (s: string) => JSON.stringify(s);

// the generated declarations carry this mark, so the deep checks leave them out of what they say of the app's own
export const ACCOUNTS = "accounts";
export const ACCOUNT_FLOWS = ["password_reset", "password_change", "email_verification"];

const mentions = (x: any, name: string): boolean => {
  if (Array.isArray(x)) return x.some((y) => mentions(y, name));
  if (!x || typeof x !== "object") return false;
  if ((x.kind === "name" || x.kind === "actor") && (x.name === name || x.kind === name)) return true;
  return Object.entries(x).some(([k, v]) => k !== "pos" && mentions(v, name));
};

// What the flows are built from, or the code of why they can't be (the checker says it: ACCOUNTS_*)
export type AccountsPlan = { flows: string[]; actor: string; email: string; password: string; session?: { entity: string; ref: string; token: string }; verified?: string; signIn: string; app: string };
export function accountsPlan(spec: Spec): AccountsPlan | { code: string; actor?: string } | null {
  const app: any = spec.decls.find((d) => d.kind === "app");
  const list: any = app?.props.accounts;
  if (!list) return null;
  const items = list.kind === "listlit" ? list.items : [list];
  const flows: string[] = [];
  for (const it of items) {
    if (it?.kind !== "name" || !ACCOUNT_FLOWS.includes(it.name)) return { code: "ACCOUNTS_FLOW" };
    if (!flows.includes(it.name)) flows.push(it.name);
  }
  const actor = app.props.actor?.name;
  const a: any = spec.decls.find((d) => d.kind === "entity" && d.name === actor);
  if (!a) return { code: "ACCOUNTS_NO_ACTOR", actor };
  const typed = (t: string) => a.fields.filter((f: any) => f.type.kind === "named" && f.type.name === t && !f.type.optional);
  const uniques: string[][] = a.uniques ?? [];
  const email = typed("Email").find((f: any) => uniques.some((u) => u.length === 1 && u[0] === f.name));
  if (!email) return { code: "ACCOUNTS_NO_EMAIL", actor };
  const password = typed("Password")[0];
  if (!password) return { code: "ACCOUNTS_NO_PASSWORD", actor };
  const signIn = app.props.sign_in_screen?.name;
  if (!signIn) return { code: "ACCOUNTS_NO_SIGN_IN", actor };
  let verified: string | undefined;
  if (flows.includes("email_verification")) {
    const f = typed("Bool").find((x: any) => x.name === "email_verified");
    if (!f) return { code: "ACCOUNTS_NO_VERIFIED", actor };
    verified = f.name;
  }
  // the browser sessions: the cookie identity's entity, and its reference to the actor
  const id: any = spec.decls.find((d: any) => d.kind === "identity" && d.source === "cookie");
  const se: any = id && id.entity !== actor ? spec.decls.find((d) => d.kind === "entity" && d.name === id.entity) : undefined;
  const ref = se?.fields.find((f: any) => f.type.kind === "named" && f.type.name === actor);
  const session = se && ref && id.field ? { entity: se.name, ref: ref.name, token: id.field } : undefined;
  const name = app.props.name?.kind === "lit" && typeof app.props.name.value === "string" ? app.props.name.value : app.name;
  return { flows, actor, email: email.name, password: password.name, session, verified, signIn, app: name };
}

export function accountsSource(spec: Spec): string {
  const plan = accountsPlan(spec);
  if (!plan || !("flows" in plan)) return "";
  const sh = shell(spec);
  if (!sh) return "";
  const { actor: A, email, password, session, signIn } = plan;
  // the app's "signed in" rules (a policy for every action that reads actor): a signed-out visitor's flow skips them
  // (a policy for every action is a gate once parsed; one for writes to an entity, a writepolicy)
  const everyActor = spec.decls.filter((d: any) => d.kind === "gate" && mentions(d.cond, "actor")).map((d) => d.name);
  const writesOf = (e: string) => spec.decls.filter((d: any) => d.kind === "writepolicy" && d.entity === e).map((d) => d.name);
  const skip = (names: string[]) => [...new Set(names)].map((n) => `  skip policy ${n}\n`).join("");
  const signedOut = skip(everyActor);
  const linkWrites = skip([...everyActor, ...writesOf(A), ...(session ? writesOf(session.entity) : [])]);
  const signOutAll = (who: string, keepThis: boolean) => session ? `  delete ${session.entity} where .${session.ref} == ${who}${keepThis ? ` and .${session.token} != request.session_token` : ""}\n` : "";
  const strong = `  require length(password) >= 8 else invalid "a password of 8 characters or more"\n`;
  const screen = (name: string, route: string, params: string, title: string, access: string, body: string) => `screen ${name}${params} {
  route ${q(route)}
  layout ${sh.layout}
  ${access}
  <Title>${title}</Title>
  <${sh.slotTag}>
    <${sh.section}>
      <h1>${title}</h1>
${body}
    </section>
  </Fill>
}`;
  const signedIn = `require actor != none else go ${signIn}`;
  const out: string[] = [];

  if (plan.flows.includes("password_reset")) {
    out.push(`// Mails a link to choose a new password, when the address has an account (and says the same either way).
action accounts_request_password_reset(email: Email) {
  callers people
${signedOut}  rate_limit 5 per Duration.minutes(15) by request.ip else blocked
  rate_limit 3 per Duration.hours(1) by lower(trim(email)) else blocked
  let p = the_or_none(${A} where .${email} == email)
  if p != none {
    send mail { to: p.${email}, subject: ${q(`Reset your ${plan.app} password`)}, text: ${q(`Someone asked to reset the password for this address at ${plan.app}. To choose a new one, open this link within an hour:\n\n`)} + text(url_of(accounts_password_reset_screen(signed_once(p, "password_reset", Duration.hours(1))))) + ${q("\n\nIf it wasn't you, ignore this message: the password stays as it is.")} }
  }
}`);
    out.push(`// Sets a new password from a mailed link, and signs the account out everywhere.
action accounts_reset_password(link: Text, password: Text) {
  callers people
${linkWrites}  rate_limit 10 per Duration.minutes(15) by request.ip else blocked
  let p = verify(${A}, link, "password_reset")
  require p != none else invalid "that link has expired or was used already: ask for a new one"
${strong}  set p.${password} = password
${signOutAll("p", false)}}`);
    out.push(screen("accounts_forgot_password_screen", "/_accounts/password/forgot", "", "Forgot your password?", "require public", `      <Form action={accounts_request_password_reset}>
        <Field name=email kind=email required label="Email" />
        <Submit label="Send me a link" />
        <On ok stay flash="If that address has an account, a link to choose a new password is on its way." />
        <On blocked flash="Too many tries: wait a while, then try again." />
      </Form>
      <Link to={${signIn}()}><span>Back to sign in</span></Link>`));
    out.push(screen("accounts_password_reset_screen", "/_accounts/password/reset/:link", "(link: Text)", "Choose a new password", "require public", `      <Robots>noindex</Robots>
      <Form action={accounts_reset_password(link)}>
        <Field name=password kind=password required label="New password" />
        <Submit label="Set password" />
        <On ok go={${signIn}()} flash="Password changed: sign in with it." />
        <On invalid flash="That link has expired or was used already, or the password is too short." />
        <On blocked flash="Too many tries: wait a while, then try again." />
      </Form>
      <Link to={accounts_forgot_password_screen()}><span>Ask for a new link</span></Link>`));
  }

  if (plan.flows.includes("password_change")) {
    out.push(`// Changes your password, given the one you have, and signs you out of your other browsers.
action accounts_change_password(current: Text, password: Text) {
  callers people
  require actor != none else unauthenticated
  rate_limit 10 per Duration.minutes(15) by request.ip else blocked
  let me = the(${A} where it == actor)
  require authenticates(me.${password}, current) else invalid "the current password isn't right"
${strong}  set me.${password} = password
${signOutAll("me", true)}}`);
    out.push(screen("accounts_change_password_screen", "/_accounts/password", "", "Change your password", signedIn, `      <Form action={accounts_change_password}>
        <Field name=current kind=password required label="Current password" />
        <Field name=password kind=password required label="New password" />
        <Submit label="Change password" />
        <On ok stay flash="Password changed. Your other browsers are signed out." />
        <On invalid flash="Not changed: the current password isn't right, or the new one is shorter than 8 characters." />
        <On blocked flash="Too many tries: wait a while, then try again." />
      </Form>`));
  }

  if (plan.flows.includes("email_verification")) {
    const v = plan.verified!;
    out.push(`// Mails you a link that confirms your email address.
action accounts_send_email_verification() {
  callers people
  require actor != none else unauthenticated
  rate_limit 5 per Duration.hours(1) by request.ip else blocked
  let me = the(${A} where it == actor)
  require not me.${v} else invalid "this address is confirmed already"
  send mail { to: me.${email}, subject: ${q(`Confirm your ${plan.app} email address`)}, text: ${q(`To confirm this address for your ${plan.app} account, open this link within two days:\n\n`)} + text(url_of(accounts_email_verification_screen(signed_once(me, "email_verification", Duration.days(2))))) + ${q("\n\nIf you didn't ask for it, ignore this message.")} }
}`);
    out.push(`// Confirms an email address from a mailed link.
action accounts_verify_email(link: Text) {
  callers people
${linkWrites}  rate_limit 10 per Duration.minutes(15) by request.ip else blocked
  let p = verify(${A}, link, "email_verification")
  require p != none else invalid "that link has expired or was used already: ask for a new one"
  set p.${v} = true
}`);
    out.push(screen("accounts_email_screen", "/_accounts/email", "", "Your email address", signedIn, `      {let me = the(${A} where it == actor)}
      {if me.${v} {
        <p>{me.${email}} is confirmed.</p>
      } else {
        <p>{me.${email}} isn't confirmed yet.</p>
        <Button action={accounts_send_email_verification()} text="Send me a link" />
        <On ok stay flash="A link is on its way: open it to confirm the address." />
        <On blocked flash="Too many tries: wait a while, then try again." />
      }}`));
    out.push(screen("accounts_email_verification_screen", "/_accounts/email/verify/:link", "(link: Text)", "Confirm your email address", "require public", `      <Robots>noindex</Robots>
      <Button action={accounts_verify_email(link)} text="Confirm my address" />
      <On ok go={${signIn}()} flash="Address confirmed." />
      <On invalid flash="That link has expired or was used already: ask for a new one." />`));
  }
  return out.join("\n\n") + "\n";
}

// Adds the account flows to a spec: their source, parsed and marked as generated, with the app's stamps woven in
export function withAccounts(spec: Spec, parse: (src: string) => Spec): Decl[] {
  const src = accountsSource(spec);
  if (!src) return [];
  const generated = parse(src).decls;
  for (const g of generated) (g as any).generated = ACCOUNTS;
  weaveStamps(generated, stampsByEntity(spec.decls), new Map(spec.decls.filter((d) => ["entity", "singleton", "data"].includes(d.kind)).map((d) => [d.name, d])));
  return generated;
}
