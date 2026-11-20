# Design: one database per tenant

**Status:** proposed (2026-11-20). Nothing here is built yet.

**Goal:** an app that hosts many separate spaces (Game Wiki's wikis; a helpdesk's customers) can keep each space's data in a SQLite file of its own:
- each space is backed up, moved, exported or deleted as one file;
- a query can't reach another space's rows, by construction rather than by policy;
- one busy space's writes don't wait on another's;
- one machine serves many more spaces, and the files can later spread across machines.

The spec says which data belongs to a space. The compiler holds every query to that line, and the runtime picks the file from the request.

## Where we are

Every app has one database: `<data>/app.sqlite`, with one writer (behind a lock) and a pool of readers. Game Wiki is multi-tenant by data:
- every content row refers to its `Wiki`;
- `policy wiki_rows: can_read(actor, wiki) for rows in Wiki` hides other wikis' rows.

That works, and it's what most hosted apps do. Its limits:
- **One file for everything.** A big or busy wiki slows every other wiki's writes; one write lock serves them all.
- **Isolation by rule, not by structure.** A missing or wrong policy leaks rows between wikis. The compiler checks that every entity has one, but a wrong condition passes.
- **Per-wiki operations are queries.** Backing up, restoring, exporting or deleting a wiki touches every table, and restoring one wiki from yesterday means surgery on the shared file.

## The model

Two kinds of data:

| | Shared (`app.sqlite`) | Per tenant (`tenants/<key>.sqlite`) |
| --- | --- | --- |
| Game Wiki | `Site`, `User`, `Login`, `AdSlot`, `Wiki` (the directory: slug, name, domain, owner, visibility) | `Page`, `Revision`, `PageCategory`, `Upload`, `InfoboxTemplate`, `InfoboxField`, `InfoboxValue`, `Membership` |
| Who reads it | every request | requests inside one tenant |

### In the spec

```
entity Wiki {
  slug: Text  …
  unique (slug)
  address slug
  tenant                      // each row is a tenant: what refers to it lives in its own database
}

entity Page {
  wiki: Wiki on delete cascade   // a required reference to the tenant: Page is per tenant
  …
}
```

- **`tenant`** on one entity makes each of its rows a database. The tenant entity's own rows stay shared: the directory of tenants has to be readable before a tenant is picked.
- **What's per tenant** follows from the references. An entity is per tenant when its required references lead to the tenant entity, by the same rule as `policy … for rows in Wiki`. That is `Page`, `Revision` (through `.page`), `Membership` and the rest. Nothing is declared twice.
- **A per-tenant entity can refer to shared ones** (`Revision.author: User`, `Membership.user: User`): a shared row is reachable from every tenant.
- **A shared entity can't refer to a per-tenant one** (`TENANT_SHARED_REF`): `User.favorite_page: Page` would point into some file. Keep such links per tenant (a per-tenant `Favorite { user: User, page: Page }`).

### What the compiler checks

- **Each query stays in one tenant.** A query of per-tenant rows needs its tenant known: a parameter, a `where .wiki == w`, or the row it starts from. Otherwise it's `TENANT_UNKNOWN`. `count(Page where true)` over every wiki isn't allowed; say `count(Page where .wiki == w)`, or use a cross-tenant view (below).
- **An action writes one tenant.** Its per-tenant writes all go to the tenant its parameters name, and one transaction can't span two files. An action that writes two tenants is `TENANT_TWO`. Moving a page between wikis becomes a copy then a delete, or a workflow.
- **Shared writes and tenant writes are two transactions.** An action that writes both (`create_wiki` makes the `Wiki` row and its first page) commits the tenant file first, then the shared one, as a workflow's steps do. The checks say which writes can be left half done if the second commit fails, and the action is retried until both hold. (SQLite's `ATTACH` with one transaction across files is the alternative. It is atomic only in rollback journal mode, not WAL, so it's slower, but it would keep actions as they are. This choice is the main open question.)
- **Policies for rows in the tenant** still apply. Isolation makes the cross-tenant leak impossible, but "members only" inside a private wiki is still a rule.
- **Invariants** are proven per tenant, plus the shared ones. A cross-tenant invariant isn't expressible.

### Cross-tenant reads

