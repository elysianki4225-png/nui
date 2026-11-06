#!/usr/bin/env bash
# ============================================================
#  备忘录 (nui-memo) 一键部署脚本
#  支持: Debian 11 / 12 / 13, Ubuntu 22.04 / 24.04 / 26.04 (amd64 / arm64)
#  特性: 自动检测 IP · 自动申请 HTTPS 证书 · 域名或 nip.io 自动分配
#        管理员界面 + 用户界面 · 本地 / Telegram 加密存储 · systemd 守护
#        管理面板「域名」页：运行时换域名 / CDN / 加密模式 / 回源端口
#
#  用法:
#    bash install.sh                 # 交互式（可输入域名，回车自动分配）
#    bash install.sh --domain m.example.com
#    bash install.sh --auto          # 全自动，使用 nip.io
#    bash install.sh --update        # 升级程序（保留数据）
#    bash install.sh --uninstall     # 卸载（可选保留数据）
#
#  Cloudflare 小黄云（代理）模式:
#    bash install.sh --domain m.example.com --cloudflare \
#         --cf-cert /path/origin.pem --cf-key /path/origin.key \
#         --cf-http-port 80 --cf-https-port 443
#    # 同时支持 Flexible(回源HTTP) 与 Full/Strict(回源HTTPS)；回源端口可自定义
#    # 也可用 --cf-api-token 自动签发 Cloudflare Origin CA 证书（用于 Strict）
#
#  一键远程安装:
#    curl -fsSL https://raw.githubusercontent.com/elysianki4225-png/nui/main/install.sh | bash
# ============================================================
set -euo pipefail

# ---------- 常量 ----------
NODE_VERSION="v22.15.0"
CADDY_VERSION="2.9.1"
REPO="elysianki4225-png/nui"
REPO_BRANCH="${NUI_BRANCH:-main}"
REPO_REF="${NUI_REF:-refs/heads/${REPO_BRANCH}}"
APP_DIR="/opt/nui-memo"
DATA_DIR="/var/lib/nui-memo"
CONF_DIR="/etc/nui-memo"
CONF_FILE="$CONF_DIR/config.json"
CADDY_BIN="/usr/local/bin/caddy"
CADDY_DIR="/etc/caddy"
CADDY_FILE="$CADDY_DIR/Caddyfile"
BACKEND_PORT="8787"
SERVICE="nui-memo"
CF_CERT_FILE="$CONF_DIR/cf-origin.pem"
CF_KEY_FILE="$CONF_DIR/cf-origin.key"
PANEL_BIN_DIR="${NUI_BIN_DIR:-/usr/local/bin}"

# ---------- 输出 ----------
if [[ -t 1 ]]; then
  C_RESET=$'\033[0m'; C_BOLD=$'\033[1m'; C_DIM=$'\033[2m'
  C_RED=$'\033[31m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_BLUE=$'\033[34m'; C_CYAN=$'\033[36m'
else
  C_RESET=""; C_BOLD=""; C_DIM=""; C_RED=""; C_GREEN=""; C_YELLOW=""; C_BLUE=""; C_CYAN=""
fi
info()  { echo "${C_BLUE}[INFO]${C_RESET} $*"; }
ok()    { echo "${C_GREEN}[ OK ]${C_RESET} $*"; }
warn()  { echo "${C_YELLOW}[WARN]${C_RESET} $*"; }
err()   { echo "${C_RED}[FAIL]${C_RESET} $*" >&2; }
die()   { err "$*"; exit 1; }
step()  { echo; echo "${C_BOLD}${C_CYAN}==> $*${C_RESET}"; }

# ---------- 参数 ----------
DOMAIN=""
AUTO=0
DO_UPDATE=0
DO_UNINSTALL=0
NO_FIREWALL=0
KEEP_DATA=0
ASSUME_YES=0
CLOUDFLARE=0
CF_EXPLICIT=0
CF_CERT=""
CF_KEY=""
CF_API_TOKEN=""
CF_HTTP_PORT=""
CF_HTTPS_PORT=""
CF_ONLY=0
HAVE_CF_CERT=0
NAT=0
NAT_PUBLIC_IP=""
NAT_PUBLIC_HTTP_PORT=80
NAT_PUBLIC_HTTPS_PORT=443
while [[ $# -gt 0 ]]; do
  case "$1" in
    --nat-public-ip) NAT_PUBLIC_IP="${2:-}"; shift 2;;
    --nat) NAT=1; shift;;
    --nat-public-http-port) NAT_PUBLIC_HTTP_PORT="${2:-}"; shift 2;;
    --nat-public-https-port) NAT_PUBLIC_HTTPS_PORT="${2:-}"; shift 2;;
    --origin-http-port) CF_HTTP_PORT="${2:-}"; shift 2;;
    --origin-https-port) CF_HTTPS_PORT="${2:-}"; shift 2;;
    --tls-cert) CF_CERT="${2:-}"; shift 2;;
    --tls-key) CF_KEY="${2:-}"; shift 2;;
    --domain) DOMAIN="${2:-}"; shift 2;;
    --domain=*) DOMAIN="${1#*=}"; shift;;
    --auto) AUTO=1; shift;;
    --update) DO_UPDATE=1; shift;;
    --uninstall) DO_UNINSTALL=1; shift;;
    --no-firewall) NO_FIREWALL=1; shift;;
    --keep-data) KEEP_DATA=1; shift;;
    --cloudflare) CLOUDFLARE=1; CF_EXPLICIT=1; shift;;
    --no-cloudflare) CLOUDFLARE=0; CF_EXPLICIT=1; shift;;
    --cf-cert) CF_CERT="${2:-}"; shift 2;;
    --cf-cert=*) CF_CERT="${1#*=}"; shift;;
    --cf-key) CF_KEY="${2:-}"; shift 2;;
    --cf-key=*) CF_KEY="${1#*=}"; shift;;
    --cf-api-token) CF_API_TOKEN="${2:-}"; shift 2;;
    --cf-api-token=*) CF_API_TOKEN="${1#*=}"; shift;;
    --cf-http-port) CF_HTTP_PORT="${2:-}"; shift 2;;
    --cf-http-port=*) CF_HTTP_PORT="${1#*=}"; shift;;
    --cf-https-port) CF_HTTPS_PORT="${2:-}"; shift 2;;
    --cf-https-port=*) CF_HTTPS_PORT="${1#*=}"; shift;;
    --origin-port) CF_HTTPS_PORT="${2:-}"; shift 2;;
    --cf-only) CF_ONLY=1; shift;;
    -y|--yes) ASSUME_YES=1; shift;;
    -h|--help)
      cat <<'USAGE'
