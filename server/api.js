import os from 'node:os';
import { sendJson, sendError, HttpError, readJson, parseCookies, setCookie, clearCookie, isHttps, randomDigits, nowSec, clampInt, VERSION } from './util.js';
import { hashSecret, verifySecret, clientIp } from './security.js';
import { registerUserRoutes } from './api-user.js';
import { registerAdminRoutes } from './api-admin.js';

export { VERSION };
const USER_COOKIE = 'memo_session';
const ADMIN_COOKIE = 'memo_admin';

export function createApi(ctx) {
  const { cfg, store, sessions, pool, limiter } = ctx;
  const routes = [];
  const route = (method, pattern, handler, opts = {}) => {
    const keys = [];
    const regex = new RegExp('^' + pattern.replace(/:[^/]+/g, (m) => { keys.push(m.slice(1)); return '([^/]+)'; }) + '$');
    routes.push({ method, regex, keys, handler, ...opts });
  };

  // ---------- 鉴权辅助 ----------
  function cookieOpts(req) {
    return { secure: isHttps(req, cfg) || !cfg.dev, httpOnly: true, sameSite: 'Strict', path: '/' };
  }
  function getUser(req) {
    const token = parseCookies(req)[USER_COOKIE];
    const s = sessions.get(token, 'user');
    if (!s) return null;
    const u = store.state.users[s.account];
    if (!u || u.banned) return null;
    return { user: u, session: s, token };
  }
  function getAdmin(req) {
    const token = parseCookies(req)[ADMIN_COOKIE];
    const s = sessions.get(token, 'admin');
    if (!s) return null;
    return { session: s, token };
  }
  function requireUser(req) {
    const a = getUser(req);
    if (!a) throw new HttpError(401, '未登录或会话已过期', 'UNAUTHORIZED');
    a.user.lastSeen = nowSec();
    store.touch();
    return a;
  }
  function requireAdmin(req) {
    const a = getAdmin(req);
    if (!a) throw new HttpError(401, '管理员未登录', 'UNAUTHORIZED');
    return a;
  }
  function csrfCheck(req) {
    if (!req.headers['x-memo-client']) throw new HttpError(403, '缺少客户端标识', 'CSRF');
    const origin = req.headers.origin;
    if (origin) {
      try {
        const o = new URL(origin);
        const host = (req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
        if (o.host !== host && o.host !== cfg.userHost && o.host !== cfg.adminHost) {
          throw new HttpError(403, '跨域请求被拒绝', 'CSRF_ORIGIN');
        }
      } catch (e) {
        if (e instanceof HttpError) throw e;
        throw new HttpError(403, '无效 Origin', 'CSRF_ORIGIN');
      }
    }
  }

  const helpers = { route, getUser, getAdmin, requireUser, requireAdmin, cookieOpts, csrfCheck, USER_COOKIE, ADMIN_COOKIE };

  // ---------- 公共 ----------
  route('GET', '/api/health', async () => ({ ok: true, version: VERSION, uptime: Math.floor(process.uptime()) }));

  route('GET', '/api/config', async () => ({
    ok: true,
    siteName: store.state.settings.siteName,
    registrationOpen: store.state.settings.registrationOpen,
    maxFileSize: Math.min(cfg.maxFileSize, store.state.settings.maxFileSizeMB * 1024 * 1024),
    chunkSize: cfg.chunkSize,
    autoLockMinutes: store.state.settings.autoLockMinutes,
    motd: store.state.settings.motd || '',
    version: VERSION,
    storageReady: pool.bots().length > 0,
  }));

  // ---------- 用户注册 / 登录 ----------
  route('POST', '/api/user/register', async (req, res, params, ip) => {
    if (!store.state.settings.registrationOpen) throw new HttpError(403, '管理员已关闭注册', 'REG_CLOSED');
    if (!limiter.allow(`reg:${ip}`, 10, 3600)) throw new HttpError(429, '注册过于频繁，请稍后再试', 'RATE_LIMIT');
    const body = await readJson(req, 4096);
    const proof = String(body.proof || '');
    if (!/^[0-9a-f]{64}$/.test(proof)) throw new HttpError(400, '无效的注册凭据', 'BAD_PROOF');
    let account;
    do { account = randomDigits(16); } while (store.state.users[account]);
    const user = {
      account,
      proofHash: hashSecret(proof, { N: 4096 }),
      createdAt: nowSec(), lastSeen: nowSec(), banned: false,
    };
    store.log({ t: 'user.create', user });
    const ttl = store.state.settings.userSessionDays * 86400;
    const { token } = sessions.create('user', account, ttl, { ip });
    setCookie(res, USER_COOKIE, token, { ...cookieOpts(req), maxAge: ttl });
    store.audit(account, 'user.register', `新账号注册`);
    return { ok: true, account, createdAt: user.createdAt };
  });

  route('POST', '/api/user/login', async (req, res, params, ip) => {
    if (!limiter.allow(`login:${ip}`, 30, 300)) throw new HttpError(429, '尝试过于频繁，请稍后再试', 'RATE_LIMIT');
    const body = await readJson(req, 4096);
    const account = String(body.account || '').replace(/\D/g, '');
    const proof = String(body.proof || '');
    if (!/^\d{16}$/.test(account) || !/^[0-9a-f]{64}$/.test(proof)) throw new HttpError(400, '账号或密钥格式错误', 'BAD_CREDENTIALS');
    if (!limiter.allow(`loginacct:${account}`, 10, 300)) throw new HttpError(429, '该账号尝试过于频繁', 'RATE_LIMIT');
    const user = store.state.users[account];
    const ok = user && verifySecret(proof, user.proofHash);
    if (!ok) throw new HttpError(401, '账号或密钥错误', 'BAD_CREDENTIALS');
    if (user.banned) throw new HttpError(403, '该账号已被封禁', 'BANNED');
    user.lastSeen = nowSec();
    store.touch();
    const ttl = store.state.settings.userSessionDays * 86400;
    const { token } = sessions.create('user', account, ttl, { ip });
    setCookie(res, USER_COOKIE, token, { ...cookieOpts(req), maxAge: ttl });
    return { ok: true, account, createdAt: user.createdAt };
  });

  route('POST', '/api/user/logout', async (req, res) => {
    const a = getUser(req);
    if (a) sessions.delete(a.token);
    clearCookie(res, USER_COOKIE, cookieOpts(req));
    return { ok: true };
  });

  route('GET', '/api/user/me', async (req) => {
    const { user } = requireUser(req);
    return { ok: true, account: user.account, createdAt: user.createdAt, lastSeen: user.lastSeen, stats: store.userStats(user.account) };
  });

  // ---------- 管理员初始化 / 登录 ----------
  route('GET', '/api/admin/status', async (req) => ({
    ok: true,
    setupRequired: !store.state.admin,
    loggedIn: !!getAdmin(req),
    siteName: store.state.settings.siteName,
  }));

  route('POST', '/api/admin/setup', async (req, res, params, ip) => {
    if (store.state.admin) throw new HttpError(409, '管理员已初始化', 'ALREADY_SETUP');
    if (!limiter.allow(`setup:${ip}`, 10, 3600)) throw new HttpError(429, '操作过于频繁', 'RATE_LIMIT');
    const body = await readJson(req, 4096);
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(username)) throw new HttpError(400, '用户名需为 3-32 位字母、数字、_ . -', 'BAD_USERNAME');
    if (password.length < 8 || password.length > 128) throw new HttpError(400, '密码长度需为 8-128 位', 'BAD_PASSWORD');
    const admin = { username, passHash: hashSecret(password), createdAt: nowSec() };
    store.log({ t: 'admin.set', admin });
    const ttl = store.state.settings.adminSessionHours * 3600;
    const { token } = sessions.create('admin', null, ttl, { ip });
    setCookie(res, ADMIN_COOKIE, token, { ...cookieOpts(req), maxAge: ttl });
    store.audit(username, 'admin.setup', '管理员初始化');
    return { ok: true, username };
  });

  route('POST', '/api/admin/login', async (req, res, params, ip) => {
    if (!limiter.allow(`adminlogin:${ip}`, 15, 300)) throw new HttpError(429, '尝试过于频繁，请稍后再试', 'RATE_LIMIT');
    const body = await readJson(req, 4096);
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    const admin = store.state.admin;
    const ok = admin && admin.username === username && verifySecret(password, admin.passHash);
    if (!ok) throw new HttpError(401, '用户名或密码错误', 'BAD_CREDENTIALS');
    const ttl = store.state.settings.adminSessionHours * 3600;
    const { token } = sessions.create('admin', null, ttl, { ip });
    setCookie(res, ADMIN_COOKIE, token, { ...cookieOpts(req), maxAge: ttl });
    store.audit(username, 'admin.login', '管理员登录');
    return { ok: true, username };
  });

  route('POST', '/api/admin/logout', async (req, res) => {
    const a = getAdmin(req);
    if (a) sessions.delete(a.token);
    clearCookie(res, ADMIN_COOKIE, cookieOpts(req));
    return { ok: true };
  });

  registerUserRoutes(helpers, ctx);
  registerAdminRoutes(helpers, ctx);

  // ---------- 分发 ----------
  return async function handleApi(req, res, pathname) {
    const ip = clientIp(req, cfg);
    if (!limiter.allow(`api:${ip}`, 600, 60)) {
      sendError(res, 429, '请求过于频繁', 'RATE_LIMIT');
      return;
    }
    const method = req.method;
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
      try { csrfCheck(req); } catch (e) { sendError(res, e.status || 403, e.message, e.code); return; }
    }
    for (const r of routes) {
      if (r.method !== method) continue;
      const m = pathname.match(r.regex);
      if (!m) continue;
      const params = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      try {
        const result = await r.handler(req, res, params, ip);
        if (result !== undefined && !res.writableEnded) sendJson(res, 200, result);
      } catch (e) {
        if (res.writableEnded) return;
        const status = e.status || 500;
        if (status >= 500) console.error(`[api] ${method} ${pathname}:`, e);
        sendError(res, status, e.message || '服务器内部错误', e.code);
      }
      return;
    }
    sendError(res, 404, '接口不存在', 'NOT_FOUND');
  };
}
