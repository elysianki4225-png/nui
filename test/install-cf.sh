#!/usr/bin/env bash
# 验证 install.sh 生成的配置 / Caddyfile（含 Cloudflare 模式），无需 root。
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck disable=SC1091
source "$ROOT/install.sh"   # 仅加载函数（不会执行 main）

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
# 覆盖为临时路径，避免触碰系统目录
CONF_DIR="$TMP/etc"; CADDY_DIR="$TMP/caddy"; DATA_DIR="$TMP/data"; APP_DIR="$TMP/app"
CONF_FILE="$CONF_DIR/config.json"; CADDY_FILE="$CADDY_DIR/Caddyfile"
CF_CERT_FILE="$CONF_DIR/cf-origin.pem"; CF_KEY_FILE="$CONF_DIR/cf-origin.key"
CADDY_BIN="/bin/true"; BACKEND_PORT=8787
mkdir -p "$CONF_DIR" "$CADDY_DIR" "$DATA_DIR" "$APP_DIR/node/bin" "$APP_DIR/server"
ln -sf "$(command -v node)" "$APP_DIR/node/bin/node"
cp "$ROOT/server/domain.js" "$APP_DIR/server/domain.js"
# 屏蔽需要 root 的系统操作
id() { return 1; }
useradd() { :; }
chown() { :; }
chgrp() { :; }

fail=0
assert() { if eval "$2"; then echo "  ok: $1"; else echo "  FAIL: $1"; fail=1; fi; }

echo "[1] Cloudflare Full/Strict + Flexible（自定义回源端口）"
CLOUDFLARE=1; CF_EXPLICIT=1; MODE=domain; USER_HOST="m.example.com"; ADMIN_HOST=""
HAVE_CF_CERT=1; CF_HTTP_PORT=8080; CF_HTTPS_PORT=8443
write_config >/dev/null
write_caddyfile >/dev/null
assert "config.cloudflare=true" "grep -q '\"cloudflare\": true' '$CONF_FILE'"
assert "config.cfHttpPort=8080" "grep -q '\"cfHttpPort\": 8080' '$CONF_FILE'"
assert "config.cfHttpsPort=8443" "grep -q '\"cfHttpsPort\": 8443' '$CONF_FILE'"
assert "caddy auto_https off" "grep -q 'auto_https off' '$CADDY_FILE'"
assert "caddy http origin :8080" "grep -q 'http://m.example.com:8080' '$CADDY_FILE'"
assert "caddy https origin :8443" "grep -q 'https://m.example.com:8443' '$CADDY_FILE'"
assert "caddy tls origin cert" "grep -q 'tls $CF_CERT_FILE $CF_KEY_FILE' '$CADDY_FILE'"
assert "caddy no forced HSTS" "! grep -q 'Strict-Transport-Security' '$CADDY_FILE'"

echo "[2] Cloudflare 仅 Flexible（无证书）"
HAVE_CF_CERT=0
write_caddyfile >/dev/null
assert "caddy http origin present" "grep -q 'http://m.example.com:8080' '$CADDY_FILE'"
assert "caddy https origin absent" "! grep -q 'https://m.example.com:8443' '$CADDY_FILE'"

echo "[3] 升级复用 CF 配置"
CLOUDFLARE=0; CF_EXPLICIT=0; CF_HTTP_PORT=""; CF_HTTPS_PORT=""
resolve_cf_defaults
assert "reuse cloudflare=1" "[[ \$CLOUDFLARE -eq 1 ]]"
assert "reuse http port 8080" "[[ \$CF_HTTP_PORT == 8080 ]]"
assert "reuse https port 8443" "[[ \$CF_HTTPS_PORT == 8443 ]]"

echo "[4] 非 CF 自定义域名（Let's Encrypt）"
CLOUDFLARE=0; CF_EXPLICIT=1; MODE=domain; USER_HOST="direct.example.com"; HAVE_CF_CERT=0
write_config >/dev/null
write_caddyfile >/dev/null
assert "config.cloudflare=false" "grep -q '\"cloudflare\": false' '$CONF_FILE'"
assert "caddy no auto_https off" "! grep -q 'auto_https off' '$CADDY_FILE'"
assert "caddy site direct.example.com" "grep -q 'direct.example.com {' '$CADDY_FILE'"
assert "caddy HSTS present" "grep -q 'Strict-Transport-Security' '$CADDY_FILE'"

echo
if [[ $fail -eq 0 ]]; then echo "install-cf: 全部通过"; else echo "install-cf: 有失败"; exit 1; fi
