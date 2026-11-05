# 备忘录 (nui-memo)

一个可以开放给他人使用的**端到端加密备忘录**服务。文字、图片、视频、文件在你的浏览器里加密后，由管理员统一选择存入**服务器磁盘或 Telegram**。备忘录内容始终端到端加密，管理员看不到正文；公开头像、网名和简介除外。

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
- **端到端加密**：HKDF-SHA256 派生密钥，AES-256-GCM 加密；主密钥不上传服务器（可由用户选择保存在本机浏览器）
- 管理员可管理账号、公开资料、存储及主题，但看不到备忘录内容
- 内容密文可存 **Telegram 或本地磁盘**，管理员可逐文件校验迁移，默认删除原文件
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

### 2. 选择存储
在管理界面「存储」页可直接选择服务器磁盘，无需绑定机器人。若选择 Telegram，则按下面步骤绑定：
1. 在 Telegram 找 [@BotFather](https://t.me/BotFather)，发送 `/newbot` 创建一个机器人，拿到 **Bot Token**。
2. 向你的机器人**发送一条任意消息**（或把它拉进一个群组）。
3. 在管理界面「机器人」页点「绑定机器人」，填入 Token，点「**自动检测 Chat**」即可获取 Chat ID，再点「绑定」。
4. 可绑定多个机器人，系统会自动轮询分担上传流量。

选择本地磁盘，或选择 Telegram 并绑定成功后，用户即可保存内容。旧安装保持原有 Telegram 模式，不会自动迁移。

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
- **DNS 记录助手**：自动推导本机公网 IP（安装时写入 `publicIp`，或从 nip.io 主机名解析），给出建议的 A/AAAA 记录（类型 / 主机记录 / 记录值 / TTL）并一键复制；套 CF 时提示开启小黄云。
- **一键诊断**：一次检测 DNS 解析、边缘 HTTPS/HTTP 可达性与延迟、是否经由 Cloudflare、边缘证书颁发者与剩余有效期、本机回源自检，并给出针对性建议（如 SSL 模式与回源证书不匹配）。
- **Cloudflare 端口快选**：列出 CF 默认代理的 HTTP/HTTPS 回源端口供一键选择；填了非支持端口会告警（需 Spectrum）。
- **CF Token 验证**：填写 API Token 后可先验证有效性再用于自动签发。
- **辅助工具**：DNS 解析检测（判断是否落在 Cloudflare 边缘 / 是否指向本机）、Caddyfile 预览、仅允许 CF IP 回源开关。

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
- 图标尺寸与容器严格匹配（按钮 / 输入框 / 抽屉 / 菜单 / 徽标），小图标不再超出边界；分段按钮改用中等圆角，视觉更稳重。

---

## 前端导出与跨域（GitHub Pages 等静态托管）

管理面板「前端 / 跨域」页：

- **跨域开关**：`关闭跨域`（默认，仅同域）/ `白名单` / `允许所有`。白名单支持**批量添加 / 移除** Origin（如 `https://name.github.io`）。
- **导出单文件前端**：一键下载 `index.html`，内联全部样式 / 脚本 / 图标 / 加密 Worker，并**自动写入 API 地址**（你的用户域名），部署到 GitHub Pages 后开箱即用，无需手动改代码。
- 外部前端使用 **Bearer token** 鉴权（登录 / 注册返回 token，存于 localStorage），不依赖跨站 Cookie；服务端对已加白名单的 Origin 放行 CORS 与 CSRF。
- 重新构建导出模板：`npm i -D esbuild && npm run build:export`（运行时仍零依赖）。

```bash
# 部署到 GitHub Pages：把导出的 index.html 推送到仓库即可
# 然后在管理面板把 https://<user>.github.io 加入跨域白名单
```

---

## 广告投放

管理面板「广告」页：

- **投放开关**：一键开启 / 关闭，关闭后用户端不展示任何广告。
- **自有广告**：批量管理图片 + 链接卡片（标题 / 图片 URL / 跳转链接，可单独启用 / 删除）。
- **广告网络**：粘贴 AdSense 等网络的 HTML/JS 代码，在**沙箱 iframe** 中渲染，与主应用隔离。
- 广告配置通过公开 `/api/config` 下发，用户端在备忘录列表上方展示广告位。

---

## 隐私与威胁模型

**管理员能看到什么？**
- 账号列表、数量/容量统计、封禁状态、IP 规则、机器人状态、审计日志。
- Telegram 聊天里能看到一条条**密文文件**（文件名含账号与备忘录 ID），但**无法解密**。

**管理员看不到什么？**
- 任何备忘录的标题、正文、图片、视频、文件内容——全部在用户浏览器内加密。

**磁盘上有什么？**
- 账号元数据、会话哈希、封禁规则、机器人凭据，以及每条备忘录的**密文元数据**（标题/摘要的密文，用于列表与搜索）。
- 本地模式下正文与媒体密文存于数据目录的 `objects/`；Telegram 模式存于机器人聊天。账号、索引、配置和公开素材的服务端密钥始终保留在服务器。

**边界（请知悉）**
- 机密性由端到端加密保证；但**可用性**取决于管理员——管理员控制机器人/聊天，理论上可删除消息。请把本服务用于「不信任服务器偷看，但信任其不恶意删除」的场景。
- 密钥在浏览器内存中用于解密；提供「自动锁定」与可选「本设备记住账号与密钥」（localStorage，默认关闭；退出或锁定会清除）。

---

## SSH 管理面板（n-ui）

安装后在 SSH 里输入 **`n-ui`**（大小写混写均可，如 `N-UI` / `n-Ui` / `N-uI`，安装时已建好全部别名）即可打开数字菜单面板：

```
1) 查看状态        2) 启动服务        3) 停止服务
4) 重启服务        5) 查看日志        6) 修改管理员账号 / 密码
7) 保留数据卸载    8) 完整卸载（清除数据）  9) 更新程序
0) 退出
```

- 输入数字回车执行；卸载 / 更新等危险操作需输入 `YES` 二次确认。
- **修改管理员密码**：短暂停止服务 → 写入新凭据（scrypt）→ 使所有管理员会话失效 → 自动重启。忘记网页密码时也可用它重置。
- **保留数据卸载**：移除程序 / 配置 / Caddy / 面板别名，但保留 `/var/lib/nui-memo` 数据。
- **完整卸载**：连同数据一起删除，不可恢复。
- 也支持非交互直跑：`sudo n-ui status|start|stop|restart|logs`。
- 面板与 CLI 均为零依赖（bash + 内置 Node），随一键脚本自动安装到 `/usr/local/bin/n-ui`。

---

## 运维

```bash
sudo n-ui                          # SSH 数字菜单面板（推荐）
systemctl status nui-memo caddy      # 状态
journalctl -u nui-memo -f            # 后端日志
journalctl -u caddy -f               # 证书/代理日志
sudo bash install.sh --update        # 升级
```

- **数据目录**：`/var/lib/nui-memo`（`snapshot.json` + `events.jsonl` + 本地模式下的 `objects/`）。应完整备份该目录；Telegram 模式仍须保留机器人聊天中的文件。
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

# 跨域 / Bearer 外部前端 / 广告 / 单文件导出测试
node test/frontend-deploy.mjs
# 域名/CDN 诊断增强测试（serverIp / CF 端口告警 / 一键诊断 / CF Token 验证）
node test/domain-probe.mjs
# SSH 面板测试（n-ui 大小写别名 / 菜单 / CLI 重置管理员密码）
bash test/panel.sh
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

### 简化的域名设置

域名页按「选择访问方式 → 填写域名 → 应用更改」配置。端口、Full/Strict、回源证书、真实 IP 头、防火墙与 Caddyfile 预览收进高级设置，原有功能保留。

新选 CDN 且未配置加密模式时，无证书使用 Flexible（源站链路为 HTTP），有证书使用 Strict；已有模式不会被覆盖。CDN 控制台的 SSL 模式仍需手动匹配，使用非标准端口还需要在 CDN 配置回源端口规则。521 表示连接源站被拒绝，后端进程自检成功不能证明 Caddy 或公网回源正常。

可选 DOM 交互回归（jsdom 仅用于测试，不是运行依赖）：

```bash
npm install --prefix /tmp/nui-ui-test jsdom@24
NUI_JSDOM_MODULE=/tmp/nui-ui-test/node_modules/jsdom node test/domain-ui.cjs
```

### 记住登录与公开资料（v1.4.0）

- 登录页或「设置 → 外观与安全」可开启“记住账号与密钥”，默认关闭。凭据保存在当前站点的浏览器 localStorage，不上传服务器；重新打开可自动登录。仅适用于私人设备，本机使用者、恶意扩展或站点脚本漏洞可能读取它。换浏览器、换站点或清除网站数据后需重新输入，请自行备份密钥。
- 设置中可随时关闭、复制账号或确认后复制密钥。退出、手动锁定和自动锁定均清除已记住的凭据，防止刷新绕过锁定。
- 「设置 → 公开资料」支持唯一网名（2–24 个文字/数字/下划线/短横线）、280 字简介，以及头像上传/移除。网名按 NFKC 与大小写归一化检查唯一性，可修改，修改后旧网名释放。
- 头像在浏览器裁剪为 256×256 JPEG，最大上传 128KB；原图限 JPEG/PNG/WebP、5MB。头像以独立服务端密钥加密后存入管理员指定的 Telegram 或本地磁盘，由 VPS 中转解密。公开资料不是端到端私密数据，管理员可见；此密钥与用户备忘录密钥无关。
- 管理端用户列表展示头像、网名、简介，可按网名搜索。公开接口 `GET /api/profiles/:nickname` 返回公开资料，不含登录账号、认证证明或存储密钥；头像经 `/api/avatars/:nickname` 中转。封禁或删除账号后资料不再公开。
- GitHub Pages 等静态导出需重新从更新后的管理端导出并替换 `index.html`，后端也必须更新，才能使用新接口和本次 UI 修复。

用户界面交互回归：
```bash
npm install --prefix /tmp/nui-ui-test jsdom@24
NUI_JSDOM_MODULE=/tmp/nui-ui-test/node_modules/jsdom node test/user-ui.cjs
```

### 管理员存储与主题（v1.5.0）

**存储选择仅管理员可操作**：「存储」页选择服务器磁盘或 Telegram，用户无切换权限。现有安装默认保持 Telegram，未绑定机器人也可以先切换本地模式。服务器端仍无 npm 运行依赖。

迁移范围包含所有用户的备忘录密文分块/缩略图、公开头像以及桌宠/手机/平板/电脑背景素材。每次请求只迁移一个对象：复制 → SHA-256 对比 → fsync 元数据 → 删除原副本。原位置默认清理，若 TG 拒绝删除（例如旧消息受平台限制），会显示「待清理」并支持重试，绝不把失败当作清空。含未迁移文件或待清理副本的机器人不允许移除。

- 全站迁移期间暂停内容与配置写入；已登录用户仍可读取。当前文件完成后关闭管理页即暂停，下次点「继续迁移」；中断/重启保留进度。取消后恢复写入，已完成的对象不会回滚，混合存储可正常读取。
- 本地文件在 `<dataDir>/objects/`，随机文件名，目录权限 0700，文件权限 0600。原有备忘录始终端到端加密；公开素材使用独立服务端 AES-GCM 密钥，不会发送用户密钥。
- **Telegram 模式不是无状态服务器**：账号、会话、索引、机器人凭据、服务端素材密钥、迁移清理记录仍保留本地；请备份数据目录。迁移不是数据库导出，也不会将这些控制数据删除。
- 删除可能保留源副本、失败的临时上传或进程崩溃前尚未登记的文件；不要直接清空整个 TG 聊天或数据目录。磁盘满、TG 断网、校验失败时原文件不会被迁移逻辑删除。

**主题页仅管理员可操作**：分别设置用户端/管理端主色及恢复默认，开启/关闭桌宠、管理端是否展示及 48–240px 尺寸；手机、平板和电脑背景独立上传，缺省向较大设备回退。全站素材跟随所选存储，迁移自动覆盖。用户重新打开页面获取新主题；GitHub Pages 用户需先更新一次导出 HTML，以包含新主题加载逻辑。

**浏览器本机处理**：选择文件 → 设置抠图参数 → 压缩/预览 → 确认上传，原图不会上传。使用专用 Worker 与 OffscreenCanvas，页面退出或取消会终止 Worker、清理超时和 Blob URL。单次处理限 90 秒；旧浏览器不支持离屏画布时会明确提示升级，不在服务器偷偷处理。

| 内容 | 限制与输出 |
| --- | --- |
| 原始素材 | JPEG / PNG / WebP / GIF，最多 12MB；静态图最多 3200 万像素 |
| 静态桌宠 | 最长边 512px，WebP（浏览器编码器不支持时可能回退 PNG），保留透明度 |
| 静态背景 | 手机 960px / 平板 1440px / 电脑 1920px 最长边，WebP；超限自动降低质量及尺寸 |
| GIF | 单帧最多 400 万像素、240 帧、总计 6400 万像素；保留帧数、时长与透明度，最长边先 320px（桌宠）/512px（背景），超限再缩至 192/128px |
| 最终上传 | 桌宠 ≤2MiB，背景 ≤1.5MiB；GIF 缩小后仍超限会拒绝，不会变成静态图 |
| 抠图 | 边缘连通纯色/近纯色背景，可自动取左上角色或指定背景色、调整容差；不是 AI 复杂场景分割，须检查预览 |

桌宠固定在视口内，尺寸限制于视口宽高，考虑安全区、横屏与小屏，不接收点击；隐藏页面或启用系统减少动画时移除动画源。主题反复应用时移除旧样式、图片和监听器，无常驻 JS 动画循环。

构建与回归（GIF 库只用于构建，产物自托管，无第三方 CDN）：
```bash
npm ci
npm run build:theme
npm run build:export
node test/storage-safety.mjs
node test/smoke.mjs
# 可选浏览器 DOM / Canvas 回归依赖，不参与产品运行
npm install --prefix /tmp/nui-ui-test jsdom@24 @napi-rs/canvas@0.1.80
NUI_JSDOM_MODULE=/tmp/nui-ui-test/node_modules/jsdom node test/appearance-ui.cjs
NUI_CANVAS_MODULE=/tmp/nui-ui-test/node_modules/@napi-rs/canvas node test/theme-worker.cjs
```

## 2.0.0 发布验收

已增加完整回归入口 `bash scripts/check-release.sh` 和 GitHub Actions 校验。
本次自检修复了更新、鉴权、并发上传、持久化/迁移、域名失败回滚和媒体生命周期等边界问题。
详细的测试结果、修复清单、生产部署限制与重现命令见 [2.0.0 验收报告](docs/RELEASE-2.0.0.md)，功能与升级说明见 [更新日志](CHANGELOG.md)。
