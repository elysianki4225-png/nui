import http from 'node:http';
import { loadConfig } from './config.js';
import { Store } from './store.js';
import { Sessions, RateLimiter, IpBanList, clientIp } from './security.js';
import { TelegramPool } from './telegram.js';
import { createApi } from './api.js';
import { createStatic } from './static.js';
import { sendError, isHttps, VERSION, behindCdn } from './util.js';
import { DomainManager } from './domain-manager.js';

const cfg = loadConfig();
const store = new Store(cfg.dataDir);
await store.load();

const sessions = new Sessions(store);
const pool = new TelegramPool(store, cfg);
const ipBans = new IpBanList();
ipBans.rebuild(store.state.ipBans);
const limiter = new RateLimiter();
const startedAt = Date.now();

// 封禁规则变更时重建匹配索引
const origLog = store.log.bind(store);
store.log = (ev) => {
  origLog(ev);
  if (ev.t === 'ban.add' || ev.t === 'ban.remove' || ev.t === 'ban.update') ipBans.rebuild(store.state.ipBans);
};

const domain = new DomainManager(cfg, store);
const ctx = { cfg, store, sessions, pool, ipBans, limiter, startedAt, domain };
const handleApi = createApi(ctx);
const handleStatic = createStatic(cfg);

function securityHeaders(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data: https:",
    "media-src 'self' blob:",
    "font-src 'self' data:",
    "connect-src 'self' https:",
    "worker-src 'self' blob:",
    "frame-src 'self' data: blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ];
  if (!cfg.dev) csp.push("frame-ancestors 'self'");
  res.setHeader('Content-Security-Policy', csp.join('; '));
  // CDN 代理模式下 HSTS 交给边缘下发，避免 Flexible 回源时的冲突
  if (isHttps(req, cfg) && !behindCdn(cfg)) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}

// ---------- CORS（前端跨域白名单 / 开关） ----------
function normOrigin(o) {
  try { const u = new URL(o); return `${u.protocol}//${u.host}`.toLowerCase(); } catch { return null; }
}
function corsAllowed(origin) {
  const s = store.state.settings;
  const mode = s.corsMode || 'off';
  if (mode === 'off' || !origin) return false;
  const o = normOrigin(origin);
  if (!o) return false;
  if (mode === 'open') return true;
  const own = [cfg.userHost, cfg.adminHost].filter(Boolean).map((h) => `https://${h}`.toLowerCase());
  if (own.includes(o)) return true;
  return (s.corsOrigins || []).some((x) => normOrigin(x) === o);
}
function applyCors(req, res) {
  const origin = req.headers.origin;
  if (!corsAllowed(origin)) return false;
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Memo-Client, Authorization');
  res.setHeader('Access-Control-Max-Age', '600');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return true; }
  return false;
}

const server = http.createServer(async (req, res) => {
  const ip = clientIp(req, cfg);
  securityHeaders(req, res);
  if (applyCors(req, res)) return; // 预检已响应
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch {
    sendError(res, 400, '无效 URL', 'BAD_URL');
    return;
  }
  const host = (req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim().toLowerCase();

  if (ipBans.contains(ip)) {
    if (pathname.startsWith('/api/')) sendError(res, 403, '您的 IP 已被封禁', 'IP_BANNED');
    else { res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('403 Forbidden - 您的 IP 已被封禁'); }
    return;
  }

  try {
    if (pathname.startsWith('/api/')) {
      await handleApi(req, res, pathname);
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendError(res, 405, '方法不允许', 'METHOD_NOT_ALLOWED');
      return;
    }
    await handleStatic(req, res, pathname, host.replace(/:\d+$/, ''));
  } catch (e) {
    if (!res.writableEnded) {
      console.error(`[http] ${req.method} ${pathname}:`, e);
      sendError(res, 500, '服务器内部错误', 'INTERNAL');
    } else {
      try { res.destroy(); } catch {}
    }
  }
});

server.headersTimeout = 60_000;
server.keepAliveTimeout = 65_000;
server.requestTimeout = 300_000;

server.listen(cfg.port, cfg.host, () => {
  console.log('──────────────────────────────────────────────');
  console.log(`  备忘录 v${VERSION} 已启动`);
  console.log(`  监听:      http://${cfg.host}:${cfg.port}`);
  console.log(`  数据目录:  ${cfg.dataDir}`);
  console.log(`  用户界面:  ${cfg.userUrl}`);
  console.log(`  管理界面:  ${cfg.adminUrl}`);
  console.log(`  模式:      ${cfg.mode}${cfg.dev ? ' (dev)' : ''}`);
  console.log(`  存储机器人: ${pool.bots().length} 个已启用`);
  console.log('──────────────────────────────────────────────');
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[main] 收到 ${signal}，正在优雅关闭...`);
  server.close();
  limiter.stop();
  pool.stop();
  await store.close();
  setTimeout(() => process.exit(0), 500).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (e) => console.error('[main] unhandledRejection:', e));
process.on('uncaughtException', (e) => { console.error('[main] uncaughtException:', e); });
