#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/app/server" "$TMP/app/web" "$TMP/app/scripts" "$TMP/new/nui-release/server" "$TMP/new/nui-release/web" "$TMP/new/nui-release/scripts"
printf old > "$TMP/app/server/index.js"
printf old > "$TMP/app/web/index.html"
printf old > "$TMP/app/scripts/n-ui.sh"
printf new > "$TMP/new/nui-release/server/index.js"
printf new > "$TMP/new/nui-release/web/index.html"
printf new > "$TMP/new/nui-release/scripts/n-ui.sh"
cp "$ROOT/install.sh" "$TMP/new/nui-release/install.sh"
tar -czf "$TMP/release.tar.gz" -C "$TMP/new" nui-release
cp "$ROOT/install.sh" "$TMP/app/install.sh"
# Source from the installed path to reproduce n-ui -> /opt/.../install.sh --update.
source "$TMP/app/install.sh"
APP_DIR="$TMP/app"; DO_UPDATE=1
curl() { local dest=''; while [[ $# -gt 0 ]]; do if [[ "$1" == '-o' ]]; then dest="$2";shift 2;else shift;fi;done; cp "$TMP/release.tar.gz" "$dest"; }
fetch_app >/dev/null
[[ "$(cat "$APP_DIR/server/index.js")" == new ]]
[[ "$(cat "$APP_DIR/server.old/index.js")" == old ]]
[[ "$(cat "$APP_DIR/scripts/n-ui.sh")" == new ]]
[[ ! -e "$APP_DIR/scripts/scripts" ]]
echo 'PASS installed-directory update downloads new release, stages files, preserves rollback copy, updates scripts without nesting'
mkdir -p "$APP_DIR/node/bin"; ln -s "$(command -v node)" "$APP_DIR/node/bin/node"
CONF_FILE="$TMP/config.json"; CF_CERT_FILE="$TMP/origin.pem"; CF_KEY_FILE="$TMP/origin.key"
printf cert > "$CF_CERT_FILE"; printf key > "$CF_KEY_FILE"
printf '{"cdn":"cloudflare","sslMode":"strict"}' > "$CONF_FILE"
CLOUDFLARE=1; CF_CERT=''; CF_KEY=''; CF_API_TOKEN=''; CF_HTTP_PORT=80; CF_HTTPS_PORT=443
setup_cloudflare_cert >/dev/null
[[ "$HAVE_CF_CERT" == 1 ]]
[[ "$(cat "$CF_CERT_FILE")" == cert && "$(cat "$CF_KEY_FILE")" == key ]]
grep -q 'strict' "$CONF_FILE"
echo 'PASS existing Origin CA certificate/key and Strict mode survive reuse'
