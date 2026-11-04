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
- 修改域名：`sudo bash install.sh --update --domain new.example.com`。

### 主要配置项（`config.json`）

| 键 | 默认 | 说明 |
|---|---|---|
| `maxFileSize` | 134217728 (128MB) | 单文件上限，最大 512MB |
| `chunkSize` | 16777216 (16MB) | 分块大小（受 Telegram 20MB 下载限制约束） |
| `thumbCacheMB` | 64 | 缩略图内存缓存上限 |
| `uploadConcurrency` | 3 | 全局上传并发 |
| `uploadQueueMB` | 96 | 上传队列内存上限 |
| `telegramApiBase` | `https://api.telegram.org` | 可指向自建 Bot API 服务器 |

站点级设置（注册开关、单文件上限、会话时长、自动锁定、公告）在管理界面「设置」页调整。

---

## 常见问题

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
# 端到端冒烟测试（内置 Telegram 模拟器）
node test/smoke.mjs

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
│   ├── security.js         哈希 / 会话 / 限流 / CIDR 匹配
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
