// A copy of the current parser that records source offsets: each token's start and end, and
// each expression's, query's, target's and call head's source text (__src). The converter
// to the TSX-style UI syntax uses it.
const fs = require("fs");
let s = fs.readFileSync(".scratch/conv/parser-before.ts", "utf8");
const rep = (a, b) => { if (!s.includes(a)) throw new Error("missing: " + a.slice(0, 70)); s = s.split(a).join(b); };
rep("    const pos = { line, col };", "    const pos: any = { line, col, off: i };");
rep('toks.push({ t: "id", v: src.slice(i, j), pos }); adv(j - i);', 'pos.end = j; toks.push({ t: "id", v: src.slice(i, j), pos }); adv(j - i);');
rep('toks.push({ t: "int", v: src.slice(i, j), pos }); adv(j - i);', 'pos.end = j; toks.push({ t: "int", v: src.slice(i, j), pos }); adv(j - i);');
rep('toks.push({ t: "str", v: out, pos }); adv(j + 1 - i);', 'pos.end = j + 1; toks.push({ t: "str", v: out, pos }); adv(j + 1 - i);');
rep('toks.push({ t: "p", v: p, pos }); adv(p.length);', 'pos.end = i + p.length; toks.push({ t: "p", v: p, pos }); adv(p.length);');
rep("  function expr(): Expr { return implies(); }", "  const tag = (r: any, st: number) => { if (r && typeof r === \"object\") Object.defineProperty(r, \"__src\", { value: src.slice(st, (toks[k - 1].pos as any).end), configurable: true }); return r; };\n  function expr(): Expr { const st = (peek().pos as any).off; return tag(implies(), st); }");
rep("  function query(): any {", "  function query(): any { const st = (peek().pos as any).off; return tag(query0(), st); }\n  function query0(): any {");
rep("  function target(): any {", "  function target(): any { const st = (peek().pos as any).off; return tag(target0(), st); }\n  function target0(): any {");
rep('      case "call": { const n = ident(); const a = at("(") ? args() : { args: [], named: {} }; el.head = { name: n, ...a }; break; }',
    '      case "call": { const st = (peek().pos as any).off; const n = ident(); const a = at("(") ? args() : { args: [], named: {} }; el.head = tag({ name: n, ...a }, st); break; }');
rep('if (peek().t === "id" && /^[A-Z]/.test(peek().v)) source = { kind: "query", ...query() };', 'if (peek().t === "id" && /^[A-Z]/.test(peek().v)) { const q = query(); source = Object.defineProperty({ kind: "query", ...q }, "__src", { value: q.__src }); }');
rep('else source = { kind: "view", ...target() };', 'else { const q = target(); source = Object.defineProperty({ kind: "view", ...q }, "__src", { value: q.__src }); }');
s = s.replace(/from "\.\/(\w+)\.ts"/g, 'from "../../lang/$1.ts"');
fs.mkdirSync(".scratch/conv", { recursive: true });
fs.writeFileSync(".scratch/conv/old-parser.ts", s);
console.log("ok");
