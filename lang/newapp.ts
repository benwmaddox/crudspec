// node lang/cli.ts new <dir>: a repository of its own for one app, built with this crudspec,
// pinned to its version (.crudspec-version). It has a small working app (sign-up, sign-in, notes
// of one's own) with its tests, AGENTS.md for the agents that write it, scripts that fetch the
// pinned crudspec, and the pull request check that verifies and reviews every change.
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const VERSION = (() => { try { return readFileSync(join(here, "VERSION"), "utf8").trim() || "dev"; } catch { return "dev"; } })();
const REPO = "benwmaddox/crudspec";

export function newApp(dir: string, name: string): string[] {
  if (existsSync(dir) && readdirSync(dir).length) throw new Error(`${dir} isn't empty`);
  const id = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || "app";
  const files: Record<string, string> = {
    ".crudspec-version": `${VERSION}\n`,
    ".gitignore": "build/\ndata/\ncrudspec/\nnode_modules/\n",
    "app/app.crud": APP(id, name),
    "app/tests.crud": TESTS,
    "app/assets/app.css": CSS,
    "README.md": README(name),
    "AGENTS.md": AGENTS(name),
    "get-crudspec.sh": GET_SH,
    "get-crudspec.ps1": GET_PS1,
    ".github/workflows/check.yml": CHECK,
  };
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), text);
  }
  return Object.keys(files);
}

const APP = (id: string, name: string) => `// ${name}: a starting point. People sign up and keep notes only they can see. Change it into
// your app: see AGENTS.md.
app ${id} {
  name ${JSON.stringify(name)}
  about "Notes, kept by people"
  actor Person
  sign_in_screen sign_in_screen
  indexes auto
}

entity Person {
  name: Text max 80
  email: Email private
  password: Password max 72
  unique (email)
}
entity Login { person: Person on delete cascade  token: Text = token(24)  unique (token) }
entity Note {
  owner: Person on delete cascade
  text: Text max 2000 searchable
}

identity login: Login.token from cookie "login"
identity agent: Person from token

policy person_rows: it == actor for rows of Person
policy login_rows: .person == actor for rows of Login
policy note_rows: .owner == actor for rows of Note
policy note_writes: .owner == actor else forbidden for writes to Note

// Makes an account and signs it in.
action sign_up(name: Text, email: Email, password: Text) {
  callers people
  rate_limit 10 per Duration.minutes(5) by request.ip else blocked
  require present(name) and length(password) >= 8 else invalid "a name, and a password of 8 characters or more"
  require not exists(Person where .email == email) else invalid "that email has an account"
  create Person { name: name, email: email, password: password } as p
  create Login { person: p } as l
  result l
}

// Signs in with an email address and password.
action sign_in(email: Email, password: Text) {
  callers people
  rate_limit 10 per Duration.minutes(3) by request.ip else blocked
  rate_limit 20 per Duration.minutes(15) by lower(trim(email)) else blocked   // per account: many addresses get no more guesses
  let p = the_or_none(Person where .email == email)
  require p != none and authenticates(p.password, password) else unauthenticated
  create Login { person: p } as l
  result l
}

// Signs out of this browser.
action sign_out() {
  callers people
  delete Login where .token == request.session_token
}

// Writes a note of your own.
action add_note(text: Text) {
  require actor != none else unauthenticated
  require present(text) else invalid
  create Note { owner: actor, text: text } as n
  result n
}

// Deletes one of your notes.
action delete_note(note: Note) {
  delete note
}

// Your notes, newest first; with q, those with its words.
view my_notes(q: Text?) {
  rows Note where .owner == actor and (q == none or matches(.text, q))
  order by created desc
}

layout page {
  <Title />
  <nav><Slot name=nav /></nav>
  <Flash />
  <main><Slot name=main /></main>
}

component Bar() {
  <div class="bar">
    <Link to={home()} class="brand"><span>${name}</span></Link>
    {if actor != none {
      <span class="muted">{actor.name}</span>
      <Link href="/_agents" label="Agent access" class="quiet" />
      <Button action={sign_out()} label="Sign out" class="quiet" />
      <On ok go={sign_in_screen()} />
    }}
  </div>
}

screen home(q: Text?) {
  route "/"
  layout page
  <Title>${name}</Title>
  <Fill name=nav><Bar /></Fill>
  <Fill name=main>
    <section class="card">
      <h1>Your notes</h1>
      <Form action={add_note} class="inline">
        <Field name=text kind=text placeholder="Write a note" label="Note" label_hidden required />
        <Submit label="Add" />
        <On ok stay />
      </Form>
      <Form to={home} class="inline">
        <Field name=q kind=text value={q} placeholder="Search your notes" label="Search" label_hidden />
      </Form>
      <List of={my_notes(q)} as=n class="list">
        <div class="row">
          <span>{n.text}</span>
          <Button action={delete_note(n)} label="Delete" class="quiet" confirm="Delete this note?" />
          <On ok stay />
        </div>
      </List>
    </section>
  </Fill>
}

screen sign_up_screen {
  route "/sign-up"
  layout page
  require public
  <Title>Create an account</Title>
  <Fill name=main>
    <section class="card narrow">
      <h1>Create an account</h1>
      <Form action={sign_up}>
        <Field name=name kind=text label="Name" required />
        <Field name=email kind=email label="Email" required />
        <Field name=password kind=password label="Password (8 characters or more)" required />
        <Submit label="Create account" />
        <On ok go={home(none)} sign_in={result} />
        <On invalid flash="That email has an account, or the password is under 8 characters." />
        <On blocked flash="Too many tries. Wait a few minutes." />
      </Form>
      <Link to={sign_in_screen()} class="quiet"><span>I have an account</span></Link>
    </section>
  </Fill>
}

screen sign_in_screen {
  route "/sign-in"
  layout page
  require public
  <Title>Sign in</Title>
  <Fill name=main>
    <section class="card narrow">
      <h1>Sign in</h1>
      <Form action={sign_in}>
        <Field name=email kind=email label="Email" required />
        <Field name=password kind=password label="Password" required />
        <Submit label="Sign in" />
        <On ok go={home(none)} sign_in={result} />
        <On unauthenticated flash="Wrong email or password." />
        <On blocked flash="Too many tries. Wait a few minutes." />
      </Form>
      <Link to={sign_up_screen()} class="quiet"><span>Create an account</span></Link>
    </section>
  </Fill>
}

theme app {
  stylesheets ["app.css"]
  classes { button: "btn", submit: "btn", screen_reader: "sr-only", form: "", avatar: "", generated_section: "card", input: "input" }
}
`;

