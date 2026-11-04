#!/usr/bin/env bash
# 回归：curl ... | bash（stdin 执行）不得因 set -u 报 BASH_SOURCE unbound variable。
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fail=0

# 1) stdin 执行（模拟 curl | bash）。非 root 时应在 root 检查处退出，而非 unbound variable。
out="$(bash < "$ROOT/install.sh" 2>&1)"
if grep -q "unbound variable" <<< "$out"; then
  echo "FAIL: stdin 执行出现 unbound variable"; fail=1
else
  echo "ok: stdin 执行无 unbound variable"
fi
if grep -qE "请以 root 运行|一键部署" <<< "$out"; then
  echo "ok: stdin 执行正常进入 main"
else
  echo "FAIL: stdin 执行未进入 main"; fail=1
fi

# 2) stdin + --help 应打印用法
out="$(bash -s -- --help < "$ROOT/install.sh" 2>&1)"
if grep -q "一键部署脚本" <<< "$out"; then echo "ok: stdin --help 正常"; else echo "FAIL: stdin --help"; fail=1; fi

# 3) 直接执行文件 --help 正常
out="$(bash "$ROOT/install.sh" --help 2>&1)"
if grep -q "一键部署脚本" <<< "$out"; then echo "ok: 文件 --help 正常"; else echo "FAIL: 文件 --help"; fail=1; fi

# 4) source 不执行 main（不应出现 root 检查/部署横幅）
out="$(bash -c "source '$ROOT/install.sh'" 2>&1)"
if grep -qE "请以 root 运行|一键部署" <<< "$out"; then
  echo "FAIL: source 误执行 main"; fail=1
else
  echo "ok: source 不执行 main"
fi

echo
if [[ $fail -eq 0 ]]; then echo "install-stdin: 全部通过"; else echo "install-stdin: 有失败"; exit 1; fi
