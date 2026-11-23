// What an entity invariant reads beyond its own row: the entities whose change can break it, each
// with the way back to the rows to check again. The generator compiles these into the checks an
// action runs before it commits (gogen/gen.ts); the deep checks refuse an invariant that would
// check every row of its entity on a write (INVARIANT_SCANS, deep.ts).
import type { Decl, Expr } from "./parser.ts";

// Each dependency's ways back are chains of references from the row: self.field.template.wiki
// gives InfoboxField by "field" and InfoboxTemplate by "field.template" (a changed template: the
// fields that point at it, then the values that point at those). An empty chain ("") means any
// change to that entity checks every row.
export type InvariantDeps = Map<string, Set<string>>;

export function invariantDeps(decls: Decl[], entity: string, inv: Expr): InvariantDeps {
  const ents = new Map<string, any>();
  for (const d of decls) if (d.kind === "entity" || d.kind === "data") ents.set(d.name, d);
  const byKind = new Map<string, any>();
  for (const d of decls) if (!["trigger", "workflow", "permission"].includes(d.kind)) byKind.set(`${d.kind}:${d.name}`, d);
  const get = (k: string, n: string) => byKind.get(`${k}:${n}`);
  const enums = new Set(decls.filter((d) => d.kind === "enum").map((d) => d.name));
  const deps: InvariantDeps = new Map();
  const ent = ents.get(entity)!;
  const add = (e: string, via: string) => (deps.get(e) ?? deps.set(e, new Set()).get(e)!).add(via);
  const all = (e: string) => add(e, "");
  const seen = new Set<string>();
  // the field names of self.f.g… or .f.g…, or none for anything else
  const pathOf = (x: any): string[] | undefined => {
    if (x?.kind === "name" && x.name === "self") return [];
    if (x?.kind === "rowfield") return [x.name];
    if (x?.kind === "field") { const p = pathOf(x.target); return p && [...p, x.name]; }
    return undefined;
  };
  const visit = (x: any, direct: boolean) => {
    if (!x || typeof x !== "object") return;
    if (Array.isArray(x)) { for (const y of x) visit(y, direct); return; }
    // self.f.g…, with f… references: each row on the way, found again by the chain back to it
    const path = direct && x.kind === "field" ? pathOf(x) : undefined;
    if (path && path.length >= 2) {
      const steps: string[] = [];
      let at = ent;
      for (const fname of path.slice(0, -1)) {
        const f = at.fields.find((y: any) => y.name === fname);
        if (!f || f.type.kind !== "named" || !ents.has(f.type.name)) { steps.length = 0; break; }
        steps.push(fname);
        add(f.type.name, steps.join("."));
        at = ents.get(f.type.name)!;
      }
      if (steps.length === path.length - 1) return;
    }
    if (["query", "listq", "all"].includes(x.kind)) all(x.entity);
    if (x.kind === "call") {
      const d = get("predicate", x.name) ?? get("fn", x.name);
      if (d && !seen.has(d.name)) { seen.add(d.name); visit(d.body, false); }
      const v = get("view", x.name);
      if (v?.rows) all(v.rows.entity);
    }
    // a field of something other than this row: any row of any entity might be it
    if (!direct && x.kind === "field" && !(x.target?.kind === "name" && enums.has(x.target.name))) for (const e of ents.keys()) all(e);
    if (direct && x.kind === "field" && x.target?.kind === "field") for (const e of ents.keys()) all(e);
    for (const [k, v] of Object.entries(x)) if (k !== "pos") visit(v, direct);
  };
  visit(inv, true);
  deps.delete(entity);
  return deps;
}

// The entities along a chain, from the invariant's own: each step's rows point at the next's
export function chainEntities(decls: Decl[], entity: string, via: string): string[] {
  const ents = new Map<string, any>();
  for (const d of decls) if (d.kind === "entity" || d.kind === "data") ents.set(d.name, d);
  const along = [entity];
  for (const f of via === "" ? [] : via.split(".")) {
    const fd = ents.get(along[along.length - 1])?.fields?.find((y: any) => y.name === f);
    along.push(fd?.type?.name);
  }
  return along;
}

// The entities a change to which checks every row of this one: an empty chain, or one through rows
// that aren't stored (data), which can't be looked up by reference
export function scansAll(decls: Decl[], entity: string, deps: InvariantDeps): string[] {
  const stored = (e: string) => decls.some((d) => d.kind === "entity" && d.name === e);
  const out: string[] = [];
  for (const [e, vias] of deps) for (const via of vias) {
    if (via === "" || !stored(entity) || !chainEntities(decls, entity, via).slice(0, -1).every(stored)) { out.push(e); break; }
  }
  return out;
}
