#!/usr/bin/env bash
# ============================================================
#  备忘录 (nui-memo) SSH 管理面板
#  命令: n-ui （大小写混写均可，如 N-UI / n-Ui / N-uI，安装时已建别名）
#  数字选择菜单: 状态 / 启动 / 停止 / 重启 / 日志 / 改管理密码 /
#              保留数据卸载 / 完整卸载 / 更新
# ============================================================
set -uo pipefail

APP_DIR="${NUI_APP_DIR:-/opt/nui-memo}"
CONF_FILE="${NUI_CONF_FILE:-/etc/nui-memo/config.json}"
SERVICE="${NUI_SERVICE:-nui-memo}"
NODE_BIN="${NUI_NODE_BIN:-$APP_DIR/node/bin/node}"
DATA_DIR_DEFAULT="/var/lib/nui-memo"

if [[ -t 1 ]]; then
  R=$'\033[0m'; B=$'\033[1m'; D=$'\033[2m'
  RED=$'\033[31m'; GRN=$'\033[32m'; YEL=$'\033[33m'; CYN=$'\033[36m'
else
  R=""; B=""; D=""; RED=""; GRN=""; YEL=""; CYN=""
fi
say()  { echo "$*"; }
ok()   { echo "${GRN}[ OK ]${R} $*"; }
warn() { echo "${YEL}[WARN]${R} $*"; }
err()  { echo "${RED}[FAIL]${R} $*" >&2; }

need_root() {
  if [[ $EUID -ne 0 && "${NUI_ALLOW_NON_ROOT:-0}" != "1" ]]; then
    err "该操作需要 root 权限，请使用: sudo n-ui"
    return 1
  fi
  return 0
}

cfg_get() {
  [[ -x "$NODE_BIN" && -f "$CONF_FILE" ]] || return 0
  "$NODE_BIN" -e 'try{const c=require(process.argv[1]);console.log(c[process.argv[2]]??"")}catch(e){}' "$CONF_FILE" "$1" 2>/dev/null
}

svc() { systemctl "$1" "$SERVICE" 2>/dev/null; }
is_active() { systemctl is-active --quiet "$SERVICE" 2>/dev/null && echo "运行中" || echo "已停止"; }

pause() { echo; read -r -p "按回车返回菜单…" _ || true; }

do_status() {
  say "${B}== 服务状态 ==${R}"
  say "  后端 ($SERVICE): $(is_active)"
  say "  Caddy:          $(systemctl is-active --quiet caddy 2>/dev/null && echo 运行中 || echo 已停止)"
  local ver; ver="$(grep -oE "VERSION = '[0-9.]+'" "$APP_DIR/server/util.js" 2>/dev/null | grep -oE '[0-9.]+')"
  say "  版本:           ${ver:-未知}"
  say "  用户域名:       $(cfg_get userHost)"
  say "  管理域名:       $(cfg_get adminHost)"
  say "  模式:           $(cfg_get mode)  CDN: $(cfg_get cdn)"
  say "  数据目录:       $(cfg_get dataDir)"
  [[ -n "${ver:-}" ]] || true
}

do_start()  { need_root || return; svc start  && ok "已启动 $SERVICE" || err "启动失败"; }
do_stop()   { need_root || return; svc stop   && ok "已停止 $SERVICE" || err "停止失败"; }
do_restart(){ need_root || return; svc restart && ok "已重启 $SERVICE" || err "重启失败"; }

do_logs() {
  say "${D}显示最近 50 行日志（Ctrl+C 退出实时模式）${R}"
  if [[ "${1:-}" == "follow" ]]; then journalctl -u "$SERVICE" -f --no-pager 2>/dev/null || true
  else journalctl -u "$SERVICE" -n 50 --no-pager 2>/dev/null || err "无法读取日志"; fi
}

