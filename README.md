# 备忘录 (nui-memo)

一个可以开放给他人使用的**端到端加密备忘录**服务。文字、图片、视频、文件在你的浏览器里加密后，通过你的 VPS 中转存入**管理员的 Telegram 机器人**——服务器不落盘任何明文，管理员也看不到任何内容。

Material Design 3 界面 · 亮/暗主题 · 响应式 · 数字账号 · 自动 HTTPS · 一键部署。

---

## 特性一览

**部署**
- 一键脚本，支持 **Debian 11 / 12 / 13**、**Ubuntu 22.04 / 24.04 / 26.04**（amd64 / arm64）
- 自动检测公网 IP，自动申请并续期 HTTPS 证书（Caddy + Let's Encrypt）
- 可输入自己的域名，也可由系统自动分配 `随机前缀 + IP + nip.io` 域名
- IP 证书模式下，**用户界面与管理界面使用两个独立子域名**，各自独立证书
- systemd 守护、开机自启、优雅重启、防火墙自动放行

**隐私与安全**
- 类 Mullvad 的 **16 位数字账号** + 一把 **随机密钥**（base32，52 字符），无需邮箱/手机号
- **端到端加密**：HKDF-SHA256 派生密钥，AES-256-GCM 加密；主密钥只在你的浏览器内存中
- 管理员**只能管理账号与封禁**，看不到任何文字、图片、视频
- 内容密文**只存 Telegram**，服务器磁盘只有加密的元数据索引（标题/摘要密文）
- 图片预览经 **VPS 中转**，浏览器绝不直接访问 `t.me`，国内可正常预览
- 登录限流、CSRF 防护、HttpOnly/SameSite Cookie、CSP、scrypt 口令哈希、自动锁定

**管理**
- 首次进入管理界面要求设置管理员账号密码
- 用户批量管理：封禁 / 解封 / 删除（含清除 Telegram 密文）
- IP 封禁：单 IP、CIDR 网段、通配符、区间，**IPv4 / IPv6** 均支持，可批量粘贴
- 绑定多个 Telegram 机器人分担流量，自动检测 Chat ID、连接测试、队列状态
- 概览仪表盘、系统监控、审计日志、站点设置

**体验**
- Material Design 3 设计系统，亮/暗一键切换，丝滑动画与涟漪反馈
- 全站图标（Material Symbols），无 emoji
- 手机/平板/桌面响应式，移动端不挤出屏幕
- **虚拟滚动**：十万条备忘录依然流畅；搜索索引在 Web Worker 解密，主线程零阻塞
- 图片缩略图内存 LRU 缓存、对象 URL 统一回收，无内存泄漏
- 文字/图片/视频/文件，数量不限；置顶、批量管理、搜索、网格/列表视图

---

## 一键安装

以 root 运行：

```bash
curl -fsSL https://raw.githubusercontent.com/elysianki4225-png/nui/main/install.sh | bash
```

或克隆仓库后本地运行：

```bash
git clone https://github.com/elysianki4225-png/nui.git
cd nui
sudo bash install.sh
```

安装过程中会提示输入域名（需已解析到本机），**直接回车**则由系统自动分配 nip.io 域名。

### 常用参数

```bash
sudo bash install.sh --domain m.example.com   # 使用自定义域名
sudo bash install.sh --auto                   # 全自动，使用 nip.io
sudo bash install.sh --update                 # 升级程序（保留数据与绑定）
sudo bash install.sh --uninstall              # 卸载
sudo bash install.sh --uninstall --keep-data  # 卸载但保留数据

# Cloudflare 小黄云（详见下文）
sudo bash install.sh --domain m.example.com --cloudflare \
     --cf-cert origin.pem --cf-key origin.key \
     --cf-http-port 80 --cf-https-port 443
```

安装完成后会打印**用户界面**与**管理界面**两个 HTTPS 网址。

> 中国大陆网络若下载 Node.js / Caddy 较慢，脚本已内置 npmmirror 与 gh-proxy 备用源。

---

## 首次使用

### 1. 初始化管理员
打开**管理界面**网址，首次进入会要求设置管理员用户名与密码。

