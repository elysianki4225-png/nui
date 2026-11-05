# 2.0.0 发布验收报告

验收日期：2026-11-05。版本：2.0.0。验收使用 Node.js 22、隔离数据目录、模拟 Telegram、jsdom、Canvas 和真实 Chromium；不操作生产 VPS 数据。

## 结论

已完成可执行范围内的全量回归和重点代码审查，发现的问题已修复并新增回归测试。**“通过验收”不等于证明不存在任何缺陷**。真实 VPS 的系统服务、防火墙、ACME 证书、Cloudflare 控制台及 Telegram 平台权限/限流，仍须部署环境验收，见下方边界。

## 功能覆盖与结果

| 范围 | 验证方式及结果 |
| --- | --- |
| 前后端模块 | 27/27 个模块 ESM 语法通过 |
| 端到端主链路 | `smoke.mjs` 70/70：注册、管理员初始化、机器人绑定、加密文字/图片、缩略图、中转解密、封禁、删除/注销、公开资料、头像、两向迁移、主题素材、权限控制 |
| 发布安全回归 | `release-regression.mjs` 19 项：并发初始化、无 TG 本地存储、Bearer/Cookie 优先级、CSRF、跨账号隔离、并发重复分块、文件大小一致性、稀疏分块删除、URL 解码、改密会话失效、坏快照保护、关闭存储保护、无未处理异常 |
| CDN | `cloudflare.mjs` 7/7：Flexible HTTPS 识别、Cookie、HSTS、访客 IP、封禁 |
| 域名 | `domain.mjs` 33/33：域名/端口校验、Caddy 配置、证书处理、拒绝静默降级、CF 来源限制/伪造头剥离、持久化、重启 |
| 域名失败回滚 | `domain-rollback.mjs`：模拟特权 Caddy 校验失败，原配置、运行时域名、Caddyfile、证书、私钥完整恢复 |
| DNS/CDN 诊断 | `domain-probe.mjs` 11/11：公网 IP、CF 端口、探测、模拟 Token 验证 |
| 跨域/导出/广告 | `frontend-deploy.mjs` 11/11：CORS 三种模式、导出、广告配置、批量操作、公开配置 |
| 存储异常 | `storage-safety.mjs`：校验失败不删源、删除失败记录、重启恢复、活引用保护、元数据 I/O 失败、快照/日志串行化 |
| 安装/运维 | install-cf、install-stdin、install-update、panel 全部通过；覆盖 curl 管道安装、配置生成、在已安装目录更新、保留回滚副本、脚本覆盖、证书复用、8 种大小写命令、重置管理员/失效会话；系统命令使用 stub |
| 前端交互 | user-ui、domain-ui、appearance-ui、session-ui 全部通过；包括重复筛选、输入保留、公开资料编辑界面、主题单实例、Worker 终止、Blob URL 清理、锁定移除敏感弹窗、2505 条批量操作分批完整提交 |
| 媒体生命周期 | `media-lifecycle.cjs`：锁定后迟到请求不得重新建立 Blob URL、分块 UTF-8 文字完整读取、已销毁媒体管理器拒绝新工作 |
| GIF/图片 | `theme-worker.cjs`：GIF 帧数/时长、透明背景处理、静态图缩放/WebP、字节和帧数限制 |
| 真实浏览器 | Chromium：11 个管理页面、用户注册、真实 Worker 加密/解密、文字保存/读取、反复筛选、公开资料、记住凭据后重载自动登录、锁定清凭据/解锁、跨端口导出页 Bearer 登录与解密，未出现页面脚本错误 |
| 响应式 | Chromium：360×780、768×1024、1440×900、780×360；主题页无横向溢出。桌宠视口边界和 GIF Worker 上传在前一轮实测通过，DOM/Canvas 回归再次通过 |
| 构建/依赖 | `npm ci`、主题 Worker 和导出 HTML 重建通过；`npm audit` 和运行依赖审计均为 0 个已报告漏洞；不等同于没有未知漏洞 |

## 自检发现并修复的问题