备忘录 (nui-memo) 一键部署脚本
用法:
  bash install.sh                 交互式（可输入域名，回车自动分配 nip.io）
  bash install.sh --domain m.example.com   使用自定义域名
  bash install.sh --auto          全自动，使用 nip.io 域名
  bash install.sh --update        升级程序（保留数据）
  bash install.sh --uninstall     卸载
选项:
  --nat          启用 NAT 映射（必须在服务商配置公网到本机 TCP 转发）
  --nat-public-ip IP          服务商提供的入口公网 IP（不一定等于出口 IP）
  --nat-public-http-port N   公网 HTTP 端口
  --nat-public-https-port N  公网 HTTPS 端口
  --origin-http-port N       本机 HTTP 监听端口
  --origin-https-port N      本机 HTTPS 监听端口
  --tls-cert FILE --tls-key FILE   NAT 直连所需的浏览器可信证书/私钥
  --no-firewall   不自动配置 ufw
  --keep-data     卸载时保留数据
  -y, --yes       跳过确认
Cloudflare 小黄云:
  --cloudflare          启用 CF 代理模式（需自定义域名，同时支持 Flexible/Full/Strict）
  --no-cloudflare       关闭 CF 模式（升级时改回直连）
  --cf-cert <file>      Cloudflare Origin CA 证书 PEM（用于 Full/Strict 回源）
  --cf-key <file>       Origin CA 私钥
  --cf-api-token <tok>  用 CF API Token 自动签发 Origin CA 证书（需 SSL and Certificates 权限）
  --cf-http-port <p>    Flexible 回源 HTTP 端口（默认 80）
  --cf-https-port <p>   Full/Strict 回源 HTTPS 端口（默认 443，可用 --origin-port 别名）
  --cf-only             防火墙仅允许 Cloudflare IP 访问回源端口
部署后:
  管理界面「域名」页可随时换域名（含 nip.io→自定义）、切换 Cloudflare/第三方 CDN、
  Flexible/Full/Strict 加密、自定义回源端口（含冷门端口），无需重装。
远程一键安装:
  curl -fsSL https://raw.githubusercontent.com/elysianki4225-png/nui/main/install.sh | bash
USAGE
      exit 0;;
    *) warn "未知参数: $1"; shift;;
  esac
done

# ---------- 基础检查 ----------
detect_os() {
  [[ -r /etc/os-release ]] || die "无法识别系统（缺少 /etc/os-release）"
  . /etc/os-release
  OS_ID="${ID:-}"
  OS_VER="${VERSION_ID:-}"
  OS_NAME="${PRETTY_NAME:-$OS_ID}"
  case "$OS_ID" in
    debian)
      case "${OS_VER%%.*}" in
        11|12|13) : ;;
        *) warn "未在 Debian ${OS_VER} 上充分测试，将继续尝试。";;
      esac;;
    ubuntu)
      case "$OS_VER" in
        22.04|24.04|26.04) : ;;
        *) warn "未在 Ubuntu ${OS_VER} 上充分测试，将继续尝试。";;
      esac;;
    *)
      warn "非 Debian/Ubuntu 系统（$OS_NAME），脚本面向 Debian/Ubuntu，可能失败。"
      [[ $ASSUME_YES -eq 1 ]] || read -r -p "仍要继续吗？[y/N] " ans </dev/tty || true
      [[ "${ans:-}" =~ ^[Yy] ]] || die "已取消"
      ;;
  esac
  command -v apt-get >/dev/null || die "需要 apt-get（Debian/Ubuntu）"
  ok "系统: $OS_NAME"
}

detect_arch() {
  local m; m="$(uname -m)"
  case "$m" in
    x86_64|amd64) ARCH="amd64"; NODE_ARCH="x64";;
    aarch64|arm64) ARCH="arm64"; NODE_ARCH="arm64";;
    armv7l) ARCH="armv7"; NODE_ARCH="armv7l";;
    *) die "不支持的架构: $m";;
  esac
  ok "架构: $ARCH"
}

# ---------- 依赖 ----------
install_deps() {
  step "安装基础依赖"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -y -qq || warn "apt-get update 失败，继续尝试"
  apt-get install -y -qq curl ca-certificates tar xz-utils openssl gettext-base >/dev/null
  ok "依赖就绪"
}

# ---------- Node.js ----------
install_node() {
  step "安装 Node.js ${NODE_VERSION}"
  if [[ -x "$APP_DIR/node/bin/node" ]] && "$APP_DIR/node/bin/node" -v 2>/dev/null | grep -q "$NODE_VERSION"; then
    ok "Node.js 已存在: $("$APP_DIR/node/bin/node" -v)"
    return
  fi
  local file="node-${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz"
  local tmp; tmp="$(mktemp -d)"
  local urls=(
    "https://nodejs.org/dist/${NODE_VERSION}/${file}"
    "https://npmmirror.com/mirrors/node/${NODE_VERSION}/${file}"
    "https://cdn.npmmirror.com/binaries/node/${NODE_VERSION}/${file}"
  )
  local got=0
  for u in "${urls[@]}"; do
    info "下载 $u"
    if curl -fL --retry 2 --connect-timeout 15 --max-time 300 -o "$tmp/node.tar.xz" "$u"; then got=1; break; fi
    warn "该源失败，尝试下一个"
  done
  [[ $got -eq 1 ]] || die "Node.js 下载失败，请检查网络"
  mkdir -p "$APP_DIR/node"
  tar -xJf "$tmp/node.tar.xz" -C "$APP_DIR/node" --strip-components=1
  rm -rf "$tmp"
  "$APP_DIR/node/bin/node" -v >/dev/null || die "Node.js 安装校验失败"
  ok "Node.js $("$APP_DIR/node/bin/node" -v) 已安装"
}

# ---------- Caddy ----------
install_caddy() {
  step "安装 Caddy ${CADDY_VERSION}（自动 HTTPS）"
  if [[ -x "$CADDY_BIN" ]] && "$CADDY_BIN" version 2>/dev/null | grep -q "v${CADDY_VERSION}"; then
    ok "Caddy 已存在"
  else
    local file="caddy_${CADDY_VERSION}_linux_${ARCH}.tar.gz"
    local tmp; tmp="$(mktemp -d)"
    local base="https://github.com/caddyserver/caddy/releases/download/v${CADDY_VERSION}/${file}"
    local urls=("$base" "https://gh-proxy.com/${base}" "https://ghproxy.net/${base}")
    local got=0
    for u in "${urls[@]}"; do
      info "下载 $u"
      if curl -fL --retry 2 --connect-timeout 15 --max-time 300 -o "$tmp/caddy.tar.gz" "$u"; then got=1; break; fi
      warn "该源失败，尝试下一个"
    done
    [[ $got -eq 1 ]] || die "Caddy 下载失败，请检查网络（中国大陆可设置代理后重试）"
    tar -xzf "$tmp/caddy.tar.gz" -C "$tmp" caddy
    install -m 0755 "$tmp/caddy" "$CADDY_BIN"
    rm -rf "$tmp"
    ok "Caddy $("$CADDY_BIN" version | head -1) 已安装"
  fi
  id caddy >/dev/null 2>&1 || useradd --system --home /var/lib/caddy --shell /usr/sbin/nologin caddy
  mkdir -p /var/lib/caddy "$CADDY_DIR"
  chown -R caddy:caddy /var/lib/caddy
}

