// The change report on Campfire: spec changes an agent might make, and what `review` says.
import { readFileSync } from "node:fs";
import { parse } from "../../../lang/parser.ts";
import { review } from "../../../lang/review.ts";
import { collectProbes } from "./probes.ts";

const src = readFileSync("apps/campfire/campfire.crud", "utf8");
const base = parse(src);
const probes = collectProbes(base);
let failed = 0;
const ok = (name: string, cond: boolean, info?: unknown) => { console.log(`${cond ? "ok  " : "FAIL"} ${name}`); if (!cond) { failed++; console.log(JSON.stringify(info, null, 2)); } };
const change = (from: string, to: string) => { if (!src.includes(from)) throw new Error(`not in the spec: ${from}`); const s = src.replace(from, to); return review(base, parse(s), src, s, probes); };
const widened = (r: any, kind: string, name: string) => r.behaviour.some((f: any) => f.change === "widened" && f.kind === kind && f.name === name);

{ const r = review(base, base, src, src, probes); ok(`unchanged spec: nothing reported (${r.runs} runs)`, !r.schema.length && !r.claims.length && !r.behaviour!.length && r.incomparable === 0, r); }
{ const r = change("  require can_administer(actor, message.creator) else forbidden\n  delete message", "  delete message");
  ok("ownership check removed from delete_message: widened", widened(r, "call", "delete_message") && r.behaviour!.every((f) => f.name === "delete_message"), r.behaviour); }
{ const r = change("permission read Message: member(actor, message.room)", "permission read Message: member(actor, message.room) or message.room.type == open");
  ok("message reads opened to open rooms: read widened", widened(r, "read", "Message"), r.behaviour); }
{ const r = change("permission read Room: member(actor, room)", "permission read Room: true");
  ok("rooms readable by everyone: read and view rows widened", widened(r, "read", "Room"), r.behaviour); }
{ const r = change("action boost(message: Message, content: Text) {", "action boost(message: Message, content: Text) {\n  require actor.role == administrator else forbidden");
  ok("boosting restricted to administrators: narrowed, not widened", r.behaviour!.some((f) => f.change === "narrowed" && f.name === "boost") && !r.behaviour!.some((f) => f.change === "widened"), r.behaviour); }
{ const r = change("  bio: Text?", "  about: Text? was bio");
  ok("a rename is a safe schema step", r.schema.some((s) => s.op === "rename_field" && s.class === "safe"), r.schema); }
process.exit(failed ? 1 : 0);