const TESTS = `// The app's tests: node crudspec/lang/cli.ts test app (verify runs them too).

test "notes are their writer's" {
  create Person { name: "Ann", email: "ann@example.test", password: "secret-123" } as ann
  create Person { name: "Bo", email: "bo@example.test", password: "secret-123" } as bo
  run add_note("Buy milk") by ann as n
  run add_note("x") by none expect unauthenticated
  run add_note("") by ann expect invalid
  run my_notes(none) by ann expect 1 row
  run my_notes(none) by bo expect 0 rows
  run delete_note(n) by bo expect not_found
  expect n.owner == ann
  run delete_note(n) by ann
}

test "search finds notes by the start of their words" {
  create Person { name: "Ann", email: "ann@example.test", password: "secret-123" } as ann
  run add_note("Buy milk") by ann
  run add_note("Call the plumber") by ann
  run my_notes("plum") by ann expect 1 row
  run my_notes("lk") by ann expect 0 rows
}

test "accounts" {
  run sign_up("Ann", "ann@example.test", "secret-123") by none
  run sign_up("Ann", "ann@example.test", "secret-123") by none expect invalid
  run sign_in("ann@example.test", "secret-123") by none
  run sign_in("ann@example.test", "wrong-one") by none expect unauthenticated
  create Person { name: "Bo", email: "bo@example.test", password: "secret-123" } as bo
  run sign_out() by bo
}
`;

const CSS = `/* The app's stylesheet: dark, plain, readable. */
:root { color-scheme: dark; --bg: #0b0d12; --card: #151922; --line: #262c3b; --ink: #e7e9f0; --muted: #949cb0; --accent: #8b5cf6; --link: #b9a6ff; }
* { box-sizing: border-box; }
body { margin: 0 auto; max-width: 760px; padding: 0 16px 40px; font: 16px/1.6 system-ui, sans-serif; color: var(--ink); background: var(--bg); }
body > a[href="#main-content"] { position: absolute; left: -9999px; }
a { color: var(--link); text-decoration: none; }
.bar { display: flex; align-items: center; gap: 14px; padding: 14px 0; border-bottom: 1px solid var(--line); margin-bottom: 20px; flex-wrap: wrap; }
.brand { font-weight: 800; color: var(--ink); margin-right: auto; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 20px 24px; }
.narrow { max-width: 420px; margin: 32px auto; }
.muted { color: var(--muted); }
.list { display: grid; gap: 2px; margin-top: 14px; }
.row { display: flex; align-items: center; gap: 12px; padding: 8px 4px; border-top: 1px solid var(--line); }
.row > span { flex: 1; }
form fieldset { border: 0; padding: 0; margin: 0 0 12px; display: grid; gap: 12px; }
.inline fieldset { display: flex; gap: 8px; }
.inline label { flex: 1; }
label { display: grid; gap: 6px; font-weight: 600; font-size: .93rem; }
.input { font: inherit; width: 100%; padding: 10px 12px; border: 1px solid var(--line); border-radius: 10px; background: #10131b; color: var(--ink); }
.btn, button[type=submit] { font: inherit; font-weight: 650; padding: 9px 16px; border-radius: 10px; border: 0; background: var(--accent); color: #fff; cursor: pointer; }
.quiet, button.quiet[type=submit] { background: none; border: 0; padding: 0; color: var(--link); font: inherit; cursor: pointer; }
.flash { position: fixed; top: 16px; left: 50%; transform: translateX(-50%); background: #222838; border: 1px solid var(--line); padding: 10px 16px; border-radius: 10px; }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
`;

