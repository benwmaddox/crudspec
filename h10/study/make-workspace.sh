#!/usr/bin/env bash
# Makes a fresh H10 study run workspace (docs/H10-STUDY-PROTOCOL.md), with no git history.
#   bash h10/study/make-workspace.sh <spec|rails> <run-name> <port> <task: 01…10>
# The task's text is h10/study/tasks/task-<task>.md, frozen; the harness contract (mail, the
# app's address, the clock) is worded the same for both arms.
set -euo pipefail
ARM=$1; RUN=$2; PORT=$3; TASK=$4
REPO=/mnt/d/code/crudspec
WS=/mnt/d/code/h10-study-runs/$RUN
SMTP=$((PORT + 20000))
test ! -e "$WS" || { echo "workspace exists: $WS"; exit 2; }
mkdir -p "$WS/tools"
cp "$REPO/h10/study/tasks/task-$TASK.md" "$WS/TASK.md"

# the same for both arms: a mail server that keeps what it's sent, and the clock
cat > "$WS/tools/mail.sh" <<EOF
#!/usr/bin/env bash
# Shows the mail the app has sent since tools/serve.sh started it (one JSON object a line:
# from, to, data). The harness's mail server is at 127.0.0.1:$SMTP; it keeps everything.
cat /tmp/h10-ws-$RUN-mail.jsonl 2>/dev/null
EOF
CLOCK_CALL=$([ "$ARM" = spec ] && echo "curl -fsS -X POST -d '{\"advance_ms\": '\$1'}' http://127.0.0.1:$PORT/_test/clock" || echo "curl -fsS -X POST -H 'Content-Type: application/json' -d '{\"ms\": '\$1'}' http://127.0.0.1:$PORT/_h10/advance")
cat > "$WS/tools/advance.sh" <<EOF
#!/usr/bin/env bash
# Moves the running app's clock forward by \$1 milliseconds (86400000 is a day), as the harness
# does to test what happens with time; work that comes due must then run (see WORKSPACE.md).
$CLOCK_CALL
echo
EOF
START_SINK="bash $REPO/h10/stop-port.sh $SMTP
(cd $REPO && setsid node lang/test/smtp-sink.ts $SMTP /tmp/h10-ws-$RUN-mail.jsonl >/dev/null 2>&1 </dev/null &)"

CONTRACT="## How the harness runs and tests the app

