// A spec's schema and contract, normalized so two versions can be compared, and the diff
// between them as classified migration steps. Storage-independent: the runtime applies the
// steps (runtime/upgrade.ts); the interpreter checks the data.
import { createHash } from "node:crypto";
import type { Spec, Decl } from "./parser.ts";

export type FieldSchema = { type: string; optional: boolean; ref?: string; default: boolean; max?: number; min?: number };
export type EntitySchema = { singleton: boolean; fields: Record<string, FieldSchema>; uniques: string[][]; invariants: string[] };
export type Schema = {
  format?: number;   // the storage format: 2 is STRICT tables with size checks; 3 stores times, durations and passwords in typed columns, not JSON; 4 files in columns and rich text as text with mention and preview tables
  entities: Record<string, EntitySchema>;
  enums: Record<string, string[]>;
  actions: Record<string, { params: { name: string; type: string; optional: boolean }[] }>;
  views: Record<string, { params: { name: string; type: string; optional: boolean }[] }>;
};

// An expression without source positions, so moving a line doesn't count as a change.
function canon(e: any): string { return JSON.stringify(e, (k, v) => (k === "pos" ? undefined : v)); }
function typeName(t: any): string { return t.kind === "set" ? `set of ${t.of}` : t.kind === "list" ? `list of ${typeName(t.of)}` : t.name; }

export function schemaOf(spec: Spec): Schema {
  const s: Schema = { format: 4, entities: {}, enums: {}, actions: {}, views: {} };
  const stored = new Set(spec.decls.filter((d) => d.kind === "entity").map((d) => d.name));
  for (const d of spec.decls) {
    if (d.kind === "entity") {
      const fields: Record<string, FieldSchema> = {};
      for (const f of d.fields) {
        const type = typeName(f.type);
        fields[f.name] = { type, optional: f.type.kind === "named" && !!f.type.optional, default: !!f.default, ...(stored.has(type) ? { ref: type } : {}), ...(f.max !== undefined ? { max: f.max } : {}), ...(f.min !== undefined ? { min: f.min } : {}) };
      }
      s.entities[d.name] = { singleton: !!d.singleton, fields, uniques: d.uniques, invariants: d.invariants.map(canon) };
    } else if (d.kind === "enum") s.enums[d.name] = [...d.values];
    else if (d.kind === "action" && !d.internal) s.actions[d.name] = { params: d.params.map((p: any) => ({ name: p.name, type: typeName(p.type), optional: p.type.kind === "named" && !!p.type.optional })) };
    else if (d.kind === "view") s.views[d.name] = { params: d.params.map((p: any) => ({ name: p.name, type: typeName(p.type), optional: p.type.kind === "named" && !!p.type.optional })) };
  }
  return s;
}
export const schemaHash = (s: Schema) => createHash("sha256").update(JSON.stringify(s)).digest("hex").slice(0, 16);

export type StepClass = "safe" | "checked" | "destructive" | "blocked" | "contract";
export type Step = { op: string; class: StepClass; entity?: string; field?: string; from?: string; to?: string; detail: string; hint?: string };

// What exists in storage now: tables and their columns (it may hold more than the old
// schema, because removed fields and entities are kept until dropped).
export type Stored = Record<string, Set<string>>;

const TEXTLIKE = new Set(["Text", "Email", "Url", "Ip"]);

