// The facts (lang/facts.ts): what each declaration reads, uses and sets off, on Campfire and Desk.
//   node lang/test/facts.test.ts
import { parse } from "../parser.ts";
import { readSpec } from "../source.ts";
import { withGenerated } from "../scaffold.ts";
import { cascade, facts, fires, reach, screenReads } from "../facts.ts";

let failed = 0;
const ok = (what: string, pass: boolean, detail?: unknown) => { console.log(`${pass ? "ok  " : "FAIL"} ${what}`); if (!pass) { failed++; if (detail !== undefined) console.log(JSON.stringify(detail, null, 2)); } };
const of = (app: string) => { const spec = parse(readSpec(app)); withGenerated(spec, parse); return facts(spec); };
const campfire = of("apps/campfire"), desk = of("app3");
const readsOf = (F: typeof campfire, id: string) => new Set(F.reads.filter((r) => r.by === id).map((r) => r.field));

// two triggers on the same thing each keep their reads (they have no names: a number tells them apart)
ok("Campfire: both triggers on update Room.type read Room.type", readsOf(campfire, "trigger on update Room.type").has("Room.type") && readsOf(campfire, "trigger on update Room.type #2").has("Room.type"));
// an entity's invariants, as one
const ban = readsOf(campfire, "invariant on Ban");
ok("Campfire: Ban's invariants read Ban.ip and Ban.user", ban.has("Ban.ip") && ban.has("Ban.user"), [...ban]);

// a use is a call, a ref, a view named, an element's head, a layout: not any name that matches
const room = reach(campfire, "screen room_screen");
ok("Campfire: the room screen uses its layout, MessageItem and room_messages", ["layout app", "component MessageItem", "view room_messages"].every((x) => room.has(x)), [...room]);
ok("... and the bot_key gate doesn't use fn bot_key (it names the identity)", !reach(campfire, "gate deny_bots").has("fn bot_key"));
ok("... nor does User, whose role defaults to the enum value member (not the predicate member)", !campfire.uses.some((u) => u.by === "entity User" && u.to === "predicate member"));

// the triggers a writer sets off: a delete sets off delete triggers of what it cascades to, only
const membershipGone = "trigger on delete Membership";
const deleters = campfire.bodies.filter((b) => b.d.kind === "action").map((b) => ({ id: b.id, dels: campfire.deletes.filter((d) => d.by === b.id) }));
const reaches = (d: { entity: string }) => !d.entity || cascade(campfire, d.entity).has("Membership");
ok("Campfire: an action sets off the Membership delete trigger exactly when what it deletes cascades there",
  deleters.every(({ id, dels }) => fires(campfire, id).has(membershipGone) === dels.some(reaches)), deleters.filter(({ id, dels }) => fires(campfire, id).has(membershipGone) !== dels.some(reaches)).map((x) => x.id));
ok("... sign_out (a Session's delete) doesn't", !fires(campfire, "action sign_out").has(membershipGone));

// a page loads what the predicates of read permissions read (a permission that runs in Go reads
// the row as the page loaded it): Desk's can_read_ticket reads Ticket.customer
ok("Desk: a page that shows no ticket fields still loads Ticket.customer, for the read permission", screenReads(desk, "screen setup_screen").fields.has("Ticket.customer"));

process.exit(failed ? 1 : 0);
