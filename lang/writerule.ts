// Write policies: `policy owner: .owner == actor else forbidden for writes to Recipe` is a rule of the
// entity. Every action that changes a row of it (`set r.f = …`, `touch r`, `delete r`) gets that rule as a
// `require` right before the change, with the row's name in the rule replaced by the row being changed.
// An action says `skip policy owner` to opt out (a schedule skips them all, as it does every-action
// policies); `delete Recipe where …` changes many rows at once, so it is refused rather than left unchecked.
// The requires are ordinary: the checks, the review and what agents are told read them like the author's own.
import type { Decl, Expr, Stmt } from "./parser.ts";
import { SpecError } from "./parser.ts";

const queryOps = new Set(["the", "the_or_none", "first_or_none"]);

// the entity a name or expression stands for, as far as the spec says it (parameters, loops, creates, lets)
export function entityOf(e: any, env: Map<string, string>, ents: Map<string, any>): string | undefined {
  if (!e) return undefined;
  if (e.kind === "name") return env.get(e.name) ?? (ents.get(e.name)?.singleton ? e.name : undefined);
  if (e.kind === "query" && queryOps.has(e.op)) return e.entity;
  if (e.kind === "field") {
    const en = entityOf(e.target, env, ents);
    const f = en ? ents.get(en)?.fields?.find((x: any) => x.name === e.name) : undefined;
    const t = f?.type?.kind === "named" ? f.type.name : undefined;
    return t && ents.has(t) ? t : undefined;
  }
  return undefined;
}

// an expression with a name replaced by another expression
function subst(x: any, name: string, by: Expr): any {
  if (Array.isArray(x)) return x.map((y) => subst(y, name, by));
  if (!x || typeof x !== "object") return x;
  if (x.kind === "name" && x.name === name) return by;
  const o: any = {};
  for (const k of Object.keys(x)) o[k] = k === "pos" ? x[k] : subst(x[k], name, by);
  return o;
}
const keyOf = (e: any): string => JSON.stringify(e, (k, v) => (k === "pos" ? undefined : v));
const snakeLower = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();

export function applyWritePolicies(decls: Decl[]): void {
  const policies = decls.filter((d: any) => d.kind === "writepolicy") as any[];
  if (!policies.length) return;
  const ents = new Map(decls.filter((d: any) => d.kind === "entity" || d.kind === "singleton" || d.kind === "data").map((d: any) => [d.name, d]));
  for (const p of policies) if (!ents.has(p.entity)) return;   // the checker names an unknown entity
  for (const a of decls as any[]) {
    if (a.kind !== "action" || !Array.isArray(a.body)) continue;
    const mine = policies.filter((p) => !(a.skips ?? []).includes(p.name));
    if (!mine.length) continue;
    const env = new Map<string, string>();
    for (const q of a.params ?? []) if (q.type?.kind === "named" && ents.has(q.type.name)) env.set(q.name, q.type.name);
    a.body = walk(a.body, env, new Set(), a);
  }

  function walk(stmts: Stmt[], env: Map<string, string>, guarded: Set<string>, a: any): Stmt[] {
    const out: Stmt[] = [];
    const seen = new Set(guarded);   // what is already required, here and in the blocks around it
    for (const st of stmts as any[]) {
      if (st.kind === "create" && st.as) env.set(st.as, st.entity);
      if (st.kind === "foreach" && st.bind) env.set(st.bind, st.entity);
      if (st.kind === "let") { const en = entityOf(st.value, env, ents); if (en) env.set(st.name, en); }
      if (st.kind === "deleteWhere") {
        for (const p of mine(a)) if (p.entity === st.entity) throw new SpecError("WRITE_POLICY_BULK", `delete ${st.entity} where …: removes many rows at once, so the policy ${p.name} (for writes to ${p.entity}) can't check each. Loop over them: for each x in ${st.entity} where … { delete x }, or say skip policy ${p.name} in this action`, st.pos);
      }
      if (st.kind === "set" || st.kind === "touch" || st.kind === "delete") {
        const target = st.target;
        const en = entityOf(target, env, ents);
        if (!en) { (a.writeUnresolved ??= []).push(st.pos); }
        for (const p of en ? mine(a).filter((q) => q.entity === en) : []) {
          const key = `${p.name}|${keyOf(target)}`;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({ kind: "require", cond: subst(p.cond, snakeLower(p.entity), target), outcome: p.outcome, reason: undefined, pos: st.pos, fromPolicy: p.name } as any);
        }
      }
      for (const k of ["then", "else", "body"]) if (Array.isArray(st[k])) st[k] = walk(st[k], new Map(env), seen, a);
      out.push(st);
    }
    return out;
  }
  function mine(a: any) { return policies.filter((p) => !(a.skips ?? []).includes(p.name)); }
}