do_reset() {
  need_root || return
  [[ -x "$NODE_BIN" ]] || { err "未找到 Node: $NODE_BIN"; return; }
  local user pass pass2
  say "${B}== 修改管理员账号 / 密码 ==${R}"
  read -r -p "新用户名（回车保持当前，3-32 位字母数字_ . -）: " user || true
  read -rs -p "新密码（8-128 位）: " pass; echo
  read -rs -p "确认新密码: " pass2; echo
  if [[ "$pass" != "$pass2" ]]; then err "两次密码不一致"; return; fi
  if [[ ${#pass} -lt 8 || ${#pass} -gt 128 ]]; then err "密码长度需为 8-128 位"; return; fi
  say "将短暂停止服务以写入新凭据…"
  systemctl stop "$SERVICE" 2>/dev/null || true
  if NUI_NEW_PASS="$pass" NUI_NEW_USER="$user" "$NODE_BIN" "$APP_DIR/server/cli.js" reset-admin; then
    ok "管理员凭据已更新，所有管理员会话已失效"
  else
    err "更新失败"
  fi
  systemctl start "$SERVICE" 2>/dev/null || true
}

confirm() {
  local ans; read -r -p "$1 输入 YES 确认: " ans || true
  [[ "$ans" == "YES" ]]
}

do_uninstall() {
  need_root || return
  local keep="$1"
  if [[ ! -f "$APP_DIR/install.sh" ]]; then err "未找到 $APP_DIR/install.sh，无法自动卸载"; return; fi
  if [[ "$keep" == "1" ]]; then
    confirm "保留数据卸载（保留 $DATA_DIR_DEFAULT 数据）？" || { warn "已取消"; return; }
    exec bash "$APP_DIR/install.sh" --uninstall --keep-data -y
  else
    confirm "完整卸载（删除程序与全部数据，不可恢复）？" || { warn "已取消"; return; }
    exec bash "$APP_DIR/install.sh" --uninstall -y
  fi
}

do_update() {
  need_root || return
  if [[ ! -f "$APP_DIR/install.sh" ]]; then err "未找到 $APP_DIR/install.sh，无法自动更新"; return; fi
  confirm "更新到最新版本（保留数据与域名）？" || { warn "已取消"; return; }
  local mode host cdn args
  mode="$(cfg_get mode)"; host="$(cfg_get userHost)"; cdn="$(cfg_get cdn)"
  args=(--update -y)
  if [[ "$mode" == "domain" && -n "$host" && "$host" != *nip.io* ]]; then args+=(--domain "$host"); else args+=(--auto); fi
  if [[ "$cdn" == "cloudflare" ]]; then
    args+=(--cloudflare --cf-http-port "$(cfg_get cfHttpPort)" --cf-https-port "$(cfg_get cfHttpsPort)")
    [[ "$(cfg_get cfOnly)" == "true" ]] && args+=(--cf-only)
  fi
  exec bash "$APP_DIR/install.sh" "${args[@]}"
}

menu() {
  echo
  echo "${B}${CYN}  备忘录 (nui-memo) 管理面板${R}   ${D}命令: n-ui（大小写均可）${R}"
  echo "${D}  ─────────────────────────────────────────${R}"
  echo "  1) 查看状态"
  echo "  2) 启动服务"
  echo "  3) 停止服务"
  echo "  4) 重启服务"
  echo "  5) 查看日志"
  echo "  6) 修改管理员账号 / 密码"
  echo "  7) 保留数据卸载"
  echo "  8) 完整卸载（清除数据）"
  echo "  9) 更新程序"
  echo "  0) 退出"
}

main_loop() {
  while true; do
    menu
    local choice; read -r -p "请输入数字选择: " choice || exit 0
    case "$choice" in
      1) do_status; pause;;
      2) do_start; pause;;
      3) do_stop; pause;;
      4) do_restart; pause;;
      5) do_logs; pause;;
      6) do_reset; pause;;
      7) do_uninstall 1;;
      8) do_uninstall 0;;
      9) do_update;;
      0|q|Q|exit) say "再见"; exit 0;;
      *) warn "无效选择: $choice";;
    esac
  done
}

# 支持非交互直跑: n-ui status|start|stop|restart|logs
case "${1:-}" in
  status) do_status; exit 0;;
  start) do_start; exit 0;;
  stop) do_stop; exit 0;;
  restart) do_restart; exit 0;;
  logs) do_logs "${2:-}"; exit 0;;
  "") main_loop;;
  *) main_loop;;
esac
