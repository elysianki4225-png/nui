import crypto from 'node:crypto';
import { behindCdn } from './domain.js';

export { behindCdn };
export const MB = 1024 * 1024;
export const VERSION = '2.1.0';

export function randomId(bytes = 12) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function randomDigits(n) {
  let s = '';
  while (s.length < n) {
    const buf = crypto.randomBytes(n);
    for (const b of buf) {
      if (b < 250) s += String(b % 10); // 拒绝采样避免模偏差
      if (s.length === n) break;
    }
  }
  if (s[0] === '0') s = String(1 + (parseInt(s[0], 10) % 9)) + s.slice(1);
  return s;
}

export function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

export function timingSafeEqualStr(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

export function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

export function sendError(res, status, message, code) {
  sendJson(res, status, { ok: false, error: message, code: code || undefined });
}

export class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    const finish = (err, val) => {
      if (done) return;
      done = true;
      if (err) {
        req.removeListener('data', onData);
        req.removeListener('end', onEnd);
        req.removeListener('error', onErr);
        reject(err);
      } else resolve(val);
    };
    const onData = (c) => {
      size += c.length;
      if (limit && size > limit) {
        finish(new HttpError(413, '请求体过大', 'BODY_TOO_LARGE'));
        req.destroy();
        return;
      }
      chunks.push(c);
    };
    const onEnd = () => finish(null, Buffer.concat(chunks));
    const onErr = (e) => finish(e);
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onErr);
  });
}

export async function readJson(req, limit = 1 * MB) {
  const buf = await readBody(req, limit);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    throw new HttpError(400, '无效的 JSON', 'BAD_JSON');
  }
}

export function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

export function setCookie(res, name, value, opts = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${opts.path || '/'}`);
  if (opts.maxAge != null) parts.push(`Max-Age=${Math.floor(opts.maxAge)}`);
  if (opts.httpOnly !== false) parts.push('HttpOnly');
  if (opts.secure) parts.push('Secure');
  parts.push(`SameSite=${opts.sameSite || 'Strict'}`);
  const prev = res.getHeader('Set-Cookie');
  const list = prev ? (Array.isArray(prev) ? prev : [prev]) : [];
  list.push(parts.join('; '));
  res.setHeader('Set-Cookie', list);
}

export function clearCookie(res, name, opts = {}) {
  setCookie(res, name, '', { ...opts, maxAge: 0 });
}

export function isHttps(req, cfg) {
  if (req.socket && req.socket.encrypted) return true;
  if (cfg.trustProxy) {
    // CDN 代理（Cloudflare 小黄云 / 第三方）：访客到边缘始终是 HTTPS，即便回源是 HTTP(Flexible)
    if (behindCdn(cfg)) return true;
    const visitor = req.headers['cf-visitor'];
    if (typeof visitor === 'string' && /"scheme"\s*:\s*"https"/.test(visitor)) return true;
    const proto = req.headers['x-forwarded-proto'];
    if (typeof proto === 'string' && proto.split(',')[0].trim() === 'https') return true;
  }
  return false;
}

export function formatBytes(n) {
  if (!Number.isFinite(n)) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export function clampInt(v, min, max, dflt) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

export function nowSec() { return Math.floor(Date.now() / 1000); }