Some screens need data from every tenant: a site directory with page counts, an administrator's "recent changes everywhere", search across wikis. Two ways:
- **Shared summaries:** a per-tenant trigger or workflow writes a summary to a shared row, for example `Wiki.page_count` or `Wiki.updated`. That's cheap, current and written in the spec.
- **`across Wiki` views:** `view all_recent() across Wiki { rows Revision order by created desc limit 50 }` runs in each tenant file and merges the results. It's read-only and limited (each file is one query), and meant for administrators and small fleets, not public pages.

## The runtime

- **Files:** `<data>/app.sqlite` (shared) and `<data>/tenants/<id>.sqlite`. The file is named by the tenant row's id, not its slug, so renaming the address never moves the file.
- **Picking the tenant:** for each request, from the first tenant the request names:
  - the screen's address (`/w/hollow-depths`, through `address`);
  - the host (`request.host`, through the app's lookup);
  - an action's parameter, or a row parameter's tenant.

  A request names at most one tenant; two are refused.
- **Connections:** an LRU pool of open tenant databases. Each has one writer and a few readers, opened on first use and closed after a while idle, with a cap on open files (default 500) and a per-tenant write lock. The shared database stays as today.
- **Caches:**
  - the page and fragment caches are keyed by tenant;
  - live updates carry the tenant in their keys;
  - the search index is per tenant file, because `Page__fts` lives with `Page`.
- **Creating and deleting a tenant:**
  - creating the tenant row creates its file, with the current schema;
  - deleting the row deletes the file, after a backup under `<data>/backups/tenants/`.
- **Upgrades:** `plan` and `migrate` apply a schema change to the shared file and to every tenant file. That's a rehearsal on a copy of each, then the change, in batches, with a resumable record of which files are done. A file not yet upgraded is upgraded as it's opened, so the app can start before every file is done. That's the one real operational cost of this design.
- **Backups and export:**
  - `backup` copies each file through SQLite's backup API;
  - export takes a tenant (`--tenant hollow-depths`) and gives that tenant's file and its rows in the shared tables it refers to;
  - restoring one tenant is replacing one file.
- **Agents:** a call names its tenant the same way a request does. `describe` lists the callables once.
- **Tests** (`test "…"`): a test's tenant rows go to a tenant file made for the test.
- **Uploads** stay in the file store, keyed as now. A tenant's export lists its uploads' keys.

## What changes for Game Wiki

- `Wiki` gets `tenant`.
- `Membership` moves into the tenant. "Your wikis" on the front page then needs to know a user's wikis without opening every file, so add a shared `Joined { user: User, wiki: Wiki, role: Role }`, written by the membership actions as a shared write.
- `can_read(u, w)` reads a per-tenant `Membership` and the shared `Wiki`, which is allowed because `w` names the tenant.
- The directory and the site administrator's screens are shared.
- Page counts on cards come from a shared summary.

## Phases

1. **Language and checks.** `tenant`, per-tenant entities from references, `TENANT_UNKNOWN`, `TENANT_TWO`, `TENANT_SHARED_REF`. No runtime change yet: the checks alone show what an app would have to change. Run them on Game Wiki.
2. **Runtime: routing and files.** Pick the tenant per request; the pool of tenant files; caches keyed by tenant; two-commit actions, or `ATTACH` (decided in phase 1).
3. **Upgrades, backups, export** per tenant, with tests on a few hundred tenant files.
4. **Cross-tenant reads:** shared summaries first, `across` views only if they're needed.
5. **Game Wiki** moves to it, with a migration that splits an existing `app.sqlite` into tenant files.

## Risks and open questions

- **Atomicity across files:** two commits (simple, WAL, retried) or `ATTACH` (atomic, rollback journal). Decide in phase 1, by measuring Game Wiki's `create_wiki`, `delete_wiki` and membership actions.
- **Many open files:** the LRU pool and the idle close keep this bounded. Thousands of small wikis are the case to measure.
- **Upgrade time** grows with the number of tenants. Lazy upgrade-on-open bounds the startup cost but means a schema change is "done" only when every file is.
- **Queries an app already has** that span tenants become errors in phase 1. That's the point, but it's work for each app that adopts `tenant`.
- **Is it needed yet?** One SQLite file serves a lot of wikis. Phase 1 alone (the checks) is cheap and shows the real cost; phases 2 and up are worth it when one wiki's size or traffic starts to hurt the others, or when per-wiki backup and export become a feature people ask for.
