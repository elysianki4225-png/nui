// 媒体中转 + 解密 + 对象 URL 生命周期管理。
// 浏览器只访问本站 /api/...（VPS 中转 Telegram），绝不直接请求 t.me。
// 所有 objectURL 由 LRU 缓存统一管理，淘汰即 revoke，杜绝内存泄漏。
import { API_BASE, IS_EXPORT, entryHeaders, entryRequired } from './core.js';

class BlobLRU {
  constructor(maxEntries, maxBytes) {
    this.maxEntries = maxEntries;
    this.maxBytes = maxBytes;
    this.map = new Map();
    this.bytes = 0;
  }
  get(key) {
    const v = this.map.get(key);
    if (!v) return null;
    this.map.delete(key); this.map.set(key, v);
    return v;
  }
  set(key, val) {
    if (this.map.has(key)) this.delete(key);
    this.map.set(key, val);
    this.bytes += val.size || 0;
    while ((this.map.size > this.maxEntries || this.bytes > this.maxBytes) && this.map.size > 1) {
      const oldest = this.map.keys().next().value;
      this.delete(oldest);
    }
  }
  delete(key) {
    const v = this.map.get(key);
    if (!v) return;
    if (v.url) URL.revokeObjectURL(v.url);
    this.bytes -= v.size || 0;
    this.map.delete(key);
  }
  clear() { for (const k of [...this.map.keys()]) this.delete(k); }
  get size() { return this.map.size; }
}

async function fetchCipher(path, signal) {
  const headers = { 'X-Memo-Client': 'web', ...entryHeaders() };
  if (IS_EXPORT) {
    const t = localStorage.getItem('memo-token');
    if (t) headers.Authorization = `Bearer ${t}`;
  }
  const res = await fetch(API_BASE + path, { credentials: IS_EXPORT ? 'omit' : 'same-origin', signal, headers });
  if (!res.ok) {
    let msg = `加载失败 (${res.status})`;
    try { const j = await res.json(); entryRequired(j.code); if (j.error) msg = j.error; } catch {}
    throw new Error(msg);
  }
  return res.arrayBuffer();
}

export class MediaManager {
  constructor(cryptoClient, { maxThumbs = 150, maxFull = 8, maxFullBytes = 256 * 1024 * 1024 } = {}) {
    this.crypto = cryptoClient;
    this.lifecycle = new AbortController();
    this.thumbs = new BlobLRU(maxThumbs, 64 * 1024 * 1024);
    this.full = new BlobLRU(maxFull, maxFullBytes);
    this.thumbPending = new Map();
    this.fullPending = new Map();
  }

  async thumbUrl(memo, signal) {
    signal = signal ? AbortSignal.any([signal, this.lifecycle.signal]) : this.lifecycle.signal;
    signal.throwIfAborted();
    const hit = this.thumbs.get(memo.id);
    if (hit) return hit.url;
    if (this.thumbPending.has(memo.id)) return this.thumbPending.get(memo.id);
    const p = (async () => {
      const cipher = await fetchCipher(`/api/user/memos/${memo.id}/thumb`, signal);
      const { buffer } = await this.crypto.decryptBytes(cipher);
      signal.throwIfAborted();
      const blob = new Blob([buffer], { type: 'image/jpeg' });
      const url = URL.createObjectURL(blob);
      this.thumbs.set(memo.id, { url, size: blob.size });
      return url;
    })();
    this.thumbPending.set(memo.id, p);
    try { return await p; } finally { this.thumbPending.delete(memo.id); }
  }

  // 拉取并解密完整内容，返回 { blob, url, bytes }
  async content(memo, mime, { signal, onProgress } = {}) {
    signal = signal ? AbortSignal.any([signal, this.lifecycle.signal]) : this.lifecycle.signal;
    signal.throwIfAborted();
    const hit = this.full.get(memo.id);
    if (hit) return hit;
    if (this.fullPending.has(memo.id)) return this.fullPending.get(memo.id);
    const p = (async () => {
      const parts = [];
      let total = 0;
      for (let i = 0; i < memo.parts; i++) {
        const cipher = await fetchCipher(`/api/user/memos/${memo.id}/content?part=${i}`, signal);
        const { buffer } = await this.crypto.decryptBytes(cipher);
        signal.throwIfAborted();
        parts.push(buffer);
        total += buffer.byteLength;
        onProgress?.((i + 1) / memo.parts);
      }
      const blob = new Blob(parts, { type: mime || 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      const entry = { blob, url, size: blob.size, bytes: total };
      this.full.set(memo.id, entry);
      return entry;
    })();
    this.fullPending.set(memo.id, p);
    try { return await p; } finally { this.fullPending.delete(memo.id); }
  }

  async text(memo, { signal } = {}) {
    const { blob } = await this.content(memo, 'text/plain;charset=utf-8', { signal });
    const text = await blob.text();
    this.lifecycle.signal.throwIfAborted();
    signal?.throwIfAborted();
    return text;
  }

  release(memoId) { this.full.delete(memoId); }
  clear() { this.lifecycle.abort(); this.thumbs.clear(); this.full.clear(); this.thumbPending.clear(); this.fullPending.clear(); }
}
