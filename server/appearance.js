import crypto from 'node:crypto';
import { HttpError, readJson, readBody } from './util.js';

const SLOTS = new Set(['logo', 'pet', 'mobile', 'tablet', 'desktop']);
export function publicAppearance(settings) {
  const theme = settings.appearance || {};
  const assets = settings.themeAssets || {};
  return { userColor: theme.userColor || '', adminColor: theme.adminColor || '', petEnabled: !!theme.petEnabled,
    petSize: theme.petSize || 120, petOnAdmin: theme.petOnAdmin !== false,
    assets: Object.fromEntries(Object.entries(assets).filter(([slot, ref]) => SLOTS.has(slot) && ref).map(([slot, ref]) => [slot, `/api/theme-assets/${slot}?v=${ref.version}`])) };
}
function mimeOf(bytes) {
  if (bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) return 'image/jpeg';
  if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  if (/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString())) {
    if (bytes.length < 14 || bytes.readUInt16LE(6) > 512 || bytes.readUInt16LE(8) > 512) throw new HttpError(400, 'GIF 请先在浏览器压缩至 512 像素以内', 'GIF_DIMENSIONS');
    return 'image/gif';
  }
  throw new HttpError(400, '仅支持 JPEG、PNG、WebP 或 GIF，不接受 SVG', 'BAD_IMAGE');
}
export function registerAppearanceRoutes({ route, requireAdmin }, { store, pool }) {
  let uploading = false;
  route('GET', '/api/appearance', async () => ({ ok: true, appearance: publicAppearance(store.state.settings) }));
  route('GET', '/api/admin/appearance', async req => { requireAdmin(req); return { ok: true, appearance: publicAppearance(store.state.settings), storageMode: pool.mode() }; });
  route('PATCH', '/api/admin/appearance', async req => {
    requireAdmin(req); const b = await readJson(req, 2048); const patch = { ...(store.state.settings.appearance || {}) };
    for (const k of ['userColor', 'adminColor']) if (k in b) {
      if (b[k] !== '' && !/^#[0-9a-f]{6}$/i.test(b[k])) throw new HttpError(400, '颜色需为六位 HEX', 'BAD_COLOR');
      patch[k] = b[k];
    }
    for (const k of ['petEnabled', 'petOnAdmin']) if (k in b) { if (typeof b[k] !== 'boolean') throw new HttpError(400, '无效开关', 'BAD_SETTING'); patch[k] = b[k]; }
    if ('petSize' in b) { if (!Number.isInteger(b.petSize) || b.petSize < 48 || b.petSize > 240) throw new HttpError(400, '桌宠尺寸为 48–240 像素', 'BAD_SIZE'); patch.petSize = b.petSize; }
    store.log({ t: 'settings.set', settings: { appearance: patch } }); await pool.durable();
    return { ok: true, appearance: publicAppearance(store.state.settings) };
  });
  route('PUT', '/api/admin/appearance/assets/:slot', async (req, res, { slot }) => {
    requireAdmin(req); if (!SLOTS.has(slot)) throw new HttpError(400, '无效素材位置', 'BAD_SLOT');
    if (uploading) throw new HttpError(409, '请等待当前素材上传完成', 'BUSY');
    uploading = true;
    try {
      const bytes = await readBody(req, slot === 'pet' ? 2 * 1024 * 1024 : 1536 * 1024);
      const mime = mimeOf(bytes);
      const key = crypto.randomBytes(32), iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const encrypted = Buffer.concat([cipher.update(bytes), cipher.final(), cipher.getAuthTag()]);
      const uploaded = await pool.upload(encrypted, { filename: `theme-${slot}.bin` });
      const old = store.state.settings.themeAssets?.[slot];
      const ref = { ...uploaded, key: key.toString('hex'), iv: iv.toString('hex'), mime, version: crypto.randomBytes(8).toString('hex') };
      store.log({ t: 'settings.set', settings: { themeAssets: { ...(store.state.settings.themeAssets || {}), [slot]: ref },
        storageCleanup: [...(store.state.settings.storageCleanup || []), ...(old ? [old] : [])] } });
      await pool.durable(); if (old) await pool.cleanupOne(old);
      return { ok: true, appearance: publicAppearance(store.state.settings) };
    } finally { uploading = false; }
  });
  route('DELETE', '/api/admin/appearance/assets/:slot', async (req, res, { slot }) => {
    requireAdmin(req); if (!SLOTS.has(slot)) throw new HttpError(400, '无效素材位置', 'BAD_SLOT');
    if (uploading) throw new HttpError(409, '素材正在上传', 'BUSY');
    const old = store.state.settings.themeAssets?.[slot];
    store.log({ t: 'settings.set', settings: { themeAssets: { ...(store.state.settings.themeAssets || {}), [slot]: null },
      storageCleanup: [...(store.state.settings.storageCleanup || []), ...(old ? [old] : [])] } });
    await pool.durable(); if (old) await pool.cleanupOne(old);
    return { ok: true, appearance: publicAppearance(store.state.settings) };
  });
  route('GET', '/api/theme-assets/:slot', async (req, res, { slot }) => {
    const ref = SLOTS.has(slot) && store.state.settings.themeAssets?.[slot];
    if (!ref) throw new HttpError(404, '素材不存在', 'NOT_FOUND');
    const encrypted = await pool.read(ref, 2 * 1024 * 1024 + 16);
    const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(ref.key, 'hex'), Buffer.from(ref.iv, 'hex'));
    decipher.setAuthTag(encrypted.subarray(-16));
    const image = Buffer.concat([decipher.update(encrypted.subarray(0, -16)), decipher.final()]);
    res.writeHead(200, { 'Content-Type': ref.mime, 'Content-Length': image.length, 'Cache-Control': 'public, max-age=300', 'X-Content-Type-Options': 'nosniff' });
    res.end(image);
  });
}