# ---------- IP 检测 ----------
detect_ip() {
  local ip
  for u in "https://api.ipify.org" "https://ifconfig.me/ip" "https://ip.sb" "https://api.ip.sb/ip" "https://checkip.amazonaws.com"; do
    ip="$(curl -4 -fsS --connect-timeout 8 --max-time 12 "$u" 2>/dev/null | tr -d '[:space:]')" || true
    if [[ "$ip" =~ ^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$ ]]; then PUBLIC_IP="$ip"; IP_FAMILY=4; return 0; fi
  done
  for u in "https://api64.ipify.org" "https://ifconfig.co/ip"; do
    ip="$(curl -6 -fsS --connect-timeout 8 --max-time 12 "$u" 2>/dev/null | tr -d '[:space:]')" || true
    if [[ "$ip" == *:* ]]; then PUBLIC_IP="$ip"; IP_FAMILY=6; return 0; fi
  done
  return 1
}

# ---------- Cloudflare 默认值（升级时复用） ----------
resolve_cf_defaults() {
  if [[ -f "$CONF_FILE" && -x "$APP_DIR/node/bin/node" ]]; then
    local vals ex_cf ex_http ex_https
    vals="$("$APP_DIR/node/bin/node" -e 'const fs=require("fs");try{const c=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));console.log([c.cloudflare?1:0,c.cfHttpPort||"",c.cfHttpsPort||""].join("|"))}catch(e){console.log("0||")}' "$CONF_FILE")"
    IFS='|' read -r ex_cf ex_http ex_https <<< "$vals"
    if [[ $CF_EXPLICIT -eq 0 && "$ex_cf" == "1" ]]; then CLOUDFLARE=1; fi
    if [[ -z "$CF_HTTP_PORT" && -n "$ex_http" ]]; then CF_HTTP_PORT="$ex_http"; fi
    if [[ -z "$CF_HTTPS_PORT" && -n "$ex_https" ]]; then CF_HTTPS_PORT="$ex_https"; fi
  fi
  CF_HTTP_PORT="${CF_HTTP_PORT:-80}"
  CF_HTTPS_PORT="${CF_HTTPS_PORT:-443}"
  if [[ "$CF_HTTP_PORT" == "$CF_HTTPS_PORT" ]]; then die "CF HTTP 与 HTTPS 回源端口不能相同"; fi
}

# ---------- 选择域名 ----------
choose_domain() {
  step "配置访问域名"
  # 升级时复用已有配置
  if [[ -z "$DOMAIN" && -f "$CONF_FILE" ]]; then
    local existing_mode existing_user
    existing_mode="$(grep -o '"mode"[^,]*' "$CONF_FILE" | head -1 | sed 's/.*: *"//;s/"//')"
    existing_user="$(grep -o '"userHost"[^,]*' "$CONF_FILE" | head -1 | sed 's/.*: *"//;s/"//')"
    if [[ -n "$existing_user" ]]; then
      MODE="$existing_mode"; USER_HOST="$existing_user"
      ADMIN_HOST="$(grep -o '"adminHost"[^,]*' "$CONF_FILE" | head -1 | sed 's/.*: *"//;s/"//')"
      if [[ $CLOUDFLARE -eq 1 && "$MODE" != "domain" ]]; then die "Cloudflare 模式需要自定义域名，请用 --domain 指定"; fi
      ok "复用已有域名: $USER_HOST"
      return
    fi
  fi
  if [[ $CLOUDFLARE -eq 1 ]]; then
    if [[ -z "$DOMAIN" && $AUTO -eq 0 && -e /dev/tty ]]; then
      read -r -p "  Cloudflare 模式需要你的域名: " DOMAIN </dev/tty || true
      DOMAIN="$(echo "$DOMAIN" | tr -d '[:space:]')"
    fi
    [[ -n "$DOMAIN" ]] || die "Cloudflare 模式必须使用自定义域名（--domain），不能用 nip.io"
    MODE="domain"; USER_HOST="$DOMAIN"; ADMIN_HOST=""
    info "Cloudflare 小黄云代理模式，域名: $DOMAIN"
    check_dns "$DOMAIN"
    return
  fi
  if [[ -n "$DOMAIN" ]]; then
    MODE="domain"; USER_HOST="$DOMAIN"; ADMIN_HOST=""
    info "使用自定义域名: $DOMAIN"
    check_dns "$DOMAIN"
    return
  fi
  if [[ $AUTO -eq 0 && -e /dev/tty ]]; then
    echo "  检测到本机公网 IP: ${C_BOLD}${PUBLIC_IP}${C_RESET}"
    echo "  你可以输入自己的域名（需已解析到本机），或直接回车由系统自动分配 nip.io 域名。"
    local input=""
    if read -r -t 40 -p "  请输入域名（回车自动分配）: " input </dev/tty; then
      DOMAIN="$(echo "$input" | tr -d '[:space:]')"
    fi
    echo
  fi
  if [[ -n "$DOMAIN" ]]; then
    MODE="domain"; USER_HOST="$DOMAIN"; ADMIN_HOST=""
    check_dns "$DOMAIN"
  else
    MODE="ip"
    local prefix; prefix="$(openssl rand -hex 3)"
    local iphost="$PUBLIC_IP"
    if [[ "$IP_FAMILY" == "6" ]]; then iphost="${PUBLIC_IP//:/-}"; fi
    USER_HOST="memo-${prefix}.${iphost}.nip.io"
    ADMIN_HOST="admin-${prefix}.${iphost}.nip.io"
    info "自动分配 nip.io 域名:"
    info "  用户: $USER_HOST"
    info "  管理: $ADMIN_HOST"
  fi
}

