# Tasks: a second app in crudspec

A small team task tracker in `tasks.crud`, about 300 lines:
- sign-up and sign-in;
- projects with members;
- tasks with a status and an assignee;
- comments.

A trigger stamps who finished a task and when. An invariant keeps "done" and the finish time
consistent. Read permissions keep a project's tasks to its members.

It runs on the same language and runtime as Campfire (`../../lang/`), with no
app-specific code there, and its own stylesheet (`assets/tasks.css`):

```
node lang/cli.ts check apps/tasks/tasks.crud
node lang/runtime/server.ts apps/tasks/tasks.crud --data <data-dir> --assets apps/tasks/assets --port 13810
```

`e2e/flow.mjs` checks, in Chromium:
- three people sign up;
- one creates a project and adds a second;
- the second sees the tasks and finishes one, which is stamped "done by";
- the third, not a member, is sent away.

Building it changed the language in three generic ways:
- theme `classes` replaced the Campfire class names the runtime had kept as defaults;
- a `select` field kind, with a checker rule that a field's kind fits its parameter;
- attributes may follow a wrapped element head.
