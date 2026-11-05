// 主线程加密客户端：管理 Worker、base32 密钥编码、Promise 化调用。
// 主密钥仅在用户浏览器内存中存在，绝不发送到服务器。

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(bytes) {
  let bits = 0, value = 0, out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/[\s-]/g, '').replace(/=+$/, '');
  let bits = 0, value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error('密钥包含无效字符');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return new Uint8Array(out);
}

export function generateKey() {
  const master = crypto.getRandomValues(new Uint8Array(32));
  return { master, keyString: base32Encode(master) };
}

export function formatKey(keyString) {
  return keyString.replace(/(.{4})/g, '$1-').replace(/-$/, '');
}

export function parseKey(input) {
  const bytes = base32Decode(input);
  if (bytes.length !== 32) throw new Error('密钥长度不正确（应为 52 个字符）');
  return bytes;
}

export class CryptoClient {
  constructor(workerUrl = '/app/worker.js') {
    // 导出单文件模式：worker 代码已内联为字符串，用 Blob 启动
    if (typeof window !== 'undefined' && window.__MEMO_WORKER__) {
      const blob = new Blob([window.__MEMO_WORKER__], { type: 'text/javascript' });
      workerUrl = URL.createObjectURL(blob);
    }
    this.worker = new Worker(workerUrl);
    this.seq = 0;
    this.pending = new Map();
    this.worker.onmessage = (e) => {
      const { id, ok, ...rest } = e.data;
      const p = this.pending.get(id);
      if (!p) return;
      this.pending.delete(id);
      if (ok) p.resolve(rest);
      else p.reject(new Error(rest.error || '加密运算失败'));
    };
    this.worker.onerror = (e) => {
      for (const [, p] of this.pending) p.reject(new Error('加密线程错误: ' + (e.message || '')));
      this.pending.clear();
    };
  }

  call(type, data = {}, transfer = []) {
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      this.pending.set(id, { resolve, reject });
      try {
        this.worker.postMessage({ id, type, ...data }, transfer);
      } catch (e) {
        this.pending.delete(id);
        reject(e);
      }
    });
  }

  proof(master) { return this.call('proof', { master }); }
  init(master, account) { return this.call('init', { master, account }); }
  encryptMeta(obj) { return this.call('encryptMeta', { obj }); }
  decryptMeta(meta) { return this.call('decryptMeta', { meta }); }
  decryptMetaBatch(items) { return this.call('decryptMetaBatch', { items }); }
  encryptBytes(buffer, chunkSize) { return this.call('encryptBytes', { buffer, chunkSize }, [buffer]); }
  decryptBytes(buffer) { return this.call('decryptBytes', { buffer }, [buffer]); }
  encryptText(text) { return this.call('encryptText', { text }); }
  decryptText(buffer) { return this.call('decryptText', { buffer }, [buffer]); }

  terminate() {
    for (const [, p] of this.pending) p.reject(new Error('已终止'));
    this.pending.clear();
    this.worker.terminate();
  }
}

export function cryptoAvailable() {
  return typeof crypto !== 'undefined' && !!crypto.subtle;
}
