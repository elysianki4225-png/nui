import { profileDTO } from './profile.js';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpError, readJson, nowSec, clampInt, formatBytes, randomId } from './util.js';
import { hashSecret, verifySecret, parseIpRule } from './security.js';
import { VERSION } from './util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXPORT_TEMPLATE = path.resolve(__dirname, '..', 'web', 'export', 'template.html');

function normOrigin(o) {
  const s = String(o || '').trim();
  if (!s) return null;
  try { const u = new URL(s.includes('://') ? s : `https://${s}`); if (!/^https?:$/.test(u.protocol)) return null; return `${u.protocol}//${u.host}`.toLowerCase(); } catch { return null; }
}

function userDTO(u, store) {
  return {
    profile: profileDTO(u), account: u.account, createdAt: u.createdAt, lastSeen: u.lastSeen, banned: !!u.banned,
    stats: store.userStats(u.account),
  };
}

function maskToken(t) {
  if (!t) return '';
  if (t.length <= 12) return t.slice(0, 3) + '•••';
  return t.slice(0, 6) + '••••••' + t.slice(-4);
}

export function registerAdminRoutes(h, ctx) {
  const { route, requireAdmin } = h;
  const { cfg, store, pool, limiter, ipBans, startedAt } = ctx;

  function systemInfo() {
    const mem = process.memoryUsage();
    return {
      version: VERSION,
      node: process.version,
      platform: `${os.type()} ${os.release()} ${os.arch()}`,
      hostname: os.hostname(),
      uptimeSec: Math.floor(process.uptime()),
      systemUptimeSec: Math.floor(os.uptime()),
      loadavg: os.loadavg().map((x) => +x.toFixed(2)),
      cpuCount: os.cpus().length,
      totalMemMB: Math.round(os.totalmem() / 1048576),
      freeMemMB: Math.round(os.freemem() / 1048576),
      processRssMB: +(mem.rss / 1048576).toFixed(1),
      processHeapMB: +(mem.heapUsed / 1048576).toFixed(1),
      dataDir: cfg.dataDir,
      mode: cfg.mode,
      userUrl: cfg.userUrl,
      adminUrl: cfg.adminUrl,
    };
  }

  route('GET', '/api/admin/overview', async (req) => {
    requireAdmin(req);
    const totals = store.totals();
    const users = Object.values(store.state.users);
    const dayAgo = nowSec() - 86400;
    const weekAgo = nowSec() - 7 * 86400;
    return {
      ok: true,
      totals: { ...totals, bytesHuman: formatBytes(totals.bytes) },
      active24h: users.filter((u) => u.lastSeen >= dayAgo).length,
      active7d: users.filter((u) => u.lastSeen >= weekAgo).length,
      new24h: users.filter((u) => u.createdAt >= dayAgo).length,
      storageReady: pool.ready(),
      telegram: pool.stats(),
      system: systemInfo(),
      recentAudit: store.state.audit.slice(-12).reverse(),
      registrationOpen: store.state.settings.registrationOpen,
    };
  });

  // ---- 用户管理 ----
  route('GET', '/api/admin/users', async (req) => {
    requireAdmin(req);
    const url = new URL(req.url, 'http://x');
    const query = (url.searchParams.get('query') || '').trim();
    const filter = url.searchParams.get('filter') || 'all';
    const limit = clampInt(url.searchParams.get('limit'), 1, 200, 50);
    const offset = clampInt(url.searchParams.get('offset'), 0, 1e9, 0);
    let users = Object.values(store.state.users);
    if (query) users = users.filter((u) => u.account.includes(query) || (u.nickname || '').toLowerCase().includes(query.toLowerCase()));
    if (filter === 'banned') users = users.filter((u) => u.banned);
    if (filter === 'active') users = users.filter((u) => !u.banned);
    users.sort((a, b) => b.createdAt - a.createdAt);
    const total = users.length;
    const items = users.slice(offset, offset + limit).map((u) => userDTO(u, store));
    return { ok: true, items, total, offset, limit };
  });

  route('GET', '/api/admin/users/:account', async (req, res, params) => {
    requireAdmin(req);
    const u = store.state.users[params.account];
    if (!u) throw new HttpError(404, '账号不存在', 'NOT_FOUND');
    return { ok: true, user: userDTO(u, store) };
  });

  route('POST', '/api/admin/users/batch', async (req) => {
    const { session } = requireAdmin(req);
    const body = await readJson(req, 256 * 1024);
    const accounts = Array.isArray(body.accounts) ? body.accounts.slice(0, 2000) : [];
    const action = String(body.action || '');
    let affected = 0; const retired = [];
    for (const account of accounts) {
      const u = store.state.users[account];
      if (!u) continue;
      if (action === 'ban') { store.log({ t: 'user.update', account, patch: { banned: true } }); ctx.sessions.deleteForAccount(account); affected++; }
      else if (action === 'unban') { store.log({ t: 'user.update', account, patch: { banned: false } }); affected++; }
      else if (action === 'delete') {
        const arr = store.accountIndex.get(account) || [];
        for (const m of [...arr]) {
          store.log({ t: 'memo.delete', id: m.id });
          retired.push(...(m.parts || []).filter(Boolean));
          if (m.thumb) retired.push(m.thumb);
        }
        if (u.avatar) retired.push(u.avatar);
        store.log({ t: 'user.delete', account });
        ctx.sessions.deleteForAccount(account);
        affected++;
      }
    }
    store.audit(store.state.admin?.username || 'admin', `users.${action}`, `批量操作 ${affected} 个账号`);
    await pool.retire(retired);
    return { ok: true, affected };
  });

  // ---- IP 封禁 ----
  route('GET', '/api/admin/ip-bans', async (req) => {
    requireAdmin(req);
    const url = new URL(req.url, 'http://x');
    const query = (url.searchParams.get('query') || '').trim().toLowerCase();
    let bans = Object.values(store.state.ipBans);
    if (query) bans = bans.filter((b) => b.rule.toLowerCase().includes(query) || (b.note || '').toLowerCase().includes(query));
    bans.sort((a, b) => b.createdAt - a.createdAt);
    return { ok: true, items: bans, total: bans.length, activeRules: ipBans.count };
  });

  route('POST', '/api/admin/ip-bans', async (req) => {
    requireAdmin(req);
    const body = await readJson(req, 1 * 1024 * 1024);
    const lines = Array.isArray(body.rules) ? body.rules : String(body.text || '').split(/[\n,;]+/);
    const existing = new Set(Object.values(store.state.ipBans).map((b) => b.rule));
    const added = [], errors = [];
    for (const raw of lines.slice(0, 5000)) {
      const line = String(raw).trim();
      if (!line) continue;
      try {
        const parsed = parseIpRule(line);
        if (existing.has(parsed.label)) { errors.push({ rule: line, error: '已存在' }); continue; }
        const ban = { id: randomId(8), rule: parsed.label, note: parsed.note || '', family: parsed.family, enabled: true, createdAt: nowSec() };
        store.log({ t: 'ban.add', ban });
        existing.add(parsed.label);
        added.push(ban);
      } catch (e) {
        errors.push({ rule: line, error: e.message });
      }
    }
    ipBans.rebuild(store.state.ipBans);
    store.audit(store.state.admin?.username || 'admin', 'ipban.add', `新增 ${added.length} 条封禁规则`);
    return { ok: true, added: added.length, errors };
  });

  route('POST', '/api/admin/ip-bans/batch', async (req) => {
    requireAdmin(req);
    const body = await readJson(req, 256 * 1024);
    const ids = Array.isArray(body.ids) ? body.ids.slice(0, 5000) : [];
    const action = String(body.action || '');
    let affected = 0;
    for (const id of ids) {
      const b = store.state.ipBans[id];
      if (!b) continue;
      if (action === 'delete') { store.log({ t: 'ban.remove', id }); affected++; }
      else if (action === 'enable') { store.log({ t: 'ban.update', id, patch: { enabled: true } }); affected++; }
      else if (action === 'disable') { store.log({ t: 'ban.update', id, patch: { enabled: false } }); affected++; }
    }
    ipBans.rebuild(store.state.ipBans);
    store.audit(store.state.admin?.username || 'admin', `ipban.${action}`, `批量操作 ${affected} 条规则`);
    return { ok: true, affected };
  });

  // ---- Telegram 机器人 ----
  route('GET', '/api/admin/bots', async (req) => {
    requireAdmin(req);
    return { ok: true, items: store.state.bots, stats: pool.stats() };
  });

  route('POST', '/api/admin/bots/test', async (req) => {
    requireAdmin(req);
    const body = await readJson(req, 4096);
    const token = String(body.token || '').trim();
    const chatId = String(body.chatId || '').trim();
    if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(token)) throw new HttpError(400, 'Bot Token 格式不正确', 'BAD_TOKEN');
    const result = await pool.testBinding(token, chatId || null);
    return {
      ok: true,
      bot: { id: result.me.id, username: result.me.username, firstName: result.me.first_name },
      chat: result.chat ? { id: String(result.chat.id), type: result.chat.type, title: result.chat.title || result.chat.username || [result.chat.first_name, result.chat.last_name].filter(Boolean).join(' ') } : null,
    };
  });

  route('POST', '/api/admin/bots/detect', async (req) => {
    requireAdmin(req);
    const body = await readJson(req, 4096);
    const token = String(body.token || '').trim();
    if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(token)) throw new HttpError(400, 'Bot Token 格式不正确', 'BAD_TOKEN');
    const chats = await pool.detectChat(token);
    return { ok: true, chats };
  });

  route('POST', '/api/admin/bots', async (req) => {
    requireAdmin(req);
    const body = await readJson(req, 4096);
    const name = String(body.name || '').trim().slice(0, 40) || '存储机器人';
    const token = String(body.token || '').trim();
    const chatId = String(body.chatId || '').trim();
    if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(token)) throw new HttpError(400, 'Bot Token 格式不正确', 'BAD_TOKEN');
    if (!chatId) throw new HttpError(400, '请填写 Chat ID（可点击自动检测）', 'BAD_CHAT');
    if (store.state.bots.some((b) => b.token === token && String(b.chatId) === chatId)) throw new HttpError(409, '该机器人+聊天已绑定', 'DUP_BOT');
    const result = await pool.testBinding(token, chatId);
    const bot = {
      id: randomId(8), name, token, chatId, enabled: true, addedAt: nowSec(),
      username: result.me.username, lastError: null, lastOkAt: nowSec(),
    };
    store.log({ t: 'bot.add', bot });
    pool.syncWorkers();
    store.audit(store.state.admin?.username || 'admin', 'bot.add', `绑定机器人 @${bot.username} -> ${chatId}`);
    return { ok: true, bot };
  });

  route('POST', '/api/admin/bots/:id/toggle', async (req, res, params) => {
    requireAdmin(req);
    const b = store.state.bots.find((x) => x.id === params.id);
    if (!b) throw new HttpError(404, '机器人不存在', 'NOT_FOUND');
    store.log({ t: 'bot.update', id: params.id, patch: { enabled: !b.enabled } });
    pool.syncWorkers();
    return { ok: true, enabled: !b.enabled };
  });

  route('DELETE', '/api/admin/bots/:id', async (req, res, params) => {
    requireAdmin(req);
    const b = store.state.bots.find((x) => x.id === params.id);
    if (!b) throw new HttpError(404, '机器人不存在', 'NOT_FOUND');
    if (pool.references().some(x => x.ref.botId === params.id) || (store.state.settings.storageCleanup || []).some(x => x.botId === params.id)) throw new HttpError(409, '该机器人仍有文件或待清理副本，请先迁移并完成清理', 'BOT_IN_USE');
    store.log({ t: 'bot.remove', id: params.id });
    pool.syncWorkers();
    store.audit(store.state.admin?.username || 'admin', 'bot.remove', `移除机器人 @${b.username || b.name}`);
    return { ok: true };
  });

  // ---- 设置 ----
  route('GET', '/api/admin/settings', async (req) => {
    requireAdmin(req);
    return { ok: true, settings: store.state.settings, limits: { maxFileSize: cfg.maxFileSize, chunkSize: cfg.chunkSize } };
  });

  route('PATCH', '/api/admin/settings', async (req) => {
    requireAdmin(req);
    const body = await readJson(req, 8192);
    const patch = {};
    const s = store.state.settings;
    if (typeof body.siteName === 'string' && body.siteName.trim()) patch.siteName = body.siteName.trim().slice(0, 30);
    if (typeof body.registrationOpen === 'boolean') patch.registrationOpen = body.registrationOpen;
    if (body.maxFileSizeMB != null) patch.maxFileSizeMB = clampInt(body.maxFileSizeMB, 1, 512, s.maxFileSizeMB);
    if (body.userSessionDays != null) patch.userSessionDays = clampInt(body.userSessionDays, 1, 365, s.userSessionDays);
    if (body.adminSessionHours != null) patch.adminSessionHours = clampInt(body.adminSessionHours, 1, 168, s.adminSessionHours);
    if (body.autoLockMinutes != null) patch.autoLockMinutes = clampInt(body.autoLockMinutes, 0, 1440, s.autoLockMinutes);
    if (typeof body.motd === 'string') patch.motd = body.motd.slice(0, 500);
    store.log({ t: 'settings.set', settings: patch });
    store.audit(store.state.admin?.username || 'admin', 'settings.update', Object.keys(patch).join(', '));
    return { ok: true, settings: store.state.settings };
  });

  route('POST', '/api/admin/password', async (req) => {
    requireAdmin(req);
    const body = await readJson(req, 4096);
    const current = String(body.current || '');
    const next = String(body.next || '');
    const admin = store.state.admin;
    if (!verifySecret(current, admin.passHash)) throw new HttpError(401, '当前密码错误', 'BAD_CREDENTIALS');
    if (next.length < 8 || next.length > 128) throw new HttpError(400, '新密码长度需为 8-128 位', 'BAD_PASSWORD');
    store.log({ t: 'admin.set', admin: { ...admin, passHash: hashSecret(next) } });
    ctx.sessions.deleteKind('admin');
    store.audit(admin.username, 'admin.password', '修改管理员密码');
    return { ok: true, reauth: true };
  });

  // ---- 域名 / CDN 管理 ----
  route('GET', '/api/admin/domain', async (req) => {
    requireAdmin(req);
    return { ok: true, ...ctx.domain.current() };
  });

  route('POST', '/api/admin/domain/check', async (req) => {
    requireAdmin(req);
    const body = await readJson(req, 4096);
    const result = await ctx.domain.check(body.host);
    return { ok: true, ...result };
  });

  route('POST', '/api/admin/domain/preview', async (req) => {
    requireAdmin(req);
    const body = await readJson(req, 64 * 1024);
    const result = ctx.domain.preview(body);
    return { ok: true, ...result };
  });

  route('POST', '/api/admin/domain', async (req, res, params, ip) => {
    requireAdmin(req);
    if (!limiter.allow(`domain:${ip}`, 30, 3600)) throw new HttpError(429, '域名修改过于频繁，请稍后再试', 'RATE_LIMIT');
    const body = await readJson(req, 256 * 1024);
    const extras = { certPem: body.certPem, keyPem: body.keyPem, cfApiToken: body.cfApiToken };
    const result = await ctx.domain.apply(body, extras);
    return { ok: true, ...result };
  });

  route('GET', '/api/admin/domain/result', async (req) => {
    requireAdmin(req);
    const url = new URL(req.url, 'http://x');
    const id = url.searchParams.get('id') || '';
    const r = id ? ctx.domain.poll(id) : ctx.domain.readResult();
    return { ok: true, result: r || null };
  });

  route('POST', '/api/admin/domain/probe', async (req, res, params, ip) => {
    requireAdmin(req);
    if (!limiter.allow(`probe:${ip}`, 30, 3600)) throw new HttpError(429, '诊断过于频繁，请稍后再试', 'RATE_LIMIT');
    const body = await readJson(req, 4096);
    const result = await ctx.domain.probe(body || {});
    return { ok: true, ...result };
  });

  route('POST', '/api/admin/domain/cf-verify', async (req, res, params, ip) => {
    requireAdmin(req);
    if (!limiter.allow(`cfverify:${ip}`, 20, 3600)) throw new HttpError(429, '验证过于频繁，请稍后再试', 'RATE_LIMIT');
    const body = await readJson(req, 4096);
    const result = await ctx.domain.verifyCfToken(body.token);
    return { ok: true, ...result };
  });

  // ---- 跨域 / 前端部署 ----
  route('GET', '/api/admin/cors', async (req) => {
    requireAdmin(req);
    const s = store.state.settings;
    return { ok: true, mode: s.corsMode || 'off', origins: s.corsOrigins || [], userUrl: cfg.userUrl, exportReady: fs.existsSync(EXPORT_TEMPLATE) };
  });

  route('PATCH', '/api/admin/cors', async (req) => {
    requireAdmin(req);
    const body = await readJson(req, 4096);
    const mode = ['off', 'whitelist', 'open'].includes(body.mode) ? body.mode : 'off';
    store.log({ t: 'settings.set', settings: { corsMode: mode } });
    store.audit(store.state.admin?.username || 'admin', 'cors.mode', `跨域模式=${mode}`);
    return { ok: true, mode };
  });

  route('POST', '/api/admin/cors/origins', async (req) => {
    requireAdmin(req);
    const body = await readJson(req, 256 * 1024);
    const lines = Array.isArray(body.origins) ? body.origins : String(body.text || '').split(/[\n,;]+/);
    const existing = new Set(store.state.settings.corsOrigins || []);
    const added = [], errors = [];
    for (const raw of lines.slice(0, 1000)) {
      const o = normOrigin(raw);
      if (!o) { if (String(raw).trim()) errors.push({ origin: raw, error: '无效 Origin' }); continue; }
      if (existing.has(o)) { errors.push({ origin: o, error: '已存在' }); continue; }
      existing.add(o); added.push(o);
    }
    store.log({ t: 'settings.set', settings: { corsOrigins: [...existing] } });
    store.audit(store.state.admin?.username || 'admin', 'cors.add', `新增 ${added.length} 个跨域白名单`);
    return { ok: true, added: added.length, errors, origins: [...existing] };
  });

  route('POST', '/api/admin/cors/origins/batch', async (req) => {
    requireAdmin(req);
    const body = await readJson(req, 256 * 1024);
    const remove = new Set((Array.isArray(body.origins) ? body.origins : []).map(normOrigin).filter(Boolean));
    const next = (store.state.settings.corsOrigins || []).filter((o) => !remove.has(o));
    store.log({ t: 'settings.set', settings: { corsOrigins: next } });
    store.audit(store.state.admin?.username || 'admin', 'cors.remove', `移除 ${remove.size} 个跨域白名单`);
    return { ok: true, origins: next };
  });

  // 导出单文件用户前端（自动写入 API 地址，开箱即用）
  route('GET', '/api/admin/export', async (req, res) => {
    requireAdmin(req);
    if (!fs.existsSync(EXPORT_TEMPLATE)) throw new HttpError(503, '导出模板未构建，请先运行 scripts/build-export.mjs', 'NO_TEMPLATE');
    const url = new URL(req.url, 'http://x');
    let base = (url.searchParams.get('base') || cfg.userUrl || '').trim().replace(/\/+$/, '');
    if (!/^https?:\/\//.test(base)) base = `https://${base}`;
    const tpl = fs.readFileSync(EXPORT_TEMPLATE, 'utf8');
    const config = { apiBase: base, siteName: store.state.settings.siteName, exportedAt: nowSec(), version: VERSION };
    const html = tpl.replace('/*__MEMO_CONFIG__*/null', JSON.stringify(config));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Disposition': 'attachment; filename="index.html"', 'Cache-Control': 'no-store' });
    res.end(html);
    store.audit(store.state.admin?.username || 'admin', 'frontend.export', `导出单文件前端 base=${base}`);
  });

  // ---- 广告 ----
  route('GET', '/api/admin/ads', async (req) => {
    requireAdmin(req);
    const s = store.state.settings;
    return { ok: true, ads: { enabled: !!s.adsEnabled, mode: s.adsMode || 'custom', html: s.adsHtml || '', items: s.adsItems || [] } };
  });

  route('PATCH', '/api/admin/ads', async (req) => {
    requireAdmin(req);
    const body = await readJson(req, 256 * 1024);
    const patch = {};
    if (typeof body.enabled === 'boolean') patch.adsEnabled = body.enabled;
    if (['custom', 'html'].includes(body.mode)) patch.adsMode = body.mode;
    if (typeof body.html === 'string') patch.adsHtml = body.html.slice(0, 20000);
    store.log({ t: 'settings.set', settings: patch });
    store.audit(store.state.admin?.username || 'admin', 'ads.update', Object.keys(patch).join(', '));
    return { ok: true };
  });

  route('POST', '/api/admin/ads/items', async (req) => {
    requireAdmin(req);
    const body = await readJson(req, 16 * 1024);
    const title = String(body.title || '').trim().slice(0, 60);
    const image = String(body.image || '').trim().slice(0, 2000);
    const link = String(body.url || '').trim().slice(0, 2000);
    if (!title) throw new HttpError(400, '请填写广告标题', 'BAD_TITLE');
    if (image && !/^https?:\/\//.test(image)) throw new HttpError(400, '图片需为 http(s) 链接', 'BAD_IMAGE');
    if (link && !/^https?:\/\//.test(link)) throw new HttpError(400, '链接需为 http(s)', 'BAD_URL');
    const item = { id: randomId(8), title, image, url: link, enabled: body.enabled !== false, createdAt: nowSec() };
    const items = [...(store.state.settings.adsItems || []), item];
    store.log({ t: 'settings.set', settings: { adsItems: items } });
    store.audit(store.state.admin?.username || 'admin', 'ads.add', `自有广告 ${title}`);
    return { ok: true, item, items };
  });

  route('POST', '/api/admin/ads/items/batch', async (req) => {
    requireAdmin(req);
    const body = await readJson(req, 64 * 1024);
    const ids = new Set(Array.isArray(body.ids) ? body.ids : []);
    const action = String(body.action || '');
    let items = store.state.settings.adsItems || [];
    if (action === 'delete') items = items.filter((i) => !ids.has(i.id));
    else if (action === 'enable' || action === 'disable') items = items.map((i) => ids.has(i.id) ? { ...i, enabled: action === 'enable' } : i);
    store.log({ t: 'settings.set', settings: { adsItems: items } });
    store.audit(store.state.admin?.username || 'admin', `ads.${action}`, `批量 ${ids.size} 个广告`);
    return { ok: true, items };
  });

  // ---- 审计 / 系统 ----
  route('GET', '/api/admin/audit', async (req) => {
    requireAdmin(req);
    const url = new URL(req.url, 'http://x');
    const limit = clampInt(url.searchParams.get('limit'), 1, 1000, 200);
    return { ok: true, items: store.state.audit.slice(-limit).reverse() };
  });

  route('GET', '/api/admin/system', async (req) => {
    requireAdmin(req);
    return { ok: true, system: systemInfo(), telegram: pool.stats(), totals: store.totals() };
  });

  route('POST', '/api/admin/compact', async (req) => {
    requireAdmin(req);
    await store.compact();
    return { ok: true };
  });
}
