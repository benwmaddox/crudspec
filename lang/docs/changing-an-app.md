[← the language guide](../LANGUAGE.md)

## Changing an app

### Versions and data migration

The runtime records each version of the spec in the database. On start, or with `node lang/cli.ts plan|migrate <spec> --data <dir>`, it compares the spec with the recorded version, and rehearses the whole upgrade on a copy:
1. renames and drops;
2. new tables and columns;
3. defaults for new fields;
4. pending migrations;
5. then every required field, enum value, reference, unique key and invariant, checked on every row.

The upgrade happens only if the rehearsal passes. The original is kept under `<data>/backups/`. Nothing prompts: every decision is written in the spec.

| Change | What happens |
| --- | --- |
| New entity; new optional field or one with a default; new enum value; a removed unique key | Applied. A default is worked out per row. A new `Int` without a default starts at 0 |
| New required field without a default; new unique key; new or changed invariant; a field made required; an enum value removed; a text type changed; a size tightened | Checked against the data. Refused while any row breaks it; the plan names the rows |
| A field or entity no longer declared | Its data is kept. `drop Entity.field` or `drop entity Entity` deletes it next time, and the plan says how much |
| Renames | `name: Text was old_name`, `entity Member was Person`, `enum Status { open, done was closed }`. Values, rows and references are kept |
| A field removed and another of the same type added | Refused as ambiguous until the spec says `was` or `drop` |
| A type change that can't convert | Refused: add a field, copy the values in a migration, drop the old one |

```
migration "unique handles" {
  for each u in User {
    if count(User where .handle == u.handle and .id < u.id) > 0 { set u.handle = u.handle + "-" + text(u.id) }
  }
}
```

**Data migrations** are statements, run once and in order, before the checks:
- triggers don't fire, and they can't emit or call externs;
- a failing `require` refuses the upgrade;
- a new database records them as applied without running them, so don't seed data with them.

**Safety:**
- `migrate` refuses while the app runs (`<data>/app.lock`);
- the upgraded copy is swapped in with one rename, so a crash at any point leaves a whole database;
- the runtime won't start empty while backups exist.

The plan also lists **contract changes** that break API and agent callers: a removed action or view, a new required parameter, a changed type. `plan --json` prints the whole plan. Its status is `ready`, `current`, `blocked`, `applied` or `created`.

**Older syntax:** `node lang/cli.ts upgrade-syntax <spec> [--check]` rewrites an older spec in the current syntax: the vocabulary renames (`gate` to `policy`, `predicate` to `fn`, `access` to `require`, `trigger on` to `on`, …) and the UI tags that became plain HTML (`<Row>`, `<Heading>`, `<Text>`, … to `<div>`, `<h1>`, `<span>`, with the theme's class written in; `<Main>`, `<Nav>` to `<Fill name=…>` in screens and `<main>`, `<nav>` in layouts; `<Content>` to `<Slot>`). A rename is checked to be the same program; the UI tags are checked to leave a spec with no errors. What it cannot rewrite (a `<Row data={…}>`, a built-in-only attribute) it reports with its place and writes nothing.

### Importing data

`app import --data <dir> [--replace] [--dry-run] < rows.json` loads rows from another system into the app's database (a new database is made, at this spec's version):

```
{ "now": 1793484048774,
  "rows": { "User":    [ { "id": 41, "created": 1700000000000, "fields": { "name": "Ann", "email": "ann@example.org", "password": { "password": "plain text" } } } ],
            "Project": [ { "id": 7, "fields": { "title": "Garden", "owner": { "ref": "User", "id": 41 }, "due": 1793484048774 } } ] } }
```

- **What is kept as it comes:** an `id` (other rows refer to it; one left out follows on from the highest), the times a row was made and last changed (`now` when left out), a `Time` as milliseconds or as `{time, seq}`. A `Password` given as `{"password": "…"}` is hashed; one from another system can't be carried over (its hash is its own), so give people a way to set theirs.
- **What is filled in:** a field the row leaves out takes the spec's default, even one worked out for each row (`token(24)`); a required field left out with none is refused.
- **Everything or nothing.** The import is refused, and the database left as it was, when a size, a unique key or a type doesn't fit (the row is named), a reference names a row that isn't in the import or the database, or any `invariant` of the spec doesn't hold (checked as an upgrade checks them). The answer is JSON: what was loaded, the problems with how many rows each touches and a few examples, and whether it was kept. Triggers and workflows don't run, and `transitions` aren't applied: the rows are data that already happened.
- **A database that has rows** is not imported into, unless `--replace` says to replace them. `--dry-run` does everything but keep it, to see what a real import would say.

### Reviewing a change

