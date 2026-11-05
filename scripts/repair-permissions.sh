#!/usr/bin/env bash
# Called by the installer and SSH panel as root. Never make credentials world-readable.
nui_repair_permissions() {
  local conf="$1" node="$2" data parent
  [[ -f "$conf" && ! -L "$conf" ]] || { echo '配置文件不存在或为符号链接，停止权限修复' >&2; return 1; }
  data="$("$node" -e 'const fs=require("fs"),path=require("path");const c=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));const p=path.resolve(c.dataDir||"/var/lib/nui-memo");if(["/","/etc","/var","/var/lib","/home","/opt","/usr"].includes(p))process.exit(2);console.log(p)' "$conf")" || return 1
  parent="$(dirname "$conf")"
  [[ ! -L "$parent" && ! -L "$data" ]] || { echo '目录为符号链接，停止权限修复' >&2; return 1; }
  id nui-memo >/dev/null 2>&1 || useradd --system --user-group --home "$data" --shell /usr/sbin/nologin nui-memo || return 1
  # Caddy must traverse this directory to read its separately protected Origin key.
  chown root:root "$parent" || return 1
  chown root:nui-memo "$conf" || return 1
  chmod 0755 "$parent" || return 1
  chmod 0640 "$conf" || return 1
  mkdir -p "$data" || return 1
  # Older root CLI runs could leave 0600 snapshots and object directories owned by root.
  chown -hR -P nui-memo:nui-memo "$data" || return 1
  chmod 0750 "$data" || return 1
}
