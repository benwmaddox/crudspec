// Rewrites a spec from the syntax before v3 to the current one (lang/LANGUAGE.md):
//   if c then a else b            -> if c { a } else { b }
//   <if test={c}>…</if><else>…</else>  -> if c { … } else { … }      (and <else test={d}>: else if d)
//   <let name="x" value={e} />    -> let x = e
//   <each as="x" in={xs}>…</each> -> for each x in xs { … }
//   name="title", as="t", kind="text"  -> name=title, as=t, kind=text
//   <text>{"Save"}</text>         -> <text>Save</text>
//   list(E where p : e), all(E where p : c)  -> list(e for E where p), all(c for E where p)
// The parser, in legacy mode, reads the old forms and records how to write each (an Edit); the
// edits are applied innermost first, a round at a time, until the current parser reads the file.
// Last, the spec read the old way and the new way must be the same program, or nothing is written.
//   node lang/cli.ts upgrade-syntax <spec> [--check]
import { parse, type Edit } from "./parser.ts";
import { check } from "./check.ts";

export type Upgraded = { text: string; counts: Record<string, number>; rounds: number };

// a failure upgrade-syntax stops on: a code and a place, so the CLI prints it like any other error
export class UpgradeError extends Error {
  readonly code: string;
  readonly pos: { line: number; col: number };
  constructor(message: string, code: string, pos: { line: number; col: number } = { line: 0, col: 0 }) { super(message); this.code = code; this.pos = pos; }
}

// the program a spec says: its declarations, without positions or where things were written
function canonical(x: any): any {
  if (Array.isArray(x)) return x.map(canonical);
  if (x && typeof x === "object") {
    const out: any = {};
    for (const k of Object.keys(x).sort()) if (k !== "pos") out[k] = canonical(x[k]);
    return out;
  }
  return typeof x === "string" ? x.replace(/@[0-9]+$/, "@N") : x;   // a trigger is named by its line (trigger@554)
}

export function upgradeSyntax(src: string): Upgraded {
  const before = JSON.stringify(canonical(parse(src, { legacy: true })));
  const counts: Record<string, number> = {};
  let text = src, rounds = 0;
  for (;;) {
    const edits: Edit[] = [];
    parse(text, { legacy: true, edits });
    if (!edits.length) break;
    if (++rounds > 20) throw new UpgradeError("the edits don't settle; nothing written", "UPGRADE_UNSETTLED");
    // innermost first: an edit that contains another waits for a later round
    const contains = (a: Edit, b: Edit) => a !== b && a.from <= b.from && b.to <= a.to && a.to > a.from && (a.from < b.from || b.to < a.to || b.from === b.to);
    const waits = (a: Edit) => edits.some((b) => contains(a, b));
    // a construct's edits go together: a group waits while any of its edits waits
    const waiting = new Set(edits.filter(waits).map((e) => e.group));
    const ready = edits.filter((a) => !waiting.has(a.group));
    // one edit per place: overlapping ones wait too; insertions at one offset keep their order
    const overlaps = (e: Edit, t: Edit) => e.from < t.to && t.from < e.to;
    const groupsReady = new Map<number, Edit[]>();
    for (const e of ready) groupsReady.set(e.group, [...(groupsReady.get(e.group) ?? []), e]);
    const taken: Edit[] = [];
    for (const g of [...groupsReady.values()].sort((a, b) => a[0].from - b[0].from)) {
      if (g.some((e) => taken.some((t) => overlaps(e, t)))) continue;
      taken.push(...g);
    }
    taken.sort((a, b) => a.from - b.from || a.to - b.to);
    for (const e of [...taken].reverse()) { text = text.slice(0, e.from) + e.text + text.slice(e.to); counts[e.what] = (counts[e.what] ?? 0) + 1; }
  }
  parse(text);   // the current parser reads it
  const after = JSON.stringify(canonical(parse(text)));
  if (after !== before) { if (process.env.UPGRADE_DEBUG) { let i = 0; while (before[i] === after[i]) i++; console.error("DIFF at", i, String.fromCharCode(10), "BEFORE", before.slice(Math.max(0, i - 150), i + 250), String.fromCharCode(10), "AFTER", after.slice(Math.max(0, i - 150), i + 250)); } throw new UpgradeError("the rewritten spec says something different; nothing written", "UPGRADE_CHANGED"); }
  // a loop whose name is also an enum value: in its where, the name meant the value before v3
  const shadow = check(parse(text)).find((f) => f.code === "ROW_NAME_SHADOWS");
  if (shadow) throw new UpgradeError(`${shadow.message}; rename it first, nothing written`, "ROW_NAME_SHADOWS", { line: shadow.line ?? 0, col: 0 });
  return { text, counts, rounds };
}
