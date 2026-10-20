// Writes crudspec.tmLanguage.json: the colouring VS Code shows before the extension's semantic
// tokens (highlight.js) arrive, and where they don't. From highlight.js's own keyword lists.
//   node editors/vscode/syntaxes/make-grammar.js
"use strict";
const fs = require("fs");
const path = require("path");
const { KEYWORDS, CONTROL } = require("../highlight");

const words = (set) => `\\b(?:${[...set].sort().join("|")})\\b`;
const tag = (name, scope) => ({
  begin: `(</?)(${name})`,
  beginCaptures: { 1: { name: "punctuation.definition.tag.crudspec" }, 2: { name: scope } },
  end: "/?>",
  endCaptures: { 0: { name: "punctuation.definition.tag.crudspec" } },
  patterns: [
    { include: "#string" },
    { include: "#braces" },
    { match: "(=)([A-Za-z_]\\w*)", captures: { 1: { name: "punctuation.separator.crudspec" }, 2: { name: "variable.other.crudspec" } } },   // a bare name as the value
    { name: "entity.other.attribute-name.crudspec", match: "[A-Za-z_][\\w-]*" },
  ],
});
const grammar = {
  $schema: "https://raw.githubusercontent.com/martinring/tmlanguage/master/tmlanguage.json",
  name: "crudspec",
  scopeName: "source.crudspec",
  patterns: [
    { include: "#comment" }, { include: "#string" }, { include: "#tag" }, { include: "#braces" },
    { name: "constant.numeric.crudspec", match: "\\b\\d+\\b" },
    { name: "keyword.control.crudspec", match: words(CONTROL) },
    { name: "keyword.other.crudspec", match: words([...KEYWORDS].filter((k) => !CONTROL.has(k))) },
    { name: "entity.name.function.crudspec", match: "\\b[a-z_]\\w*(?=\\s*\\()" },
    { name: "entity.name.type.crudspec", match: "\\b[A-Z]\\w*\\b" },
    { name: "variable.other.property.crudspec", match: "(?<=\\.)[A-Za-z_]\\w*" },
  ],
  repository: {
    // code in braces, nested: a } closes its own {
    braces: { begin: "\\{", end: "\\}", patterns: [{ include: "$self" }] },
    comment: { name: "comment.line.double-slash.crudspec", match: "(?:^|(?<=\\s))//.*$" },
    string: { name: "string.quoted.double.crudspec", begin: "\"", end: "\"|$", patterns: [{ name: "constant.character.escape.crudspec", match: "\\\\." }] },
    // a component's or built-in's tag (capitalised), and an HTML element's
    tag: { patterns: [tag("[A-Z][\\w-]*", "support.class.component.crudspec"), tag("[a-z][\\w-]*", "entity.name.tag.crudspec")] },
  },
};
fs.writeFileSync(path.join(__dirname, "crudspec.tmLanguage.json"), JSON.stringify(grammar, null, 2) + "\n");
console.log("wrote crudspec.tmLanguage.json");
