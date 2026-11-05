#!/usr/bin/env bash
# 验证 SSH 管理面板 n-ui：大小写别名安装/移除、脚本语法、CLI 重置管理员密码。
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck disable=SC1091
source "$ROOT/install.sh"   # 仅加载函数

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
PANEL_BIN_DIR="$TMP/bin"; APP_DIR="$TMP/app"
mkdir -p "$PANEL_BIN_DIR" "$APP_DIR/scripts" "$APP_DIR/server"
cp "$ROOT/scripts/n-ui.sh" "$APP_DIR/scripts/n-ui.sh"
cp "$ROOT/server/util.js" "$APP_DIR/server/util.js"

fail=0
assert() { if eval "$2"; then echo "  ok: $1"; else echo "  FAIL: $1"; fail=1; fi; }

echo "[1] 面板脚本语法"
assert "n-ui.sh bash -n" "bash -n '$APP_DIR/scripts/n-ui.sh'"

echo "[2] 安装面板 + 大小写别名"
install_panel >/dev/null
assert "n-ui 可执行" "[[ -x '$PANEL_BIN_DIR/n-ui' ]]"
for name in n-ui n-Ui n-uI n-UI N-ui N-Ui N-uI N-UI; do
  assert "别名 $name 存在" "[[ -e '$PANEL_BIN_DIR/$name' ]]"
done
assert "N-UI 指向 n-ui" "[[ \$(readlink -f '$PANEL_BIN_DIR/N-UI') == \$(readlink -f '$PANEL_BIN_DIR/n-ui') ]]"

echo "[3] 非交互 status（stub systemctl）"
mkdir -p "$TMP/stub"
printf '#!/usr/bin/env bash\nexit 0\n' > "$TMP/stub/systemctl"; chmod +x "$TMP/stub/systemctl"
cat > "$TMP/config.json" <<EOF
{"dataDir":"$TMP/data","mode":"domain","userHost":"m.example.com","adminHost":"","cdn":"none"}
EOF
out="$(PATH="$TMP/stub:$PATH" NUI_ALLOW_NON_ROOT=1 NUI_APP_DIR="$APP_DIR" NUI_CONF_FILE="$TMP/config.json" NUI_NODE_BIN="$(command -v node)" bash "$APP_DIR/scripts/n-ui.sh" status 2>&1)"
assert "status 显示用户域名" "grep -q 'm.example.com' <<< \"\$out\""
assert "status 显示运行中" "grep -q '运行中' <<< \"\$out\""

echo "[4] 移除面板别名"
remove_panel
assert "n-ui 已移除" "[[ ! -e '$PANEL_BIN_DIR/n-ui' ]]"
assert "N-UI 已移除" "[[ ! -e '$PANEL_BIN_DIR/N-UI' ]]"

echo "[5] CLI 重置管理员密码（含会话失效）"
mkdir -p "$TMP/data"
cat > "$TMP/data/snapshot.json" <<EOF
{"version":1,"admin":{"username":"old","passHash":"x","createdAt":1},"users":{},"memos":{},"sessions":{"h1":{"kind":"admin","expiresAt":9999999999},"h2":{"kind":"user","account":"1","expiresAt":9999999999}},"ipBans":{},"bots":[],"settings":{},"audit":[],"stats":{}}
EOF
cat > "$TMP/cli-test.mjs" <<EOF
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { verifySecret } from '$ROOT/server/security.js';
const env = { ...process.env, MEMO_CONFIG: '$TMP/config.json', NUI_NEW_PASS: 'NewPass12345', NUI_NEW_USER: 'newadmin' };
const r = spawnSync(process.execPath, ['$ROOT/server/cli.js', 'reset-admin'], { env, encoding: 'utf8' });
if (r.status !== 0) { console.error('cli failed', r.stderr); process.exit(1); }
const snap = JSON.parse(fs.readFileSync('$TMP/data/snapshot.json', 'utf8'));
const okUser = snap.admin.username === 'newadmin';
const okHash = verifySecret('NewPass12345', snap.admin.passHash);
const okSess = !snap.sessions.h1 && !!snap.sessions.h2;
console.log((okUser && okHash && okSess) ? 'CLI_OK' : 'CLI_BAD ' + JSON.stringify({ okUser, okHash, okSess }));
EOF
cli_out="$(node "$TMP/cli-test.mjs" 2>&1)"
assert "CLI 重置密码/用户名/会话失效" "grep -q 'CLI_OK' <<< \"\$cli_out\""

echo
if [[ $fail -eq 0 ]]; then echo "panel: 全部通过"; else echo "panel: 有失败"; exit 1; fi
