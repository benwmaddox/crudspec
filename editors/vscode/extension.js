// crudspec for VS Code: colours a spec by what each part is (highlight.js, which the README
// picture uses too), shows what check finds as problems, on opening and saving a .crud file, and
// gives hover, go to definition and completion (language.js).
// check runs on the whole app (the file's directory: an app is its directory's .crud files),
// with lang/cli.ts from the crudspec checkout the file is in, or the crudspec.cli setting.
"use strict";
const vscode = require("vscode");
const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");
const { tokens } = require("./highlight");
const { place } = require("./diagnostics");
const language = require("./language");

// the token types, in the legend's order; package.json maps the custom ones to TextMate scopes
const TYPES = ["keyword", "controlKeyword", "type", "function", "variable", "property", "string", "number", "comment", "tag", "htmlTag", "attribute", "punctuation", "text"];
const KIND = { kw: "keyword", ctl: "controlKeyword", type: "type", fn: "function", name: "variable", field: "property", str: "string", num: "number", com: "comment", tag: "tag", html: "htmlTag", attr: "attribute", p: "punctuation", txt: "text" };
const legend = new vscode.SemanticTokensLegend(TYPES, []);

function activate(context) {
  const out = vscode.window.createOutputChannel("crudspec");
  context.subscriptions.push(vscode.languages.registerDocumentSemanticTokensProvider({ language: "crudspec" }, {
    provideDocumentSemanticTokens(doc) {
      const b = new vscode.SemanticTokensBuilder(legend);
      const src = doc.getText();
      for (const t of tokens(src)) {
        const type = TYPES.indexOf(KIND[t.kind]);
        if (type < 0) continue;
        // a token is on one line: text that runs over lines is a token per line
        let at = t.start;
        while (at < t.end) {
          const nl = src.indexOf("\n", at), stop = nl >= 0 && nl < t.end ? nl : t.end;
          const p = doc.positionAt(at), len = stop - at - (src[stop - 1] === "\r" ? 1 : 0);
          if (len > 0) b.push(p.line, p.character, len, type, 0);
          at = stop + 1;
        }
      }
      return b.build();
    },
  }, legend));

  // hover, go to definition and completion (language.js): the app's declarations from its files
  // (the open ones as edited), the language's vocabulary from cli.ts reference --json, read once
  const refs = new Map();   // cli path -> the reference, or a promise of it
  const reference = (dir) => {
    const cfg = vscode.workspace.getConfiguration("crudspec"), cli = cfg.get("cli") || findCli(dir);
    if (!cli) return Promise.resolve(undefined);
    if (!refs.has(cli)) refs.set(cli, new Promise((resolve) => execFile(cfg.get("node") || "node", ["--no-warnings", cli, "reference", "--json"], { cwd: path.dirname(path.dirname(cli)), maxBuffer: 16 << 20 }, (err, stdout) => {
      try { resolve(JSON.parse(stdout)); } catch { out.appendLine(`reference --json gave no result: ${String(err)}`); refs.delete(cli); resolve(undefined); }
    })));
    return refs.get(cli);
  };
  const declsFor = (doc) => {
    const dir = path.dirname(doc.uri.fsPath);
    const open = new Map(vscode.workspace.textDocuments.filter((d) => d.languageId === "crudspec").map((d) => [d.uri.fsPath, d.getText()]));
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".crud")).sort().map((f) => path.join(dir, f));
    return language.declarations(files.map((f) => [f, open.get(f) ?? fs.readFileSync(f, "utf8")]));
  };
  const sel = { language: "crudspec" };
  context.subscriptions.push(
    vscode.languages.registerHoverProvider(sel, {
      async provideHover(doc, pos) {
        const md = language.hover(doc.getText(), doc.offsetAt(pos), await reference(path.dirname(doc.uri.fsPath)), declsFor(doc));
        return md && new vscode.Hover(new vscode.MarkdownString(md));
      },
    }),
    vscode.languages.registerDefinitionProvider(sel, {
      provideDefinition(doc, pos) {
        const d = language.definition(doc.getText(), doc.offsetAt(pos), declsFor(doc));
        return d && new vscode.Location(vscode.Uri.file(d.file), new vscode.Position(d.line, d.col));
      },
    }),
    // quick fixes: a problem's "did you mean X?", and the few that say what to add
    vscode.languages.registerCodeActionsProvider(sel, {
      provideCodeActions(doc, _range, ctx) {
        const actions = [];
        for (const d of ctx.diagnostics) {
          if (d.source !== "crudspec") continue;
          const p = { line: d.range.start.line, start: d.range.start.character, end: d.range.end.character, message: d.message, code: d.code };
          for (const f of language.quickFixes(p, doc.getText().split(/\r?\n/))) {
            const a = new vscode.CodeAction(f.title, vscode.CodeActionKind.QuickFix);
            a.edit = new vscode.WorkspaceEdit();
            for (const e of f.edits) a.edit.replace(doc.uri, new vscode.Range(e.line, e.start, e.line, e.end), e.text);
            a.diagnostics = [d]; a.isPreferred = /^Change to /.test(f.title);
            actions.push(a);
          }
        }
        return actions;
      },
    }, { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }),
    vscode.languages.registerCompletionItemProvider(sel, {
      async provideCompletionItems(doc, pos) {
        const KINDS = { element: "Class", attribute: "Property", value: "EnumMember", outcome: "EnumMember", declaration: "Reference", builtin: "Function" };
        return language.completions(doc.getText(), doc.offsetAt(pos), await reference(path.dirname(doc.uri.fsPath)), declsFor(doc)).map((c) => {
          const item = new vscode.CompletionItem(c.label, vscode.CompletionItemKind[KINDS[c.kind]]);
          item.detail = c.detail;
          return item;
        });
      },
    }, "<", " ", "="),
  );

  const problems = vscode.languages.createDiagnosticCollection("crudspec");
  context.subscriptions.push(problems);
  const shown = new Map();   // app directory -> the files it last put problems on
  const running = new Map(); // app directory -> a timer, so saves in a row check once

  const checkApp = (doc) => {
    if (doc.languageId !== "crudspec" || doc.uri.scheme !== "file") return;
    const dir = path.dirname(doc.uri.fsPath);
    clearTimeout(running.get(dir));
    running.set(dir, setTimeout(() => runCheck(dir), 150));
  };
  const runCheck = (dir) => {
    const cfg = vscode.workspace.getConfiguration("crudspec");
    const cli = cfg.get("cli") || findCli(dir);
    if (!cli) { out.appendLine(`no lang/cli.ts above ${dir}: set crudspec.cli to a crudspec checkout's lang/cli.ts`); return; }
    const args = ["--no-warnings", cli, "check", dir, "--json", ...(cfg.get("deep") ? ["--deep"] : [])];
    execFile(cfg.get("node") || "node", args, { cwd: path.dirname(path.dirname(cli)), maxBuffer: 32 << 20, timeout: 120000 }, (err, stdout, stderr) => {
      let result;
      try { result = JSON.parse(stdout); } catch { out.appendLine(`check ${dir} gave no result: ${(stderr || String(err)).trim()}`); return; }
      const files = fs.readdirSync(dir).filter((f) => f.endsWith(".crud")).sort().map((f) => path.join(dir, f));
      for (const f of shown.get(dir) ?? []) problems.delete(vscode.Uri.file(f));
      const placed = place(result, files[0]);
      for (const [file, list] of Object.entries(placed)) {
        problems.set(vscode.Uri.file(file), list.map((p) => {
          const d = new vscode.Diagnostic(new vscode.Range(p.line, p.start, p.line, p.end), p.message, p.severity === "error" ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning);
          d.source = "crudspec"; d.code = p.code;
          return d;
        }));
      }
      shown.set(dir, Object.keys(placed));
    });
  };
  context.subscriptions.push(vscode.workspace.onDidOpenTextDocument(checkApp), vscode.workspace.onDidSaveTextDocument(checkApp));
  for (const doc of vscode.workspace.textDocuments) checkApp(doc);
}

// lang/cli.ts in the nearest directory above that has one: the crudspec checkout
function findCli(dir) {
  for (let d = dir; ; d = path.dirname(d)) {
    const f = path.join(d, "lang", "cli.ts");
    if (fs.existsSync(f)) return f;
    if (path.dirname(d) === d) return undefined;
  }
}

module.exports = { activate, deactivate() {} };
