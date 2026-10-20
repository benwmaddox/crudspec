// The VS Code extension's parts that run without VS Code (editors/vscode): the colouring reader,
// the placing of check's findings, the grammar kept in step with the reader's keywords, and the
// token types the extension and its package.json agree on.
//   node lang/test/editor.test.ts
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { readSpec } from "../source.ts";

const require = createRequire(import.meta.url);
const { tokens } = require("../../editors/vscode/highlight.js");
const { place } = require("../../editors/vscode/diagnostics.js");
let failed = 0;
const ok = (what: string, pass: boolean, detail?: unknown) => { console.log(`${pass ? "ok  " : "FAIL"} ${what}`); if (!pass) { failed++; if (detail !== undefined) console.log(typeof detail === "string" ? detail : JSON.stringify(detail, null, 2)); } };
const kinds = (src: string) => tokens(src).map((t: any) => `${t.kind}:${src.slice(t.start, t.end)}`);

for (const app of ["apps/campfire", "apps/tasks", "apps/todomvc"]) {
  const src = readSpec(app), ts = tokens(src);
  ok(`${app}: tokens in order, apart, in the source`, ts.every((t: any, i: number) => t.start < t.end && t.end <= src.length && (i === 0 || ts[i - 1].end <= t.start)));
}
ok("content: text, and {…} in it as code", JSON.stringify(kinds(`<p>Hello {name}!</p>`)) === JSON.stringify(["p:<", "html:p", "p:>", "txt:Hello", "br:{", "name:name", "br:}", "txt:!", "p:</", "html:p", "p:>"]), kinds(`<p>Hello {name}!</p>`));
ok("a component's tag apart from HTML's, and its attributes", kinds(`<Button action={go()} label="Go" />`).join(" ") === `p:< tag:Button attr:action p:= br:{ fn:go br:} attr:label p:= str:"Go" p:/>`, kinds(`<Button action={go()} label="Go" />`));
ok("a < b is no tag", !kinds(`view v() { rows Note where .n < limit }`).some((k: string) => k.startsWith("p:<")));
ok("// in text after a space is a comment", kinds(`<p>Hi // a note\n</p>`).includes("com:// a note"));
ok("keywords, control flow, types and fields", kinds(`action a(t: Task) { require t.done else forbidden }`).join(" ") === "kw:action fn:a name:t type:Task br:{ ctl:require name:t field:done ctl:else name:forbidden br:}", kinds(`action a(t: Task) { require t.done else forbidden }`));

// findings placed: the file, the line in it, and the name the column is at
const dir = mkdtempSync(join(tmpdir(), "editor-"));
writeFileSync(join(dir, "a.crud"), `app d { name "D"  actor User }\nentity User { name: Text }\n`);
writeFileSync(join(dir, "b.crud"), `entity Note { title: Txt }\n`);
const r = JSON.parse(spawnSync(process.execPath, ["--no-warnings", "lang/cli.ts", "check", dir, "--json"], { encoding: "utf8" }).stdout);
const placed = place(r, join(dir, "a.crud"));
const file = Object.keys(placed).find((f) => f.endsWith("b.crud"));
const p = file && placed[file].find((x: any) => x.code === "UNKNOWN_TYPE");
ok("a finding: its file, line, and the name it's at", !!p && p.line === 0 && p.start === 21 && p.end === 24 && p.severity === "error", placed);
ok("a finding with no place: the app's first file, first line", (() => { const q = place({ findings: [{ severity: "warning", code: "X", message: "m" }] }, join(dir, "a.crud")); return q[join(dir, "a.crud")]?.[0]?.line === 0; })());

// the grammar is what make-grammar.js writes from highlight.js's keywords
const committed = readFileSync("editors/vscode/syntaxes/crudspec.tmLanguage.json", "utf8");
spawnSync(process.execPath, ["editors/vscode/syntaxes/make-grammar.js"], { encoding: "utf8" });
ok("the grammar is in step with highlight.js (node editors/vscode/syntaxes/make-grammar.js)", readFileSync("editors/vscode/syntaxes/crudspec.tmLanguage.json", "utf8") === committed);

