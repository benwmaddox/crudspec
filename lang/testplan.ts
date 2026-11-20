// The test plan (docs/testing.md): for each action and view, the outcomes it can end with (ok,
// and each refusal its requires, rejects, rate limits and policies can give), and which of them a
// test of the spec runs (run name(…) … expect outcome). An agent reads it to know which tests to
// write; verify reports how much of it is covered.
import type { Spec } from "./parser.ts";

export type PlanRow = { name: string; kind: "action" | "view"; line: number; outcomes: { outcome: string; tested: boolean; why: string; line?: number }[] };

// each outcome a body can end with, and the first statement that gives it
function outcomesOf(body: any): Map<string, { why: string; line?: number }> {
  const out = new Map<string, { why: string; line?: number }>();
  const walk = (x: any): void => {
    if (!x || typeof x !== "object") return;
    if (Array.isArray(x)) { x.forEach(walk); return; }
    if ((x.kind === "require" || x.kind === "reject" || x.kind === "rate_limit") && typeof x.outcome === "string" && !out.has(x.outcome)) {
      const why = x.kind === "rate_limit" ? "its rate limit" : x.fromPolicy ? `policy ${x.fromPolicy}` : x.kind === "reject" ? "a reject" : x.reason ? `"${x.reason}"` : "a require";
      out.set(x.outcome, { why, line: x.pos?.line });
    }
    for (const [k, v] of Object.entries(x)) if (k !== "pos") walk(v);
  };
  walk(body);
  return out;
}

export function testPlan(spec: Spec): PlanRow[] {
  const tested = new Map<string, Set<string>>();
  for (const t of spec.decls.filter((d) => d.kind === "test") as any[])
    for (const s of t.steps) if (s.kind === "run") { if (!tested.has(s.call)) tested.set(s.call, new Set()); tested.get(s.call)!.add(s.expect ?? "ok"); }
  const gates = spec.decls.filter((d) => d.kind === "gate") as any[];
  const rows: PlanRow[] = [];
  for (const d of spec.decls as any[]) {
    if (d.kind !== "action" && d.kind !== "view") continue;
    if (d.internal || d.scheduled || d.std || (d.pos?.line ?? 0) === 0) continue;
    const found = outcomesOf(d.kind === "action" ? d.body : [d.requires, d.require, d.body]);
    if (d.kind === "action") for (const g of gates) if (!(d.skips ?? []).includes(g.name) && !found.has(g.outcome)) found.set(g.outcome, { why: `policy ${g.name} for every action`, line: g.pos?.line });
    const has = tested.get(d.name) ?? new Set();
    const outcomes = [{ outcome: "ok", tested: has.has("ok"), why: d.kind === "view" ? "its rows" : "it runs" }, ...[...found].map(([o, w]) => ({ outcome: o, tested: has.has(o), why: w.why, line: w.line }))];
    rows.push({ name: d.name, kind: d.kind, line: d.pos?.line ?? 0, outcomes });
  }
  return rows;
}

export function planSummary(rows: PlanRow[]): { covered: number; total: number; untested: number } {
  const all = rows.flatMap((r) => r.outcomes);
  return { covered: all.filter((o) => o.tested).length, total: all.length, untested: rows.filter((r) => r.outcomes.every((o) => !o.tested)).length };
}
