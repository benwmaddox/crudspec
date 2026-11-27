// The admin section: when an app says who its administrators are (app { admin actor.is_admin }),
// the runtime adds /_admin: an index of the entities, a list of each one's rows, and a form to create,
// edit and delete a row. It is written as ordinary crudspec source (like scaffold.ts's default
// screens), so it runs on everything else does: sizes, unique keys, invariants, `transitions`, live
// pages. Only administrators may use it, whatever the entity's own read permission says.
//   - /_admin                an index of the entities, with how many rows each has;
//   - /_admin/<entity>       50 rows a page, newest, oldest or A to Z by the label field, found by
//                            the words in the text fields and narrowed by the enum fields; picked rows
//                            deleted together; the whole table as CSV (export.csv); a link to a new one;
//   - a form per entity      one field per field the form can carry; a Password left empty is kept;
//   - /_admin/<entity>/<id>  a row's form, and the newest 20 rows of each entity that refers to it;
//   - actions admin_create_<entity>, admin_update_<entity>, admin_delete_<entity> and
//     admin_delete_many_<entity> (callers people).
// A field of a type the forms can't carry (File, Json, Duration, a set) is left out: kept as it is on
// an edit, and an entity that needs one to be created can be edited and deleted but not created.
import type { Spec, Decl } from "./parser.ts";
import { formField, human, shell } from "./scaffold.ts";
import { stampsByEntity, weaveStamps } from "./rules.ts";

