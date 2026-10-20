# crudspec for VS Code

- **Colours** a spec by what each part is: keywords, control flow, types, calls, fields, a
  component's tag apart from an HTML tag, attributes, and text shown as written apart from the
  `{…}` code in it. The colours come from `highlight.js`, the reader the README picture uses
  (`docs/readme/render.mjs`), as semantic tokens mapped to the scopes your theme already colours.
  A TextMate grammar (`syntaxes/`, written by `make-grammar.js`) colours a file until they arrive.
- **Problems**: on opening and saving a `.crud` file, `check --deep` runs on its app (the
  directory's `.crud` files) and each finding shows at its file, line and name.

It has no dependencies and no build step.

## Install

Link this directory into VS Code's extensions, then reload VS Code. In PowerShell:

```powershell
New-Item -ItemType Junction -Path "$env:USERPROFILE\.vscode\extensions\benwmaddox.crudspec-0.1.0" -Target D:\code\crudspec\editors\vscode
```

On Linux or macOS: `ln -s "$PWD/editors/vscode" ~/.vscode/extensions/benwmaddox.crudspec-0.1.0`.

## Settings

| Setting | Default | |
|---|---|---|
| `crudspec.cli` | the nearest `lang/cli.ts` above the spec | a crudspec checkout's `lang/cli.ts` |
| `crudspec.node` | `node` | Node.js 22.18 or later (it runs `cli.ts` as TypeScript) |
| `crudspec.deep` | `true` | `check --deep`: the type pass, the deep checks and query costs; off for names alone (faster) |

Output from check that isn't a result goes to the **crudspec** output channel.

## Tests

`node lang/test/editor.test.ts` tests the colouring reader, the placing of findings, that the
grammar is what `make-grammar.js` writes, and that every token type is declared.
