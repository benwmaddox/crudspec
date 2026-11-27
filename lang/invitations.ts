// Invitations: `invitations { into Membership  by can_invite }` lets people invite others by email
// to a team (any entity the membership refers to besides the person), generated as ordinary
// crudspec (as accounts.ts and admin.ts are), so the app's rules hold in it. From the app:
//   - into: the membership entity; it refers to the actor's entity (the person) and to one other
//     entity (the team), and may have one enum field (the role, chosen by whoever invites);
//   - by: a predicate of (the actor, the team): who may invite to it, see its invitations, withdraw them;
//   - the actor's Email field that is a unique key: an invitation is accepted by the address it went to.
// It adds an entity, Invitation (email, the team, the role, who sent it), and:
//   - invitations_send: mails a link that works for seven days;
//   - invitations_withdraw;
//   - invitations_accept: signed in as the invited address, it makes the membership, and the
//     invitation is gone (deleted), so the link works once;
//   - /_invitations/<team>: the invite form and the invitations not yet accepted;
//   - /_invitations/accept/<link>: the accept page.
import type { Spec, Decl } from "./parser.ts";
import { shell } from "./scaffold.ts";
import { stampsByEntity, weaveStamps } from "./rules.ts";

const q = (s: string) => JSON.stringify(s);
const snake = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
export const INVITATIONS = "invitations";

export type InvitationsPlan = { into: string; by: string; person: string; personField: string; team: string; teamField: string; role?: { field: string; enum: string }; email: string; signIn: string; home: string; app: string };

// what the flow is built from, or the code of why it can't be (the checker says it: INVITATIONS_*)
export function invitationsPlan(spec: Spec): InvitationsPlan | { code: string; detail?: string } | null {
  const d: any = spec.decls.find((x) => x.kind === "invitations");
  if (!d) return null;
  const app: any = spec.decls.find((x) => x.kind === "app");
  const actor = app?.props.actor?.name;
  const ents = new Map(spec.decls.filter((x) => x.kind === "entity").map((x: any) => [x.name, x]));
  const enums = new Set(spec.decls.filter((x) => x.kind === "enum").map((x) => x.name));
  if (!actor || !ents.has(actor)) return { code: "INVITATIONS_NO_ACTOR" };
  const m: any = ents.get(d.into);
  if (!m) return { code: "INVITATIONS_INTO", detail: d.into };
  const refs = m.fields.filter((f: any) => f.type.kind === "named" && ents.has(f.type.name));
  const pf = refs.find((f: any) => f.type.name === actor);
  const others = refs.filter((f: any) => f !== pf);
  if (!pf || others.length !== 1) return { code: "INVITATIONS_INTO", detail: d.into };
  const tf = others[0];
  const roles = m.fields.filter((f: any) => f.type.kind === "named" && enums.has(f.type.name));
  if (roles.length > 1) return { code: "INVITATIONS_INTO", detail: d.into };
  const role = roles[0] ? { field: roles[0].name, enum: roles[0].type.name } : undefined;
  // every other field the membership needs has a default, or may be none
  const rest = m.fields.filter((f: any) => f !== pf && f !== tf && f !== roles[0] && !f.stamped);
  if (rest.some((f: any) => !f.default && !(f.type.kind === "named" && f.type.optional))) return { code: "INVITATIONS_INTO", detail: d.into };
  const p: any = spec.decls.find((x: any) => x.kind === "predicate" && x.name === d.by);
  if (!p || (p.params ?? []).length !== 2) return { code: "INVITATIONS_BY", detail: d.by };
  const a: any = ents.get(actor);
  const email = a.fields.find((f: any) => f.type.kind === "named" && f.type.name === "Email" && !f.type.optional && (a.uniques ?? []).some((u: string[]) => u.length === 1 && u[0] === f.name));
  if (!email) return { code: "INVITATIONS_NO_EMAIL" };
  const signIn = app.props.sign_in_screen?.name;
  if (!signIn) return { code: "INVITATIONS_NO_SIGN_IN" };
  if (spec.decls.some((x: any) => x.name === "Invitation" && x.kind === "entity" && !x.generated)) return { code: "INVITATIONS_TAKEN" };
  const home = spec.decls.find((x: any) => x.kind === "screen" && x.route === "/" && !(x.params ?? []).length)?.name ?? signIn;
  const name = app.props.name?.kind === "lit" && typeof app.props.name.value === "string" ? app.props.name.value : app.name;
  return { into: d.into, by: d.by, person: actor, personField: pf.name, team: tf.type.name, teamField: tf.name, role, email: email.name, signIn, home, app: name };
}

