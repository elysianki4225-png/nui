#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)";trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/units" "$TMP/libexec" "$TMP/conf" "$TMP/app/scripts"
# Redirect all system paths; never install units or restart anything on the test host.
sed "s|/etc/systemd/system|$TMP/units|g;s|/usr/local/libexec|$TMP/libexec|g" "$ROOT/install.sh" > "$TMP/installer.sh"
source "$TMP/installer.sh"
APP_DIR="$TMP/app";CONF_DIR="$TMP/conf";DATA_DIR="$TMP/data";SERVICE=nui-memo
cp "$ROOT/scripts/maintenance-helper.mjs" "$APP_DIR/scripts/maintenance-helper.mjs"
install(){ cp "${@: -2:1}" "${@: -1}"; }
chown(){ :; }
systemctl(){ echo "$*" >> "$TMP/commands"; }
write_maintenance
cmp "$APP_DIR/scripts/maintenance-helper.mjs" "$TMP/libexec/nui-maintenance.mjs"
grep -q 'User=root' "$TMP/units/nui-memo-maintenance.service"
grep -q "ExecStart=$APP_DIR/node/bin/node $TMP/libexec/nui-maintenance.mjs" "$TMP/units/nui-memo-maintenance.service"
grep -q "PathChanged=$DATA_DIR/maintenance-request.json" "$TMP/units/nui-memo-maintenance.path"
grep -q '^restart nui-memo-maintenance.path$' "$TMP/commands"
[[ "$(cat "$CONF_DIR/maintenance-enabled")" == enabled ]]
[[ "$(stat -c %a "$CONF_DIR/maintenance-enabled")" == 644 ]]
! grep -q 'sudo' "$TMP/units/nui-memo-maintenance.service"
echo 'PASS maintenance installer: fixed root helper/path trigger, marker permissions and no generic shell/sudo grant (isolated filesystem and command stubs)'