- **Mail** goes to the harness's mail server over SMTP. Whatever the app sends there is what
  counts; \`tools/mail.sh\` shows it. Links in mail should point at the app's address,
  http://127.0.0.1:$PORT.
- **Time:** to test anything that happens later (\"after 30 days\", \"each morning\"), the harness
  moves the app's clock forward (\`tools/advance.sh <ms>\`), then expects work that has come due to
  be done within a few seconds.
- The browser it uses is in the America/Chicago time zone; the server's is America/New_York."

if [ "$ARM" = spec ]; then
  cp "$REPO/apps/campfire/campfire.crud" "$REPO/apps/campfire/widgets.go" "$WS/"
  mkdir -p "$WS/lang"
  (cd "$REPO/lang" && tar --exclude=node_modules --exclude=browser --exclude=test -cf - .) | (cd "$WS/lang" && tar -xf -)
  cat > "$WS/tools/check.sh" <<EOF
#!/usr/bin/env bash
# Checks the spec: names, types, and the deep checks. Errors must be fixed; warnings are advice.
cd "$WS" && node lang/cli.ts check campfire.crud --deep
EOF
  cat > "$WS/tools/serve.sh" <<EOF
#!/usr/bin/env bash
# Builds the spec into the app and serves it on http://127.0.0.1:$PORT with a fresh, empty
# database (the first visit sets the app up), as the harness does. Stops a previous one first.
set -e
$START_SINK
B=\$HOME/h10-study-ws/$RUN; rm -rf "\$B"; mkdir -p "\$B"
SMTP_PORT=$SMTP bash $REPO/h10/study/spec-serve.sh "$WS/campfire.crud" "\$B/build" "\$B/data" $PORT fresh
echo "log: \$B/data/server.log"
EOF
  cat > "$WS/WORKSPACE.md" <<EOF
# Workspace

Campfire is written in crudspec, a language for apps like it: \`campfire.crud\` is the whole app
(data, rules, actions, screens), and it compiles to a program. The language is described in
\`lang/LANGUAGE.md\` (and \`lang/README.md\`); \`lang/REFERENCE.md\` lists every element, attribute
and function; \`lang/\` is the compiler and its tools. \`widgets.go\` holds a few small UI pieces
the spec declares; Go functions the spec binds to go in \`ext.go\` beside it (LANGUAGE.md, "Go
bindings").

The task is in \`TASK.md\`.

Run the tools from WSL (\`wsl -e bash $WS/tools/<tool>.sh\` from Windows):
- \`tools/check.sh\`: checks the spec.
- \`tools/serve.sh\`: builds the app and serves it at http://127.0.0.1:$PORT on a fresh database,
  with the harness's mail server. The first visit sets up an account and its first user.
- \`tools/mail.sh\`: the mail the app has sent. \`tools/advance.sh <ms>\`: moves its clock.

When the change is deployed, the running installation's database is upgraded from the spec:
\`node lang/cli.ts plan campfire.crud --data <dir>\` shows what an upgrade would do. Make the
change in \`campfire.crud\` (and \`widgets.go\` or \`ext.go\` if it must); changing \`lang/\` won't
reach the deployed app.

$CONTRACT
  In this app, the harness's clock is the runtime's test clock: what a \`schedule\` makes due runs
  when it moves.
EOF
else
  cp -a "$HOME/linuxbench/rails/app" "$WS/app"
  rm -rf "$WS/app/storage" "$WS/app/log/"* "$WS/app/tmp/"* 2>/dev/null || true
  cp "$REPO/h10/study/rails/h10_harness.rb" "$WS/app/config/initializers/h10_harness.rb"
  cat > "$WS/tools/serve.sh" <<EOF
#!/usr/bin/env bash
# Serves the app on http://127.0.0.1:$PORT with a fresh database loaded from db/schema.rb (the
# first visit sets the app up), with Redis, a Resque worker and the harness's mail server, as the
# harness does. Stops a previous one first.
$START_SINK
D=\$HOME/h10-study-ws/$RUN; rm -rf "\$D"; mkdir -p "\$D"
bash $REPO/h10/stop-port.sh $PORT
SMTP_PORT=$SMTP bash $REPO/h10/study/rails-serve.sh "$WS/app" "\$D/data" $PORT fresh
echo "logs: \$D/data/logs/"
EOF
  cat > "$WS/tools/rails.sh" <<EOF
#!/usr/bin/env bash
# Runs a Rails command in the app (production environment, the scratch database of the last
# serve.sh), e.g. tools/rails.sh db:migrate, tools/rails.sh db:schema:dump, tools/rails.sh runner '...'
L=\$HOME/linuxbench; D=\$HOME/h10-study-ws/$RUN/data
cd "$WS/app"
exec env -i LANG=C.UTF-8 HOME=\$HOME USER=\$USER RAILS_ENV=production DISABLE_SSL=1 SECRET_KEY_BASE=\$(cat \$D/secret_key_base 2>/dev/null || echo x) \\
  PATH=\$L/rails/bundle/bin:\$L/ruby-3.4.10/bin:/usr/bin:/bin GEM_HOME=\$L/rails/bundle BUNDLE_APP_CONFIG=\$L/rails/bundle \\
  BUNDLE_PATH=\$L/rails/bundle BUNDLE_DEPLOYMENT=1 BUNDLE_WITHOUT=development BUNDLE_SILENCE_ROOT_WARNING=1 \\
  REDIS_URL=redis://127.0.0.1:$((PORT + 10000)) H10_CLOCK_FILE=\$D/h10_clock SMTP_ADDRESS=127.0.0.1 SMTP_PORT=$SMTP APP_URL=http://127.0.0.1:$PORT bin/rails "\$@"
EOF
  cat > "$WS/WORKSPACE.md" <<EOF
# Workspace

\`app/\` is Campfire, a Rails 8 app (Ruby 3.4, SQLite). It runs in production mode from WSL;
the gems are installed for it, without the development group. Jobs run with Resque.

The task is in \`TASK.md\`.

Run the tools from WSL (\`wsl -e bash $WS/tools/<tool>.sh\` from Windows):
- \`tools/serve.sh\`: serves the app at http://127.0.0.1:$PORT on a fresh database loaded from
  \`db/schema.rb\`, with Redis, a Resque worker and the harness's mail server. The first visit sets
  up an account and its first user.
- \`tools/rails.sh <command>\`: runs \`bin/rails <command>\` against that scratch database.
- \`tools/mail.sh\`: the mail the app has sent. \`tools/advance.sh <ms>\`: moves its clock.

When the change is deployed, the running installation's database is upgraded with
\`bin/rails db:migrate\`, and a new installation is loaded from \`db/schema.rb\`: keep both in step.

$CONTRACT
  In this app, \`config/initializers/h10_harness.rb\` (the harness's, don't change it) configures
  Action Mailer for that mail server and makes the clock movable: register time-based work with
  \`H10.on_tick { |now| … }\`; it runs whenever the clock moves (there's no recurring-job scheduler).
EOF
fi
chmod +x "$WS/tools/"*.sh
echo "$WS"
