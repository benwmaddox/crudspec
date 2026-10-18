#!/usr/bin/env bash
# The third app's workspace (app3/PROTOCOL.md): the language and its docs, the Tasks app as an
# example, the brief. No Campfire, no git history.
#   bash app3/make-workspace.sh <run-name> <port>
set -euo pipefail
RUN=$1; PORT=$2
REPO=/mnt/d/code/crudspec
WS=/mnt/d/code/app3-runs/$RUN
test ! -e "$WS" || { echo "workspace exists: $WS"; exit 2; }
mkdir -p "$WS/tools" "$WS/examples" "$WS/assets"
mkdir -p "$WS/lang"; (cd "$REPO/lang" && tar --exclude=node_modules --exclude=browser -cf - .) | (cd "$WS/lang" && tar -xf -)
cp -r "$REPO/apps/tasks" "$WS/examples/tasks"; rm -rf "$WS/examples/tasks/e2e"
cp "$REPO/app3/BRIEF.md" "$WS/BRIEF.md"
cat > "$WS/tools/check.sh" <<EOF
#!/usr/bin/env bash
# Checks desk.crud: names, types, and the deep checks. Errors must be fixed; warnings are advice.
cd "$WS" && node lang/cli.ts check desk.crud --deep
EOF
cat > "$WS/tools/serve.sh" <<EOF
#!/usr/bin/env bash
# Builds desk.crud and serves it on http://127.0.0.1:$PORT with a fresh, empty database, the
# stylesheets in assets/. Stops a previous one first.
set -e
export PATH=\$PATH:/usr/local/go/bin GOFLAGS=-buildvcs=false
fuser -k $PORT/tcp >/dev/null 2>&1 || true
B=\$HOME/app3-ws/$RUN; rm -rf "\$B"; mkdir -p "\$B"
cd "$WS" && node lang/cli.ts build desk.crud --out "\$B/build"
(setsid "\$B/build/app" --data "\$B/data" --assets "$WS/assets" --port $PORT --check-cache > "\$B/server.log" 2>&1 &)
for i in \$(seq 1 100); do curl -fsS -o /dev/null http://127.0.0.1:$PORT/up 2>/dev/null && break; sleep 0.1; done
echo "serving http://127.0.0.1:$PORT (log: \$B/server.log)"
EOF
cat > "$WS/WORKSPACE.md" <<EOF
# Workspace

Build the app described in \`BRIEF.md\` as \`desk.crud\`, in crudspec: a language for apps like
it, in which one file is the whole app (data, rules, actions, screens) and compiles to a program.

- \`lang/LANGUAGE.md\` describes the language (\`lang/README.md\` the tools); \`lang/\` is the compiler.
- \`examples/tasks/\` is a small app written in it (\`tasks.crud\`, its stylesheet in \`assets/\`).
- Stylesheets go in \`assets/\` here.

Run the tools from WSL (\`wsl -e bash $WS/tools/<tool>.sh\` from Windows):
- \`tools/check.sh\`: checks \`desk.crud\`.
- \`tools/serve.sh\`: builds it and serves it at http://127.0.0.1:$PORT on a fresh database. Stop
  it with \`fuser -k $PORT/tcp\`.

Write the app in \`desk.crud\` (and \`assets/\`). Changing \`lang/\` won't reach the built app: if
the language can't express something the brief asks for, say so in your summary.
EOF
chmod +x "$WS/tools/"*.sh
echo "$WS"
