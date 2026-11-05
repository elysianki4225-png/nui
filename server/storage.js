import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { createReadStream } from 'node:fs';
import { TelegramPool } from './telegram.js';
import { HttpError, readJson } from './util.js';

const kind = ref => ref.botId === 'local' ? 'local' : 'telegram';
const digest = data => crypto.createHash('sha256').update(data).digest('hex');
export class StoragePool extends TelegramPool {
  constructor(store, cfg) { super(store, cfg); this.directory = path.join(cfg.dataDir, 'objects'); this.activeWrites = 0; this.migrationBusy = false; }
  mode() { return this.store.state.settings.storageMode || 'telegram'; }
  ready() { return this.mode() === 'local' || this.bots().length > 0; }
  objectPath(id) {
    if (!/^[a-f0-9]{48}$/.test(id)) throw new HttpError(400, '无效存储对象', 'BAD_OBJECT');
    return path.join(this.directory, id);
  }
  async upload(buffer, options = {}) {
    const mode = options.storageMode || this.mode();
    if (mode !== 'local') return super.upload(buffer, options);
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const id = crypto.randomBytes(24).toString('hex');
    const target = this.objectPath(id), temp = target + '.pending';
    const file = await fs.open(temp, 'wx', 0o600);
    try { await file.writeFile(buffer); await file.sync(); } finally { await file.close(); }
    await fs.rename(temp, target);
    const dir = await fs.open(this.directory, 'r'); try { await dir.sync(); } finally { await dir.close(); }
    return { botId: 'local', fileId: id, messageId: id, size: buffer.length };
  }
  async deleteMessage(botId, messageId) {
    if (botId !== 'local') return super.deleteMessage(botId, messageId);
    try {
      await fs.unlink(this.objectPath(messageId));
      const dir = await fs.open(this.directory, 'r'); try { await dir.sync(); } finally { await dir.close(); }
      return true;
    } catch (e) { return e.code === 'ENOENT'; }
  }
  async read(ref, max = this.cfg.chunkSize + 1024) {
    if (ref.botId === 'local') {
      const p = this.objectPath(ref.fileId), stat = await fs.stat(p);
      if (stat.size > max) throw new HttpError(413, '存储对象超过限制', 'OBJECT_LIMIT');
      return fs.readFile(p);
    }
    const bot = this.store.state.bots.find(b => b.id === ref.botId);
    if (!bot) throw new HttpError(404, '原存储机器人已移除，无法读取或迁移', 'BOT_GONE');
    const file = await this.getFilePath(bot, ref.fileId);
    const response = await fetch(`${this.apiBase}/file/bot${bot.token}/${file}`, { signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw new HttpError(502, 'Telegram 读取失败', 'TG_READ');
    let size = 0; const chunks = [];
    for await (const chunk of response.body) { size += chunk.length; if (size > max) throw new HttpError(413, '存储对象超过限制', 'OBJECT_LIMIT'); chunks.push(chunk); }
    return Buffer.concat(chunks);
  }
  async streamToClient(options) {
    if (options.botId !== 'local') return super.streamToClient(options);
    const p = this.objectPath(options.fileId), stat = await fs.stat(p);
    options.res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': stat.size, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
    await pipeline(createReadStream(p), options.res);
  }
  // Enumerate content references, never expose these (or encryption keys) in public DTOs.
  references() {
    const refs = [];
    for (const m of Object.values(this.store.state.memos)) {
      m.parts.forEach((ref, i) => { if (ref) refs.push({ ref, replace: next => { const parts = [...m.parts]; parts[i] = next; this.store.log({ t: 'memo.update', id: m.id, patch: { parts } }); } }); });
      if (m.thumb) refs.push({ ref: m.thumb, replace: thumb => this.store.log({ t: 'memo.update', id: m.id, patch: { thumb } }) });
    }
    for (const u of Object.values(this.store.state.users)) if (u.avatar) refs.push({ ref: u.avatar, replace: avatar => this.store.log({ t: 'user.update', account: u.account, patch: { avatar } }) });
    for (const [slot, ref] of Object.entries(this.store.state.settings.themeAssets || {})) if (ref) refs.push({ ref, replace: next => this.store.log({ t: 'settings.set', settings: { themeAssets: { ...this.store.state.settings.themeAssets, [slot]: next } } }) });
    return refs;
  }
  status() {
    const refs = this.references();
    return { mode: this.mode(), telegramReady: this.bots().length > 0, local: refs.filter(x => kind(x.ref) === 'local').length, telegram: refs.filter(x => kind(x.ref) === 'telegram').length,
      migration: this.store.state.settings.storageMigration || null, cleanupPending: (this.store.state.settings.storageCleanup || []).length };
  }
  async durable() {
    if (this.draining || this.store.closed) throw new Error('服务正在关闭，原文件未删除');
    await this.store.flushDurable();
  }
  async step() {
    if (this.migrationBusy) throw new HttpError(409, '迁移正在进行', 'BUSY');
    this.migrationBusy = true;
    try {
      const job = this.store.state.settings.storageMigration;
      if (!job) return this.status();
      const item = this.references().find(x => kind(x.ref) !== job.target);
      if (!item) {
        this.store.log({ t: 'settings.set', settings: { storageMode: job.target, storageMigration: null } });
        await this.durable(); return this.status();
      }
      const bytes = await this.read(item.ref, Math.max(this.cfg.chunkSize + 1024, 4 * 1024 * 1024));
      const next = await this.upload(bytes, { storageMode: job.target, filename: 'migrated.bin' });
      const verify = await this.read(next, bytes.length);
      if (digest(bytes) !== digest(verify)) { await this.deleteMessage(next.botId, next.messageId); throw new Error('迁移校验失败，原文件未删除'); }
      // Journal cleanup first, then change reference; both are durable before deletion.
      const cleanup = [...(this.store.state.settings.storageCleanup || []), item.ref];
      this.store.log({ t: 'settings.set', settings: { storageCleanup: cleanup } });
      item.replace({ ...item.ref, ...next });
      this.store.log({ t: 'settings.set', settings: { storageMigration: { ...job, moved: job.moved + 1 } } });
      await this.durable();
      await this.cleanupOne(item.ref);
      return this.status();
    } finally { this.migrationBusy = false; }
  }
  async retire(refs) {
    if (refs.length) this.store.log({ t: 'settings.set', settings: { storageCleanup: [...(this.store.state.settings.storageCleanup || []), ...refs] } });
    await this.durable();
    // Serial cleanup avoids one fsync/full snapshot per concurrently deleting file.
    for (const ref of refs) await this.cleanupOne(ref);
  }
  async cleanupOne(ref) {
    // A crash between journal and reference replacement must never delete a live object.
    const live = this.references().some(x => x.ref.botId === ref.botId && x.ref.fileId === ref.fileId);
    await this.durable();
    if (!live && !await this.deleteMessage(ref.botId, ref.messageId)) return false;
    this.store.log({ t: 'settings.set', settings: { storageCleanup: (this.store.state.settings.storageCleanup || []).filter(x => x.botId !== ref.botId || x.fileId !== ref.fileId) } });
    await this.durable(); return true;
  }
}

export function registerStorageRoutes({ route, requireAdmin }, { store, pool }) {
  route('GET', '/api/admin/storage', async req => { requireAdmin(req); return { ok: true, ...pool.status() }; });
  route('POST', '/api/admin/storage/start', async req => {
    requireAdmin(req); const body = await readJson(req, 1024);
    if (!['local', 'telegram'].includes(body.target)) throw new HttpError(400, '无效存储类型', 'BAD_STORAGE');
    if (pool.activeWrites > 1 || pool.migrationBusy || store.state.settings.storageMigration) throw new HttpError(409, '请等待当前写入或迁移完成', 'BUSY');
    if (body.target === 'telegram' && !pool.bots().length) throw new HttpError(400, '请先配置并启用 Telegram 机器人', 'NO_BOT');
    store.log({ t: 'settings.set', settings: { storageMigration: { target: body.target, moved: 0, startedAt: Date.now() } } });
    await pool.durable(); return { ok: true, ...pool.status() };
  });
  route('POST', '/api/admin/storage/step', async req => { requireAdmin(req); return { ok: true, ...await pool.step() }; });
  route('POST', '/api/admin/storage/cancel', async req => {
    requireAdmin(req); if (pool.migrationBusy) throw new HttpError(409, '请等待当前文件迁移完成', 'BUSY');
    store.log({ t: 'settings.set', settings: { storageMigration: null } }); await pool.durable(); return { ok: true, ...pool.status() };
  });
  route('POST', '/api/admin/storage/cleanup', async req => {
    requireAdmin(req); if (pool.migrationBusy) throw new HttpError(409, '迁移中，请稍后清理', 'BUSY');
    pool.migrationBusy = true;
    try { const ref = (store.state.settings.storageCleanup || [])[0]; const removed = ref ? await pool.cleanupOne(ref) : true; return { ok: true, removed, ...pool.status() }; }
    finally { pool.migrationBusy = false; }
  });
}
