// node lang/cli.ts expand <spec> <name>: an action, view, screen, channel or signal as it runs, with what
// the rules wove into it (lang/rules.ts, lang/writerule.ts) marked with where it came from. Every-action
// policies run before the body, so they are listed first.
import type { Decl } from "./parser.ts";
import { showExpr } from "./review.ts";

const typeText = (p: any): string => {
  const t = p.type;
  if (t?.kind === "set") return `set of ${t.of}`;
  if (t?.kind === "list") return `list of ${typeText({ type: t.of })}`;
  return `${p.subset ?? t?.name}${t?.optional ? "?" : ""}`;
};
const from = (x: any) => (x.fromPolicy ? `   // from ${/^(policy|subset) /.test(x.fromPolicy) ? x.fromPolicy : `policy ${x.fromPolicy}`}` : x.policy ? `   // from policy ${x.policy}` : "");
const outcomeText = (r: any) => (r.go ? `go ${r.go.name ?? showExpr(r.go)}${r.flash ? ` flash ${showExpr(r.flash)}` : ""}` : r.outcome) + (r.reason ? ` ${JSON.stringify(r.reason)}` : "");

function stmts(list: any[], ind: string): string[] {
  const out: string[] = [];
  for (const s of list ?? []) {
    const q = (e: string, w?: any) => `${e}${w ? ` where ${showExpr(w)}` : ""}`;
    switch (s.kind) {
      case "require": out.push(`${ind}require ${showExpr(s.cond)} else ${outcomeText(s)}${from(s)}`); break;
      case "reject": out.push(`${ind}reject ${outcomeText(s)}`); break;
      case "let": out.push(`${ind}let ${s.name} = ${showExpr(s.value)}`); break;
      case "create": out.push(`${ind}${s.ensure ? "ensure" : "create"} ${s.entity} { ${(s.fields ?? []).map((f: any) => `${f.name}: ${showExpr(f.value)}`).join(", ")} }${s.as ? ` as ${s.as}` : ""}${s.fromStamp ? `   // fields from ${s.fromStamp}` : ""}`); break;
      case "set": out.push(`${ind}set ${showExpr(s.target)}.${s.name} = ${showExpr(s.value)}${s.fromStamp ? `   // from ${s.fromStamp}` : ""}`); break;
      case "touch": out.push(`${ind}touch ${showExpr(s.target)}`); break;
      case "delete": out.push(`${ind}delete ${showExpr(s.target)}`); break;
      case "deleteWhere": out.push(`${ind}delete ${q(s.entity, s.where)}`); break;
      case "emit": out.push(`${ind}emit ${s.event}(${(s.args ?? []).map(showExpr).join(", ")})`); break;
      case "result": out.push(`${ind}result ${showExpr(s.value)}`); break;
      case "callstmt": out.push(`${ind}${showExpr(s.call)}`); break;
      case "rate_limit": out.push(`${ind}rate_limit ${s.n} per ${showExpr(s.per)} by ${showExpr(s.by)} else ${s.outcome}`); break;
      case "sendmail": out.push(`${ind}send mail { … }`); break;
      case "foreach": out.push(`${ind}for each ${s.bind} in ${q(s.entity, s.where)} {`, ...stmts(s.body, ind + "  "), `${ind}}`); break;
      case "foreachList": out.push(`${ind}for each ${s.bind} in ${showExpr(s.over)} {`, ...stmts(s.body, ind + "  "), `${ind}}`); break;
      case "if": {
        out.push(`${ind}if ${showExpr(s.cond)} {`, ...stmts(s.then, ind + "  "));
        if (s.else?.length) out.push(`${ind}} else {`, ...stmts(s.else, ind + "  "));
        out.push(`${ind}}`);
        break;
      }
      default: out.push(`${ind}${s.kind} …`);
    }
  }
  return out;
}

export function expandText(decls: Decl[], name: string): string | undefined {
  const d: any = decls.find((x) => x.name === name && ["action", "view", "screen", "channel", "signal"].includes(x.kind));
  if (!d) return undefined;
  const lines: string[] = [];
  if (d.kind === "action") {
    for (const g of decls as any[]) if (g.kind === "gate" && !(d.skips ?? []).includes(g.name)) lines.push(`// first, policy ${g.name}: refused ${g.outcome} when ${showExpr(g.cond)}`);
  }
  const ps = (d.params ?? []).map((p: any) => `${p.name}: ${typeText(p)}`).join(", ");
  lines.push(`${d.kind} ${d.name}(${ps}) {`);
  if (d.skips?.length) lines.push(...d.skips.map((s: string) => `  skip policy ${s}`));
  if (d.kind === "action") lines.push(...stmts(d.body, "  "));
  else if (d.kind === "channel" || d.kind === "signal") { if (d.requires) lines.push(`  require ${showExpr(d.requires)}`); }
  else {
    for (const r of d.requires ?? []) lines.push(`  require ${showExpr(r.cond)} else ${outcomeText(r)}${from(r)}`);
    if (d.rows) lines.push(`  rows ${d.rows.entity}${d.rows.where ? ` where ${showExpr(d.rows.where)}` : ""}`);
    if (d.kind === "screen") lines.push("  …");
  }
  lines.push("}");
  return lines.join("\n");
}

// every require the rules added that the site didn't say itself, for the inventory of what a rule changes
export function wovenChecks(decls: Decl[]): { site: string; line: number; text: string; from: string }[] {
  const out: { site: string; line: number; text: string; from: string }[] = [];
  const walk = (site: any, list: any[]) => { for (const s of list ?? []) { if (s.fromPolicy && /^(policy|subset) /.test(s.fromPolicy)) out.push({ site: `${site.kind} ${site.name}`, line: site.pos.line, text: showExpr(s.cond), from: s.fromPolicy }); for (const k of ["then", "else", "body"]) if (Array.isArray(s[k])) walk(site, s[k]); } };
  for (const d of decls as any[]) {
    if (d.kind === "action") walk(d, d.body);
    if (d.kind === "view" || d.kind === "screen") walk(d, d.requires);
  }
  return out;
}