check_dns() {
  local d="$1" resolved=""
  resolved="$(getent ahosts "$d" 2>/dev/null | awk '{print $1; exit}')" || true
  if [[ $CLOUDFLARE -eq 1 ]]; then
    if [[ -z "$resolved" ]]; then
      warn "域名 $d 目前无法解析。请在 Cloudflare 添加 A/AAAA 记录指向 $PUBLIC_IP 并开启小黄云。"
    else
      ok "域名已解析（Cloudflare 边缘）。请确认 DNS 记录已开启小黄云代理。"
    fi
    return
  fi
  if [[ -z "$resolved" ]]; then
    warn "域名 $d 目前无法解析。请先将其 A/AAAA 记录指向 $PUBLIC_IP，否则证书申请会失败。"
  elif [[ "$resolved" != "$PUBLIC_IP" ]]; then
    warn "域名 $d 解析到 $resolved，与本机 IP $PUBLIC_IP 不一致，证书可能申请失败。"
  else
    ok "域名解析正确 ($resolved)"
  fi
}

# ---------- Cloudflare Origin CA 证书 ----------
setup_cloudflare_cert() {
  [[ $CLOUDFLARE -eq 1 || $NAT -eq 1 ]] || return 0
  if [[ $NAT -eq 1 && $CLOUDFLARE -eq 0 && -n "$CF_API_TOKEN" ]]; then die "NAT 直连不能使用 CF Origin CA 自动签发，请提供浏览器可信证书"; fi
  step "配置 Cloudflare 回源证书"
  HAVE_CF_CERT=0
  [[ -s "$CF_CERT_FILE" && -s "$CF_KEY_FILE" ]] && HAVE_CF_CERT=1
  if [[ -n "$CF_CERT" || -n "$CF_KEY" ]]; then
    [[ -n "$CF_CERT" && -n "$CF_KEY" ]] || die "--cf-cert 与 --cf-key 需同时提供"
    [[ -f "$CF_CERT" ]] || die "证书文件不存在: $CF_CERT"
    [[ -f "$CF_KEY" ]] || die "私钥文件不存在: $CF_KEY"
    install -m 0644 "$CF_CERT" "$CF_CERT_FILE"
    install -m 0640 "$CF_KEY" "$CF_KEY_FILE"
    HAVE_CF_CERT=1
    ok "已安装 Origin CA 证书（支持 Full/Strict 回源）"
  elif [[ -n "$CF_API_TOKEN" ]]; then
    info "使用 Cloudflare API 自动签发 Origin CA 证书..."
    local tmp; tmp="$(mktemp -d)"
    if openssl req -new -newkey rsa:2048 -nodes -keyout "$tmp/origin.key" -out "$tmp/origin.csr" -subj "/CN=${USER_HOST}" >/dev/null 2>&1; then
      local csr_json resp cert
      csr_json="$("$APP_DIR/node/bin/node" -e 'const fs=require("fs");console.log(JSON.stringify(fs.readFileSync(process.argv[1],"utf8")))' "$tmp/origin.csr")"
      resp="$(curl -fsS --max-time 30 -X POST "https://api.cloudflare.com/client/v4/certificates" \
        -H "Authorization: Bearer ${CF_API_TOKEN}" -H "Content-Type: application/json" \
        --data "{\"hostnames\":[\"${USER_HOST}\",\"*.${USER_HOST}\"],\"requested_validity\":5475,\"request_type\":\"origin-rsa\",\"csr\":${csr_json}}" 2>/dev/null)" || resp=""
      cert="$(printf '%s' "$resp" | "$APP_DIR/node/bin/node" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);if(j.success&&j.result&&j.result.certificate)process.stdout.write(j.result.certificate);else console.error((j.errors&&j.errors[0]&&j.errors[0].message)||"API 失败")}catch(e){console.error("解析失败")}})')" || cert=""
      if [[ -n "$cert" ]]; then
        printf '%s\n' "$cert" > "$CF_CERT_FILE"
        install -m 0640 "$tmp/origin.key" "$CF_KEY_FILE"
        chmod 0644 "$CF_CERT_FILE"
        HAVE_CF_CERT=1
        ok "Origin CA 证书已自动签发（支持 Full/Strict 回源）"
      else
        warn "自动签发失败，将仅启用 HTTP 回源（Flexible）。可手动创建 Origin CA 证书后用 --cf-cert/--cf-key 重新运行。"
      fi
    else
      warn "生成 CSR 失败，跳过自动签发"
    fi
    rm -rf "$tmp"
  fi
  if [[ $HAVE_CF_CERT -eq 1 ]]; then
    chown root:caddy "$CF_CERT_FILE" "$CF_KEY_FILE" 2>/dev/null || true
    chmod 0644 "$CF_CERT_FILE"; chmod 0640 "$CF_KEY_FILE"
    ok "回源 HTTPS 端口 ${CF_HTTPS_PORT} 已启用（Full/Strict）"
  else
    warn "未提供 Origin CA 证书：仅启用 HTTP 回源（Flexible）。"
    warn "如需 Full/Strict，请在 CF 控制台 SSL/TLS -> Origin Server 创建证书，再用 --cf-cert/--cf-key 重新运行。"
  fi
  if [[ $NAT -eq 1 && $CLOUDFLARE -eq 0 && $HAVE_CF_CERT -eq 0 ]]; then die "NAT 直连需要 --tls-cert 和 --tls-key，不尝试自动申请证书"; fi
  # 同步 sslMode 到配置（有证书默认 full，无证书 flexible）
  HAVE_CF_CERT="$HAVE_CF_CERT" "$APP_DIR/node/bin/node" -e '
    const fs=require("fs");const f=process.argv[1];
    try{const c=JSON.parse(fs.readFileSync(f,"utf8"));
      if(c.cdn&&c.cdn!=="none"){c.sslMode=process.env.HAVE_CF_CERT==="1"?(c.sslMode==="strict"?"strict":"full"):"flexible";
      fs.writeFileSync(f,JSON.stringify(c,null,2));}}catch(e){}
  ' "$CONF_FILE" 2>/dev/null || true
  ok "回源 HTTP 端口 ${CF_HTTP_PORT} 已启用（Flexible）"
}