export function invitationsSource(spec: Spec): string {
  const pl = invitationsPlan(spec);
  if (!pl || !("into" in pl)) return "";
  const sh = shell(spec);
  if (!sh) return "";
  const { into: M, by: P, person: A, personField: pf, team: T, teamField: tf, role, email } = pl;
  const t = snake(T);
  const roleParam = role ? `, role: ${role.enum}` : "";
  const roleField = role ? `\n  role: ${role.enum}` : "";
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
  return `entity Invitation {
  email: Email
  ${tf}: ${T} on delete cascade${roleField}
  by: ${A} on delete cascade
}
policy invitations_rows: ${P}(actor, .${tf}) for rows of Invitation

// Invites someone, by email, to ${t.replace(/_/g, " ")}: a link that works for seven days.
action invitations_send(${tf}: ${T}, email: Email${roleParam}) {
  callers people
  require actor != none else unauthenticated
  require ${P}(actor, ${tf}) else forbidden
  rate_limit 30 per Duration.hours(1) by request.ip else blocked
  create Invitation { email: email, ${tf}: ${tf}${role ? ", role: role" : ""}, by: actor } as inv
  send mail { to: email, subject: ${q(`You're invited to ${pl.app}`)}, text: ${q(`You're invited to join ${pl.app}. To accept, open this link within seven days, signed in with this address (or make an account with it first):\n\n`)} + text(url_of(invitations_accept_screen(signed(inv, "invitation", Duration.days(7))))) + ${q("\n\nIf you weren't expecting it, ignore this message.")} }
  result inv
}

// Withdraws an invitation not yet accepted.
action invitations_withdraw(invitation: Invitation) {
  callers people
  require ${P}(actor, invitation.${tf}) else forbidden
  delete invitation
}

// Accepts an invitation from its link, signed in with the address it went to.
action invitations_accept(link: Text) {
  callers people
  require actor != none else unauthenticated
  rate_limit 20 per Duration.minutes(15) by request.ip else blocked
  let inv = verify(Invitation, link, "invitation")
  require inv != none else invalid "that invitation has expired, was withdrawn, or was used already"
  let me = the(${A} where it == actor)
  require lower(me.${email}) == lower(inv.email) else forbidden "that invitation is for another address"
  require not exists(${M} where .${pf} == me and .${tf} == inv.${tf}) else conflict "you're in already"
  create ${M} { ${pf}: me, ${tf}: inv.${tf}${role ? `, ${role.field}: inv.role` : ""} }
  delete inv
}

// The invitations to a ${t.replace(/_/g, " ")} not yet accepted.
view invitations_pending(${tf}: ${T}) {
  require ${P}(actor, ${tf}) else forbidden
  rows Invitation where .${tf} == ${tf}
  order by created desc
  limit 200
}

${screen("invitations_screen", `/_invitations/:${tf}`, `(${tf}: ${T})`, "Invite people", `require ${P}(actor, ${tf}) else go ${pl.home}`, `      <Form action={invitations_send(${tf})}>
        <Field name=email kind=email required label="Email" />
${role ? `        <Field name=role kind=choice from={[${(spec.decls.find((x: any) => x.kind === "enum" && x.name === role.enum) as any).values.join(", ")}]} required label="Role" />\n` : ""}        <Submit label="Send the invitation" />
        <On ok stay flash="Sent." />
        <On blocked flash="Too many invitations: wait a while, then try again." />
      </Form>
      <h2>Not yet accepted</h2>
      <List of={invitations_pending(${tf})} as=i class="list">
        <div class="row"><span>{i.email}</span>${role ? `<span class="muted">{i.role}</span>` : ""}<Button action={invitations_withdraw(i)} text="Withdraw" class="quiet" /></div>
      </List>`)}

${screen("invitations_accept_screen", "/_invitations/accept/:link", "(link: Text)", "Your invitation", "require public", `      <Robots>noindex</Robots>
      {if actor == none {
        <p>Sign in with the address the invitation went to (or make an account with it), then open the link again.</p>
        <Link to={${pl.signIn}()}><span>Sign in</span></Link>
      } else {
        <Button action={invitations_accept(link)} text="Accept the invitation" />
        <On ok go={${pl.home}()} flash="You're in." />
        <On invalid flash="That invitation has expired, was withdrawn, or was used already." />
        <On forbidden flash="That invitation is for another address: sign in with that one." />
        <On conflict flash="You're in already." />
      }}`)}
`;
}

export function withInvitations(spec: Spec, parse: (src: string) => Spec): Decl[] {
  const src = invitationsSource(spec);
  if (!src) return [];
  const generated = parse(src).decls;
  for (const g of generated) (g as any).generated = INVITATIONS;
  weaveStamps(generated, stampsByEntity(spec.decls), new Map(spec.decls.filter((d) => ["entity", "singleton", "data"].includes(d.kind)).map((d) => [d.name, d])));
  return generated;
}
