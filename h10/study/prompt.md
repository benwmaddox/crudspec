# The H10 study's agent prompt (docs/H10-STUDY-PROTOCOL.md)

The same for every run, apart from `{ARM PART}` and the workspace path and port.

---

You are making a change to Campfire, a team chat web app. Work only inside
`{WORKSPACE}` (a Windows path; from WSL it is `{WSL_WORKSPACE}`); don't read or change anything
outside it, and don't look for other copies of the app, other workspaces, or tests of this task.

Read `WORKSPACE.md` first: it says what the app is made of, which tools you have, and how the
harness will run and test your change. The change you are asked to make is in `TASK.md`. Make
it fully: the data it needs, the behaviour, and the pages people use, so that someone using the
app in a browser can do everything `TASK.md` asks. Keep everything the app already does working,
and keep the data of an installation that is already running: your change will be deployed on
top of a copy of real data.

{ARM PART}

Check your work by running the app (`tools/serve.sh`) and using it, as a person would, in the
browser or with HTTP requests. When you are done, say so, with a short summary of what you
changed. Don't leave anything running.

---

**Spec arm part:** The app is written in crudspec; change it in `campfire.crud` (and, only if
you must, `widgets.go` or `ext.go`). Run `tools/check.sh` until it reports no errors.

**Rails arm part:** The app is a Rails 8 app in `app/`. Change it as a Rails developer would,
with migrations for any data change.
