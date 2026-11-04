import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { randomId, nowSec, HttpError } from './util.js';

const MB = 1024 * 1024;
const SEND_INTERVAL = 1100;      // 每个机器人最小发送间隔（Telegram 限制约 1 条/秒/会话）
const FILE_PATH_TTL = 25 * 60_000;
const FILE_PATH_MAX = 4096;
const THUMB_MAX = 512 * 1024;

class LRU {
  constructor(max) { this.max = max; this.map = new Map(); }
  get(k) {
    const v = this.map.get(k);
    if (v === undefined) return undefined;
    this.map.delete(k); this.map.set(k, v);
    return v;
  }
  set(k, v) {
    if (this.map.has(k)) this.map.delete(k);
    this.map.set(k, v);
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
  }
  delete(k) { this.map.delete(k); }
  get size() { return this.map.size; }
}

/**
 * Telegram 机器人池：所有密文（文本/图片/视频/文件）只通过机器人存入管理员的聊天，
 * 服务器不落盘任何内容。内置每机器人限速队列、429 退避、并发与内存上限。
 */
export class TelegramPool {
  constructor(store, cfg) {
    this.store = store;
    this.cfg = cfg;
    this.apiBase = (cfg.telegramApiBase || 'https://api.telegram.org').replace(/\/$/, '');
    this.workers = new Map(); // botId -> worker
    this.filePathCache = new LRU(FILE_PATH_MAX);
    this.thumbCache = new Map(); // key -> Buffer
    this.thumbBytes = 0;
    this.thumbMaxBytes = (cfg.thumbCacheMB || 64) * MB;
    this.queueBytes = 0;
    this.queueMaxBytes = (cfg.uploadQueueMB || 96) * MB;
    this.uploadConcurrency = Math.max(1, cfg.uploadConcurrency || 3);
    this.inFlight = 0;
    this.waiters = [];
    this.sentTotal = 0;
    this.errorTotal = 0;
    this.closed = false;
    this.syncWorkers();
  }

  bots() { return this.store.state.bots.filter((b) => b.enabled && b.token && b.chatId); }

  syncWorkers() {
    const bots = this.store.state.bots;
    const ids = new Set(bots.map((b) => b.id));
    for (const [id, w] of this.workers) {
      if (!ids.has(id)) { w.stop(); this.workers.delete(id); }
    }
    for (const b of bots) {
      if (!this.workers.has(b.id)) this.workers.set(b.id, new BotWorker(this, b));
      else this.workers.get(b.id).bot = b;
    }
  }

