#!/usr/bin/env bash
# Runs the domain oracle in a fresh copy of the native Rails app (ONCE Campfire 90b3300)
# against a freshly schema-loaded SQLite database, then copies the golden files back.
#
#   wsl -d Ubuntu -u root -- bash /mnt/d/code/crudspec/oracle/rails/run.sh <run-name> <scenario-dir>
#
# Needs the native Rails install at ~ben/linuxbench (set up during AgentLang's Linux work).
# Secrets are generated per run and never written to the repository.
set -euo pipefail
RUN=$1
SCEN=$2
U=ben; UH=/home/$U; L=$UH/linuxbench
REPO=/mnt/d/code/crudspec
W=$L/crudspec-runs/$RUN
OUT=$REPO/oracle/golden/$RUN
test ! -e "$W" || { echo "run $RUN exists"; exit 2; }
asu() { setpriv --reuid=$U --regid=$U --init-groups "$@"; }

asu mkdir -p "$W"
asu cp -a "$L/rails/app" "$W/app"
ROOT=$W/app
asu rm -rf "$ROOT/storage"; asu mkdir -p "$ROOT/storage/db" "$ROOT/storage/logs" "$ROOT/storage/files"
asu cp "$REPO/oracle/rails/oracle.rb" "$W/oracle.rb"
asu mkdir -p "$W/scenarios" "$W/out"
asu cp "$REPO/$SCEN"/*.json "$W/scenarios/"

SECRET=$(head -c 64 /dev/urandom | od -An -tx1 | tr -d ' \n')
ENVV=(LANG=C.UTF-8 HOME=$UH USER=$U RAILS_ENV=production DISABLE_SSL=1 SECRET_KEY_BASE=$SECRET
      PATH=$L/rails/bundle/bin:$L/ruby-3.4.10/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
      GEM_HOME=$L/rails/bundle BUNDLE_APP_CONFIG=$L/rails/bundle BUNDLE_SILENCE_ROOT_WARNING=1 BUNDLE_DEPLOYMENT=1
      BUNDLE_PATH=$L/rails/bundle BUNDLE_WITHOUT=development APP_VERSION=crudspec-oracle
      GIT_REVISION=90b330024dec3e757c79b6a7e6568f93da8e3148 RAILS_LOG_LEVEL=warn)

cd "$ROOT"
asu env -i "${ENVV[@]}" bin/rails db:schema:load >/dev/null
asu env -i "${ENVV[@]}" ORACLE_OUT="$W/out" bin/rails runner "$W/oracle.rb" "$W"/scenarios/*.json
mkdir -p "$OUT"
cp "$W"/out/*.json "$OUT/"
echo "golden files: oracle/golden/$RUN ($(ls "$OUT" | wc -l))"
