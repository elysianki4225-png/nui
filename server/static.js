import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(__dirname, '..', 'web');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

function safeJoin(root, urlPath) {
  const decoded = urlPath; // decoded once by the HTTP entrypoint
  const full = path.normalize(path.join(root, decoded));
  if (full !== root && !full.startsWith(root + path.sep)) return null;
  return full;
}

async function serveFile(req, res, file, { cache = 'no-cache', spa = false } = {}) {
  let stat;
  try { stat = await fsp.stat(file); } catch { return false; }
  if (!stat.isFile()) return false;
  const ext = path.extname(file).toLowerCase();
  const etag = `W/"${stat.size.toString(16)}-${stat.mtimeMs.toString(16)}"`;
  const headers = {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': cache,
    'ETag': etag,
    'X-Content-Type-Options': 'nosniff',
    'Accept-Ranges': 'none',
  };
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    res.end();
    return true;
  }
  headers['Content-Length'] = stat.size;
  res.writeHead(200, headers);
  if (req.method === 'HEAD') { res.end(); return true; }
  await pipeline(fs.createReadStream(file), res).catch(() => { try { res.destroy(); } catch {} });
  return true;
}

export function createStatic(cfg) {
  const userIndex = path.join(WEB_ROOT, 'user', 'index.html');
  const adminIndex = path.join(WEB_ROOT, 'admin', 'index.html');

  return async function handleStatic(req, res, pathname, host) {
    const isAdminHost = cfg.adminHost && host === cfg.adminHost && (cfg.mode === 'ip' || cfg.adminHost !== cfg.userHost);
    const isAdminPath = pathname === '/admin' || pathname.startsWith('/admin/');

    // 共享静态资源
    if (pathname.startsWith('/assets/')) {
      const file = safeJoin(path.join(WEB_ROOT, 'assets'), pathname.slice('/assets/'.length));
      if (!file) { res.writeHead(403); res.end(); return true; }
      const cache = /\.(woff2?|svg|png|jpg|webp|ico)$/.test(file) ? 'public, max-age=86400' : 'no-cache';
      if (await serveFile(req, res, file, { cache })) return true;
      res.writeHead(404); res.end('Not Found'); return true;
    }
    // 用户应用模块
    if (pathname.startsWith('/app/')) {
      const file = safeJoin(path.join(WEB_ROOT, 'user'), pathname.slice('/app/'.length));
      if (!file) { res.writeHead(403); res.end(); return true; }
      if (await serveFile(req, res, file, { cache: 'no-cache' })) return true;
      // 用户应用 SPA 回退
      if (!isAdminHost) { await serveFile(req, res, userIndex, { cache: 'no-cache', spa: true }); return true; }
      res.writeHead(404); res.end('Not Found'); return true;
    }
    // 管理应用模块 / SPA
    if (isAdminPath) {
      if (cfg.adminHost && cfg.adminHost !== cfg.userHost && !isAdminHost) {
        // IP 模式下管理端在独立子域名
        res.writeHead(302, { Location: cfg.adminUrl }); res.end(); return true;
      }
      const sub = pathname.replace(/^\/admin\/?/, '');
      if (sub) {
        const file = safeJoin(path.join(WEB_ROOT, 'admin'), sub);
        if (file && await serveFile(req, res, file, { cache: 'no-cache' })) return true;
      }
      await serveFile(req, res, adminIndex, { cache: 'no-cache', spa: true });
      return true;
    }
    // 管理子域名根路径
    if (isAdminHost) {
      const sub = pathname.replace(/^\//, '');
      if (sub) {
        const file = safeJoin(path.join(WEB_ROOT, 'admin'), sub);
        if (file && await serveFile(req, res, file, { cache: 'no-cache' })) return true;
      }
      await serveFile(req, res, adminIndex, { cache: 'no-cache', spa: true });
      return true;
    }
    // favicon / manifest
    if (pathname === '/favicon.ico') {
      const file = path.join(WEB_ROOT, 'assets', 'favicon.svg');
      if (await serveFile(req, res, file, { cache: 'public, max-age=86400' })) return true;
      res.writeHead(204); res.end(); return true;
    }
    if (pathname === '/manifest.webmanifest') {
      const file = path.join(WEB_ROOT, 'assets', 'manifest.webmanifest');
      if (await serveFile(req, res, file, { cache: 'no-cache' })) return true;
    }
    // 用户 SPA 回退
    await serveFile(req, res, userIndex, { cache: 'no-cache', spa: true });
    return true;
  };
}