`node lang/cli.ts review <old.crud> <new.crud> [--probes <file>] [--data <dir>] [--matrix] [--json]` is the report a reviewer of a spec change needs:
- **Schema and data steps**, as in a plan. With `--data`, how many rows each checked or destructive step touches, and how many rows a new `if missed run` schedule would run at once.
- **Outcomes:** what each action can now answer, and each form or button that has no `<On>` for it.
- **What screens show and views return:** the fields each now reads, against before.
- **Who can see and change each field, delete each entity's rows, and call each extern:**
  - the screens, components (counted as the screens that show them) and views that read it, through functions too, with who may open them and their requires;
  - the read permission;
  - the actions that set it, with their requires and the gates they skip;
  - the actions that delete an entity's rows, and that call an extern;
  - what the workflows an action's events start do, as that action's doing.

  Each is compared with its conditions apart (a require's and-parts, a permission's, signed in): one dropped, or a gate skipped, **widens** (`… can now be changed by action x (…), without is_admin(actor)`); one added narrows (`… now also needs …`), which isn't flagged.

  A new reader or writer is a reason to exit 2. `--matrix` prints the whole matrix. An `if` inside a page isn't counted, so the matrix may list more people as seeing a field than really can, never fewer.
- **Conditions:** each condition that changed: a predicate, a permission, a gate, the requires of an action, screen or view (taken together), a trigger's `when`, an `if`, a `where`. Each is said to hold in **fewer** cases, **more**, or **others**. This is worked out by trying every true/false value of the comparisons and calls inside it, so `a or b` → `a` is fewer and `x` → `true` is more, whatever `a`, `b` and `x` are; `x > 3` → `x > 5` is "others", since what's inside a comparison isn't looked into. A predicate's line names what it guards. A guard that admits more or others, or a gate that blocks fewer or others, is **WIDER**, a reason to exit 2. A declaration that changed with none of its conditions changed is listed by name. The access diff above uses the same test: a guard replaced by one that holds in fewer cases narrows (`… now needs x instead of y`).
- **Lifecycles:** the moves each enum field's `transitions` allow, against before: a move added, or a field no longer restricted, is **WIDER**; a move removed, or a field newly restricted, is narrowed.
- **Query costs:** what the change makes slower (a new scan, sort or per-row query) and faster, as SQLite plans each version. Reported, not a reason to exit 2.
- **What agents are told:** actions, annotations, confirmation, effects.
- **Behaviour, by bounded exploration:**
  - recorded calls (`--probes`) are replayed against both versions, by every actor;
  - every row's read permission is checked for every actor;
  - what was refused and is now allowed is **widened**.

It exits 2 when something widened (a guard or gate among them), a screen or view shows more, a new reader or writer appears, a change breaks callers, or data would be dropped.

### Verifying before release

`node lang/cli.ts verify <spec> [--against <old.crud>] [--data <dir>] [--probes <file>] [--strict] [--report <file>] [--json]` runs everything, for CI or packaging:
1. `check --deep`;
2. the invariant proofs, with 20 s per proof (`--timeout`), from the same cache as `build`;
3. with `--against`, the review.

It exits 1 for an error or a broken invariant, and 2 when the review needs a person (or, with `--strict`, an invariant is unproven). `--report` writes the result as JSON.

### Serving

- **Pages are gzipped** for a client that asks (`Accept-Encoding`). A page is mostly fragments from the cache, and each cached fragment keeps its compressed form, made once. A page is sent as those pieces joined, with only what's around them compressed afresh, so compression costs about the same CPU as sending the page plain. Campfire's room page goes from 351 KB to 23 KB. `--no-gzip` turns it off, for a proxy that compresses.
- **Assets are addressed by content.** A page names each asset with a hash of its bytes (`/assets/app.css?v=1a2b3c4d5e6f`), and that address is kept by browsers for good (`immutable`, a year). An address without the current hash is kept 5 minutes and revalidated by `ETag`, so a 304 sends nothing. Text assets (CSS, JS, SVG, JSON) are gzipped once, at the best level. Campfire's room page loads 40 assets: 82 KB plain, 28 KB gzipped, and nothing on a return visit.

- **Live streams are bounded.** An open page holds a stream (`/_events`) for its live updates and signals. The server keeps at most `--max-streams` (10,000) of them, and at most `--max-streams-each` (16) for one person (a session, or an address when signed out). Past either it refuses one (503, `Retry-After: 30`); the page stays as it is, and tries again 30 seconds later.

### Testing

- **`--test`** starts an app with endpoints for tests:
  - `/_test/load`, `/_test/fixture`, `/_test/clock`, `/_test/outbox` and `/_test/dump`;
  - an `X-Test-Actor: Entity:id` header, to act as someone.
- **`--check-cache`** renders every cached fragment afresh too, and logs any difference as a cache bug. Campfire's 42 scenarios make 18,726 comparisons with no difference.
- **Checking screens:** `node lang/browser/screens.ts <spec> --base <url> --fixture <file> --out <dir> [--baseline <dir>] [--accept] [--shots]`.
  - It renders every screen as text an agent can read (and as screenshots with `--shots`), and diffs it against a baseline.
  - It exits 2 on a change until it's accepted. Accepting is a reviewer's step.
