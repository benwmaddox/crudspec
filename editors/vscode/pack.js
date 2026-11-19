// Packs this directory as a .vsix that VS Code installs (code --install-extension), with no
// dependencies: a .vsix is a zip of the extension under extension/, a manifest and a content-types
// file. Linking the directory into ~/.vscode/extensions isn't enough for recent VS Code, which
// loads only extensions an install has registered.
//   node editors/vscode/pack.js [--install]
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const here = __dirname;
const pkg = JSON.parse(fs.readFileSync(path.join(here, "package.json"), "utf8"));
const FILES = ["package.json", "README.md", "extension.js", "highlight.js", "diagnostics.js", "language.js", "markdown.js", "markdown.css",
  "language-configuration.json", "syntaxes/crudspec.tmLanguage.json", "syntaxes/crudspec.markdown.tmLanguage.json"];
const esc = (t) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const stage = fs.mkdtempSync(path.join(os.tmpdir(), "crudspec-vsix-"));
for (const f of FILES) {
  const to = path.join(stage, "extension", f);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(path.join(here, f), to);
}
fs.writeFileSync(path.join(stage, "extension.vsixmanifest"), `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="${esc(pkg.name)}" Version="${esc(pkg.version)}" Publisher="${esc(pkg.publisher)}" />
    <DisplayName>${esc(pkg.displayName)}</DisplayName>
    <Description xml:space="preserve">${esc(pkg.description)}</Description>
    <Categories>${esc(pkg.categories.join(","))}</Categories>
    <Properties><Property Id="Microsoft.VisualStudio.Code.Engine" Value="${esc(pkg.engines.vscode)}" /></Properties>
  </Metadata>
  <Installation><InstallationTarget Id="Microsoft.VisualStudio.Code" /></Installation>
  <Dependencies />
  <Assets><Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" /></Assets>
</PackageManifest>
`);
fs.writeFileSync(path.join(stage, "[Content_Types].xml"), `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension=".json" ContentType="application/json" /><Default Extension=".vsixmanifest" ContentType="text/xml" /><Default Extension=".js" ContentType="application/javascript" /><Default Extension=".css" ContentType="text/css" /><Default Extension=".md" ContentType="text/markdown" /></Types>
`);
const out = path.join(os.tmpdir(), `${pkg.publisher}.${pkg.name}-${pkg.version}.vsix`);
fs.rmSync(out, { force: true });
// bsdtar (Windows' tar, and macOS's) writes a zip with -a and a .zip name; elsewhere, zip
const zip = path.join(stage, "out.zip");
let r = spawnSync("tar", ["-a", "-c", "-f", zip, "extension.vsixmanifest", "[Content_Types].xml", "extension"], { cwd: stage, encoding: "utf8" });
if (r.status !== 0) r = spawnSync("zip", ["-r", "-q", zip, "extension.vsixmanifest", "[Content_Types].xml", "extension"], { cwd: stage, encoding: "utf8" });
if (r.status !== 0) { console.error(`couldn't zip: ${r.stderr || r.error}`); process.exit(1); }
fs.renameSync(zip, out);
fs.rmSync(stage, { recursive: true, force: true });
console.log(`wrote ${out}`);
if (process.argv.includes("--install")) {
  const i = spawnSync("code", ["--install-extension", out, "--force"], { encoding: "utf8", shell: process.platform === "win32" });
  process.stdout.write(i.stdout ?? ""); process.stderr.write(i.stderr ?? "");
  process.exit(i.status ?? 1);
}