  async api(bot, method, params = {}, { timeout = 30_000 } = {}) {
    const url = `${this.apiBase}/bot${bot.token}/${method}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(timeout),
    });
    const data = await res.json().catch(() => null);
    if (!data) throw new Error(`Telegram 返回异常 (HTTP ${res.status})`);
    if (!data.ok) {
      const err = new Error(data.description || `Telegram 错误 ${data.error_code}`);
      err.code = data.error_code;
      err.retryAfter = data.parameters?.retry_after;
      throw err;
    }
    return data.result;
  }

  async testBinding(token, chatId) {
    const bot = { token, chatId };
    const me = await this.api(bot, 'getMe', {}, { timeout: 15_000 });
    let chat = null;
    if (chatId) {
      try { chat = await this.api(bot, 'getChat', { chat_id: chatId }, { timeout: 15_000 }); }
      catch (e) { const err = new Error(`机器人信息获取成功(@${me.username})，但无法访问聊天 ${chatId}: ${e.message}`); err.partial = me; throw err; }
    }
    return { me, chat };
  }

  async detectChat(token) {
    const bot = { token };
    const updates = await this.api(bot, 'getUpdates', { limit: 50, timeout: 0 }, { timeout: 20_000 });
    const chats = new Map();
    for (const u of updates) {
      const msg = u.message || u.channel_post || u.my_chat_member || u.edited_message;
      const c = msg?.chat;
      if (c) chats.set(String(c.id), { id: String(c.id), type: c.type, title: c.title || c.username || [c.first_name, c.last_name].filter(Boolean).join(' ') || String(c.id) });
    }
    return [...chats.values()];
  }

  pickWorker() {
    this.syncWorkers();
    const candidates = [...this.workers.values()].filter((w) => w.bot.enabled && w.bot.token && w.bot.chatId);
    if (!candidates.length) throw new HttpError(503, '管理员尚未绑定可用的 Telegram 机器人，无法存储内容', 'NO_BOT');
    candidates.sort((a, b) => (a.queue.length - b.queue.length) || (a.nextAt - b.nextAt));
    return candidates[0];
  }

  acquireSlot() {
    if (this.inFlight < this.uploadConcurrency) { this.inFlight++; return Promise.resolve(); }
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  releaseSlot() {
    const next = this.waiters.shift();
    if (next) next();
    else this.inFlight = Math.max(0, this.inFlight - 1);
  }

  /** 上传一个密文分块，返回 Telegram file_id */
  upload(buffer, { filename, caption }) {
    if (this.queueBytes + buffer.length > this.queueMaxBytes) {
      throw new HttpError(503, '上传队列已满，请稍后重试', 'QUEUE_FULL');
    }
    const worker = this.pickWorker();
    this.queueBytes += buffer.length;
    return new Promise((resolve, reject) => {
      worker.push({
        kind: 'upload', buffer, filename, caption, resolve, reject, retries: 0,
        onDone: () => { this.queueBytes = Math.max(0, this.queueBytes - buffer.length); },
      });
    });
  }

  /** 删除 Telegram 消息（尽力而为，进入同一限速队列） */
  deleteMessage(botId, messageId) {
    const w = this.workers.get(botId);
    if (!w || !messageId) return Promise.resolve(false);
    return new Promise((resolve) => {
      w.push({ kind: 'delete', messageId, resolve, reject: () => resolve(false), retries: 0, onDone: () => {} });
    });
  }

  async getFilePath(bot, fileId) {
    const key = `${bot.id}:${fileId}`;
    const cached = this.filePathCache.get(key);
    if (cached && cached.expires > Date.now()) return cached.path;
    const result = await this.api(bot, 'getFile', { file_id: fileId }, { timeout: 20_000 });
    this.filePathCache.set(key, { path: result.file_path, expires: Date.now() + FILE_PATH_TTL });
    return result.file_path;
  }

  thumbCacheGet(key) {
    const v = this.thumbCache.get(key);
    if (!v) return null;
    this.thumbCache.delete(key); this.thumbCache.set(key, v);
    return v;
  }

  thumbCacheSet(key, buf) {
    if (buf.length > THUMB_MAX) return;
    if (this.thumbCache.has(key)) {
      this.thumbBytes -= this.thumbCache.get(key).length;
      this.thumbCache.delete(key);
    }
    this.thumbCache.set(key, buf);
    this.thumbBytes += buf.length;
    while (this.thumbBytes > this.thumbMaxBytes && this.thumbCache.size > 1) {
      const oldest = this.thumbCache.keys().next().value;
      this.thumbBytes -= this.thumbCache.get(oldest).length;
      this.thumbCache.delete(oldest);
    }
  }

  /**
   * 将 Telegram 上的密文流式转发给客户端（VPS 中转，浏览器永远不直接访问 t.me）。
   * 小缩略图走内存 LRU 缓存；大文件纯流式转发，不占内存、不落盘。
   */
  async streamToClient({ botId, fileId, expectedSize, res, req }) {
    const bot = this.store.state.bots.find((b) => b.id === botId);
    if (!bot) throw new HttpError(404, '存储该内容的机器人已被移除', 'BOT_GONE');
    const cacheKey = `${botId}:${fileId}`;
    const canCache = expectedSize && expectedSize <= THUMB_MAX;
    if (canCache) {
      const hit = this.thumbCacheGet(cacheKey);
      if (hit) {
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': hit.length,
          'Cache-Control': 'private, no-store',
          'X-Content-Type-Options': 'nosniff',
        });
        res.end(hit);
        return;
      }
    }
    const path = await this.getFilePath(bot, fileId);
    const url = `${this.apiBase}/file/bot${bot.token}/${path}`;
    const controller = new AbortController();
    const onClose = () => controller.abort();
    req.on('close', onClose);
    let upstream;
    try {
      upstream = await fetch(url, { signal: controller.signal });
      if (!upstream.ok || !upstream.body) throw new HttpError(502, `从 Telegram 拉取失败 (HTTP ${upstream.status})`, 'TG_FETCH_FAIL');
      const headers = {
        'Content-Type': 'application/octet-stream',
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      };
      const len = upstream.headers.get('content-length');
      if (len) headers['Content-Length'] = len;
      if (canCache) {
        const chunks = [];
        let total = 0;
        for await (const chunk of Readable.fromWeb(upstream.body)) {
          total += chunk.length;
          if (total > THUMB_MAX) { // 超出缓存上限则转为流式
            res.writeHead(200, headers);
            for (const c of chunks) res.write(c);
            res.write(chunk);
            await pipeline(Readable.fromWeb(upstream.body), res).catch(() => {});
            req.removeListener('close', onClose);
            return;
          }
          chunks.push(chunk);
        }
        const buf = Buffer.concat(chunks);
        this.thumbCacheSet(cacheKey, buf);
        res.writeHead(200, { ...headers, 'Content-Length': buf.length });
        res.end(buf);
      } else {
        res.writeHead(200, headers);
        await pipeline(Readable.fromWeb(upstream.body), res);
      }
    } catch (e) {
      if (controller.signal.aborted || e?.name === 'AbortError' || e?.code === 'ERR_STREAM_PREMATURE_CLOSE') return;
      throw e;
    } finally {
      req.removeListener('close', onClose);
    }
  }

  stats() {
    this.syncWorkers();
    return {
      queueBytes: this.queueBytes,
      queueMaxBytes: this.queueMaxBytes,
      inFlight: this.inFlight,
      sentTotal: this.sentTotal,
      errorTotal: this.errorTotal,
      thumbCacheEntries: this.thumbCache.size,
      thumbCacheBytes: this.thumbBytes,
      bots: [...this.workers.values()].map((w) => ({
        id: w.bot.id, name: w.bot.name, username: w.bot.username || null,
        queue: w.queue.length, sent: w.sent, errors: w.errors,
        lastError: w.bot.lastError || null, lastOkAt: w.bot.lastOkAt || null,
        cooldownMs: Math.max(0, w.nextAt - Date.now()),
      })),
    };
  }

  stop() {
    this.closed = true;
    for (const w of this.workers.values()) w.stop();
    this.thumbCache.clear();
    this.filePathCache.map.clear();
  }
}

class BotWorker {
  constructor(pool, bot) {
    this.pool = pool;
    this.bot = bot;
    this.queue = [];
    this.nextAt = 0;
    this.running = false;
    this.stopped = false;
    this.sent = 0;
    this.errors = 0;
    this.wake = null;
  }

  push(job) {
    if (this.stopped) { job.reject(new HttpError(503, '机器人已停用')); return; }
    this.queue.push(job);
    if (!this.running) this.run();
    else if (this.wake) this.wake();
  }

  stop() {
    this.stopped = true;
    if (this.wake) this.wake();
    for (const j of this.queue.splice(0)) { j.onDone?.(); j.reject?.(new Error('worker stopped')); }
  }

  async run() {
    this.running = true;
    while (!this.stopped && this.queue.length) {
      const wait = this.nextAt - Date.now();
      if (wait > 0) {
        await new Promise((r) => { this.wake = r; setTimeout(r, wait); });
        this.wake = null;
        continue;
      }
      const job = this.queue.shift();
      try {
        if (job.kind === 'upload') await this.doUpload(job);
        else if (job.kind === 'delete') await this.doDelete(job);
        this.nextAt = Date.now() + SEND_INTERVAL;
        this.bot.lastError = null;
        this.bot.lastOkAt = nowSec();
      } catch (e) {
        this.errors++;
        this.pool.errorTotal++;
        if (e.retryAfter) {
          this.nextAt = Date.now() + (e.retryAfter + 1) * 1000;
          if (job.retries < 5) { job.retries++; this.queue.unshift(job); continue; }
        } else if (job.retries < 2 && /timeout|network|fetch failed|ECONN|ETIMEDOUT|5\d\d/i.test(String(e.message))) {
          job.retries++;
          this.nextAt = Date.now() + 2000 * job.retries;
          this.queue.unshift(job);
          continue;
        }
        this.bot.lastError = String(e.message).slice(0, 300);
        job.onDone?.();
        job.reject?.(e);
      }
    }
    this.running = false;
  }

  async doUpload(job) {
    await this.pool.acquireSlot();
    try {
      const fd = new FormData();
      fd.append('chat_id', String(this.bot.chatId));
      fd.append('document', new Blob([job.buffer]), job.filename || 'memo.bin');
      if (job.caption) fd.append('caption', job.caption.slice(0, 1024));
      fd.append('disable_notification', 'true');
      const url = `${this.pool.apiBase}/bot${this.bot.token}/sendDocument`;
      const res = await fetch(url, { method: 'POST', body: fd, signal: AbortSignal.timeout(180_000) });
      const data = await res.json().catch(() => null);
      if (!data || !data.ok) {
        const err = new Error(data?.description || `Telegram 上传失败 (HTTP ${res.status})`);
        err.code = data?.error_code;
        err.retryAfter = data?.parameters?.retry_after;
        throw err;
      }
      const doc = data.result.document || data.result.video || data.result.audio;
      if (!doc) throw new Error('Telegram 未返回文件信息');
      this.sent++;
      this.pool.sentTotal++;
      job.onDone?.();
      job.resolve({
        fileId: doc.file_id,
        fileUniqueId: doc.file_unique_id,
        messageId: data.result.message_id,
        size: doc.file_size || job.buffer.length,
        botId: this.bot.id,
      });
    } finally {
      this.pool.releaseSlot();
    }
  }

  async doDelete(job) {
    try {
      await this.pool.api(this.bot, 'deleteMessage', { chat_id: this.bot.chatId, message_id: job.messageId }, { timeout: 15_000 });
      job.resolve(true);
    } catch (e) {
      job.resolve(false); // 删除失败不阻塞（消息可能已被手动删除）
    }
  }
}
