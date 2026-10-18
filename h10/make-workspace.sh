#!/usr/bin/env bash
# Makes a fresh H10 run workspace (docs/H10-PROTOCOL.md), with no git history.
#   bash h10/make-workspace.sh <spec|rails> <run-name> <port>
set -euo pipefail
ARM=$1; RUN=$2; PORT=$3
REPO=/mnt/d/code/crudspec
WS=/mnt/d/code/h10-runs/$RUN
test ! -e "$WS" || { echo "workspace exists: $WS"; exit 2; }
mkdir -p "$WS/tools"
if [ "$ARM" = spec ]; then
  cp "$REPO/apps/campfire/campfire.crud" "$REPO/apps/campfire/widgets.go" "$WS/"
  mkdir -p "$WS/lang"
  (cd "$REPO/lang" && tar --exclude=node_modules --exclude=browser -cf - .) | (cd "$WS/lang" && tar -xf -)
  cat > "$WS/tools/check.sh" <<EOF
#!/usr/bin/env bash
# Checks the spec: names, types, and the deep checks. Errors must be fixed; warnings are advice.
cd "$WS" && node lang/cli.ts check campfire.crud --deep
EOF
  cat > "$WS/tools/serve.sh" <<EOF
#!/usr/bin/env bash
# Builds the spec into the app and serves it on http://127.0.0.1:$PORT with a fresh, empty
# database (the first visit sets the app up). Stops a previous one first.
set -e
export PATH=\$PATH:/usr/local/go/bin GOFLAGS=-buildvcs=false
fuser -k $PORT/tcp >/dev/null 2>&1 || true
B=\$HOME/h10-ws/$RUN; rm -rf "\$B"; mkdir -p "\$B"
cd "$WS" && node lang/cli.ts build campfire.crud --out "\$B/build"
(TZ=America/New_York setsid "\$B/build/app" --data "\$B/data" --assets /mnt/d/code/crudspec-assets/campfire --port $PORT > "\$B/server.log" 2>&1 &)
for i in \$(seq 1 100); do curl -fsS -o /dev/null http://127.0.0.1:$PORT/up 2>/dev/null && break; sleep 0.1; done
echo "serving http://127.0.0.1:$PORT (log: \$B/server.log)"
EOF
  cat > "$WS/WORKSPACE.md" <<EOF
# Workspace

Campfire is written in crudspec, a language for apps like it: \`campfire.crud\` is the whole app
(data, rules, actions, screens), and it compiles to a program. The language is described in
\`lang/LANGUAGE.md\` (and \`lang/README.md\`); \`lang/\` is the compiler and its tools.
\`widgets.go\` holds a few small UI pieces the spec declares.

Run the tools from WSL (\`wsl -e bash $WS/tools/<tool>.sh\` from Windows):
- \`tools/check.sh\`: checks the spec.
- \`tools/serve.sh\`: builds the app and serves it at http://127.0.0.1:$PORT on a fresh database.
  The first visit sets up an account and its first user. Stop it with \`fuser -k $PORT/tcp\`.

When the change is deployed, the running installation's database is upgraded from the spec:
\`node lang/cli.ts plan campfire.crud --data <dir>\` shows what an upgrade would do. Make the
change in the spec; changing \`lang/\` won't reach the deployed app.
EOF
else
  cp -a "$HOME/linuxbench/rails/app" "$WS/app"
  rm -rf "$WS/app/storage" "$WS/app/log/"* "$WS/app/tmp/"* 2>/dev/null || true
  cat > "$WS/tools/serve.sh" <<EOF
#!/usr/bin/env bash
# Serves the app on http://127.0.0.1:$PORT with a fresh database loaded from db/schema.rb (the
# first visit sets the app up). Stops a previous one first.
fuser -k $PORT/tcp >/dev/null 2>&1 || true
D=\$HOME/h10-ws/$RUN; rm -rf "\$D"; mkdir -p "\$D"
bash /mnt/d/code/crudspec/h10/rails-serve.sh "$WS/app" "\$D/data" $PORT fresh
echo "log: \$D/data/logs/server.log"
EOF
  cat > "$WS/tools/rails.sh" <<EOF
#!/usr/bin/env bash
# Runs a Rails command in the app (production environment, the scratch database of the last
# serve.sh), e.g. tools/rails.sh db:migrate, tools/rails.sh db:schema:dump, tools/rails.sh runner '...'
L=\$HOME/linuxbench; D=\$HOME/h10-ws/$RUN/data
cd "$WS/app"
exec env -i LANG=C.UTF-8 HOME=\$HOME USER=\$USER RAILS_ENV=production DISABLE_SSL=1 SECRET_KEY_BASE=\$(cat \$D/secret_key_base 2>/dev/null || echo x) \\
  PATH=\$L/rails/bundle/bin:\$L/ruby-3.4.10/bin:/usr/bin:/bin GEM_HOME=\$L/rails/bundle BUNDLE_APP_CONFIG=\$L/rails/bundle \\
  BUNDLE_PATH=\$L/rails/bundle BUNDLE_DEPLOYMENT=1 BUNDLE_WITHOUT=development BUNDLE_SILENCE_ROOT_WARNING=1 bin/rails "\$@"
EOF
  cat > "$WS/WORKSPACE.md" <<EOF
# Workspace

\`app/\` is Campfire, a Rails 8 app (Ruby 3.4, SQLite). It runs in production mode from WSL;
the gems are installed for it, without the development group.

Run the tools from WSL (\`wsl -e bash $WS/tools/<tool>.sh\` from Windows):
- \`tools/serve.sh\`: serves the app at http://127.0.0.1:$PORT on a fresh database loaded from
  \`db/schema.rb\`. The first visit sets up an account and its first user. Stop it with
  \`fuser -k $PORT/tcp\`.
- \`tools/rails.sh <command>\`: runs \`bin/rails <command>\` against that scratch database.

When the change is deployed, the running installation's database is upgraded with
\`bin/rails db:migrate\`, and a new installation is loaded from \`db/schema.rb\`: keep both in step.
EOF
fi
chmod +x "$WS/tools/"*.sh
echo "$WS"