// The steps from the previous version (or none) to this spec. `stored` is the database's
// actual tables and columns.
export function diff(prev: Schema | null, spec: Spec, stored: Stored): Step[] {
  const next = schemaOf(spec);
  const steps: Step[] = [];
  const decls = (k: string) => spec.decls.filter((d) => d.kind === k);
  const drops = decls("drop");
  const dropped = (e: string, f?: string) => drops.some((d) => d.entity === e && d.field === f);
  const enumRenames = new Map<string, Record<string, string>>(decls("enum").map((d) => [d.name, d.renames ?? {}]));
  const old = prev ?? { entities: {}, enums: {}, actions: {}, views: {} };

  // entities: renamed, added, removed
  const entityDecl = new Map<string, Decl>(decls("entity").map((d) => [d.name, d]));
  const renamedFrom = new Map<string, string>();   // new name -> old name
  for (const [name, d] of entityDecl) {
    if (!d.was || d.was === name) continue;
    if (stored[d.was] && !stored[name]) { renamedFrom.set(name, d.was); steps.push({ op: "rename_entity", class: "safe", entity: name, from: d.was, to: name, detail: `rename ${d.was} to ${name}; rows and references are kept` }); }
  }
  const oldNameOf = (e: string) => renamedFrom.get(e) ?? e;
  for (const name of Object.keys(next.entities)) {
    if (stored[oldNameOf(name)]) continue;
    steps.push({ op: "create_entity", class: "safe", entity: name, detail: `new entity ${name}` });
  }
  const gone = Object.keys(stored).filter((t) => !next.entities[t] && ![...renamedFrom.values()].includes(t));
  for (const t of gone) {
    if (dropped(t)) steps.push({ op: "drop_entity", class: "destructive", entity: t, detail: `drop ${t} and all its rows` });
    else if (old.entities[t]) steps.push({ op: "keep_entity", class: "safe", entity: t, detail: `${t} is no longer declared; its table is kept until "drop entity ${t}"` });
  }
  // an entity removed and another added with mostly the same fields looks like a rename
  for (const name of Object.keys(next.entities)) {
    if (stored[oldNameOf(name)] || old.entities[name]) continue;
    for (const t of gone) {
      if (dropped(t) || !old.entities[t]) continue;
      const a = Object.keys(old.entities[t].fields), b = Object.keys(next.entities[name].fields);
      const shared = a.filter((f) => b.includes(f)).length;
      if (shared * 2 >= Math.max(a.length, b.length)) steps.push({ op: "ambiguous_entity", class: "blocked", entity: name, from: t, detail: `${t} was removed and ${name} added with mostly the same fields`, hint: `if ${name} is ${t} renamed, write "entity ${name} was ${t}"; if not, write "drop entity ${t}"` });
    }
  }

  // the storage format: tables from before 2 become STRICT, with their size checks; from before
  // 3, times, durations and passwords move out of JSON text into typed columns
  const was = prev ? prev.format ?? 1 : 0;
  if (prev && was !== next.format) steps.push({ op: "storage_format", class: "checked", detail: [
    was < 2 ? "tables become STRICT (SQLite enforces each column's type) with size checks; each table is rebuilt and its rows checked" : "",
    was < 3 ? "Time fields become INTEGER milliseconds (UTC) with their order in a __seq column, Duration fields INTEGER milliseconds, Password fields plain TEXT, converted in place from their JSON" : "",
    was < 4 ? "File fields become four columns (the stored key, name, content type and size), RichText fields their text, with mentions and link previews in <Entity>__<field>__mentions and __embeds tables, converted in place from their JSON" : "",
  ].filter(Boolean).join("; ") });

  // fields of entities that exist on both sides
  for (const [name, ent] of Object.entries(next.entities)) {
    const before = old.entities[oldNameOf(name)];
    const cols = stored[oldNameOf(name)];
    if (!cols) continue;
    const decl = entityDecl.get(name)!;
    const renamedField = new Map<string, string>();
    for (const f of decl.fields) if (f.was && f.was !== f.name && cols.has(f.was) && !cols.has(f.name)) {
      renamedField.set(f.name, f.was);
      steps.push({ op: "rename_field", class: "safe", entity: name, field: f.name, from: f.was, to: f.name, detail: `rename ${name}.${f.was} to ${f.name}; values are kept` });
    }
    const added: string[] = [];
    for (const [fname, f] of Object.entries(ent.fields)) {
      const src = renamedField.get(fname) ?? fname;
      const was = before?.fields[src];
      if (!cols.has(src)) {
        added.push(fname);
        if (f.optional || f.default || f.type === "Int") steps.push({ op: "add_field", class: "safe", entity: name, field: fname, detail: `new field ${name}.${fname}${f.default ? ", filled with its default on existing rows" : f.optional ? ", empty on existing rows" : ", 0 on existing rows"}` });
        else steps.push({ op: "add_required_field", class: "checked", entity: name, field: fname, detail: `new required field ${name}.${fname} without a default`, hint: `existing rows need a value: give it a default, or set it in a migration` });
        continue;
      }
      if (!was) {
        // a column kept from an earlier removal, declared again: its old values come back
        if (prev && !renamedField.has(fname)) steps.push({ op: "restore_field", class: "checked", entity: name, field: fname, detail: `${name}.${fname} is declared again; the values kept from before come back and are checked against its type` });
        continue;
      }
      // the old type, in today's names: references and sets follow a renamed entity
      const renamedTo = new Map([...renamedFrom].map(([n, o]) => [o, n]));
      const oldType = was.type.startsWith("set of ") ? `set of ${renamedTo.get(was.type.slice(7)) ?? was.type.slice(7)}` : renamedTo.get(was.type) ?? was.type;
      if (oldType !== f.type && !(TEXTLIKE.has(oldType) && TEXTLIKE.has(f.type)) && !(next.enums[f.type] && TEXTLIKE.has(oldType)) && !(TEXTLIKE.has(f.type) && old.enums[oldType]))
        steps.push({ op: "change_type", class: "blocked", entity: name, field: fname, from: oldType, to: f.type, detail: `${name}.${fname} changes type from ${oldType} to ${f.type}`, hint: `add a new field, copy the values in a migration, then drop the old one` });
      else if (oldType !== f.type) steps.push({ op: "change_type", class: "checked", entity: name, field: fname, from: oldType, to: f.type, detail: `${name}.${fname} changes type from ${oldType} to ${f.type}; existing values are checked${next.enums[f.type] ? ` to be ${f.type} values` : " to be text (the language has no format rules, so formats aren't validated)"}` });
      // sizes: a tighter one is checked against the rows; a looser one is safe
      if ((f.max !== undefined && (was.max === undefined || f.max < was.max)) || (f.min !== undefined && (was.min === undefined || f.min > was.min)))
        steps.push({ op: "tighten_size", class: "checked", entity: name, field: fname, detail: `${name}.${fname} gets a size (${[f.min !== undefined ? `min ${f.min}` : "", f.max !== undefined ? `max ${f.max}` : ""].filter(Boolean).join(", ")}); existing values are checked` });
      else if (was.max !== f.max || was.min !== f.min) steps.push({ op: "loosen_size", class: "safe", entity: name, field: fname, detail: `${name}.${fname}'s size is loosened` });
      if (was.optional && !f.optional) steps.push({ op: "make_required", class: "checked", entity: name, field: fname, detail: `${name}.${fname} becomes required; existing empty values are checked` });
    }
    const removed = [...cols].filter((c) => !["id", "seq", "created", "updated"].includes(c) && !ent.fields[c] && ![...renamedField.values()].includes(c));
    for (const c of removed) {
      if (dropped(name, c)) steps.push({ op: "drop_field", class: "destructive", entity: name, field: c, detail: `drop ${name}.${c} and its values` });
      else if (before?.fields[c]) {
        steps.push({ op: "keep_field", class: "safe", entity: name, field: c, detail: `${name}.${c} is no longer declared; its values are kept until "drop ${name}.${c}"` });
        const lookalike = added.find((a) => ent.fields[a].type === before.fields[c].type);
        if (lookalike) steps.push({ op: "ambiguous_field", class: "blocked", entity: name, field: lookalike, from: c, detail: `${name}.${c} was removed and ${name}.${lookalike} added with the same type`, hint: `if it is a rename, write "${lookalike}: … was ${c}"; if not, write "drop ${name}.${c}"` });
      }
    }
    // keys and rules: new ones are checked against the data
    const key = (u: string[]) => u.join(",");
    for (const u of ent.uniques) if (!before || !before.uniques.some((b) => key(b) === key(u))) steps.push({ op: "add_unique", class: "checked", entity: name, detail: `new unique key (${u.join(", ")}); existing rows are checked for duplicates` });
    for (const u of before?.uniques ?? []) if (!ent.uniques.some((b) => key(b) === key(u))) steps.push({ op: "remove_unique", class: "safe", entity: name, detail: `unique key (${u.join(", ")}) removed` });
    for (const inv of ent.invariants) if (!before || !before.invariants.includes(inv)) steps.push({ op: "add_invariant", class: "checked", entity: name, detail: `new or changed invariant on ${name}; every row is checked` });
  }

  // enum values: renamed, removed
  for (const [name, values] of Object.entries(next.enums)) {
    const before = old.enums[name]; if (!before) continue;
    const ren = enumRenames.get(name) ?? {};
    for (const [to, from] of Object.entries(ren)) if (before.includes(from) && !before.includes(to)) steps.push({ op: "rename_value", class: "safe", entity: name, from, to, detail: `${name} value ${from} becomes ${to} in every row` });
    for (const v of before) if (!values.includes(v) && !Object.values(ren).includes(v)) steps.push({ op: "remove_value", class: "checked", entity: name, from: v, detail: `${name} value ${v} removed; rows still using it are checked`, hint: `rewrite those rows in a migration, or write "<new> was ${v}"` });
  }

  // the contract API and agent callers rely on
  for (const kind of ["actions", "views"] as const) {
    const label = kind === "actions" ? "action" : "view";
    for (const [n, a] of Object.entries(old[kind])) {
      const b = next[kind][n];
      if (!b) { steps.push({ op: `remove_${label}`, class: "contract", entity: n, detail: `${label} ${n} removed; callers break` }); continue; }
      for (const p of b.params) { const q = a.params.find((x) => x.name === p.name); if (!q && !p.optional) steps.push({ op: "add_param", class: "contract", entity: n, field: p.name, detail: `${label} ${n} gains a required parameter ${p.name}; callers break` }); else if (q && q.type !== p.type) steps.push({ op: "change_param", class: "contract", entity: n, field: p.name, detail: `${label} ${n}: ${p.name} changes type from ${q.type} to ${p.type}` }); }
      for (const q of a.params) if (!b.params.some((p) => p.name === q.name)) steps.push({ op: "remove_param", class: "contract", entity: n, field: q.name, detail: `${label} ${n} no longer takes ${q.name}; callers passing it break` });
    }
  }
  return steps;
}
