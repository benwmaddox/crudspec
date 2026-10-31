// The admin section: when an app says who its administrators are (app { admin actor.is_admin }),
// the runtime adds /_admin: an index of the entities, a list of each one's rows, and a form to create,
// edit and delete a row. It is written as ordinary crudspec source (like scaffold.ts's default
// screens), so it runs on everything else does: sizes, unique keys, invariants, `transitions`, live
// pages. Only administrators may use it, whatever the entity's own read permission says.
//   - /_admin                an index of the entities, with how many rows each has;
//   - /_admin/<entity>       the newest 200 rows, each linking to its form, and a link to a new one;
//   - a form per entity      one field per field the form can carry; a Password left empty is kept;
//   - actions admin_create_<entity>, admin_update_<entity>, admin_delete_<entity> (agents no).
// A field of a type the forms can't carry (File, Json, Duration, a set) is left out: kept as it is on
// an edit, and an entity that needs one to be created can be edited and deleted but not created.
import type { Spec, Decl } from "./parser.ts";
import { formField, human, shell } from "./scaffold.ts";

const q = (s: string) => JSON.stringify(s);
const snake = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
const FORM_TYPES = new Set(["Text", "Int", "Bool", "Time", "Email", "Url", "Ip", "Password", "RichText"]);

// the generated declarations carry this mark, so the deep checks leave them out of what they say of the app's own
export const ADMIN = "admin";

export function adminSource(spec: Spec): string {
  const app = spec.decls.find((d) => d.kind === "app");
  if (!app?.props.admin) return "";
  const sh = shell(spec);
  const actor = app.props.actor?.name;
  if (!sh || !actor) return "";
  const decls = spec.decls;
  const entities = new Set(decls.filter((d) => d.kind === "entity" || d.kind === "data").map((d) => d.name));
  const enums = new Map(decls.filter((d) => d.kind === "enum").map((d) => [d.name, d.values as string[]]));
  const stored = decls.filter((d) => d.kind === "entity");
  if (decls.some((d) => d.name === "admin_index")) return "";
  const taken = new Set(decls.map((d) => d.name));
  const home = app.props.sign_in?.name ?? decls.find((d) => d.kind === "screen" && !(d.params ?? []).length)?.name;
  if (!home) return "";
  const deny = `go ${home} flash "Administrators only."`;
  const out: string[] = [];
  const index: string[] = [];

  for (const e of stored) {
    const s = snake(e.name);
    if ([`admin_${s}_rows`, `admin_${s}_list`, `admin_${s}_new`, `admin_${s}_edit`, `admin_create_${s}`, `admin_update_${s}`, `admin_delete_${s}`].some((n) => taken.has(n))) continue;
    const trans = new Set<string>((e.transitions ?? []).map((t: any) => t.field));
    const fields = e.fields.filter((f: any) => f.type.kind === "named" && (entities.has(f.type.name) || enums.has(f.type.name) || FORM_TYPES.has(f.type.name)));
    const left = e.fields.filter((f: any) => !fields.includes(f));
    const canCreate = !e.singleton && left.every((f: any) => f.default || (f.type.kind === "named" && f.type.optional));
    const opt = (f: any) => f.type.kind === "named" && f.type.optional;
    // create: a field with a default may be left empty (the default is used), except one with transitions, which says where the row starts
    const createParam = (f: any) => `${f.name}: ${f.type.name}${opt(f) || (f.default && !trans.has(f.name)) ? "?" : ""}`;
    const updateParam = (f: any) => `${f.name}: ${f.type.name}${opt(f) || f.type.name === "Password" ? "?" : ""}`;
    const withDefault = (f: any) => f.default && !opt(f) && !trans.has(f.name);
    const form = (prefill: string | null, param: (f: any) => any) => fields.map((f: any) => {
      const p = { name: f.name, type: { ...f.type, optional: param(f).endsWith("?") } };
      const value = prefill && f.type.name !== "Password" ? ` value={${prefill}.${f.name}}` : "";
      return `        ${formField(p, entities, enums, value)}`;
    }).join("\n");
    const label = human(snake(e.name));
    const row = e.singleton ? e.name : "admin_row";
    index.push(`      <Row><Link to={admin_${s}_${e.singleton ? "edit" : "list"}${e.singleton ? "" : "()"}}><Text>${label}</Text></Link>${e.singleton ? "" : `<Text class="muted">{text(count(${e.name} where true))}</Text>`}</Row>`);

    if (!e.singleton) out.push(`view admin_${s}_rows() {
  require admin_ok(actor) else forbidden
  rows ${e.name} where true
  order by created desc
  limit 200
}`);
    if (canCreate) {
      const params = fields.map(createParam).join(", ");
      const direct = fields.filter((f: any) => !withDefault(f));
      const later = fields.filter(withDefault);
      out.push(`action admin_create_${s}(${params}) {
  agents no
  require admin_ok(actor) else forbidden
  create ${e.name} { ${direct.map((f: any) => `${f.name}: ${f.name}`).join(", ")} } as made
${later.map((f: any) => `  if ${f.name} != none { set made.${f.name} = ${f.name} }`).join("\n")}
  result made
}`);
    }
    if (e.singleton) {
      out.push(`action admin_update_${s}(${fields.map(updateParam).join(", ")}) {
  agents no
  require admin_ok(actor) else forbidden
  if not exists(${e.name} where true) {
    create ${e.name} { ${fields.map((f: any) => `${f.name}: ${f.name}`).join(", ")} }
  } else {
${fields.map((f: any) => f.type.name === "Password" ? `    if ${f.name} != none { set ${e.name}.${f.name} = ${f.name} }` : `    set ${e.name}.${f.name} = ${f.name}`).join("\n")}
  }
}`);
    } else {
      out.push(`action admin_update_${s}(admin_row: ${e.name}${fields.length ? ", " + fields.map(updateParam).join(", ") : ""}) {
  agents no
  require admin_ok(actor) else forbidden
${fields.map((f: any) => f.type.name === "Password" ? `  if ${f.name} != none { set admin_row.${f.name} = ${f.name} }` : `  set admin_row.${f.name} = ${f.name}`).join("\n")}
}
action admin_delete_${s}(admin_row: ${e.name}) {
  agents no
  require admin_ok(actor) else forbidden
  delete admin_row
}`);
    }
    const shellOpen = (name: string, route: string, params: string, title: string) => `screen ${name}${params} {
  route ${q(route)}
  layout ${sh.layout}
  require admin_ok(actor) else ${deny}
  <Title>{${q(title)}}</Title>
  <${sh.slotTag}>
    <${sh.section}>`;
    const shellClose = `    </Section>\n  </${sh.slotTag}>\n}`;
    if (!e.singleton) {
      out.push(`${shellOpen(`admin_${s}_list`, `/_admin/${s}`, "", label)}
      <Heading>${label}</Heading>
      <Link to={admin_index} class="quiet"><Text>All tables</Text></Link>
${canCreate ? `      <Link to={admin_${s}_new} class="btn"><Text>New ${label.toLowerCase()}</Text></Link>\n` : ""}      <List of={admin_${s}_rows()} as=r class="list">
        <Link to={admin_${s}_edit(r)} class="row"><Text>{r}</Text><Text class="muted">{"#" + text(r.id)}</Text></Link>
      </List>
${shellClose}`);
    }
    if (canCreate) out.push(`${shellOpen(`admin_${s}_new`, `/_admin/${s}/new`, "", `New ${label.toLowerCase()}`)}
      <Heading>New ${label.toLowerCase()}</Heading>
      <Form action={admin_create_${s}}>
${form(null, createParam)}
        <Submit label="Create" />
        <On ok go={admin_${s}_${e.singleton ? "edit" : "list"}} />
        <On invalid flash="Not saved: check the values against the entity's sizes, keys and rules." />
      </Form>
${shellClose}`);
    out.push(`${shellOpen(`admin_${s}_edit`, e.singleton ? `/_admin/${s}` : `/_admin/${s}/:admin_row`, e.singleton ? "" : `(admin_row: ${e.name})`, label)}
      <Heading>${e.singleton ? label : `Edit ${label.toLowerCase()}`}</Heading>
${e.singleton ? "" : `      <Text class="muted">{admin_row}</Text>
`}
      <Link to={${e.singleton ? "admin_index" : `admin_${s}_list`}} class="quiet"><Text>Back</Text></Link>
      <Form action={admin_update_${s}${e.singleton ? "" : "(admin_row)"}}>
${form(row, updateParam)}
        <Submit label="Save" />
        <On ok stay flash="Saved." />
        <On invalid flash="Not saved: check the values against the entity's sizes, keys and rules, and the moves its fields allow." />
      </Form>
${e.singleton ? "" : `      <Button action={admin_delete_${s}(admin_row)} text="Delete" class="quiet" confirm="Delete this ${label.toLowerCase()}?" />
      <On ok go={admin_${s}_list} />
      <On invalid flash="Not deleted: other rows still refer to it." />
`}${left.length ? `      <Text class="muted">${left.map((f: any) => f.name).join(", ")}: not editable here.</Text>\n` : ""}${shellClose}`);
  }
  if (!out.length) return "";
  out.push(`screen admin_index {
  route "/_admin"
  layout ${sh.layout}
  require admin_ok(actor) else ${deny}
  <Title>Admin</Title>
  <${sh.slotTag}>
    <${sh.section}>
      <Heading>Admin</Heading>
${index.join("\n")}
    </Section>
  </${sh.slotTag}>
}`);
  return `predicate admin_ok(a: ${actor}?) = true\n\n${out.join("\n\n")}\n`;
}

