// What each action and view does, derived from the spec: the rows it creates, updates and
// deletes (including through triggers, cascades and workflows), the events and externs it
// reaches, and from those the agent-facing annotations (read-only, destructive, idempotent,
// open-world) and JSON Schemas. The annotations are claims; test/annotations checks them
// against the interpreter.
import type { Spec, Decl } from "./parser.ts";
import { paramSizes, type Size } from "./sizes.ts";

export type Effects = {
  creates: string[]; updates: Record<string, string[]>; deletes: string[];
  later: { creates: string[]; updates: Record<string, string[]>; deletes: string[] };   // by workflows, after the response
  emits: string[]; externs: string[];
  unknown: boolean;                 // a write whose target entity couldn't be resolved
  unknownDelete: boolean;           // a delete whose target couldn't be resolved: treated as deleting
  notIdempotent: string[];          // reasons a repeat call can have more effect
};
export type Annotations = { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean };
export type Param = { name: string; type: string; optional: boolean; schema: any };
export type Callable = {
  name: string; kind: "action" | "view"; description: string;
  params: Param[]; inputSchema: any; outcomes: string[];
  effects: Effects; annotations: Annotations;
  confirm: boolean;                 // applying needs a confirmation from a dry run (it deletes rows)
  returns?: { entity: string; fields: string[] } | { value: true };
  unavailable?: string;             // why agents can't call it (file uploads, say)
};
export type Descriptor = { app: string; actor: string; callables: Callable[] };

const TEXT = new Set(["Text", "Email", "Url", "Ip", "Password", "RichText"]);

