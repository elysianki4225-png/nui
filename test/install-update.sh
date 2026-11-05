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
# A normal upgrade must not collapse the independent management origin.
cp "$ROOT/server/domain.js" "$APP_DIR/server/domain.js"
CONF_DIR="$TMP/conf"; CADDY_DIR="$TMP/caddy";mkdir -p "$CONF_DIR" "$CADDY_DIR"
CONF_FILE="$CONF_DIR/config.json";CADDY_FILE="$CADDY_DIR/Caddyfile";CADDY_BIN=/bin/true
CF_CERT_FILE="$CONF_DIR/cf-origin.pem";CF_KEY_FILE="$CONF_DIR/cf-origin.key"
printf cert > "$CF_CERT_FILE";printf key > "$CF_KEY_FILE"
printf cert > "$CONF_DIR/admin-origin.pem";printf key > "$CONF_DIR/admin-origin.key"
printf '{"userHost":"memo.example.com","adminHost":"manage.example.net","adminOrigin":{"cdn":"cloudflare","sslMode":"strict","cfHttpPort":8080,"cfHttpsPort":8443}}' > "$CONF_FILE"
MODE=domain;USER_HOST=memo.example.com;ADMIN_HOST=manage.example.net;SSL_MODE=strict;HAVE_CF_CERT=1;CF_HTTP_PORT=80;CF_HTTPS_PORT=443
write_caddyfile >/dev/null
grep -q 'https://memo.example.com:443' "$CADDY_FILE"
grep -q 'https://manage.example.net:8443' "$CADDY_FILE"
grep -q "tls $CONF_DIR/admin-origin.pem $CONF_DIR/admin-origin.key" "$CADDY_FILE"
echo 'PASS installer reuses independent management ports and certificate paths'
cp "$CADDY_FILE" "$TMP/before-caddy"
CADDY_BIN=/bin/false
if (write_caddyfile >/dev/null 2>&1);then echo 'FAIL invalid Caddyfile accepted';exit 1;fi
cmp "$CADDY_FILE" "$TMP/before-caddy"
echo 'PASS failed installer proxy validation leaves existing Caddyfile untouched'
