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
node lang/cli.ts build apps/tasks/tasks.crud --out <build-dir>
<build-dir>/app --data <data-dir> --assets apps/tasks/assets --port 13810
```

`e2e/flow.mjs` checks, in Chromium:
- three people sign up;
- one creates a project and adds a second;
- the second sees the tasks and finishes one, which is stamped "done by";
- the third, not a member, is sent away.

`e2e/generated.ts` adds a feature with no UI to a copy of the spec: rename a project, move a task, a list of open work. It then:
- uses the generated screens under `/_auto` to move a task;
- checks the move landed;
- checks that someone outside the project is offered none of its tasks.

It starts its own runtime.

`ui/` holds the screens fixture and the accepted structure of every screen:

```
<build-dir>/app --data <dir> --assets apps/tasks/assets --port 13810 --test
node lang/browser/screens.ts apps/tasks/tasks.crud --base http://127.0.0.1:13810 --fixture apps/tasks/ui/fixture.json --out <dir> --baseline apps/tasks/ui/baseline
```

The theme's colours are design tokens in the spec (`tokens json {…}`), used by `assets/tasks.css`.

Building it changed the language in three generic ways:
- theme `classes` replaced the Campfire class names the runtime had kept as defaults;
- a `select` field kind, with a checker rule that a field's kind fits its parameter;
- attributes may follow a wrapped element head.
