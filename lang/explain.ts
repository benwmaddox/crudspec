// Why a call is refused, in the spec's own words: what a require needs, with the predicates it
// calls spelled out for the call's arguments. The Go runtime returns these to agents (and test
// reports); describe lists them with each callable, so an agent can see the rules before calling.
// A not_found refusal says no more than a missing row would, so it doesn't reveal what exists.
import type { Spec } from "./parser.ts";
import { showExpr } from "./review.ts";

export type Refusal = { outcome: string; when: string; message: string; hint: string };

// the names a condition reads, in order
function namesIn(x: any, out: string[] = []): string[] {
  if (!x || typeof x !== "object") return out;
  if (Array.isArray(x)) { x.forEach((y) => namesIn(y, out)); return out; }
  if (x.kind === "name" && !out.includes(x.name)) out.push(x.name);
  for (const [k, v] of Object.entries(x)) if (k !== "pos") namesIn(v, out);
  return out;
}
// an expression with the given names replaced by expressions (a predicate's parameters by its arguments)
function subst(x: any, by: Map<string, any>): any {
  if (!x || typeof x !== "object") return x;
  if (Array.isArray(x)) return x.map((y) => subst(y, by));
  if (x.kind === "name" && by.has(x.name)) return by.get(x.name);
  return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, k === "pos" ? v : subst(v, by)]));
}

export function explainer(spec: Spec) {
  const preds = new Map(spec.decls.filter((d: any) => d.kind === "predicate").map((d: any) => [d.name, d]));
  // the predicate calls a condition is made of (through and, or and not), each spelled out once
  function expansions(cond: any, depth = 0): string[] {
    const out: string[] = [];
    const visit = (x: any) => {
      if (!x) return;
      if (x.kind === "binary" && ["and", "or", "implies"].includes(x.op)) { visit(x.left); visit(x.right); return; }
      if (x.kind === "unary" && x.op === "not") return visit(x.arg);
      if (x.kind !== "call") return;
      const p: any = preds.get(x.name);
      if (!p?.body) return;
      const body = subst(p.body, new Map(p.params.map((q: any, i: number) => [q.name, x.args?.[i]])));
      const line = `${showExpr(x)} means ${showExpr(body)}`;
      if (!out.includes(line)) out.push(line);
      if (depth < 1) for (const more of expansions(body, depth + 1)) if (!out.includes(more)) out.push(more);
    };
    visit(cond);
    return out;
  }
  return {
    // a require; isRef says which names hold a row, so a not_found can name the row it hides
    require(cond: any, outcome: string, reason: string | undefined, isRef: (name: string) => boolean): Refusal & { hidden: string[] } {
      const when = showExpr(cond);
      const hint = expansions(cond).join("; ");
      if (outcome === "not_found") {
        return { outcome, when, message: "not found", hint: "", hidden: namesIn(cond).filter(isRef) };
      }
      return { outcome, when, message: reason ?? `this needs ${when}`, hint, hidden: [] };
    },
  };
}
