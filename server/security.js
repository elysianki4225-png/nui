import crypto from 'node:crypto';
import net from 'node:net';
import { nowSec, sha256, timingSafeEqualStr } from './util.js';

// ---------- 密码 / 凭据哈希 ----------
export function hashSecret(secret, { N = 16384, r = 8, p = 1, keylen = 64 } = {}) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(secret), salt, keylen, { N, r, p, maxmem: 256 * 1024 * 1024 });
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifySecret(secret, stored) {
  try {
    const [scheme, N, r, p, saltB64, hashB64] = String(stored).split('$');
    if (scheme !== 'scrypt') return false;
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');
    const actual = crypto.scryptSync(String(secret), salt, expected.length, {
      N: parseInt(N, 10), r: parseInt(r, 10), p: parseInt(p, 10), maxmem: 256 * 1024 * 1024,
    });
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

// ---------- 会话 ----------
export class Sessions {
  constructor(store) { this.store = store; }

  create(kind, account, ttlSec, meta = {}) {
    const token = crypto.randomBytes(32).toString('base64url');
    const session = {
      tokenHash: sha256(token), kind, account: account || null,
      createdAt: nowSec(), expiresAt: nowSec() + ttlSec, ...meta,
    };
    this.store.log({ t: 'session.create', session });
    return { token, session };
  }

  get(token, kind) {
    if (!token) return null;
    const s = this.store.state.sessions[sha256(token)];
    if (!s) return null;
    if (s.expiresAt <= nowSec()) return null;
    if (kind && s.kind !== kind) return null;
    return s;
  }

  delete(token) {
    if (!token) return;
    this.store.log({ t: 'session.delete', tokenHash: sha256(token) });
  }

  deleteForAccount(account) {
    for (const [hash, s] of Object.entries(this.store.state.sessions)) {
      if (s.account === account) this.store.log({ t: 'session.delete', tokenHash: hash });
    }
  }

  deleteKind(kind) {
    for (const [hash, s] of Object.entries(this.store.state.sessions)) {
      if (s.kind === kind) this.store.log({ t: 'session.delete', tokenHash: hash });
    }
  }
}

// ---------- 限流（固定窗口，定期清理，内存有界） ----------
export class RateLimiter {
  constructor(maxKeys = 50000) {
    this.map = new Map();
    this.maxKeys = maxKeys;
    this.timer = setInterval(() => this.prune(), 60_000);
    this.timer.unref();
  }
  allow(key, limit, windowSec) {
    const now = Date.now();
    let e = this.map.get(key);
    if (!e || e.resetAt <= now) {
      if (this.map.size >= this.maxKeys) this.prune(true);
      e = { count: 0, resetAt: now + windowSec * 1000 };
      this.map.set(key, e);
    }
    e.count++;
    return e.count <= limit;
  }
  remaining(key) {
    const e = this.map.get(key);
    return e ? Math.max(0, e.resetAt - Date.now()) : 0;
  }
  prune(force = false) {
    const now = Date.now();
    for (const [k, e] of this.map) if (e.resetAt <= now) this.map.delete(k);
    if (force && this.map.size >= this.maxKeys) {
      // 极端情况下丢弃最旧的一半，保证内存有界
      const keys = [...this.map.keys()].slice(0, Math.floor(this.maxKeys / 2));
      for (const k of keys) this.map.delete(k);
    }
  }
  stop() { clearInterval(this.timer); }
}

// ---------- IP 解析与 CIDR / 区间匹配 ----------
export function normalizeIp(input) {
  if (!input) return null;
  let ip = String(input).trim().toLowerCase();
  if (ip.startsWith('[')) ip = ip.replace(/^\[|\]$/g, '');
  const pct = ip.indexOf('%');
  if (pct >= 0) ip = ip.slice(0, pct);
  if (ip.startsWith('::ffff:')) {
    const v4 = ip.slice(7);
    if (net.isIP(v4) === 4) ip = v4;
  }
  return net.isIP(ip) ? ip : null;
}

function ipv4ToNum(ip) {
  const parts = ip.split('.').map((x) => parseInt(x, 10));
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

function ipv6ToBig(ip) {
  // 展开 :: 与内嵌 IPv4
  let head = ip, tail = '';
  if (ip.includes('::')) {
    const [h, t] = ip.split('::');
    head = h; tail = t || '';
  }
  const expand = (seg) => {
    if (!seg) return [];
    const out = [];
    for (const part of seg.split(':')) {
      if (part.includes('.')) {
        const n = ipv4ToNum(part);
        out.push((n >>> 16) & 0xffff, n & 0xffff);
      } else out.push(parseInt(part || '0', 16));
    }
    return out;
  };
  let groups;
  if (ip.includes('::')) {
    const h = expand(head), t = expand(tail);
    const fill = new Array(8 - h.length - t.length).fill(0);
    groups = [...h, ...fill, ...t];
  } else groups = expand(ip);
  if (groups.length !== 8) throw new Error('invalid ipv6');
  let v = 0n;
  for (const g of groups) v = (v << 16n) | BigInt(g & 0xffff);
  return v;
}

export function ipToValue(ip) {
  const norm = normalizeIp(ip);
  if (!norm) return null;
  if (net.isIP(norm) === 4) return { family: 4, value: ipv4ToNum(norm) };
  return { family: 6, value: ipv6ToBig(norm) };
}

/** 解析封禁规则：单 IP / CIDR / 通配符 1.2.3.* / 区间 1.2.3.4-1.2.3.9 */
export function parseIpRule(input) {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('空规则');
  const commentIdx = raw.search(/[\s#]/);
  const token = commentIdx >= 0 ? raw.slice(0, commentIdx) : raw;
  const note = commentIdx >= 0 ? raw.slice(commentIdx).replace(/^[\s#]+/, '').trim() : '';
  let family, start, end, label = token;

  if (token.includes('/')) {
    const [ip, bitsStr] = token.split('/');
    const v = ipToValue(ip);
    if (!v) throw new Error(`无效 IP: ${ip}`);
    const bits = parseInt(bitsStr, 10);
    const maxBits = v.family === 4 ? 32 : 128;
    if (!Number.isFinite(bits) || bits < 0 || bits > maxBits) throw new Error(`无效掩码: /${bitsStr}`);
    family = v.family;
    const size = 1n << BigInt(maxBits - bits);
    const big = BigInt(v.value);
    start = (big / size) * size;
    end = start + size - 1n;
  } else if (token.includes('*')) {
    const filled = token.replace(/\*/g, '0');
    const v = ipToValue(filled);
    if (!v || v.family !== 4) throw new Error('通配符仅支持 IPv4，例如 1.2.3.*');
    const starCount = (token.match(/\*/g) || []).length;
    const bits = 32 - starCount * 8;
    const size = 1n << BigInt(32 - bits);
    const big = BigInt(v.value);
    family = 4;
    start = (big / size) * size;
    end = start + size - 1n;
    label = token;
  } else if (token.includes('-')) {
    const [a, b] = token.split('-').map((x) => x.trim());
    const va = ipToValue(a);
    let vb = ipToValue(b);
    if (!va) throw new Error(`无效 IP: ${a}`);
    if (!vb) {
      // 支持 1.2.3.4-10 形式
      if (va.family === 4 && /^\d{1,3}$/.test(b)) {
        const prefix = a.split('.').slice(0, 3).join('.');
        vb = ipToValue(`${prefix}.${b}`);
      }
      if (!vb) throw new Error(`无效区间终点: ${b}`);
    }
    if (va.family !== vb.family) throw new Error('区间两端 IP 版本不一致');
    family = va.family;
    start = BigInt(va.value); end = BigInt(vb.value);
    if (end < start) throw new Error('区间终点小于起点');
  } else {
    const v = ipToValue(token);
    if (!v) throw new Error(`无效 IP: ${token}`);
    family = v.family;
    start = BigInt(v.value); end = start;
    label = family === 4 ? token : `${token}/${128}`;
  }
  return { family, start, end, label, note };
}

function mergeIntervals(list) {
  if (!list.length) return [];
  list.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  const out = [{ ...list[0] }];
  for (let i = 1; i < list.length; i++) {
    const last = out[out.length - 1];
    const cur = list[i];
    if (cur.start <= last.end + 1n) {
      if (cur.end > last.end) last.end = cur.end;
    } else out.push({ ...cur });
  }
  return out;
}

export class IpBanList {
  constructor() { this.v4 = []; this.v6 = []; this.count = 0; }

  rebuild(bans) {
    const v4 = [], v6 = [];
    let count = 0;
    for (const b of Object.values(bans)) {
      if (!b.enabled) continue;
      try {
        const r = parseIpRule(b.rule);
        (r.family === 4 ? v4 : v6).push({ start: r.start, end: r.end });
        count++;
      } catch { /* 忽略无效规则 */ }
    }
    this.v4 = mergeIntervals(v4);
    this.v6 = mergeIntervals(v6);
    this.count = count;
  }

  contains(ip) {
    const v = ipToValue(ip);
    if (!v) return false;
    const list = v.family === 4 ? this.v4 : this.v6;
    if (!list.length) return false;
    const target = BigInt(v.value);
    let lo = 0, hi = list.length - 1, idx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid].start <= target) { idx = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    return idx >= 0 && target <= list[idx].end;
  }
}

export function clientIp(req, cfg) {
  let ip = req.socket.remoteAddress || '';
  if (cfg.trustProxy) {
    // 按 CDN 配置选择真实访客 IP 头：Cloudflare 默认 CF-Connecting-IP，第三方默认 XFF 首个
    const header = cfg.realIpHeader || (cfg.cdn === 'cloudflare' || cfg.cloudflare ? 'cf-connecting-ip' : 'x-forwarded-for');
    const xffFirst = () => {
      const xff = req.headers['x-forwarded-for'];
      if (typeof xff === 'string' && xff.length) {
        const first = xff.split(',')[0].trim();
        if (normalizeIp(first)) return first;
      }
      return null;
    };
    if (header === 'x-forwarded-for') {
      ip = xffFirst() || ip;
    } else {
      const val = req.headers[header];
      if (typeof val === 'string' && normalizeIp(val.trim())) ip = val.trim();
      else ip = xffFirst() || ip;
    }
  }
  return normalizeIp(ip) || '0.0.0.0';
}