const q = (s: string) => JSON.stringify(s);
const snake = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
const FORM_TYPES = new Set(["Text", "Int", "Decimal", "Date", "Bool", "Time", "Email", "Url", "Ip", "Password", "RichText"]);

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
  const home = app.props.sign_in_screen?.name ?? decls.find((d) => d.kind === "screen" && !(d.params ?? []).length)?.name;
  if (!home) return "";
  const deny = `go ${home} flash "Administrators only."`;
  const out: string[] = [];
  const index: string[] = [];

  // a reference field's picker: a view asked as its box is typed in, for an entity whose rows are
  // found by a text field (its show label's, or one called name, title, email or slug)
  const picks = new Map<string, string>(), labels = new Map<string, string>();
  const display = new Map(decls.filter((d: any) => d.kind === "display").map((d: any) => [d.entity, d.value]));
  for (const e of stored) {
    if (e.singleton) continue;
    const textField = (n: string) => e.fields.find((f: any) => f.name === n && f.type.kind === "named" && ["Text", "Email"].includes(f.type.name));
    const shown: any = display.get(e.name);
    const f: any = (shown?.kind === "rowfield" && textField(shown.name)) || ["name", "title", "email", "slug"].map(textField).find(Boolean);
    const view = `admin_${snake(e.name)}_pick`;
    if (f) labels.set(e.name, f.name);
    if (!f || taken.has(view)) continue;
    picks.set(e.name, view);
    const opt = f.type.optional;
    out.push(`view ${view}(typed: Text) {
  callers people
  require admin_ok(actor) else forbidden
  rows ${e.name} where contains(lower(.${f.name}${opt ? '.default("")' : ""}), lower(trim(typed)))
  order by created desc
  limit 20
}`);
  }

  for (const e of stored) {
    const s = snake(e.name);
    if ([`admin_${s}_rows`, `admin_${s}_list`, `admin_${s}_new`, `admin_${s}_edit`, `admin_create_${s}`, `admin_update_${s}`, `admin_delete_${s}`].some((n) => taken.has(n))) continue;
    const trans = new Set<string>((e.transitions ?? []).map((t: any) => t.field));
    // (a stamp's field is the compiler's to set, on every create and change: the forms leave it out)
    const fields = e.fields.filter((f: any) => !f.stamped && f.type.kind === "named" && (entities.has(f.type.name) || enums.has(f.type.name) || FORM_TYPES.has(f.type.name)));
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
      return `        ${formField(p, entities, enums, value, picks)}`;
    }).join("\n");
    const label = human(snake(e.name));
    const row = e.singleton ? e.name : "admin_row";
    index.push(`      <div><Link to={admin_${s}_${e.singleton ? "edit" : "list"}${e.singleton ? "" : "()"}}><span>${label}</span></Link>${e.singleton ? "" : `<span class="muted">{text(count(${e.name} where true))}</span>`}</div>`);

    // the list: a page at a time, newest first, oldest first or by the label (A-Z); found by the
    // words in its text fields (q) and narrowed by its enum fields
    const textual = e.fields.filter((f: any) => f.type.kind === "named" && ["Text", "Email", "Url"].includes(f.type.name));
    const filters = e.fields.filter((f: any) => f.type.kind === "named" && enums.has(f.type.name));
    const lf = labels.get(e.name);
    const listParams = [...(textual.length ? ["q: Text?"] : []), ...filters.map((f: any) => `${f.name}: ${f.type.name}?`)];
    const listArgs = [...(textual.length ? ["q"] : []), ...filters.map((f: any) => f.name)];
    const conds = [
      ...(textual.length ? [`(q == none or ${textual.map((f: any) => (f.type.name === "Url" && opt(f) ? `(.${f.name} != none and contains(lower(.${f.name}), lower(trim(q))))` : `contains(lower(.${f.name}${opt(f) ? '.default("")' : ""}), lower(trim(q)))`)).join(" or ")})`] : []),
      ...filters.map((f: any) => `(${f.name} == none or .${f.name} == ${f.name})`),
    ];
    const orders: [string, string, string][] = [["", "created desc", "Newest"], ["_oldest", "created", "Oldest"], ...(lf && !e.fields.find((f: any) => f.name === lf)?.type.optional ? [["_az", `.${lf}`, "A–Z"] as [string, string, string]] : [])];   // A–Z only by a label always set: a page leaves out rows with none
    if (!e.singleton) for (const [suffix, order] of orders) out.push(`view admin_${s}_rows${suffix}(${listParams.join(", ")}) {
  require admin_ok(actor) else forbidden
  rows ${e.name} where ${conds.join(" and ") || "true"}
  order by ${order}
  page 50
}`);
    // the whole table as CSV: its fields a spreadsheet can hold (no private ones, which never leave)
    const csvCols = e.fields.filter((f: any) => !f.private && f.type.kind === "named" && f.type.name !== "Password" && (entities.has(f.type.name) || enums.has(f.type.name) || ["Text", "Int", "Decimal", "Date", "Bool", "Time", "Email", "Url", "Ip", "RichText"].includes(f.type.name)));
    if (!e.singleton) out.push(`view admin_${s}_all() {
  require admin_ok(actor) else forbidden
  rows ${e.name} where true
  order by created desc
  limit 10000
}
export admin_${s}_csv() {
  route ${q(`/_admin/${s}/export.csv`)}
  format csv
  of admin_${s}_all() as r
  named ${q(label)}
  ${[`"Id": .id`, `"Created": .created`, ...csvCols.map((f: any) => `${q(human(f.name))}: ${f.type.name === "RichText" ? `plain(.${f.name})` : `.${f.name}`}`)].join(", ")}
}
action admin_delete_many_${s}(admin_rows: set of ${e.name}) {
  callers people
  require admin_ok(actor) else forbidden
  for each r in ${e.name} where r in admin_rows {
    delete r
  }
}`);
    if (canCreate) {
      const params = fields.map(createParam).join(", ");
      const direct = fields.filter((f: any) => !withDefault(f));
      const later = fields.filter(withDefault);
      out.push(`action admin_create_${s}(${params}) {
  callers people
  require admin_ok(actor) else forbidden
  create ${e.name} { ${direct.map((f: any) => `${f.name}: ${f.name}`).join(", ")} } as made
${later.map((f: any) => `  if ${f.name} != none { set made.${f.name} = ${f.name} }`).join("\n")}
  result made
}`);
    }
    if (e.singleton) {
      out.push(`action admin_update_${s}(${fields.map(updateParam).join(", ")}) {
  callers people
  require admin_ok(actor) else forbidden
  if not exists(${e.name} where true) {
    create ${e.name} { ${fields.map((f: any) => `${f.name}: ${f.name}`).join(", ")} }
  } else {
${fields.map((f: any) => f.type.name === "Password" ? `    if ${f.name} != none { set ${e.name}.${f.name} = ${f.name} }` : `    set ${e.name}.${f.name} = ${f.name}`).join("\n")}
  }
}`);
    } else {
      out.push(`action admin_update_${s}(admin_row: ${e.name}${fields.length ? ", " + fields.map(updateParam).join(", ") : ""}) {
  callers people
  require admin_ok(actor) else forbidden
${fields.map((f: any) => f.type.name === "Password" ? `  if ${f.name} != none { set admin_row.${f.name} = ${f.name} }` : `  set admin_row.${f.name} = ${f.name}`).join("\n")}
}
action admin_delete_${s}(admin_row: ${e.name}) {
  callers people
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
    const shellClose = `    </section>\n  </Fill>\n}`;
    if (!e.singleton) {
      // the screen's parameters: the search, the order, the filters (in the views' order, with sort after q)
      const screenParams = [...(textual.length ? ["q: Text?"] : []), "sort: Text?", ...filters.map((f: any) => `${f.name}: ${f.type.name}?`)];
      const linkArgs = (sort: string) => [...(textual.length ? ["q"] : []), sort, ...filters.map((f: any) => f.name)].join(", ");
      // a row: a box to pick it, its label (to its form), up to four of its fields, its number
      const cols = fields.filter((f: any) => f.name !== lf && !["Password", "RichText"].includes(f.type.name)).slice(0, 4);
      const rowMarkup = `          <div class="row">
            <input type="checkbox" name="admin_rows[]" value={text(r.id)} aria-label={"Pick #" + text(r.id)} />
            <Link to={admin_${s}_edit(r)} class="label"><span>{r}</span></Link>
${cols.map((f: any) => `            <span class="muted">{r.${f.name}}</span>`).join("\n")}
            <span class="muted">{"#" + text(r.id)}</span>
          </div>`;
      const list = (suffix: string) => `<List of={admin_${s}_rows${suffix}(${listArgs.join(", ")})} as=r class="list">\n${rowMarkup}\n        </List>`;
      const [first, ...rest] = orders.slice(1);
      const lists = `        {if sort == ${q(first[0].slice(1))} {\n        ${list(first[0])}\n${rest.map(([sx]) => `        } else if sort == ${q(sx.slice(1))} {\n        ${list(sx)}\n`).join("")}        } else {\n        ${list("")}\n        }}`;
      const find = textual.length || filters.length ? `      <Form to={admin_${s}_list} class="inline">
${textual.length ? `        <Field name=q kind=text value={q} label="Search" />\n` : ""}${filters.map((f: any) => `        <Field name=${f.name} kind=choice from={[${enums.get(f.type.name)!.join(", ")}]} value={${f.name}} label=${q(human(f.name))} />\n`).join("")}        <Submit label="Find" />
      </Form>
` : "";
      out.push(`${shellOpen(`admin_${s}_list`, `/_admin/${s}`, `(${screenParams.join(", ")})`, label)}
      <h1>${label}</h1>
      <Link to={admin_index} class="quiet"><span>All tables</span></Link>
${canCreate ? `      <Link to={admin_${s}_new} class="btn"><span>New ${label.toLowerCase()}</span></Link>\n` : ""}      <Link href=${q(`/_admin/${s}/export.csv`)} class="quiet"><span>Download CSV</span></Link>
${find}      <nav>${orders.map(([sx, , name]) => `<Link to={admin_${s}_list(${linkArgs(sx ? q(sx.slice(1)) : "none")})} class="quiet"><span>${name}</span></Link>`).join("")}</nav>
      <Form action={admin_delete_many_${s}}>
${lists}
        <Submit label="Delete the picked rows" />
        <On ok stay flash="Deleted." />
        <On invalid flash="Not deleted: other rows still refer to some of them." />
      </Form>
${shellClose}`);
    }
    if (canCreate) out.push(`${shellOpen(`admin_${s}_new`, `/_admin/${s}/new`, "", `New ${label.toLowerCase()}`)}
      <h1>New ${label.toLowerCase()}</h1>
      <Form action={admin_create_${s}}>
${form(null, createParam)}
        <Submit label="Create" />
        <On ok go={admin_${s}_${e.singleton ? "edit" : "list"}} />
        <On invalid flash="Not saved: check the values against the entity's sizes, keys and rules." />
      </Form>
${shellClose}`);
    // the rows that refer to this one: the newest 20 of each, by each reference, each linking to its form
    let related = "";
    if (!e.singleton) for (const c of stored) {
      if (c.singleton) continue;
      for (const f of c.fields.filter((x: any) => x.type.kind === "named" && x.type.name === e.name)) {
        const v = `admin_${snake(c.name)}_by_${f.name}`;
        if (taken.has(v)) continue;
        taken.add(v);
        out.push(`view ${v}(p: ${e.name}) {
  require admin_ok(actor) else forbidden
  rows ${c.name} where .${f.name} == p
  order by created desc
  limit 20
}`);
        related += `      <h2>${human(snake(c.name))} (${human(f.name).toLowerCase()})</h2>
      <List of={${v}(admin_row)} as=x class="list">
        <Link to={admin_${snake(c.name)}_edit(x)} class="row"><span>{x}</span><span class="muted">{"#" + text(x.id)}</span></Link>
      </List>
`;
      }
    }
    out.push(`${shellOpen(`admin_${s}_edit`, e.singleton ? `/_admin/${s}` : `/_admin/${s}/:admin_row`, e.singleton ? "" : `(admin_row: ${e.name})`, label)}
      <h1>${e.singleton ? label : `Edit ${label.toLowerCase()}`}</h1>
${e.singleton ? "" : `      <span class="muted">{admin_row}</span>
`}
      <Link to={${e.singleton ? "admin_index" : `admin_${s}_list`}} class="quiet"><span>Back</span></Link>
      <Form action={admin_update_${s}${e.singleton ? "" : "(admin_row)"}}>
${form(row, updateParam)}
        <Submit label="Save" />
        <On ok stay flash="Saved." />
        <On invalid flash="Not saved: check the values against the entity's sizes, keys and rules, and the moves its fields allow." />
      </Form>
${e.singleton ? "" : `      <Button action={admin_delete_${s}(admin_row)} text="Delete" class="quiet" confirm="Delete this ${label.toLowerCase()}?" />
      <On ok go={admin_${s}_list} />
      <On invalid flash="Not deleted: other rows still refer to it." />
`}${left.length ? `      <span class="muted">${left.map((f: any) => f.name).join(", ")}: not editable here.</span>\n` : ""}${related}${e.history && !e.singleton ? `      <h2>History</h2>\n      <History>{admin_row}</History>\n` : ""}${shellClose}`);
  }
  if (!out.length) return "";
  out.push(`screen admin_index {
  route "/_admin"
  layout ${sh.layout}
  require admin_ok(actor) else ${deny}
  <Title>Admin</Title>
  <${sh.slotTag}>
    <${sh.section}>
      <h1>Admin</h1>
${index.join("\n")}
    </section>
  </Fill>
}`);
  return `fn admin_ok(a: ${actor}?): Bool = true\n\n${out.join("\n\n")}\n`;
}

// Adds the admin section to a spec: its source, with the condition the app gave for who an administrator is,
// and read access for administrators to every entity (so its lists can show them).
export function withAdmin(spec: Spec, parse: (src: string) => Spec): Decl[] {
  const src = adminSource(spec);
  if (!src) return [];
  const app = spec.decls.find((d) => d.kind === "app")!;
  const generated = parse(src).decls;
  for (const g of generated) (g as any).generated = ADMIN;
  // its creates and changes set the app's stamps, as the app's own do (lang/rules.ts)
  weaveStamps(generated, stampsByEntity(spec.decls), new Map(spec.decls.filter((d) => ["entity", "singleton", "data"].includes(d.kind)).map((d) => [d.name, d])));
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
