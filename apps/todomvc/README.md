# TodoMVC in crudspec

[TodoMVC](https://todomvc.com/app-spec) rendered on the server: every change is a form post,
every filter and edit a page, the list in SQLite. Each browser has its own list (a cookie), as
the reference implementations do with local storage.

| File | Lines (non-blank) | |
| --- | --- | --- |
| `todomvc.crud` | 136 | data, rules, actions, the page |
| `widgets.go` | 21 | double-click to edit, Escape to cancel, focus: the only script |
| `assets/todomvc.css` | 46 | TodoMVC's look for this markup (the reference CSS expects checkboxes and list items) |
| `e2e.mjs` | | the app spec's behaviours in a browser: 27 checks |

```
node lang/cli.ts build apps/todomvc/todomvc.crud --out <dir>
<dir>/app --data <data> --assets apps/todomvc/assets --port 4301
node apps/todomvc/e2e.mjs http://127.0.0.1:4301
```

Differences from the app spec: filters are `/?show=active` and `/?show=completed`, not
`#/active`; the new-todo field isn't focused on load; and every action reloads the page (the
live script refreshes only what changed when the data changes elsewhere).