# ---------- 获取程序 ----------
fetch_app() {
  step "部署程序文件"
  local src=""
  local script_dir; script_dir="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd)" || true
  if [[ $DO_UPDATE -eq 0 && -n "$script_dir" && "$script_dir" != "$(realpath -m "$APP_DIR")" && -f "$script_dir/server/index.js" && -d "$script_dir/web" ]]; then
    src="$script_dir"
    info "使用本地仓库文件: $src"
  else
    local tmp; tmp="$(mktemp -d)"
    local url="https://codeload.github.com/${REPO}/tar.gz/${REPO_REF}"
    info "下载程序: $url"
    curl -fL --retry 2 --connect-timeout 15 --max-time 300 -o "$tmp/app.tar.gz" "$url" || die "程序下载失败"
    tar -xzf "$tmp/app.tar.gz" -C "$tmp"
    src="$(find "$tmp" -maxdepth 1 -type d -name 'nui-*' | head -1)"
    [[ -n "$src" && -f "$src/server/index.js" ]] || die "程序包结构异常"
    FETCH_TMP="$tmp"
  fi
  mkdir -p "$APP_DIR"
  # 完整复制到临时目录后才替换运行文件，避免下载/复制失败损坏旧安装。
  local stage; stage="$(mktemp -d "$APP_DIR/.deploy.XXXXXX")"
  cp -a "$src/server" "$stage/server"
  cp -a "$src/web" "$stage/web"
  # 备份旧程序（升级）
  if [[ -d "$APP_DIR/server" ]]; then
    rm -rf "$APP_DIR/server.old" "$APP_DIR/web.old"
    mv "$APP_DIR/server" "$APP_DIR/server.old" 2>/dev/null || true
    mv "$APP_DIR/web" "$APP_DIR/web.old" 2>/dev/null || true
  fi
  mv "$stage/server" "$APP_DIR/server"
  mv "$stage/web" "$APP_DIR/web"
  rmdir "$stage"
  # 附带安装器与 SSH 面板脚本，供 n-ui 面板「更新 / 卸载」复用
  if [[ -d "$src/scripts" ]]; then mkdir -p "$APP_DIR/scripts"; cp -a "$src/scripts/." "$APP_DIR/scripts/"; fi
  [[ -f "$src/install.sh" ]] && cp "$src/install.sh" "$APP_DIR/install.sh"
  [[ -n "${FETCH_TMP:-}" ]] && rm -rf "$FETCH_TMP"
  ok "程序已部署到 $APP_DIR"
}

repair_permissions() {
  local helper="$APP_DIR/scripts/repair-permissions.sh"
  [[ -f "$helper" ]] || die "缺少权限修复脚本，请使用完整新版安装器更新"
  source "$helper"
  nui_repair_permissions "$CONF_FILE" "$APP_DIR/node/bin/node" || die "权限修复失败，未启动服务"
}

# ---------- 配置 ----------
write_config() {
  step "写入配置"
  mkdir -p "$CONF_DIR" "$DATA_DIR"
  if [[ ! -f "$CONF_FILE" ]]; then
    cat > "$CONF_FILE" <<EOF
{
  "host": "127.0.0.1",
  "port": ${BACKEND_PORT},
  "dataDir": "${DATA_DIR}",
  "mode": "${MODE}",
  "userHost": "${USER_HOST}",
  "adminHost": "${ADMIN_HOST}",
  "publicIp": "${PUBLIC_IP:-}",
  "trustProxy": true,
  "cloudflare": $([[ $CLOUDFLARE -eq 1 ]] && echo true || echo false),
  "cdn": "$([[ $CLOUDFLARE -eq 1 ]] && echo cloudflare || echo none)",
  "cdnName": "$([[ $CLOUDFLARE -eq 1 ]] && echo Cloudflare || echo '')",
  "sslMode": "$([[ $CLOUDFLARE -eq 1 ]] && echo flexible || echo auto)",
  "realIpHeader": "$([[ $CLOUDFLARE -eq 1 ]] && echo cf-connecting-ip || echo x-forwarded-for)",
  "cfOnly": $([[ $CF_ONLY -eq 1 ]] && echo true || echo false),
  "cfHttpPort": ${CF_HTTP_PORT:-80},
  "cfHttpsPort": ${CF_HTTPS_PORT:-443},
  "telegramApiBase": "https://api.telegram.org",
  "maxFileSize": 134217728,
  "chunkSize": 16777216,
  "thumbCacheMB": 64,
  "uploadConcurrency": 3,
  "uploadQueueMB": 96
}
EOF
    chmod 640 "$CONF_FILE"
    ok "配置已创建: $CONF_FILE"
  else
    # 更新域名 / Cloudflare 字段（保留其余）
    MODE="$MODE" USER_HOST="$USER_HOST" ADMIN_HOST="$ADMIN_HOST" PUBLIC_IP="${PUBLIC_IP:-}" \
    CLOUDFLARE="$CLOUDFLARE" CF_ONLY="$CF_ONLY" CF_HTTP_PORT="${CF_HTTP_PORT:-80}" CF_HTTPS_PORT="${CF_HTTPS_PORT:-443}" \
    "$APP_DIR/node/bin/node" -e '
      const fs=require("fs");const f=process.argv[1];
      const c=JSON.parse(fs.readFileSync(f,"utf8"));
      const cf=process.env.CLOUDFLARE==="1";
      c.mode=process.env.MODE;c.userHost=process.env.USER_HOST;c.adminHost=process.env.ADMIN_HOST||(c.adminOrigin?c.adminHost:"");
      if(process.env.PUBLIC_IP)c.publicIp=process.env.PUBLIC_IP;
      c.cloudflare=cf;c.cdn=cf?"cloudflare":"none";c.cdnName=cf?"Cloudflare":"";
      c.sslMode=cf?(c.sslMode&&c.sslMode!=="auto"?c.sslMode:"flexible"):"auto";
      c.realIpHeader=cf?"cf-connecting-ip":"x-forwarded-for";
      c.cfOnly=process.env.CF_ONLY==="1";
      c.cfHttpPort=parseInt(process.env.CF_HTTP_PORT,10)||80;
      c.cfHttpsPort=parseInt(process.env.CF_HTTPS_PORT,10)||443;
      fs.writeFileSync(f,JSON.stringify(c,null,2));
    ' "$CONF_FILE"
    ok "配置已更新（保留数据与机器人绑定）"
  fi
  if [[ $NAT -eq 1 ]]; then
    "$APP_DIR/node/bin/node" -e '
      const fs=require("fs");const file=process.argv[1],c=JSON.parse(fs.readFileSync(file));
      const [http,https]=process.argv.slice(2,4).map(Number);
      if(![http,https].every(p=>Number.isInteger(p)&&p>0&&p<=65535)||http===https)throw new Error("无效 NAT 公网端口");
      const publicIp=process.argv[4]||"";if(publicIp&&!require("net").isIP(publicIp))throw new Error("无效公网 IP");
      c.nat={enabled:true,publicHttpPort:http,publicHttpsPort:https,publicIp};fs.writeFileSync(file,JSON.stringify(c,null,2));
    ' "$CONF_FILE" "$NAT_PUBLIC_HTTP_PORT" "$NAT_PUBLIC_HTTPS_PORT" "$NAT_PUBLIC_IP"
  fi
  repair_permissions
}

