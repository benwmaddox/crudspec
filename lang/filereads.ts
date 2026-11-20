// Files follow their row. A file is served at /files/<key> only to someone who may read a row that
// holds it: an image of a private wiki's page is its members', and an image whose row was deleted
// is no one's. For each entity with a File field the app gets an internal action,
// __files_<Entity>(held: <Entity>), whose only statement uses the row: the rules (rules.ts) put the
// entity's read policy in front of it as for any parameter, so the runtime (sendUpload) asks it
// with the visitor as the actor and serves the file when it ends ok. It skips the every-action
// policies (a sign-in gate doesn't hide a public page's picture); no screen, agent or review sees it.
import type { Decl } from "./parser.ts";

export const FILE_READS = "__files_";

export function fileReadDecls(decls: Decl[]): Decl[] {
  const skips = decls.filter((d: any) => d.kind === "gate" || d.kind === "writepolicy").map((d) => d.name);
  const ents = new Map((decls as any[]).filter((d) => d.kind === "entity" || d.kind === "singleton").map((d) => [d.name, d]));
  // the rows the read policy may read: every chain of references from the row, three deep
  const chains = (en: string, seen: string[], depth: number): string[][] => depth === 0 ? [] : (ents.get(en)?.fields ?? []).filter((f: any) => f.type?.kind === "named" && ents.has(f.type.name) && !seen.includes(f.type.name)).flatMap((f: any) => [[f.name], ...chains(f.type.name, [...seen, f.type.name], depth - 1).map((c) => [f.name, ...c])]);
  const out: Decl[] = [];
  for (const d of decls as any[]) {
    if (d.kind !== "entity") continue;
    if (!(d.fields ?? []).some((f: any) => f.type?.kind === "named" && f.type.name === "File")) continue;
    const held = { kind: "name", name: "held", pos: d.pos };
    out.push({
      kind: "action", name: FILE_READS + d.name, internal: true, fileReads: d.name, skips, pos: d.pos,
      params: [{ name: "held", type: { kind: "named", name: d.name, optional: false }, pos: d.pos, with: chains(d.name, [d.name], 3).map((path) => ({ path, pos: d.pos })) }],
      body: [{ kind: "require", cond: { kind: "binary", op: "!=", left: held, right: { kind: "lit", value: null, pos: d.pos }, pos: d.pos }, outcome: "not_found", pos: d.pos }],
    } as any);
  }
  return out;
}