1. SSH 面板从安装目录执行更新时误复用旧源码，源目录移动后复制失败；更新脚本目录重复嵌套。
2. 普通程序更新可能重置第三方 CDN、源站端口及证书设置。现在更新路径保留配置，临时目录完整准备后再替换程序，健康检查成功后移除旧程序备份。
3. 错误 Bearer 头可借有效 Cookie 通过认证，削弱 CSRF 防线；现在显式 Bearer 优先且不回退 Cookie。
4. 并发管理员初始化请求可能覆盖先完成的管理员；请求体读取后再次检查初始化状态。
5. 快照/日志损坏时跳过异常可能覆盖原状态；现在停止启动并保留原文件，要求恢复备份。
6. 服务关闭期间的迁移、以及失败持久化后的重试清理存在删除原副本风险；现在排空请求、关闭保护、清理前持久化校验。
7. 同一分块并发上传、宽松分块编号、声明大小与实际密文不符、稀疏分块删除异常；均增加校验与回归。删除内容先持久化索引/清理记录，再清理文件。
8. 域名应用提前改运行态、失败后配置/证书未恢复；现在特权校验成功前保留原运行态，失败回滚。Full/Strict 缺证书不再静默改为 Flexible。
9. 管理端 CF-only 选项未在运行时反代层生效；现在生成来源限制，并剥离非 CF 连接伪造的访客头。安装器创建的 UFW 规则仍需通过 SSH 管理。
10. 媒体请求在清理后迟到建立新 Blob URL、长文字只读第一块、图片查看器传递 Promise 而不是 Blob、批量超过 1000 条只处理一部分；均已修复。
11. 锁定时私密编辑弹窗/菜单可能残留，以及详情返回按钮缺可访问名称；锁定现在关闭覆盖层并清理监听器，补上返回标签。
12. 重复 URL 解码导致百分号路径产生 500；静态流与 API 中途断开时重复写响应头；已修正。

## 发布边界与部署注意

- 真实 TG 使用平台限流、下载上限、旧消息删除限制、网络可达性：本次用模拟器验证协议与异常逻辑，不声称已验证生产 Telegram。清理失败保留记录，可重试，不能保证平台允许删除所有旧消息。
- TG 模式仅内容对象存 TG；账号、索引、配置及公开素材服务端密钥仍在 VPS。升级前备份 `/var/lib/nui-memo` 与 `/etc/nui-memo`，包括本地 `objects/`（若使用本地存储）。
- 真实 Caddy/systemd/UFW、ACME、CF Flexible/Full/Strict、Origin CA 签发、第三方 CDN 的供应商配置需在部署端验收；本次为配置生成、dry-run、stub 和故障注入。CF-only 反代规则不能替代网络防火墙。
- 从旧版首次升级请下载 2.0.0 Release 附带的新安装器再执行 `--update`；不要依赖旧版 n-ui 调用旧安装器自更新。
- 从此版本起 Full/Strict 缺少证书会失败并保留旧配置，必须补证书或明确选择 Flexible。
- GIF 处理是纯色/近纯色边缘连通抠图，不是 AI 人物/复杂背景分割。图片有明确尺寸/字节/帧数/超时限制，GIF 不偷偷转换为静态图。
- 广告网络脚本可能受 srcdoc 沙箱、CSP 或广告商要求限制；自有广告与配置接口已验收，不保证所有第三方广告代码都可运行。
- 内存验收覆盖关键生命周期和资源释放，不宣称完成长期满负载压力测试或证明绝无内存泄漏。
- GitHub Pages/静态托管必须重新导出并替换 `index.html`，只更新 VPS 不会更新已部署的旧文件。

## 重现

```bash
npm ci
npm run build:theme
npm run build:export
npm install --prefix /tmp/nui-ui-test jsdom@24.1.3 @napi-rs/canvas@0.1.80
NUI_JSDOM_MODULE=/tmp/nui-ui-test/node_modules/jsdom \
NUI_CANVAS_MODULE=/tmp/nui-ui-test/node_modules/@napi-rs/canvas \
bash scripts/check-release.sh
```

`.github/workflows/verify.yml` 对 PR 和 main 执行同一回归，并验证已提交浏览器构建产物可重现。
