#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [[ $EUID -ne 0 ]]; then exec sudo -n bash "$0" --root; fi
TMP="$(mktemp -d)"; CREATED=0; PID=''
id nui-memo >/dev/null 2>&1 || CREATED=1
cleanup() { [[ -z "$PID" ]] || { kill "$PID" 2>/dev/null || true; wait "$PID" 2>/dev/null || true; }; rm -rf "$TMP"; if [[ $CREATED == 1 ]]; then userdel nui-memo; fi; }
trap cleanup EXIT
chmod 0755 "$TMP"
mkdir -p "$TMP/conf" "$TMP/data"
printf '{"dataDir":"%s","port":8979,"host":"127.0.0.1","userHost":"memo.example.com"}\n' "$TMP/data" > "$TMP/conf/config.json"
chmod 0700 "$TMP/conf"; chmod 0600 "$TMP/conf/config.json"
mkdir -p "$TMP/app"; cp -R "$ROOT/server" "$ROOT/web" "$TMP/app/"
chmod -R a+rX "$TMP/app"
NODE="$(command -v node)"
source "$ROOT/scripts/repair-permissions.sh"
nui_repair_permissions "$TMP/conf/config.json" "$NODE"
runuser -u nui-memo -- test -r "$TMP/conf/config.json"
! runuser -u nobody -- test -r "$TMP/conf/config.json"
[[ "$(stat -c %a "$TMP/conf/config.json")" == 640 ]]
[[ "$(stat -c %a "$TMP/conf")" == 755 ]]
printf origin > "$TMP/conf/origin.key"
chown root:"$(id -gn nobody)" "$TMP/conf/origin.key"; chmod 0640 "$TMP/conf/origin.key"
runuser -u nobody -- test -r "$TMP/conf/origin.key"
echo 'PASS existing root-only config repaired; service can read, unrelated account cannot; separate certificate reader can traverse directory' 
cd "$ROOT"
CONF="$TMP/conf/config.json" "$NODE" --input-type=module -e 'import {mergeConfigFile} from "./server/domain.js";mergeConfigFile(process.env.CONF,{mode:"domain",userHost:"new.example.com",cdn:"none",sslMode:"auto",cfHttpPort:80,cfHttpsPort:443,cfOnly:false});'
[[ "$(stat -c %G "$TMP/conf/config.json")" == nui-memo ]]
runuser -u nui-memo -- test -r "$TMP/conf/config.json"
echo 'PASS privileged domain rewrite preserves config group and service access'
# Reproduce root CLI producing root-owned snapshots, then repair without changing content.
MEMO_CONFIG="$TMP/conf/config.json" NUI_NEW_USER=admin NUI_NEW_PASS=permissions-test-password "$NODE" "$TMP/app/server/cli.js" reset-admin >/dev/null
HASH="$(sha256sum "$TMP/data/snapshot.json" | cut -d' ' -f1)"
nui_repair_permissions "$TMP/conf/config.json" "$NODE"
[[ "$(sha256sum "$TMP/data/snapshot.json" | cut -d' ' -f1)" == "$HASH" ]]
runuser -u nui-memo -- env MEMO_CONFIG="$TMP/conf/config.json" "$NODE" "$TMP/app/server/cli.js" info >/dev/null
echo 'PASS root password-reset snapshots repaired without changing data; service CLI can load/write'
mkdir -p "$TMP/app/scripts" "$TMP/bin"
cp "$ROOT/scripts/repair-permissions.sh" "$TMP/app/scripts/"
printf '#!/bin/sh\nexit 0\n' > "$TMP/bin/systemctl"; chmod 0755 "$TMP/bin/systemctl"
printf '6\nadmin\nchanged-test-password\nchanged-test-password\n\n0\n' | PATH="$TMP/bin:$PATH" NUI_APP_DIR="$TMP/app" NUI_CONF_FILE="$TMP/conf/config.json" NUI_NODE_BIN="$NODE" bash "$ROOT/scripts/n-ui.sh" > "$TMP/panel.log"
grep -q '管理员凭据已更新' "$TMP/panel.log"
[[ "$(stat -c %U "$TMP/data/snapshot.json")" == nui-memo ]]
printf '#!/bin/sh\nexit 1\n' > "$TMP/bin/systemctl"
if PATH="$TMP/bin:$PATH" NUI_APP_DIR="$TMP/app" NUI_CONF_FILE="$TMP/conf/config.json" NUI_NODE_BIN="$NODE" bash "$ROOT/scripts/n-ui.sh" start > /dev/null 2>&1; then echo 'FAIL failed start returned success'; exit 1; fi
echo 'PASS SSH reset runs as service user; failed service start returns nonzero'
runuser -u nui-memo -- env MEMO_CONFIG="$TMP/conf/config.json" MEMO_DEV=1 "$NODE" "$TMP/app/server/index.js" >"$TMP/server.log" 2>&1 & PID=$!
for i in {1..100}; do if curl -fsS http://127.0.0.1:8979/api/health >"$TMP/health" 2>/dev/null; then break; fi; sleep .05; done
grep -q '"ok":true' "$TMP/health" || { cat "$TMP/server.log"; exit 1; }
echo 'PASS real non-root backend starts and answers health after permission repair'