export function describe(spec: Spec, source = ""): Descriptor {
  const decls = spec.decls;
  const entities = new Map(decls.filter((d) => d.kind === "entity" || d.kind === "data").map((d) => [d.name, d]));
  const enums = new Map(decls.filter((d) => d.kind === "enum").map((d) => [d.name, d.values as string[]]));
  const triggers = decls.filter((d) => d.kind === "trigger");
  const workflows = decls.filter((d) => d.kind === "workflow");
  const gates = decls.filter((d) => d.kind === "gate");
  const app = decls.find((d) => d.kind === "app");
  const lines = source.split("\n");
  const actorEntity: string | null = app?.props?.actor?.name ?? null;

  // ---- effects
  function effectsOf(body: any[], env0: Map<string, string | null>): Effects {
    const mk = () => ({ creates: new Set<string>(), updates: new Map<string, Set<string>>(), deletes: new Set<string>() });
    const now = mk(), after = mk();
    const fx = { emits: new Set<string>(), externs: new Set<string>(), unknown: false, unknownDelete: false, notIdempotent: new Set<string>() };
    let later = false;
    const w = () => (later ? after : now);
    const seen = new Set<any>();
    const entityOf = (e: any, env: Map<string, string | null>): string | null => {
      if (!e) return null;
      switch (e.kind) {
        case "name": return env.has(e.name) ? env.get(e.name) ?? null : e.name === "actor" ? actorEntity : entities.get(e.name)?.singleton ? e.name : null;
        case "field": { const t = entityOf(e.target, env); const f = t ? entities.get(t)?.fields.find((x: any) => x.name === e.name) : null; return f && entities.has(f.type.name) ? f.type.name : null; }
        case "query": return ["the", "the_or_none", "first_or_none"].includes(e.op) ? e.entity : null;
        case "if": return entityOf(e.then, env) ?? entityOf(e.else, env);
        default: return null;
      }
    };
    const externsIn = (x: any): void => { if (!x || typeof x !== "object") return; if (Array.isArray(x)) return x.forEach(externsIn); if (x.kind === "extern") fx.externs.add(x.name); if (x.kind === "sendmail") fx.externs.add("mail"); for (const [k, v] of Object.entries(x)) if (k !== "pos") externsIn(v); };
    const usesNow = (x: any): boolean => !!x && typeof x === "object" && (x.kind === "now" || Object.entries(x).some(([k, v]) => k !== "pos" && usesNow(v)));
    const random = (x: any): boolean => !!x && typeof x === "object" && ((x.kind === "call" && ["token", "random"].includes(x.name)) || Object.entries(x).some(([k, v]) => k !== "pos" && random(v)));
    const readsField = (x: any, name: string): boolean => !!x && typeof x === "object" && (((x.kind === "field" || x.kind === "rowfield") && x.name === name) || Object.entries(x).some(([k, v]) => k !== "pos" && readsField(v, name)));
    const fire = (on: (t: any) => boolean, bindEntity: string | null) => {
      for (const t of triggers) if (on(t.on) && !seen.has(t)) { seen.add(t); walk(t.body, new Map([[t.bind, bindEntity], ["old", bindEntity]])); }
    };
    const deleted = (ent: string) => {
      if (w().deletes.has(ent)) return;
      w().deletes.add(ent);
      fire((o) => o.kind === "delete" && o.entity === ent, ent);
      for (const [ename, d] of entities) for (const f of d.fields) if (f.type.kind === "named" && f.type.name === ent && f.onDelete !== "restrict") deleted(ename);   // cascades
    };
    function walk(ss: any[], env: Map<string, string | null>) {
      for (const s of ss) {
        externsIn(s);
        switch (s.kind) {
          case "let": env.set(s.name, entityOf(s.value, env)); break;
          case "create":
            w().creates.add(s.entity); if (s.as) env.set(s.as, s.entity);
            if (!s.ensure && !later) fx.notIdempotent.add(`creates a ${s.entity} each time`);
            fire((o) => o.kind === "create" && o.entity === s.entity, s.entity);
            break;
          case "set": {
            const ent = entityOf(s.target, env);
            if (!ent) { fx.unknown = true; break; }
            (w().updates.get(ent) ?? w().updates.set(ent, new Set()).get(ent)!).add(s.name);
            if (!later && usesNow(s.value)) fx.notIdempotent.add(`sets ${ent}.${s.name} from the time`);
            if (!later && random(s.value)) fx.notIdempotent.add(`sets ${ent}.${s.name} to a new random value`);
            if (!later && readsField(s.value, s.name)) fx.notIdempotent.add(`sets ${ent}.${s.name} from its own value`);
            fire((o) => o.kind === "update" && o.entity === ent && o.field === s.name, ent);
            break;
          }
          case "delete": { const ent = entityOf(s.target, env); if (ent) deleted(ent); else if (!later) { fx.unknown = true; fx.unknownDelete = true; } break; }
          case "deleteWhere": deleted(s.entity); break;
          case "foreach": walk(s.body, new Map([...env, [s.bind, s.entity]])); break;
          case "foreachList": walk(s.body, new Map([...env, [s.bind, null]])); break;
          case "if": walk(s.then, new Map(env)); walk(s.else, new Map(env)); break;
          case "rate_limit": fx.notIdempotent.add("rate-limited: repeated calls are refused"); break;
          case "emit":
            fx.emits.add(s.event);
            fire((o) => o.kind === "event" && o.event === s.event, null);
            for (const wf of workflows) if (wf.event === s.event && !seen.has(wf)) {
              seen.add(wf); const was = later; later = true;
              for (const st of wf.steps) walk(st.body, new Map([[wf.bind, entityOf(s.args[0], env)]]));
              later = was;
            }
            break;
        }
      }
    }
    walk(body, new Map(env0));
    if (fx.externs.size) fx.notIdempotent.add(`calls ${[...fx.externs].join(", ")} each time`);
    if (fx.emits.size && !fx.externs.size) fx.notIdempotent.add(`emits ${[...fx.emits].join(", ")} each time`);
    const out = (x: ReturnType<typeof mk>) => ({ creates: [...x.creates], updates: Object.fromEntries([...x.updates].map(([k, v]) => [k, [...v]])), deletes: [...x.deletes] });
    return {
      ...out(now), later: out(after),
      emits: [...fx.emits], externs: [...fx.externs], unknown: fx.unknown, unknownDelete: fx.unknownDelete, notIdempotent: [...fx.notIdempotent],
    };
  }

  // ---- parameters as JSON Schema
  const sizes = paramSizes(spec);
  const sized = (s: any, z?: Size) => (z && s?.type === "string" ? { ...s, ...(z.max !== undefined ? { maxLength: z.max } : {}), ...(z.min !== undefined ? { minLength: z.min } : {}) } : s);
  function schemaOf(t: any): any {
    if (t.kind === "set") return { type: "array", items: { type: "integer" }, description: `ids of ${t.of} rows` };
    const n = t.name;
    if (entities.has(n)) return { type: "integer", description: `the id of a ${n}` };
    if (enums.has(n)) return { type: "string", enum: enums.get(n) };
    if (n === "Int") return { type: "integer" };
    if (n === "Bool") return { type: "boolean" };
    if (n === "Email") return { type: "string", format: "email" };
    if (n === "Url") return { type: "string", format: "uri" };
    if (TEXT.has(n)) return { type: "string" };
    return { type: "string", description: n };
  }
  const typeName = (t: any) => (t.kind === "set" ? `set of ${t.of}` : t.name);

  // ---- possible outcomes
  function outcomesOf(d: Decl): string[] {
    const out = new Set<string>(["ok"]);
    const walkO = (x: any): void => { if (!x || typeof x !== "object") return; if (Array.isArray(x)) return x.forEach(walkO);
      if ((x.kind === "require" || x.kind === "reject" || x.kind === "rate_limit") && typeof x.outcome === "string") out.add(x.outcome);
      for (const [k, v] of Object.entries(x)) if (k !== "pos") walkO(v); };
    walkO(d.body ?? d.requires);
    for (const g of gates) if (!(d.skips ?? []).includes(g.name)) out.add(g.outcome);
    if (d.kind === "action" && (d.body ?? []).some((s: any) => s.kind === "create" || s.kind === "set")) out.add("invalid");
    if (d.kind === "action" && JSON.stringify(d.body ?? []).includes(`"kind":"sendmail"`)) out.add("invalid");   // a bad address or subject
    return [...out];
  }

  // a description: the comment block just above the declaration, then what it does
  function docOf(d: Decl): string {
    const above: string[] = [];
    for (let i = d.pos.line - 2; i >= 0 && /^\s*\/\//.test(lines[i] ?? ""); i--) above.unshift(lines[i].replace(/^\s*\/\/\s?/, ""));
    return above.join(" ").trim();
  }
  function summary(fx: Effects): string {
    const parts: string[] = [];
    if (fx.creates.length) parts.push(`creates ${fx.creates.join(", ")}`);
    const ups = Object.entries(fx.updates).map(([e, fs]) => `${e}.${fs.join("/")}`);
    if (ups.length) parts.push(`updates ${ups.join(", ")}`);
    if (fx.deletes.length) parts.push(`deletes ${fx.deletes.join(", ")}`);
    if (fx.externs.length) parts.push(`then calls ${fx.externs.join(", ")}`);
    return parts.length ? parts.join("; ") : "changes nothing";
  }

  const callables: Callable[] = [];
  for (const d of decls) {
    if (d.kind === "action" && !d.internal) {
      const env = new Map<string, string | null>(d.params.map((p: any) => [p.name, p.type.kind === "named" && entities.has(p.type.name) ? p.type.name : null]));
      const fx = effectsOf(d.body, env);
      const writes = fx.creates.length || Object.keys(fx.updates).length || fx.deletes.length || fx.unknown;
      const annotations: Annotations = {
        readOnlyHint: !writes && !fx.externs.length && !fx.emits.length,
        destructiveHint: !!(Object.keys(fx.updates).length || fx.deletes.length || fx.unknown),
        idempotentHint: !fx.notIdempotent.length,
        openWorldHint: fx.externs.length > 0,
      };
      // file parameters: an optional one is left out (agents can't upload yet); a required one makes the action unavailable
      const isFile = (p: any) => p.type.kind === "named" && p.type.name === "File";
      const sz = sizes.get(d) ?? new Map<string, Size>();
      const params: Param[] = d.params.filter((p: any) => !isFile(p)).map((p: any) => ({ name: p.name, type: typeName(p.type), optional: p.type.kind === "named" && !!p.type.optional, schema: sized(schemaOf(p.type), sz.get(p.name)) }));
      const file = d.params.find((p: any) => isFile(p) && !p.type.optional);
      // sign-in style actions manage browser sessions; agents have tokens instead
      const sessionEntity = decls.find((x) => x.kind === "identity" && x.source === "cookie")?.entity;
      const managesSessions = (sessionEntity && fx.creates.includes(sessionEntity)) || JSON.stringify(d.body).includes('"name":"session_token"');
      const doc = docOf(d);
      callables.push({
        name: d.name, kind: "action", description: [doc, `This action ${summary(fx)}.`].filter(Boolean).join(" "),
        params, inputSchema: { type: "object", properties: Object.fromEntries(params.map((p) => [p.name, p.schema])), required: params.filter((p) => !p.optional).map((p) => p.name), additionalProperties: false },
        outcomes: outcomesOf(d), effects: fx, annotations, confirm: fx.unknownDelete || fx.deletes.some((e) => !fx.creates.includes(e)),
        ...(file ? { unavailable: `takes a file (${file.name}); file uploads aren't available to agents yet` } : managesSessions ? { unavailable: "manages browser sessions; agents use tokens" } : {}),
      });
    } else if (d.kind === "view") {
      const fx: Effects = { creates: [], updates: {}, deletes: [], later: { creates: [], updates: {}, deletes: [] }, emits: [], externs: d.value?.kind === "extern" ? [d.value.name] : [], unknown: false, unknownDelete: false, notIdempotent: [] };
      const params: Param[] = d.params.map((p: any) => ({ name: p.name, type: typeName(p.type), optional: p.type.kind === "named" && !!p.type.optional, schema: schemaOf(p.type) }));
      const ent = d.rows?.entity;
      callables.push({
        name: d.name, kind: "view", description: [docOf(d), ent ? `Lists ${ent} rows the caller may read.` : "Returns a value."].filter(Boolean).join(" "),
        params, inputSchema: { type: "object", properties: Object.fromEntries(params.map((p) => [p.name, p.schema])), required: params.filter((p) => !p.optional).map((p) => p.name), additionalProperties: false },
        outcomes: outcomesOf(d), effects: fx,
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: fx.externs.length > 0 },
        confirm: false,
        returns: ent ? { entity: ent, fields: entities.get(ent).fields.filter((f: any) => !["Password"].includes(f.type.name)).map((f: any) => f.name) } : { value: true },
      });
    }
  }
  return { app: app?.props?.name?.value ?? "app", actor: app?.props?.actor?.name ?? "", callables };
}
