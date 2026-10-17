// The change report on Campfire: spec changes an agent might make, and what `review` says.
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compiledApp } from "../../../lang/gogen/program.ts";
import { parse } from "../../../lang/parser.ts";
import { review } from "../../../lang/review.ts";
import { collectProbes } from "./probes.ts";

const src = readFileSync("apps/campfire/campfire.crud", "utf8");
const base = parse(src);
const probes = await collectProbes("apps/campfire/campfire.crud");
// each version as a compiled app (with Campfire's widgets beside it)
const appOf = (text: string) => { if (text === src) return compiledApp("apps/campfire/campfire.crud"); const d = mkdtempSync(join(tmpdir(), "crudspec-review-")); writeFileSync(join(d, "campfire.crud"), text); copyFileSync("apps/campfire/widgets.go", join(d, "widgets.go")); return compiledApp(join(d, "campfire.crud")); };
const rev = (a: string, b: string) => review(parse(a), parse(b), a, b, probes, { old: appOf(a), new: appOf(b) });
let failed = 0;
const ok = (name: string, cond: boolean, info?: unknown) => { console.log(`${cond ? "ok  " : "FAIL"} ${name}`); if (!cond) { failed++; console.log(JSON.stringify(info, null, 2)); } };
const change = (from: string, to: string) => { if (!src.includes(from)) throw new Error(`not in the spec: ${from}`); const s = src.replace(from, to); return rev(src, s); };
const widened = (r: any, kind: string, name: string) => r.behaviour.some((f: any) => f.change === "widened" && f.kind === kind && f.name === name);

{ const r = rev(src, src); ok(`unchanged spec: nothing reported (${r.runs} runs)`, !r.schema.length && !r.claims.length && !r.behaviour!.length && r.incomparable === 0, r); }
{ const r = change("  require can_administer(actor, message.creator) else forbidden\n  delete message", "  delete message");
  ok("ownership check removed from delete_message: widened", widened(r, "call", "delete_message") && r.behaviour!.every((f) => f.name === "delete_message"), r.behaviour); }
{ const r = change("permission read Message: member(actor, message.room)", "permission read Message: member(actor, message.room) or message.room.type == open");
  ok("message reads opened to open rooms: read widened", widened(r, "read", "Message"), r.behaviour); }
{ const r = change("permission read Room: member(actor, room)", "permission read Room: true");
  ok("rooms readable by everyone: read and view rows widened", widened(r, "read", "Room"), r.behaviour); }
{ const r = change("action boost(message: Message, content: Text) {", "action boost(message: Message, content: Text) {\n  require actor.role == administrator else forbidden");
  ok("boosting restricted to administrators: narrowed, not widened", r.behaviour!.some((f) => f.change === "narrowed" && f.name === "boost") && !r.behaviour!.some((f) => f.change === "widened"), r.behaviour); }
{ const s = src.replace("  bio: Text?", "  about: Text? was bio"); const r = review(base, parse(s), src, s);   // the schema step only: the rest of the spec still says bio
  ok("a rename is a safe schema step", r.schema.some((s) => s.op === "rename_field" && s.class === "safe"), r.schema); }
// an agent adds a destructive action any member can call: new, so only synthesized calls can find it
{ const r = change("action boost(message: Message, content: Text) {", `action wipe_room(room: Room) {
  require member(actor, room) else not_found
  delete Message where .room == room
}
action boost(message: Message, content: Text) {`);
  ok("a new destructive action is explored: who can call it is reported", widened(r, "new call", "wipe_room") && r.claims.some((c) => c.startsWith("new action wipe_room")), r.behaviour); }
// a rename with the same rules: once probe states are migrated, nothing changes
{ let s = src.replace("  role: Role = member", "  access: Role was role = member").replace(/\.role\b/g, ".access").replace("avatar: avatar, role: administrator", "avatar: avatar, access: administrator").replace("role: bot, bot_token", "access: bot, bot_token");
  const r = rev(src, s);
  ok(`renaming User.role with was: a safe step and no access change (${r.incomparable} incomparable)`, r.schema.some((x) => x.op === "rename_field") && r.behaviour!.length === 0, r.behaviour); }
// a gate on agents: removing it widens what agents can do, and only for agents
{ const gate = `gate agents_read_only: request.identity == agent and request.method == write -> forbidden
`;
  const withGate = src.replace("gate signed_in:", gate + "gate signed_in:");
  const r = rev(withGate, src);
  const f = r.behaviour!.filter((x) => x.change === "widened");
  ok("removing a gate on agents: widened, as an agent only", f.length > 0 && f.every((x) => x.examples.every((e) => e.includes("as an agent"))), f); }
process.exit(failed ? 1 : 0);