// every token kind has a token type, and every custom type is declared
const ext = readFileSync("editors/vscode/extension.js", "utf8"), pkg = JSON.parse(readFileSync("editors/vscode/package.json", "utf8"));
const TYPES = JSON.parse(/const TYPES = (\[[^\]]*\])/.exec(ext)![1]);
const KIND = Function(`return ${/const KIND = (\{[^}]*\})/.exec(ext)![1]}`)();
const STANDARD = new Set(["keyword", "type", "function", "variable", "property", "string", "number", "comment"]);
const used = new Set(tokens(readSpec("apps/campfire")).map((t: any) => t.kind));
ok("each kind the reader gives has a token type", [...used].every((k) => TYPES.includes(KIND[k] ?? "-") || k === "br"), [...used]);
ok("each custom token type is declared, with its scope", TYPES.filter((t: string) => !STANDARD.has(t)).every((t: string) => pkg.contributes.semanticTokenTypes.some((x: any) => x.id === t) && pkg.contributes.semanticTokenScopes[0].scopes[t]));
// extension.js against a stand-in for the vscode API: activated, a spec opened, its problems set
{
  const Module = require("node:module");
  const problems = new Map<string, any[]>(), handlers: Record<string, Function[]> = {};
  let provider: any;
  const providers: Record<string, any> = {};
  class Builder { data: number[][] = []; push(...a: number[]) { this.data.push(a); } build() { return this.data; } }
  const fake = {
    SemanticTokensLegend: class { types: string[]; constructor(types: string[]) { this.types = types; } }, SemanticTokensBuilder: Builder,
    Range: class { l0: number; c0: number; c1: number; start: any; end: any; constructor(l0: number, c0: number, l1: number, c1: number) { this.l0 = l0; this.c0 = c0; this.c1 = c1; this.start = { line: l0, character: c0 }; this.end = { line: l1, character: c1 }; } },
    CodeAction: class { title: string; kind: any; edit: any; diagnostics: any; isPreferred?: boolean; constructor(t: string, k: any) { this.title = t; this.kind = k; } },
    CodeActionKind: { QuickFix: "quickfix" },
    WorkspaceEdit: class { edits: any[] = []; replace(uri: any, range: any, text: string) { this.edits.push({ uri, range, text }); } },
    Diagnostic: class { source?: string; code?: string; range: any; message: string; severity: number; constructor(range: any, message: string, severity: number) { this.range = range; this.message = message; this.severity = severity; } },
    DiagnosticSeverity: { Error: 0, Warning: 1 },
    Uri: { file: (p: string) => ({ fsPath: p, toString: () => p }) },
    Hover: class { contents: any; constructor(c: any) { this.contents = c; } },
    MarkdownString: class { value: string; constructor(v: string) { this.value = v; } },
    Location: class { uri: any; pos: any; constructor(u: any, p: any) { this.uri = u; this.pos = p; } },
    Position: class { line: number; character: number; constructor(l: number, c: number) { this.line = l; this.character = c; } },
    CompletionItem: class { label: string; kind: any; detail?: string; constructor(l: string, k: any) { this.label = l; this.kind = k; } },
    CompletionItemKind: { Class: 1, Property: 2, EnumMember: 3, Reference: 4, Function: 5 },
    languages: {
      registerDocumentSemanticTokensProvider: (_s: any, p: any) => { provider = p; return { dispose() {} }; },
      registerHoverProvider: (_s: any, p: any) => { providers.hover = p; return { dispose() {} }; },
      registerCodeActionsProvider: (_s: any, p: any) => { providers.actions = p; return { dispose() {} }; },
      registerDefinitionProvider: (_s: any, p: any) => { providers.definition = p; return { dispose() {} }; },
      registerCompletionItemProvider: (_s: any, p: any) => { providers.completion = p; return { dispose() {} }; },
      createDiagnosticCollection: () => ({ set: (u: any, d: any[]) => problems.set(u.fsPath, d), delete: (u: any) => problems.delete(u.fsPath), dispose() {} }),
    },
    window: { createOutputChannel: () => ({ appendLine: (l: string) => console.log("  (output) " + l) }) },
    workspace: {
      getConfiguration: () => ({ get: (k: string) => ({ cli: "", node: process.execPath, deep: false } as any)[k] }),
      onDidOpenTextDocument: (f: Function) => ((handlers.open ??= []).push(f), { dispose() {} }),
      onDidSaveTextDocument: (f: Function) => ((handlers.save ??= []).push(f), { dispose() {} }),
      textDocuments: [] as any[],
    },
  };
  const load = Module._load;
  Module._load = function (name: string, ...rest: any[]) { return name === "vscode" ? fake : load.call(this, name, ...rest); };
  const ext = require("../../editors/vscode/extension.js");
  Module._load = load;
  ext.activate({ subscriptions: [] });
  // a spec in the checkout (so the extension finds lang/cli.ts above it), with a slip in its second file
  mkdirSync(join(process.cwd(), ".scratch"), { recursive: true });
  const app = mkdtempSync(join(process.cwd(), ".scratch", "editor-app-"));
  writeFileSync(join(app, "a.crud"), `app d { name "D"  actor User }\nentity User { name: Text }\n`);
  writeFileSync(join(app, "b.crud"), `\nentity Note { title: Txt }\n`);
  const text = readFileSync(join(app, "b.crud"), "utf8");
  const docOf = (file: string, text: string) => ({ languageId: "crudspec", uri: { scheme: "file", fsPath: file }, getText: () => text,
    positionAt: (o: number) => { const before = text.slice(0, o).split("\n"); return { line: before.length - 1, character: before[before.length - 1].length }; },
    offsetAt: (p: any) => text.split("\n").slice(0, p.line).reduce((n, l) => n + l.length + 1, 0) + p.character });
  const doc = docOf(join(app, "b.crud"), text);
  handlers.open[0](doc);
  const deadline = Date.now() + 60000;
  while (!problems.has(join(app, "b.crud")) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  const d = problems.get(join(app, "b.crud"))?.[0];
  ok("extension: opening a spec runs check on its app, and the problem is at its name", !!d && d.code === "UNKNOWN_TYPE" && d.severity === 0 && d.range.l0 === 1 && d.range.c0 === 21 && d.range.c1 === 24, d);
  const fixes = providers.actions.provideCodeActions(doc, null, { diagnostics: problems.get(join(app, "b.crud")) });
  const fix = fixes.find((a: any) => a.title === "Change to Text");
  ok("extension quick fix: did you mean Text? replaces the name", !!fix && fix.isPreferred && fix.edit.edits[0].text === "Text" && fix.edit.edits[0].range.start.character === 21 && fix.edit.edits[0].range.end.character === 24, fixes);
  const { quickFixes } = require("../../editors/vscode/language.js");
  const tagFix = quickFixes({ line: 0, start: 9, end: 15, code: "UI_ELEMENT", message: "unknown element; did you mean Heading?" }, [`  <Main><Heding>x <Heding>y</Heding></Heding></Main>`])[0];
  ok("quick fix on a tag: its closing tag too (the one that closes it)", tagFix?.edits.length === 2 && tagFix.edits[1].start === 38 && tagFix.edits[1].text === "Heading", tagFix);
  const toks = provider.provideDocumentSemanticTokens(doc);
  ok("extension: semantic tokens on their lines (keyword entity, type Note, type Txt)", JSON.stringify(toks.slice(0, 3)) === JSON.stringify([[1, 0, 6, 0, 0], [1, 7, 4, 2, 0], [1, 14, 5, 4, 0]]) && toks.some((t: number[]) => t[0] === 1 && t[1] === 21 && t[3] === 2), toks);
  // hover, definition, completion: a screen in a third file, open and edited but not saved
  const ui = `// Shows the notes.\nscreen notes {\n  route "/"\n  <Main><Button action={add()} confirm="Sure?" /><Field name=t kind=email label="E" /></Main>\n}\n`;
  writeFileSync(join(app, "c.crud"), "");
  const udoc = docOf(join(app, "c.crud"), ui);
  fake.workspace.textDocuments.push(udoc);
  const posOf = (needle: string, k = 1) => { const o = ui.indexOf(needle) + k, before = ui.slice(0, o).split("\n"); return { line: before.length - 1, character: before[before.length - 1].length }; };
  const hv = async (needle: string, k = 1) => (await providers.hover.provideHover(udoc, posOf(needle, k)))?.contents.value ?? "";
  ok("extension hover: a built-in element's doc and attributes", (await hv("Button")).startsWith("**<Button>** — A button that runs an action") && (await hv("Button")).includes("`confirm`"), await hv("Button"));
  ok("extension hover: an attribute's doc, on its element", (await hv("confirm")).includes("asks for confirmation first"), await hv("confirm"));
  ok("extension hover: a field kind's doc", (await hv("email ")).includes("field:"), await hv("email "));
  ok("extension hover: a declaration, with its doc comment", (await hv("notes {", 1)).includes("Shows the notes.") && ((await providers.hover.provideHover(doc, { line: 1, character: 9 }))?.contents.value ?? "").includes("entity Note"));
  const adoc = docOf(join(app, "a.crud"), readFileSync(join(app, "a.crud"), "utf8"));
  const defUser = providers.definition.provideDefinition(adoc, { line: 0, character: 26 });
  ok("extension definition: a name goes to its declaration's file and line", !!defUser && defUser.uri.fsPath.endsWith("a.crud") && defUser.pos.line === 1 && defUser.pos.character === 7, defUser);
  const comp = async (needle: string, k: number) => (await providers.completion.provideCompletionItems(udoc, posOf(needle, k))).map((c: any) => c.label);
  ok("extension completion: after <, the elements", (await comp("<Button", 1)).includes("Heading") && (await comp("<Button", 1)).includes("Separator"));
  ok("extension completion: in a tag, its attributes and the common ones", (await comp(" confirm", 1)).includes("reveal") && (await comp(" confirm", 1)).includes("class"), await comp(" confirm", 1));
  ok("extension completion: after kind=, the field kinds", (await comp("kind=", 5)).includes("textarea"), await comp("kind=", 5));
  (await import("node:fs")).rmSync(app, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
