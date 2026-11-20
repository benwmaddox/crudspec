# TodoMVC in crudspec

[TodoMVC](https://todomvc.com/app-spec) rendered on the server: every change is a form post,
every filter and edit a page, the list in SQLite. Each browser has its own list (a cookie), as
the reference implementations do with local storage.

| File | Lines (non-blank) | |
| --- | --- | --- |
| `todomvc.crud` | 153 | data, rules, actions, the page, and its browser behaviors (double-click to edit, Escape to cancel, focus): no script of its own |
| `assets/todomvc.css` | 46 | TodoMVC's look for this markup (the reference CSS expects checkboxes and list items) |
| `e2e.mjs` | | the app spec's behaviours in a browser: 27 checks |

```
node lang/cli.ts build apps/todomvc/todomvc.crud --out <dir>
<dir>/app --data <data> --assets apps/todomvc/assets --port 4301
node apps/todomvc/e2e.mjs http://127.0.0.1:4301
```

**Proven:** no todo has a blank title (`invariant titles_not_blank`), for every action: adding needs a title, and an edit that blanks one removes the todo. The build proves it. A change that lets a blank title in is reported as unproven, with the run that does it (the prover treats `trim` as unknown, so it can't call the run certain), and the build then checks the rule as the app runs.

**Agents:** a browser issues a token for its list at `/_agents` (linked in the footer); the
agent then calls `add`, `toggle`, `toggle_all`, `rename`, `destroy`, `clear_completed` and
`todos(show)` over JSON (`/_agent/call/<name>`) or MCP (`/_mcp`), and deletes need a confirm.
`add_todo`, which makes a browser's list, stays with people. `tests.crud` covers every outcome.

Differences from the app spec: filters are `/?show=active` and `/?show=completed`, not
`#/active`; the new-todo field isn't focused on load; and every action reloads the page (the
live script refreshes only what changed when the data changes elsewhere).