### 2. 绑定 Telegram 机器人
1. 在 Telegram 找 [@BotFather](https://t.me/BotFather)，发送 `/newbot` 创建一个机器人，拿到 **Bot Token**。
2. 向你的机器人**发送一条任意消息**（或把它拉进一个群组）。
3. 在管理界面「机器人」页点「绑定机器人」，填入 Token，点「**自动检测 Chat**」即可获取 Chat ID，再点「绑定」。
4. 可绑定多个机器人，系统会自动轮询分担上传流量。

绑定成功后，用户才能保存内容。

### 3. 用户注册
打开**用户界面**网址 → 注册 → 系统生成数字账号与密钥 → **务必抄写/下载保存密钥** → 进入即可使用。

> 密钥丢失无法找回，也无法再查看已存内容。这正是端到端加密的意义。

---

## 两种域名模式

| 模式 | 用户界面 | 管理界面 | 适用 |
|---|---|---|---|
| 自定义域名 | `https://m.example.com` | `https://m.example.com/admin/` | 生产推荐，稳定 |
| 自动 IP (nip.io) | `https://memo-<rand>.<ip>.nip.io` | `https://admin-<rand>.<ip>.nip.io` | 快速体验，无需域名 |

- 自定义域名需先把 A/AAAA 记录解析到 VPS，脚本会校验解析是否正确。
- nip.io 模式两个子域名各自独立证书，全自动签发与续期。
- nip.io 为免费共享域名，受 Let's Encrypt 速率限制，**长期使用建议绑定自己的域名**（`--update --domain your.domain`）。

---

## Cloudflare 小黄云（CDN 代理）

自定义域名可以套 Cloudflare 橙色云代理。脚本提供 `--cloudflare` 模式，**同时兼容 Flexible 与 Full/Strict 两种 SSL 模式，并支持自定义回源端口**：

```bash
# 方式 A：手动提供 Origin CA 证书（推荐，Strict 最稳）
# 先在 CF 控制台 SSL/TLS -> Origin Server -> Create Certificate 下载 cert/key
sudo bash install.sh --domain m.example.com --cloudflare \
     --cf-cert /path/origin.pem --cf-key /path/origin.key

# 方式 B：用 API Token 自动签发 Origin CA 证书（需 SSL and Certificates 权限）
sudo bash install.sh --domain m.example.com --cloudflare --cf-api-token <CF_API_TOKEN>

# 自定义回源端口（例如 CF Origin Rule 把回源指到 8443 / 8080）
sudo bash install.sh --domain m.example.com --cloudflare \
     --cf-cert origin.pem --cf-key origin.key \
     --cf-https-port 8443 --cf-http-port 8080

# 仅允许 Cloudflare IP 回源，防止绕过 CDN 直连源站
sudo bash install.sh --domain m.example.com --cloudflare --cf-only ...
```

工作原理与 CF 侧设置：

| CF SSL 模式 | 回源协议/端口 | 需要的证书 | 说明 |
|---|---|---|---|
| Flexible | HTTP `--cf-http-port`（默认 80） | 不需要 | 源站**不强制跳转 HTTPS**，避免重定向循环 |
| Full / Strict | HTTPS `--cf-https-port`（默认 443） | Origin CA 证书 | Strict 会校验证书主机名，Origin CA 证书受 CF 信任 |

- 脚本在 CF 模式下关闭 Caddy 自动 HTTPS 与强制跳转，改为按端口分别监听 HTTP/HTTPS 回源；HSTS 交给 CF 边缘下发。
- 后端优先读取 `CF-Connecting-IP` 作为真实访客 IP（用于限流与 IP 封禁），Flexible 回源（HTTP）下仍会下发 `Secure` Cookie。
- 若回源端口不是 80/443，请在 CF「Rules → Origin Rules」把 **Destination Port** 设为对应端口（或使用 CF 支持的端口）。
- 建议关闭 Rocket Loader；升级时 CF 配置会自动复用，也可用 `--no-cloudflare` 改回直连。
- 未提供证书时仅启用 Flexible（HTTP 回源）；补上 `--cf-cert/--cf-key` 重新运行即可启用 Full/Strict。

---

## 域名管理（管理面板，运行时切换）

部署后无需重装，在**管理界面 →「域名」**页即可随时调整：

- **换域名**：哪怕安装时用的是 nip.io，也能直接改成自己的域名（或改回 nip.io / IP 模式）。
- **CDN 代理**：支持 **Cloudflare 小黄云** 与 **第三方 CDN**（阿里云 / 腾讯云 EdgeOne 等），也可切回直连。
- **加密模式**：Flexible（HTTP 回源）/ Full / Strict（HTTPS 回源），随时切换。
- **自定义回源端口**：HTTP / HTTPS 回源端口均可自定义，**冷门端口**也支持（配合 CDN 的回源端口规则）。
- **回源证书**：粘贴 Origin CA 证书 + 私钥，或填 Cloudflare API Token 自动签发；Strict 无证书时自动回退 Flexible 并提示。
- **真实访客 IP**：Cloudflare 默认 `CF-Connecting-IP`；第三方可选 `X-Forwarded-For` / `X-Real-IP` / `True-Client-IP`，限流与 IP 封禁据此识别。
- **辅助工具**：DNS 解析检测（并判断是否落在 Cloudflare 边缘）、Caddyfile 预览、仅允许 CF IP 回源开关。

应用机制：

- 一键脚本部署会安装一个 **systemd path + root helper**（`nui-memo-domain.path/.service`）。面板提交后由 root helper 写入证书 / 配置 / Caddyfile，`caddy validate` 校验通过后重载 Caddy 并重启后端，全程自动。
- 后端会**热更新**域名相关行为（路由、Cookie、真实 IP、HSTS），并把设置持久化到 `DATA_DIR/domain.json`，重启后仍生效。
- 若未启用特权自动应用（如手动运行），面板会热更新后端并给出完整 Caddyfile 与手动应用指引。
- 安装脚本与管理面板**共用同一个 Caddyfile 生成器**（`server/domain.js`），保证两者输出一致。

> 注意：域名变更后，旧域名上的登录会话会失效，请到新域名重新登录。面板会显示新的用户 / 管理网址并提供一键打开。

---

## 界面与响应式（M3）

- **桌面（≥840px）**：高密度布局 —— 侧边导航 rail + 紧凑数据表格，一屏更多信息。
- **移动（<840px）**：汉堡按钮 + **M3 侧边抽屉**导航（不再用会溢出的底部导航），表格自动切换为卡片，表单/分段按钮自适应窄屏，杜绝横向溢出。
- 亮 / 暗主题、涟漪与动效遵循 Material Design 3，并支持 `prefers-reduced-motion`。
- 注册 / 登录 / 密钥展示在窄屏下自动收紧边距与字号，长密钥自动换行，可复制 / 下载。

---

## 隐私与威胁模型

**管理员能看到什么？**
- 账号列表、数量/容量统计、封禁状态、IP 规则、机器人状态、审计日志。
- Telegram 聊天里能看到一条条**密文文件**（文件名含账号与备忘录 ID），但**无法解密**。

**管理员看不到什么？**
- 任何备忘录的标题、正文、图片、视频、文件内容——全部在用户浏览器内加密。

**磁盘上有什么？**
- 账号元数据、会话哈希、封禁规则、机器人凭据，以及每条备忘录的**密文元数据**（标题/摘要的密文，用于列表与搜索）。
- **正文与媒体密文只存在于 Telegram**，服务器不缓存、不落盘。

**边界（请知悉）**
- 机密性由端到端加密保证；但**可用性**取决于管理员——管理员控制机器人/聊天，理论上可删除消息。请把本服务用于「不信任服务器偷看，但信任其不恶意删除」的场景。
- 密钥在浏览器内存中用于解密；提供「自动锁定」与可选「本设备记住密钥」（仅 sessionStorage，关闭标签页即清除）。

---

## 运维

```bash
systemctl status nui-memo caddy      # 状态
journalctl -u nui-memo -f            # 后端日志
journalctl -u caddy -f               # 证书/代理日志
sudo bash install.sh --update        # 升级
```

- **数据目录**：`/var/lib/nui-memo`（`snapshot.json` + `events.jsonl`）。备份此目录即可备份账号/封禁/绑定（内容在 Telegram）。
- **配置**：`/etc/nui-memo/config.json`。
- **程序**：`/opt/nui-memo`。
- 修改域名 / CDN / 回源端口：推荐在管理界面「域名」页直接修改（运行时生效，见下文）；也可 `sudo bash install.sh --update --domain new.example.com`。

### 主要配置项（`config.json`）

| 键 | 默认 | 说明 |
|---|---|---|
| `maxFileSize` | 134217728 (128MB) | 单文件上限，最大 512MB |
| `chunkSize` | 16777216 (16MB) | 分块大小（受 Telegram 20MB 下载限制约束） |
| `thumbCacheMB` | 64 | 缩略图内存缓存上限 |
| `uploadConcurrency` | 3 | 全局上传并发 |
| `uploadQueueMB` | 96 | 上传队列内存上限 |
| `telegramApiBase` | `https://api.telegram.org` | 可指向自建 Bot API 服务器 |
| `cdn` | `none` | `none` / `cloudflare` / `custom`（第三方 CDN） |
| `sslMode` | `auto` | 直连 `auto`；CDN 下 `flexible` / `full` / `strict` |
| `cfHttpPort` / `cfHttpsPort` | 80 / 443 | CDN 回源 HTTP / HTTPS 端口（可自定义冷门端口） |
| `realIpHeader` | 按 CDN | 真实访客 IP 头：`cf-connecting-ip` / `x-forwarded-for` / `x-real-ip` / `true-client-ip` |
| `cfOnly` | false | 防火墙仅允许 Cloudflare IP 回源 |

站点级设置（注册开关、单文件上限、会话时长、自动锁定、公告）在管理界面「设置」页调整。

---

## 常见问题

**`curl ... | bash` 报 `BASH_SOURCE[0]: unbound variable`？**
v1.1.1 已修复。旧版脚本在 `set -u` 下通过 stdin 运行时 `BASH_SOURCE` 未设置导致报错。请重新执行最新的一键安装命令，或先下载再运行：`curl -fsSL <url> -o install.sh && sudo bash install.sh`。

**管理界面打开是空白？**
v1.0.1 已修复管理端脚本的一处语法错误。请升级到最新版（`bash install.sh --update`）并强制刷新浏览器（Ctrl+F5 / 清缓存）。若仍空白，打开浏览器控制台查看报错，并确认 `/admin/app.js` 能正常返回 200。

**套了 Cloudflare 小黄云后打不开 / 重定向循环？**
使用 `--cloudflare` 模式部署，或在管理界面「域名」页把 CDN 设为 Cloudflare 并选对加密模式。Flexible 必须走 HTTP 回源端口且源站不强制跳转（已处理）；Full/Strict 需要 Origin CA 证书并走 HTTPS 回源端口。详见上文 Cloudflare 与域名管理章节。

**部署后想换域名 / 套第三方 CDN / 改回源端口？**
管理界面「域名」页可随时修改，无需重装。支持 nip.io 换自定义域名、Cloudflare 与第三方 CDN、Flexible/Full/Strict、自定义（含冷门）回源端口。域名变更后请到新域名重新登录。

**国内用户图片打不开？**
图片/视频均经你的 VPS 中转（`/api/user/memos/:id/...`），浏览器不直连 `t.me`，只要 VPS 能访问 Telegram 即可正常预览。

**证书签发慢/失败？**
确认 80/443 端口开放、域名解析正确。nip.io 偶有速率限制，稍候 1-2 分钟或改用自定义域名。查看 `journalctl -u caddy -f`。

**单个文件最大多少？**
默认 128MB（分块上传，每块 16MB 以符合 Telegram Bot 下载限制）。可在配置中调高至 512MB。

**上传速度？**
受 Telegram 机器人限速（约 1 条/秒/聊天），系统内置限速队列与 429 退避；绑定多个机器人可提升吞吐。

**忘记密钥？**
无法找回。端到端加密下没有任何人（包括管理员）能恢复你的内容。

---

## 本地开发与测试

零依赖后端（Node.js ≥ 20），前端为原生 ES 模块 + 本地化 M3 设计系统。

```bash
# 前端/后端 ESM 语法门禁（防止白屏类语法错误）
node --experimental-vm-modules test/frontend-check.mjs

# 端到端冒烟测试（内置 Telegram 模拟器）
node test/smoke.mjs

# Cloudflare 后端行为测试（真实 IP / Secure Cookie / HSTS / 封禁）
node test/cloudflare.mjs

# 域名 / CDN 管理测试（校验 / Caddyfile / 特权应用 / API 热切换 / 重启持久化）
node test/domain.mjs

# 一键脚本生成的配置 / Caddyfile 测试（含 CF 模式，无需 root）
bash test/install-cf.sh

# 一键脚本 stdin（curl | bash）/ --help / source 行为回归
bash test/install-stdin.sh

# 启动演示（模拟存储）
node test/mock-telegram.mjs 9099 &
MEMO_DEV=1 MEMO_HOST=0.0.0.0 MEMO_PORT=8080 \
MEMO_DATA_DIR=.demo-data MEMO_TELEGRAM_API=http://127.0.0.1:9099 \
node server/index.js
# 填充演示数据
node test/seed-demo.mjs
```

### 目录结构

```
nui/
├── install.sh              一键部署脚本
├── server/                 零依赖 Node.js 后端
│   ├── index.js            入口 / HTTP / 安全头 / IP 封禁
│   ├── api*.js             公共 / 用户 / 管理员 API
│   ├── store.js            内存索引 + 事件日志 + 快照
│   ├── security.js         哈希 / 会话 / 限流 / CIDR 匹配 / 真实 IP
│   ├── domain.js           域名校验 / Caddyfile 生成 / 特权应用
│   ├── domain-manager.js   运行时域名管理（热更新 / 持久化 / 应用调度）
│   ├── telegram.js         机器人池 / 限速队列 / 流式中转
│   └── static.js           静态资源 / Host 路由
├── web/
│   ├── assets/             M3 设计系统 / 图标 / 字体 / 共享 JS
│   ├── user/               用户 SPA + 加密 Worker
│   └── admin/              管理 SPA
├── test/                   冒烟测试 / Telegram 模拟 / 演示数据
└── scripts/                资源构建（开发期）
```

---

## 许可

本项目按仓库现有许可发布。图标来自 Material Design Icons（Apache-2.0），字体 Roboto / Roboto Mono（Apache-2.0）。
