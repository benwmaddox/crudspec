// What a compiled app needs to upgrade its own database (rt/upgrade.go), written into the
// build: the spec's renames (`was`), drops and enum renames, and for each stored entity its
// table as the spec wants it, its columns, its indexes and its rich-text tables. With these and
// the schema the database recorded, the app plans, rehearses and applies an upgrade without the
// spec or Node.
import { specMeta } from "./rows.ts";
import { SqliteStore, sqlDefs } from "./runtime/store-sqlite.ts";
import { fieldSize } from "./sizes.ts";
import type { Spec } from "./parser.ts";

export type UpgradeInfo = {
  entities: {
    name: string; was?: string; table: string; rich: string[]; indexes: [string, string][]; uniques: string[][]; invariants: boolean;
    fields: { name: string; was?: string; named: boolean; type: string; optional: boolean; kind: string; to?: string; enum?: string; cols: [string, string][]; max?: number; min?: number; sized: boolean }[];
  }[];
  drops: [string, string][];   // [entity, field] ("" for the whole entity)
  enums: { name: string; values: string[]; renames: [string, string][] }[];   // renames: [new value, old], in the spec's order
  appInvariants: boolean;
};

export function upgradeInfo(spec: Spec): UpgradeInfo {
  const meta = specMeta(spec);
  const store = new SqliteStore(":memory:", meta);
  try {
    const entities = store.entities().map(([name, ent]) => {
      const cols = store.columns(ent);
      return {
        name, ...(ent.was && ent.was !== name ? { was: ent.was } : {}),
        table: store.tableSql(name, ent), rich: store.richTableSql(name, ent), indexes: [...store.wantIndexes(name, ent)],
        uniques: ent.uniques ?? [], invariants: (ent.invariants ?? []).length > 0,
        fields: ent.fields.map((f: any, i: number) => {
          const c = cols[i], named = f.type.kind === "named", z = fieldSize(f);
          return {
            name: f.name, ...(f.was && f.was !== f.name ? { was: f.was } : {}), named, type: named ? f.type.name : "", optional: named && !!f.type.optional,
            kind: c.kind, ...(c.to ? { to: c.to } : {}), ...(named && meta.enums.has(f.type.name) ? { enum: f.type.name } : {}),
            cols: sqlDefs(c), ...(z.max !== undefined ? { max: z.max } : {}), ...(z.min !== undefined ? { min: z.min } : {}), sized: named && f.type.name !== "Password",
          };
        }),
      };
    });
    return {
      entities,
      drops: spec.decls.filter((d) => d.kind === "drop").map((d) => [d.entity, d.field ?? ""]),
      enums: spec.decls.filter((d) => d.kind === "enum").map((d) => ({ name: d.name, values: [...d.values], renames: Object.entries(d.renames ?? {}) as [string, string][] })),
      appInvariants: spec.decls.some((d) => d.kind === "invariant"),
    };
  } finally { store.db.close(); }
}
