import { profileDTO, validateProfile } from './profile.js';
import crypto from 'node:crypto';
import { HttpError, readJson, readBody, sendJson, nowSec, clampInt, clearCookie } from './util.js';
import { verifySecret } from './security.js';

const MB = 1024 * 1024;
const TYPES = new Set(['text', 'image', 'video', 'file']);
const META_MAX = 8 * 1024; // 密文元数据上限

function memoDTO(m) {
  return {
    id: m.id, type: m.type, size: m.size, createdAt: m.createdAt, updatedAt: m.updatedAt,
    pinned: !!m.pinned, meta: m.meta, thumb: !!m.thumb, parts: m.parts.length,
  };
}

export function registerUserRoutes(h, ctx) {
  const { route, requireUser, cookieOpts, USER_COOKIE } = h;
  const { cfg, store, pool, sessions, limiter } = ctx;

  route('GET', '/api/user/profile', async req => ({ ok: true, profile: profileDTO(requireUser(req).user) }));
  route('PATCH', '/api/user/profile', async req => {
    const { user } = requireUser(req);
    if (!limiter.allow(`profile:${user.account}`, 60, 3600)) throw new HttpError(429, '修改过于频繁', 'RATE_LIMIT');
    const body = await readJson(req, 4096);
    // No await between uniqueness validation and store mutation.
    const patch = validateProfile(body, store.state.users, user.account);
    store.log({ t: 'user.update', account: user.account, patch });
    return { ok: true, profile: profileDTO(user) };
  });
  route('GET', '/api/profiles/:nickname', async (req, res, params) => {
    const key = params.nickname.normalize('NFKC').toLowerCase();
    const user = Object.values(store.state.users).find(u => u.nicknameKey === key && !u.banned);
    if (!user) throw new HttpError(404, '资料不存在', 'NOT_FOUND');
    return { ok: true, profile: profileDTO(user) };
  });
  const avatarBusy = new Set();
  route('PUT', '/api/user/profile/avatar', async req => {
    const { user } = requireUser(req);
    if (!user.nickname) throw new HttpError(400, '请先保存网名', 'PROFILE_REQUIRED');
    if (avatarBusy.has(user.account) || !limiter.allow(`avatar:${user.account}`, 10, 3600)) throw new HttpError(429, '上传过于频繁', 'RATE_LIMIT');
    avatarBusy.add(user.account);
    try {
      const bytes = await readBody(req, 128 * 1024);
      if (bytes.length < 4 || bytes[0] !== 255 || bytes[1] !== 216 || bytes[2] !== 255) throw new HttpError(400, '请上传 JPEG 头像', 'BAD_AVATAR');
      const key = crypto.randomBytes(32), iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const encrypted = Buffer.concat([cipher.update(bytes), cipher.final(), cipher.getAuthTag()]);
      const uploaded = await pool.upload(encrypted, { filename: 'avatar.bin', caption: 'public profile avatar' });
      if (store.state.users[user.account] !== user) { await pool.deleteMessage(uploaded.botId, uploaded.messageId).catch(() => {}); throw new HttpError(409, '账号已删除', 'NOT_FOUND'); }
      const old = user.avatar;
      store.log({ t: 'user.update', account: user.account, patch: { avatar: { ...uploaded, key: key.toString('hex'), iv: iv.toString('hex') } } });
      await pool.retire(old ? [old] : []);
      return { ok: true, profile: profileDTO(user) };
    } finally { avatarBusy.delete(user.account); }
  });
  route('DELETE', '/api/user/profile/avatar', async req => {
    const { user } = requireUser(req);
    if (avatarBusy.has(user.account)) throw new HttpError(409, '头像正在上传，请稍后操作', 'AVATAR_BUSY');
    const old = user.avatar;
    store.log({ t: 'user.update', account: user.account, patch: { avatar: null } });
    await pool.retire(old ? [old] : []);
    return { ok: true };
  });
  route('GET', '/api/avatars/:nickname', async (req, res, params, ip) => {
    if (!limiter.allow(`avatar-read:${ip}`, 120, 60)) throw new HttpError(429, '请求过于频繁', 'RATE_LIMIT');
    const user = Object.values(store.state.users).find(u => u.nicknameKey === params.nickname.normalize('NFKC').toLowerCase() && !u.banned);
    const a = user?.avatar;
    if (!a) throw new HttpError(404, '头像不存在', 'NOT_FOUND');
    const bytes = await pool.read(a, 128 * 1024 + 16);
    const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(a.key, 'hex'), Buffer.from(a.iv, 'hex'));
    decipher.setAuthTag(bytes.subarray(-16));
    const image = Buffer.concat([decipher.update(bytes.subarray(0, -16)), decipher.final()]);
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': image.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(image);
  });

  function maxFileSize() {
    return Math.min(cfg.maxFileSize, store.state.settings.maxFileSizeMB * MB);
  }

  function getOwnedMemo(req, id) {
    const a = requireUser(req);
    const m = store.state.memos[id];
    if (!m || m.account !== a.user.account) throw new HttpError(404, '备忘录不存在', 'NOT_FOUND');
    return { memo: m, auth: a };
  }

  function memoFiles(m) { return [...(m.parts || []).filter(Boolean), ...(m.thumb ? [m.thumb] : [])]; }
  const uploads = new Set();

  // 列表（仅返回密文元数据，服务端无法解密）
  route('GET', '/api/user/memos', async (req) => {
    const { user } = requireUser(req);
    const url = new URL(req.url, 'http://x');
    const limit = clampInt(url.searchParams.get('limit'), 1, 500, 200);
    const cursor = url.searchParams.get('cursor') || null;
    const type = url.searchParams.get('type') || 'all';
    const pinned = url.searchParams.get('pinned') === '1';
    const { items, nextCursor } = store.listMemos(user.account, { cursor, limit, type, pinned });
    return { ok: true, items: items.map(memoDTO), nextCursor, stats: store.userStats(user.account) };
  });

  route('GET', '/api/user/stats', async (req) => {
    const { user } = requireUser(req);
    return { ok: true, stats: store.userStats(user.account), storageReady: pool.ready() };
  });

  // 创建（占位，随后上传密文分块）
  route('POST', '/api/user/memos', async (req) => {
    const { user } = requireUser(req);
    if (!limiter.allow(`create:${user.account}`, 240, 60)) throw new HttpError(429, '创建过于频繁', 'RATE_LIMIT');
    const body = await readJson(req, META_MAX + 4096);
    const type = String(body.type || '');
    const size = Number(body.size);
    const meta = String(body.meta || '');
    const expectedParts = clampInt(body.parts, 1, 64, 1);
    if (!TYPES.has(type)) throw new HttpError(400, '无效类型', 'BAD_TYPE');
    if (!Number.isFinite(size) || size < 0 || size > maxFileSize()) throw new HttpError(400, `文件大小需在 0 - ${Math.floor(maxFileSize() / MB)}MB 之间`, 'BAD_SIZE');
    if (!meta || meta.length > META_MAX) throw new HttpError(400, '元数据无效或过大', 'BAD_META');
    if (type === 'text' && expectedParts !== 1 && size <= cfg.chunkSize) { /* 允许 */ }
    if (!pool.ready()) throw new HttpError(503, '管理员尚未绑定存储机器人，暂时无法保存', 'NO_BOT');
    const id = crypto.randomBytes(12).toString('base64url');
    const memo = {
      id, account: user.account, type, size, meta,
      parts: [], thumb: null, expectedParts,
      pinned: false, status: 'pending', createdAt: nowSec(), updatedAt: nowSec(),
    };
    store.log({ t: 'memo.create', memo });
    return { ok: true, id, chunkSize: cfg.chunkSize, maxFileSize: maxFileSize() };
  });

  // 上传一个密文分块（原始字节 = IV || AES-GCM 密文）
  route('PUT', '/api/user/memos/:id/parts/:index', async (req, res, params) => {
    const { memo, auth } = getOwnedMemo(req, params.id);
    const slot = `${memo.id}:part:${params.index}`;
    if (uploads.has(slot)) throw new HttpError(409, '该分块正在上传', 'UPLOAD_BUSY');
    uploads.add(slot);
    try {
    if (memo.status !== 'pending') throw new HttpError(409, '该备忘录已完成或已锁定', 'NOT_PENDING');
    const index = Number(params.index);
    if (!Number.isInteger(index) || index < 0 || index >= memo.expectedParts) throw new HttpError(400, '分块序号无效', 'BAD_INDEX');
    if (memo.parts[index]) throw new HttpError(409, '该分块已上传', 'DUP_PART');
    const limit = cfg.chunkSize + 64;
    const buf = await readBody(req, limit);
    if (buf.length < 28) throw new HttpError(400, '分块数据无效', 'BAD_PART');
    const caption = JSON.stringify({ v: 1, a: memo.account, m: memo.id, p: index, t: memo.type });
    const result = await pool.upload(buf, { filename: `${memo.id}.${index}.bin`, caption });
    if (store.state.memos[memo.id] !== memo || !store.state.users[memo.account] || store.state.users[memo.account].banned) {
      await pool.retire([result]); throw new HttpError(409, '备忘录或账号已删除/封禁', 'NOT_FOUND');
    }
    memo.parts[index] = { fileId: result.fileId, messageId: result.messageId, botId: result.botId, size: result.size };
    store.log({ t: 'memo.update', id: memo.id, patch: { parts: memo.parts } });
    return { ok: true, index, size: result.size };
    } finally { uploads.delete(slot); }
  });

  // 上传加密缩略图
  route('PUT', '/api/user/memos/:id/thumb', async (req, res, params) => {
    const { memo } = getOwnedMemo(req, params.id);
    const slot = `${memo.id}:thumb`;
    if (uploads.has(slot)) throw new HttpError(409, '该分块正在上传', 'UPLOAD_BUSY');
    uploads.add(slot);
    try {
    if (memo.status !== 'pending') throw new HttpError(409, '该备忘录已完成', 'NOT_PENDING');
    if (memo.thumb) throw new HttpError(409, '缩略图已存在', 'DUP_THUMB');
    const buf = await readBody(req, 1 * MB);
    if (buf.length < 28) throw new HttpError(400, '缩略图数据无效', 'BAD_THUMB');
    const caption = JSON.stringify({ v: 1, a: memo.account, m: memo.id, p: 'thumb', t: memo.type });
    const result = await pool.upload(buf, { filename: `${memo.id}.thumb.bin`, caption });
    if (store.state.memos[memo.id] !== memo || !store.state.users[memo.account] || store.state.users[memo.account].banned) {
      await pool.retire([result]); throw new HttpError(409, '备忘录或账号已删除/封禁', 'NOT_FOUND');
    }
    const thumb = { fileId: result.fileId, messageId: result.messageId, botId: result.botId, size: result.size };
    store.log({ t: 'memo.update', id: memo.id, patch: { thumb } });
    return { ok: true };
    } finally { uploads.delete(slot); }
  });

  // 完成上传
  route('POST', '/api/user/memos/:id/complete', async (req, res, params) => {
    const { memo } = getOwnedMemo(req, params.id);
    if (memo.status === 'ready') return { ok: true, memo: memoDTO(memo) };
    if ([...uploads].some(key => key.startsWith(memo.id + ':'))) throw new HttpError(409, '请等待分块和缩略图上传完成', 'UPLOAD_BUSY');
    const count = memo.parts.filter(Boolean).length;
    if (count !== memo.expectedParts) throw new HttpError(409, `分块不完整 (${count}/${memo.expectedParts})`, 'INCOMPLETE');
    if (memo.parts.reduce((sum, p) => sum + p.size, 0) !== memo.size + 28 * memo.expectedParts) throw new HttpError(400, '密文长度与申报文件大小不符', 'BAD_SIZE');
    const cipherSize = memo.parts.reduce((s, p) => s + (p?.size || 0), 0) + (memo.thumb?.size || 0);
    store.log({ t: 'memo.update', id: memo.id, patch: { status: 'ready', cipherSize, updatedAt: nowSec() } });
    return { ok: true, memo: memoDTO(store.state.memos[memo.id]) };
  });

  route('GET', '/api/user/memos/:id', async (req, res, params) => {
    const { memo } = getOwnedMemo(req, params.id);
    return { ok: true, memo: memoDTO(memo) };
  });

  // 密文内容中转（浏览器 -> VPS -> Telegram，绝不暴露 t.me）
  route('GET', '/api/user/memos/:id/content', async (req, res, params) => {
    const { memo, auth } = getOwnedMemo(req, params.id);
    if (!limiter.allow(`media:${auth.user.account}`, 300, 60)) throw new HttpError(429, '加载过于频繁', 'RATE_LIMIT');
    const url = new URL(req.url, 'http://x');
    const index = clampInt(url.searchParams.get('part'), 0, 63, 0);
    const part = memo.parts[index];
    if (!part) throw new HttpError(404, '分块不存在', 'NOT_FOUND');
    await pool.streamToClient({ botId: part.botId, fileId: part.fileId, expectedSize: part.size, res, req });
  });

  route('GET', '/api/user/memos/:id/thumb', async (req, res, params) => {
    const { memo, auth } = getOwnedMemo(req, params.id);
    if (!limiter.allow(`media:${auth.user.account}`, 300, 60)) throw new HttpError(429, '加载过于频繁', 'RATE_LIMIT');
    if (!memo.thumb) throw new HttpError(404, '无缩略图', 'NOT_FOUND');
    await pool.streamToClient({ botId: memo.thumb.botId, fileId: memo.thumb.fileId, expectedSize: memo.thumb.size, res, req });
  });

  // 更新（置顶 / 元数据）
  route('PATCH', '/api/user/memos/:id', async (req, res, params) => {
    const { memo } = getOwnedMemo(req, params.id);
    const body = await readJson(req, META_MAX + 4096);
    const patch = { updatedAt: nowSec() };
    if (typeof body.pinned === 'boolean') patch.pinned = body.pinned;
    if (typeof body.meta === 'string' && body.meta.length > 0 && body.meta.length <= META_MAX) patch.meta = body.meta;
    store.log({ t: 'memo.update', id: memo.id, patch });
    return { ok: true, memo: memoDTO(store.state.memos[memo.id]) };
  });

  route('DELETE', '/api/user/memos/:id', async (req, res, params) => {
    const { memo } = getOwnedMemo(req, params.id);
    store.log({ t: 'memo.delete', id: memo.id });
    await pool.retire(memoFiles(memo));
    return { ok: true };
  });

  route('POST', '/api/user/memos/batch-delete', async (req) => {
    const { user } = requireUser(req);
    const body = await readJson(req, 256 * 1024);
    const ids = Array.isArray(body.ids) ? body.ids.slice(0, 1000) : [];
    let deleted = 0; const retired = [];
    for (const id of ids) {
      const m = store.state.memos[id];
      if (m && m.account === user.account) {
        store.log({ t: 'memo.delete', id });
        retired.push(...memoFiles(m));
        deleted++;
      }
    }
    await pool.retire(retired);
    return { ok: true, deleted };
  });

  route('POST', '/api/user/memos/batch-pin', async (req) => {
    const { user } = requireUser(req);
    const body = await readJson(req, 256 * 1024);
    const ids = Array.isArray(body.ids) ? body.ids.slice(0, 1000) : [];
    const pinned = !!body.pinned;
    let updated = 0;
    for (const id of ids) {
      const m = store.state.memos[id];
      if (m && m.account === user.account) {
        store.log({ t: 'memo.update', id, patch: { pinned, updatedAt: nowSec() } });
        updated++;
      }
    }
    return { ok: true, updated };
  });

  // 注销账号（删除全部内容与账号）
  route('POST', '/api/user/delete-account', async (req, res) => {
    const { user, token } = requireUser(req);
    const body = await readJson(req, 4096);
    const proof = String(body.proof || '');
    if (!verifySecret(proof, user.proofHash)) throw new HttpError(401, '密钥验证失败', 'BAD_CREDENTIALS');
    const arr = store.accountIndex.get(user.account) || [];
    const retired = user.avatar ? [user.avatar] : [];
    for (const m of [...arr]) {
      store.log({ t: 'memo.delete', id: m.id });
      retired.push(...memoFiles(m));
    }
    store.log({ t: 'user.delete', account: user.account });
    await pool.retire(retired);
    sessions.deleteForAccount(user.account);
    clearCookie(res, USER_COOKIE, cookieOpts(req));
    store.audit(user.account, 'user.delete', '用户自助注销');
    return { ok: true };
  });
}
