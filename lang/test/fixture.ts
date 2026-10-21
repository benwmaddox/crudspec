// A generic fixture built from a spec: two rows of every entity, every field given a value of
// its type (so a page that shows a field shows something), loaded into a running test app; and
// the address of every routed screen on it. Used to render every page of an app.
import type { App } from "./go-app.ts";

const T0 = 1_800_000_000_000;
// values the generic fixture gets wrong for a useful page: an administrator signed in, rooms visible
const OVERRIDE: Record<string, unknown> = { "User.role.1": "administrator", "Membership.involvement.1": "everything", "Membership.involvement.2": "everything" };

// loads the fixture; the headers that sign in as the first row of the cookie identity's entity
export async function loadFixture(app: App, spec: { decls: any[] }): Promise<Record<string, string>> {
  const decls = spec.decls;
  const entities = decls.filter((d) => d.kind === "entity");
  const enums = new Map(decls.filter((d) => d.kind === "enum").map((d) => [d.name, d.values]));
  const ents = new Set(decls.filter((d) => d.kind === "entity" || d.kind === "data").map((d) => d.name));
  const cookie = decls.find((d) => d.kind === "identity" && d.source === "cookie");
  const value = (f: any, i: number): unknown => {
    const t = f.type;
    if (t.kind === "set") return { set: [1], entity: t.of };
    if (t.kind === "list") return [];
    const n = t.name;
    if (cookie && f.name === cookie.field && n === "Text") return `tok-${i}`;
    if (ents.has(n)) return { ref: n, id: i };
    if (OVERRIDE[`${f.entity}.${f.name}.${i}`] !== undefined) return OVERRIDE[`${f.entity}.${f.name}.${i}`];
    if (enums.has(n)) return enums.get(n)[i === 1 ? 0 : Math.min(1, enums.get(n).length - 1)];
    switch (n) {
      case "Int": return i;
      case "Bool": return i === 1;
      case "Time": return { time: T0 - i * 3_600_000 };
      case "Duration": return { ms: 60_000 };
      case "Email": return `${f.name}${i}@example.com`;
      case "Url": return `https://example.com/${f.name}/${i}`;
      case "Ip": return `192.0.2.${i}`;
      case "Password": return { password: "secret-pass" };
      case "RichText": return { rich: `${f.name} ${i} text`, mentions: [], entity: "" };
      case "File": return f.type.optional ? null : { file: "a.png", stored: `k${i}.png`, content_type: "image/png", size: 10 };
      default: return t.optional && i === 2 ? null : `${f.name} ${i}`;
    }
  };
  const rows: Record<string, unknown[]> = {};
  let seq = 0;
  for (const e of entities) rows[e.name] = [1, 2].map((i) => ({ id: i, seq: ++seq, created: T0 - 86_400_000 + i * 1000, updated: T0 - 86_400_000 + i * 1000, fields: Object.fromEntries(e.fields.map((f: any) => [f.name, value({ ...f, entity: e.name }, i)])) }));
  const load = await app.post("/_test/load", { clock: T0, seq: seq + 1, rows });
  // (rows the spec refuses, as a whole: as many entities as load)
  if (load.status !== 200) {
    const acc: Record<string, unknown[]> = {};
    for (const e of entities) { acc[e.name] = rows[e.name]; if ((await app.post("/_test/load", { clock: T0, seq: seq + 1, rows: acc })).status !== 200) { delete acc[e.name]; break; } }
  }
  return cookie ? { Cookie: `${cookie.key?.value ?? "session"}=tok-1` } : {};
}

// every routed screen (not an export) and its address on the fixture
export function screenPaths(spec: { decls: any[] }): [string, string][] {
  const ents = new Set(spec.decls.filter((d) => d.kind === "entity" || d.kind === "data").map((d) => d.name));
  return spec.decls.filter((d) => d.kind === "screen" && d.route && !d.file).map((d) => [d.name, String(d.route).replace(/:(\w+)/g, (_: string, p: string) => {
    const param = d.params.find((x: any) => x.name === p);
    return param && ents.has(param.type.name) ? "1" : p === "join_code" ? "join_code%201" : "x";
  })]);
}
