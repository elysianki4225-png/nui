// 端到端加密 Worker：所有密码学运算在此线程执行，主线程零阻塞。
// 密钥派生：HKDF-SHA256；内容加密：AES-256-GCM（每分块独立随机 IV）。
// 服务器 / 管理员永远拿不到主密钥与明文。

const enc = new TextEncoder();
const dec = new TextDecoder();
const AUTH_SALT = enc.encode('nui-memo-auth-salt-v1');
const AUTH_INFO = enc.encode('auth');
const ENC_INFO = enc.encode('nui-memo-enc-v1');
let encKey = null;

const b64u = (buf) => {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const unb64u = (s) => {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

async function deriveProof(master) {
  const key = await crypto.subtle.importKey('raw', master, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: AUTH_SALT, info: AUTH_INFO }, key, 256);
  return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function deriveEncKey(master, account) {
  const key = await crypto.subtle.importKey('raw', master, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: enc.encode(String(account)), info: ENC_INFO },
    key, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  );
}

async function encryptChunk(key, bytes) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes);
  const out = new Uint8Array(12 + ct.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(ct), 12);
  return out.buffer;
}

async function decryptChunk(key, blob) {
  const bytes = new Uint8Array(blob);
  const iv = bytes.slice(0, 12);
  const ct = bytes.slice(12);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  return pt;
}

self.onmessage = async (e) => {
  const { id, type, ...d } = e.data;
  try {
    let result = {};
    let transfer = [];
    switch (type) {
      case 'proof': {
        result.proof = await deriveProof(d.master);
        break;
      }
      case 'init': {
        encKey = await deriveEncKey(d.master, d.account);
        result.ready = true;
        break;
      }
      case 'encryptMeta': {
        const blob = await encryptChunk(encKey, enc.encode(JSON.stringify(d.obj)));
        result.meta = b64u(blob);
        break;
      }
      case 'decryptMeta': {
        const pt = await decryptChunk(encKey, unb64u(d.meta));
        result.obj = JSON.parse(dec.decode(pt));
        break;
      }
      case 'decryptMetaBatch': {
        const out = [];
        for (const item of d.items) {
          try {
            const pt = await decryptChunk(encKey, unb64u(item.meta));
            out.push({ id: item.id, obj: JSON.parse(dec.decode(pt)) });
          } catch {
            out.push({ id: item.id, obj: null });
          }
        }
        result.items = out;
        break;
      }
      case 'encryptBytes': {
        const bytes = new Uint8Array(d.buffer);
        const chunkSize = d.chunkSize || bytes.length || 1;
        const parts = [];
        if (bytes.length === 0) {
          parts.push(await encryptChunk(encKey, bytes));
        } else {
          for (let off = 0; off < bytes.length; off += chunkSize) {
            parts.push(await encryptChunk(encKey, bytes.subarray(off, off + chunkSize)));
          }
        }
        result.parts = parts;
        transfer = parts;
        break;
      }
      case 'decryptBytes': {
        const pt = await decryptChunk(encKey, d.buffer);
        result.buffer = pt;
        transfer = [pt];
        break;
      }
      case 'encryptText': {
        const blob = await encryptChunk(encKey, enc.encode(d.text));
        result.buffer = blob;
        transfer = [blob];
        break;
      }
      case 'decryptText': {
        const pt = await decryptChunk(encKey, d.buffer);
        result.text = dec.decode(pt);
        break;
      }
      default:
        throw new Error('unknown message type: ' + type);
    }
    self.postMessage({ id, ok: true, ...result }, transfer);
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err && err.message || err) });
  }
};
