#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
node --experimental-vm-modules test/frontend-check.mjs
for test in acceleration smoke release-regression storage-safety domain-rollback cloudflare domain domain-probe frontend-deploy; do
  echo "===== $test ====="
  node "test/$test.mjs"
done
node test/media-lifecycle.cjs
for test in install-cf install-stdin install-update panel permissions; do
  echo "===== $test ====="
  bash "test/$test.sh"
done
if [[ -n "${NUI_JSDOM_MODULE:-}" ]]; then
  for test in user-ui domain-ui acceleration-ui appearance-ui session-ui; do node "test/$test.cjs"; done
fi
if [[ -n "${NUI_CANVAS_MODULE:-}" ]]; then node test/theme-worker.cjs; fi
bash -n install.sh scripts/n-ui.sh scripts/repair-permissions.sh
npm audit

if [[ -n "${NUI_BROWSER_DEPS:-}" ]]; then node test/browser-release.mjs; fi