// Adds the admin section to a spec: its source, with the condition the app gave for who an administrator is,
// and read access for administrators to every entity (so its lists can show them).
export function withAdmin(spec: Spec, parse: (src: string) => Spec): Decl[] {
  const src = adminSource(spec);
  if (!src) return [];
  const app = spec.decls.find((d) => d.kind === "app")!;
  const generated = parse(src).decls;
  for (const g of generated) (g as any).generated = ADMIN;
  // admin_ok(a): the app's condition, about `a` instead of `actor`
  const swap = (x: any): any => {
    if (Array.isArray(x)) return x.map(swap);
    if (!x || typeof x !== "object") return x;
    if (x.kind === "name" && x.name === "actor") return { ...x, name: "a" };
    return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, k === "pos" ? v : swap(v)]));
  };
  const ok = generated.find((d) => d.kind === "predicate" && d.name === "admin_ok")!;
  (ok as any).body = swap(structuredClone(app.props.admin));
  // administrators read every entity: its own permission, or an administrator
  const call = (): any => ({ kind: "call", name: "admin_ok", args: [{ kind: "name", name: "actor", pos: app.pos }], named: {}, pos: app.pos });
  for (const e of spec.decls.filter((d) => d.kind === "entity")) {
    const perm = spec.decls.find((d) => d.kind === "permission" && d.entity === e.name);
    if (perm && !(perm as any).adminWrapped) { perm.cond = { kind: "binary", op: "or", left: perm.cond, right: call(), pos: perm.pos }; (perm as any).adminWrapped = true; }
    else if (!perm) generated.push({ kind: "permission", name: e.name, entity: e.name, cond: call(), pos: e.pos, generated: ADMIN } as any);
  }
  return generated;
}