const README = (name: string) => `# ${name}

A web app written in [crudspec](https://github.com/${REPO}) (version in \`.crudspec-version\`),
by AI agents, following AGENTS.md. The app is \`app/\`: its spec (\`*.crud\`), its tests
(\`tests.crud\`) and its stylesheet (\`assets/\`).

## Run it

You need Node 24, Go 1.27 and a C compiler (gcc; on Windows, MinGW-w64 gcc such as WinLibs with
\`CGO_ENABLED=1\`).

\`\`\`
./get-crudspec.sh            # or .\\get-crudspec.ps1 on Windows: the pinned crudspec, in crudspec/
node crudspec/lang/cli.ts verify app
node crudspec/lang/cli.ts build app --out build
build/app --data data --assets app/assets --port 4300
\`\`\`

Every pull request is verified, tested and reviewed against its base by
\`.github/workflows/check.yml\`. The review is posted as a comment, which says when a change widens
access (who gains what), for reading before merging; only failing checks or tests fail the check.
`;

const AGENTS = (name: string) => `# Working on ${name}

This app is written in crudspec by agents. Fetch the pinned crudspec first
(\`./get-crudspec.sh\`, or \`.\\get-crudspec.ps1\`). Its \`crudspec/AGENTS.md\` is the guide: the loop
(check, test-plan, test, verify, review), the errors you'll meet and their fixes, and the habits
that keep apps safe. Follow it, with \`app\` as the app's folder:

\`\`\`
node crudspec/lang/cli.ts check app
node crudspec/lang/cli.ts test-plan app --untested
node crudspec/lang/cli.ts test app
node crudspec/lang/cli.ts verify app
\`\`\`

The language is \`crudspec/lang/LANGUAGE.md\`, and everything in it is in \`crudspec/lang/REFERENCE.md\`.
When the app needs something crudspec lacks, say so in the pull request rather than working
around it in a script: it belongs in crudspec.
`;

const GET_SH = `#!/bin/sh
# Fetches the crudspec this app is pinned to (.crudspec-version) into crudspec/.
set -e
v=$(tr -d '[:space:]' < .crudspec-version)
rm -rf crudspec && mkdir crudspec
curl -fsSL "https://github.com/${REPO}/releases/download/$v/crudspec-$v.tar.gz" | tar -xz -C crudspec
(cd crudspec && npm ci --omit=dev --no-audit --no-fund)
echo "crudspec $v in crudspec/"
`;

const GET_PS1 = `# Fetches the crudspec this app is pinned to (.crudspec-version) into crudspec\\.
$ErrorActionPreference = "Stop"
$v = (Get-Content .crudspec-version -Raw).Trim()
if (Test-Path crudspec) { Remove-Item -Recurse -Force crudspec }
New-Item -ItemType Directory crudspec | Out-Null
$tgz = Join-Path $env:TEMP "crudspec-$v.tar.gz"
Invoke-WebRequest "https://github.com/${REPO}/releases/download/$v/crudspec-$v.tar.gz" -OutFile $tgz
tar -xzf $tgz -C crudspec
Push-Location crudspec; npm ci --omit=dev --no-audit --no-fund; Pop-Location
Write-Host "crudspec $v in crudspec\\"
`;

const CHECK = `# Every pull request: the app is checked, its invariants proven, its tests run, and the change
# reviewed against the base branch, with the pinned crudspec. The review is posted as a comment,
# which says when a change widens access; that's for reading, and doesn't fail the check.
name: check
on:
  pull_request:
    types: [opened, synchronize, reopened]
permissions:
  contents: read
  pull-requests: write
jobs:
  verify:
    runs-on: ubuntu-latest
    env:
      CGO_ENABLED: 1
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version: 24
      - uses: actions/setup-go@v5
        with:
          go-version: "1.27"
      - run: sh get-crudspec.sh
      - run: git worktree add base \${{ github.event.pull_request.base.sha }}
      - name: verify against the base
        id: verify
        shell: bash
        run: |
          set +e
          against=(); [ -d base/app ] && against=(--against base/app)
          node crudspec/lang/cli.ts verify app "\${against[@]}" > verify.txt 2>&1
          code=$?
          { echo "## crudspec: what this change does"; echo; echo '\`\`\`'; grep -vE 'MODULE_TYPELESS|Reparsing as ES module|eliminate this warning|trace-warnings|ExperimentalWarning' verify.txt | tail -n 150; echo '\`\`\`'; } > comment.md
          [ $code = 2 ] && echo "**This change widens access:** read the review above (who gains what) before merging." >> comment.md
          echo "code=$code" >> "$GITHUB_OUTPUT"
      - if: always()
        env:
          GH_TOKEN: \${{ github.token }}
        run: gh pr comment \${{ github.event.pull_request.number }} --edit-last --body-file comment.md || gh pr comment \${{ github.event.pull_request.number }} --body-file comment.md
      - shell: bash
        run: |
          code=\${{ steps.verify.outputs.code }}
          # 1: checks or tests failed; 2: it passed and widens access (said in the comment, not a failure)
          if [ "$code" = 1 ]; then exit 1; fi
          if [ "$code" = 2 ]; then echo "::notice::This change widens access: the PR comment says who gains what."; fi
`;