# ---------- Caddyfile ----------
write_caddyfile() {
  step "配置 Caddy 反向代理"
  # 与管理面板「域名」页共用同一生成器（server/domain.js），保证一致
  local cdn="none"
  [[ $CLOUDFLARE -eq 1 ]] && cdn="cloudflare"
  local staged; staged="$(mktemp "$CADDY_DIR/.nui-caddy.XXXXXX")"
  NUI_CONF_FILE="$CONF_FILE" NUI_ADMIN_CERT_FILE="$CONF_DIR/admin-origin.pem" NUI_ADMIN_KEY_FILE="$CONF_DIR/admin-origin.key" \
  NUI_MODE="$MODE" NUI_USER_HOST="$USER_HOST" NUI_ADMIN_HOST="$ADMIN_HOST" \
  NUI_CDN="$cdn" NUI_SSL_MODE="${SSL_MODE:-auto}" \
  NUI_CF_HTTP_PORT="${CF_HTTP_PORT:-80}" NUI_CF_HTTPS_PORT="${CF_HTTPS_PORT:-443}" \
  NUI_HAVE_CERT="$HAVE_CF_CERT" NUI_BACKEND_PORT="$BACKEND_PORT" \
  NUI_CF_CERT_FILE="$CF_CERT_FILE" NUI_CF_KEY_FILE="$CF_KEY_FILE" \
  "$APP_DIR/node/bin/node" "$APP_DIR/server/domain.js" caddyfile > "$staged" || { rm -f "$staged"; die "域名配置生成失败，原 Caddyfile 未改动"; }
  "$CADDY_BIN" validate --config "$staged" --adapter caddyfile >/dev/null 2>&1 || { rm -f "$staged"; die "Caddyfile 校验未通过，原代理配置未改动"; }
  install -m 0644 "$staged" "$CADDY_FILE"
  rm -f "$staged"
  ok "Caddyfile 校验通过"
}

# ---------- 域名管理特权应用（systemd path 触发 root helper） ----------
write_domain_apply() {
  step "配置域名管理自动应用"
  cat > "$CONF_DIR/domain-apply.json" <<EOF
{ "mode": "systemd" }
EOF
  chmod 644 "$CONF_DIR/domain-apply.json"
  cat > /etc/systemd/system/${SERVICE}-domain.service <<EOF
[Unit]
Description=nui-memo 域名/证书自动应用（root）
After=network.target

[Service]
Type=oneshot
User=root
Environment=NUI_CONF_FILE=${CONF_FILE}
Environment=NUI_CADDY_FILE=${CADDY_FILE}
Environment=NUI_CF_CERT_FILE=${CF_CERT_FILE}
Environment=NUI_CF_KEY_FILE=${CF_KEY_FILE}
Environment=NUI_ADMIN_CERT_FILE=${CONF_DIR}/admin-origin.pem
Environment=NUI_ADMIN_KEY_FILE=${CONF_DIR}/admin-origin.key
Environment=NUI_CADDY_BIN=${CADDY_BIN}
Environment=NUI_BACKEND_PORT=${BACKEND_PORT}
Environment=NUI_DATA_DIR=${DATA_DIR}
Environment=NUI_SERVICE=${SERVICE}
Environment=NUI_CADDY_SERVICE=caddy
ExecStart=${APP_DIR}/node/bin/node ${APP_DIR}/server/domain.js apply --request ${DATA_DIR}/domain-request.json
TimeoutStartSec=120
NoNewPrivileges=true
PrivateTmp=true
EOF
  cat > /etc/systemd/system/${SERVICE}-domain.path <<EOF
[Unit]
Description=监听 nui-memo 域名变更请求

[Path]
PathChanged=${DATA_DIR}/domain-request.json
Unit=${SERVICE}-domain.service

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable ${SERVICE}-domain.path >/dev/null 2>&1 || true
  systemctl restart ${SERVICE}-domain.path >/dev/null 2>&1 || true
  ok "域名管理自动应用已启用（管理面板「域名」页）"
}

# Fixed maintenance capability. Never grant the web process shell/sudo access.
write_maintenance() {
  [[ -f "$APP_DIR/scripts/maintenance-helper.mjs" ]] || return 0
  install -D -o root -g root -m 0755 "$APP_DIR/scripts/maintenance-helper.mjs" /usr/local/libexec/nui-maintenance.mjs
  cat > /etc/systemd/system/${SERVICE}-maintenance.service <<EOF
[Unit]
Description=nui-memo fixed maintenance helper
ConditionPathExists=${DATA_DIR}/maintenance-request.json
[Service]
Type=oneshot
User=root
ExecStart=${APP_DIR}/node/bin/node /usr/local/libexec/nui-maintenance.mjs
TimeoutStartSec=1200
PrivateTmp=true
NoNewPrivileges=true
EOF
  cat > /etc/systemd/system/${SERVICE}-maintenance.path <<EOF
[Unit]
Description=Watch nui-memo maintenance requests
[Path]
PathChanged=${DATA_DIR}/maintenance-request.json
Unit=${SERVICE}-maintenance.service
[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable ${SERVICE}-maintenance.path >/dev/null 2>&1
  systemctl restart ${SERVICE}-maintenance.path
  printf 'enabled\n' > "$CONF_DIR/maintenance-enabled"
  chown root:root "$CONF_DIR/maintenance-enabled"
  chmod 0644 "$CONF_DIR/maintenance-enabled"
}

# ---------- systemd ----------
write_systemd() {
  step "配置 systemd 服务"
  cat > /etc/systemd/system/${SERVICE}.service <<EOF
[Unit]
Description=nui-memo (备忘录)
After=network.target
Wants=network-online.target

[Service]
Type=simple
User=nui-memo
Group=nui-memo
WorkingDirectory=${APP_DIR}/server
Environment=MEMO_CONFIG=${CONF_FILE}
ExecStart=${APP_DIR}/node/bin/node ${APP_DIR}/server/index.js
Restart=always
RestartSec=3
TimeoutStopSec=20
LimitNOFILE=65536
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=${DATA_DIR}
ProtectHome=true
PrivateTmp=true
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictSUIDSGID=true
MemoryHigh=512M
MemoryMax=768M

[Install]
WantedBy=multi-user.target
EOF

  cat > /etc/systemd/system/caddy.service <<EOF
[Unit]
Description=Caddy web server
After=network.target network-online.target
Wants=network-online.target

[Service]
Type=notify
User=caddy
Group=caddy
Environment=XDG_DATA_HOME=/var/lib/caddy
ExecStart=${CADDY_BIN} run --environ --config ${CADDY_FILE}
ExecReload=${CADDY_BIN} reload --config ${CADDY_FILE} --force
TimeoutStopSec=5s
LimitNOFILE=1048576
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=true
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  ok "systemd 服务已配置"
}

# ---------- 防火墙 ----------
setup_firewall() {
  [[ $NO_FIREWALL -eq 1 ]] && { info "跳过防火墙配置"; return; }
  if command -v ufw >/dev/null 2>&1; then
    if ufw status 2>/dev/null | grep -q "Status: active"; then
      step "配置防火墙 (ufw)"
      if [[ $CLOUDFLARE -eq 1 ]]; then
        if [[ $CF_ONLY -eq 1 ]]; then
          local cfv4 cfv6 net
          cfv4="$(curl -fsS --max-time 15 https://www.cloudflare.com/ips-v4 2>/dev/null)" || cfv4=""
          cfv6="$(curl -fsS --max-time 15 https://www.cloudflare.com/ips-v6 2>/dev/null)" || cfv6=""
          if [[ -n "$cfv4" ]]; then
            for net in $cfv4 $cfv6; do
              ufw allow from "$net" to any port "$CF_HTTP_PORT" proto tcp >/dev/null 2>&1 || true
              if [[ $HAVE_CF_CERT -eq 1 ]]; then ufw allow from "$net" to any port "$CF_HTTPS_PORT" proto tcp >/dev/null 2>&1 || true; fi
            done
            ok "已仅允许 Cloudflare IP 访问回源端口"
          else
            warn "无法获取 Cloudflare IP 列表，改为放行回源端口（建议手动限制来源）"
            ufw allow "$CF_HTTP_PORT"/tcp >/dev/null 2>&1 || true
            if [[ $HAVE_CF_CERT -eq 1 ]]; then ufw allow "$CF_HTTPS_PORT"/tcp >/dev/null 2>&1 || true; fi
          fi
        else
          ufw allow "$CF_HTTP_PORT"/tcp >/dev/null 2>&1 || true
          if [[ $HAVE_CF_CERT -eq 1 ]]; then ufw allow "$CF_HTTPS_PORT"/tcp >/dev/null 2>&1 || true; fi
          ok "已放行回源端口 ${CF_HTTP_PORT}$([[ $HAVE_CF_CERT -eq 1 ]] && echo "/${CF_HTTPS_PORT}")"
          info "建议: 加 --cf-only 可仅允许 Cloudflare IP 回源，防止绕过 CDN 直连"
        fi
      else
        if [[ $NAT -eq 1 ]]; then
          ufw allow "$CF_HTTP_PORT"/tcp >/dev/null 2>&1 || true
          ufw allow "$CF_HTTPS_PORT"/tcp >/dev/null 2>&1 || true
        else
          ufw allow 80/tcp >/dev/null 2>&1 || true
          ufw allow 443/tcp >/dev/null 2>&1 || true
        fi
        ok "已放行 80/443"
      fi
    fi
  fi
}

# ---------- 启动 ----------
start_services() {
  step "启动服务"
  systemctl enable ${SERVICE} >/dev/null 2>&1 || true
  systemctl restart ${SERVICE}
  systemctl enable caddy >/dev/null 2>&1 || true
  systemctl restart caddy
  sleep 2
  systemctl is-active --quiet ${SERVICE} || { journalctl -u ${SERVICE} -n 30 --no-pager; die "后端启动失败"; }
  ok "后端运行中"
  systemctl is-active --quiet caddy && ok "Caddy 运行中" || warn "Caddy 未运行，请检查 journalctl -u caddy"
}

health_check() {
  step "健康检查"
  local i
  for i in $(seq 1 15); do
    if curl -fsS --max-time 5 "http://127.0.0.1:${BACKEND_PORT}/api/health" >/dev/null 2>&1; then
      ok "后端 API 正常"
      rm -rf "$APP_DIR/server.old" "$APP_DIR/web.old"
      return
    fi
    sleep 1
  done
  warn "后端健康检查超时，请查看日志: journalctl -u ${SERVICE} -f"
}

# ---------- 总结 ----------
print_summary() {
  local user_url admin_url
  if [[ "$MODE" == "ip" ]]; then
    user_url="https://${USER_HOST}"
    admin_url="https://${ADMIN_HOST}"
  else
    user_url="https://${USER_HOST}"
    admin_url="https://${USER_HOST}/admin/"
  fi
  echo
  echo "${C_BOLD}${C_GREEN}============================================================${C_RESET}"
  echo "${C_BOLD}  备忘录 部署完成${C_RESET}"
  echo "${C_BOLD}${C_GREEN}============================================================${C_RESET}"
  if [[ $NAT -eq 1 && $CLOUDFLARE -eq 0 && $NAT_PUBLIC_HTTPS_PORT -ne 443 ]]; then
    user_url="https://${USER_HOST}:${NAT_PUBLIC_HTTPS_PORT}"
    if [[ -n "$ADMIN_HOST" && "$ADMIN_HOST" != "$USER_HOST" ]]; then admin_url="https://${ADMIN_HOST}:${NAT_PUBLIC_HTTPS_PORT}";else admin_url="${user_url}/admin/";fi
  fi
  echo "  用户界面:  ${C_CYAN}${user_url}${C_RESET}"
  echo "  管理界面:  ${C_CYAN}${admin_url}${C_RESET}"
  echo
  echo "  下一步:"
  echo "   1. 打开管理界面，首次进入设置管理员账号密码"
  echo "   2. 在「存储」页选择本地磁盘；或在「机器人」页绑定 Telegram 后使用 TG 存储"
  echo "      (先向机器人发一条消息，再点「自动检测」获取 Chat ID)"
  echo "   3. 打开用户界面注册数字账号，妥善保存密钥，开始使用"
  echo "   4. 如需换域名 / 套 CDN：管理界面「域名」页可随时修改（含 nip.io 换自定义域名）"
  echo
  echo "  常用命令:"
  echo "   ${C_BOLD}SSH 面板:  sudo n-ui${C_RESET}  （大小写混写均可，数字菜单: 启动/停止/改密码/卸载/更新）"
  echo "   查看状态:  systemctl status ${SERVICE} caddy"
  echo "   查看日志:  journalctl -u ${SERVICE} -f"
  echo "   升级程序:  bash install.sh --update"
  echo "   卸载:      bash install.sh --uninstall"
  echo
  if [[ $CLOUDFLARE -eq 1 ]]; then
    echo "  ${C_BOLD}Cloudflare 小黄云设置:${C_RESET}"
    echo "   - DNS 记录指向本机并开启小黄云（代理）"
    echo "   - SSL/TLS 模式选 Flexible：回源走 HTTP 端口 ${C_BOLD}${CF_HTTP_PORT}${C_RESET}"
    if [[ $HAVE_CF_CERT -eq 1 ]]; then
      echo "   - SSL/TLS 模式选 Full / Strict：回源走 HTTPS 端口 ${C_BOLD}${CF_HTTPS_PORT}${C_RESET}（已装 Origin CA 证书）"
    else
      echo "   - 如需 Full / Strict：请先配置 Origin CA 证书（--cf-cert/--cf-key 或 --cf-api-token）"
    fi
    echo "   - 若回源端口非 80/443，请在 CF「Rules -> Origin Rules」把 Destination Port 设为上述端口"
    echo "   - 源站已禁用强制 HTTPS 跳转，Flexible 不会重定向循环"
    echo "   - 建议关闭 Rocket Loader；HSTS 由 Cloudflare 边缘下发"
  elif [[ "$MODE" == "ip" ]]; then
    echo "  ${C_DIM}提示: nip.io 域名证书由 Let's Encrypt 自动签发与续期。${C_RESET}"
    echo "  ${C_DIM}若证书签发稍慢，请稍候 1-2 分钟后刷新。${C_RESET}"
  else
    echo "  ${C_DIM}提示: 请确保域名已解析到本机，证书将自动签发与续期。${C_RESET}"
  fi
  echo "${C_BOLD}${C_GREEN}============================================================${C_RESET}"
}

# ---------- 卸载 ----------
# ---------- SSH 管理面板（n-ui，大小写混写均可） ----------
panel_aliases() {
  local a b c
  for a in n N; do for b in u U; do for c in i I; do
    echo "${a}-${b}${c}"
  done; done; done
}
install_panel() {
  step "安装 SSH 管理面板 (n-ui)"
  local src="$APP_DIR/scripts/n-ui.sh"
  [[ -f "$src" ]] || src="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd)/scripts/n-ui.sh"
  if [[ ! -f "$src" ]]; then warn "未找到 n-ui.sh，跳过面板安装"; return 0; fi
  mkdir -p "$PANEL_BIN_DIR"
  cp "$src" "$PANEL_BIN_DIR/n-ui"
  chmod 0755 "$PANEL_BIN_DIR/n-ui"
  local name
  while read -r name; do
    [[ "$name" == "n-ui" ]] && continue
    ln -sf "$PANEL_BIN_DIR/n-ui" "$PANEL_BIN_DIR/$name"
  done < <(panel_aliases)
  ok "面板已安装: n-ui（大小写混写均可）。SSH 中运行 sudo n-ui"
}
remove_panel() {
  local name
  while read -r name; do rm -f "$PANEL_BIN_DIR/$name"; done < <(panel_aliases)
}

uninstall() {
  step "卸载 备忘录"
  remove_panel
  systemctl stop ${SERVICE} caddy ${SERVICE}-domain.path ${SERVICE}-maintenance.path ${SERVICE}-maintenance.service 2>/dev/null || true
  systemctl disable ${SERVICE} caddy ${SERVICE}-domain.path ${SERVICE}-maintenance.path 2>/dev/null || true
  rm -f /etc/systemd/system/${SERVICE}.service /etc/systemd/system/caddy.service \
        /etc/systemd/system/${SERVICE}-domain.service /etc/systemd/system/${SERVICE}-domain.path
  rm -f /etc/systemd/system/${SERVICE}-maintenance.service /etc/systemd/system/${SERVICE}-maintenance.path /usr/local/libexec/nui-maintenance.mjs
  systemctl daemon-reload
  rm -rf "$APP_DIR" "$CONF_DIR" "$CADDY_FILE"
  if [[ $KEEP_DATA -eq 1 ]]; then
    info "保留数据目录: $DATA_DIR"
  else
    if [[ $ASSUME_YES -eq 0 && -e /dev/tty ]]; then
      read -r -p "是否同时删除所有数据（账号/封禁/机器人绑定）？[y/N] " ans </dev/tty || true
      [[ "${ans:-}" =~ ^[Yy] ]] && KEEP_DATA=0 || KEEP_DATA=1
    fi
    if [[ $KEEP_DATA -eq 0 ]]; then rm -rf "$DATA_DIR" /var/backups/nui-memo /var/lib/nui-maintenance; ok "数据及维护备份已删除"; else info "保留数据: $DATA_DIR"; fi
  fi
  ok "卸载完成（Caddy 二进制保留在 $CADDY_BIN）"
  exit 0
}

# ---------- 主流程 ----------
main() {
  echo "${C_BOLD}"
  echo "  备忘录 (nui-memo) 一键部署"
  echo "  端到端加密 · 本地 / Telegram 存储 · 自动 HTTPS"
  echo "${C_RESET}"
  [[ $EUID -eq 0 ]] || die "请以 root 运行：sudo bash install.sh"
  [[ $DO_UNINSTALL -eq 1 ]] && uninstall
  detect_os
  detect_arch
  install_deps
  install_node
  install_caddy
  # A program update must not reset runtime domains, third-party CDN, certificates,
  # custom origin ports or firewall policy selected in the admin panel.
  if [[ $DO_UPDATE -eq 1 && -f "$CONF_FILE" ]]; then
    BACKEND_PORT="$("$APP_DIR/node/bin/node" -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).port||8787)' "$CONF_FILE")"
    fetch_app
    repair_permissions
    write_maintenance
    start_services
    install_panel
    health_check
    ok "程序更新完成；数据、域名、CDN、证书与防火墙配置保持不变"
    return
  fi
  resolve_cf_defaults
  if [[ $NAT -eq 1 && -n "$NAT_PUBLIC_IP" ]]; then
    "$APP_DIR/node/bin/node" -e 'if(!require("net").isIP(process.argv[1]))process.exit(1)' "$NAT_PUBLIC_IP" || die "NAT 入口公网 IP 无效"
    PUBLIC_IP="$NAT_PUBLIC_IP";[[ "$PUBLIC_IP" == *:* ]] && IP_FAMILY=6 || IP_FAMILY=4
  elif ! detect_ip; then
    die "无法检测公网 IP；NAT 可用 --nat-public-ip 指定服务商入口 IP"
  fi
  ok "公网 IP: $PUBLIC_IP (IPv$IP_FAMILY)"
  choose_domain
  fetch_app
  write_config
  setup_cloudflare_cert
  write_caddyfile
  write_systemd
  write_domain_apply
  write_maintenance
  setup_firewall
  start_services
  install_panel
  health_check
  print_summary
}

# 通过 stdin 运行（curl ... | bash）时 BASH_SOURCE 未设置，set -u 下需回退到 $0，
# 否则报 "BASH_SOURCE[0]: unbound variable"。回退后 stdin 场景判定为直接执行，正常进入 main。
if [[ "${BASH_SOURCE[0]:-$0}" == "${0}" ]]; then
  main "$@"
fi
