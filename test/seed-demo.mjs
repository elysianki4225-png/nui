// 为演示环境填充数据：管理员 + 模拟机器人 + 含示例内容的演示账号
import { webcrypto as crypto } from 'node:crypto';
import zlib from 'node:zlib';

const BASE = process.env.DEMO_BASE || 'http://127.0.0.1:8080';
const ADMIN_USER = 'admin';
const ADMIN_PASS = 'memo-demo-2026';
const DEMO_KEY = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRST';
const enc = new TextEncoder(), dec = new TextDecoder();
const AUTH_SALT = enc.encode('nui-memo-auth-salt-v1'), AUTH_INFO = enc.encode('auth'), ENC_INFO = enc.encode('nui-memo-enc-v1');
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function b32decode(str) { let bits = 0, value = 0; const out = []; for (const ch of str.toUpperCase().replace(/[\s-]/g, '')) { value = (value << 5) | B32.indexOf(ch); bits += 5; if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; } } return new Uint8Array(out); }
const b64u = (b) => Buffer.from(b).toString('base64url');
async function proofOf(m) { const k = await crypto.subtle.importKey('raw', m, 'HKDF', false, ['deriveBits']); return Buffer.from(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: AUTH_SALT, info: AUTH_INFO }, k, 256)).toString('hex'); }
async function encKeyOf(m, a) { const k = await crypto.subtle.importKey('raw', m, 'HKDF', false, ['deriveKey']); return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: enc.encode(a), info: ENC_INFO }, k, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']); }
async function encBytes(k, b) { const iv = crypto.getRandomValues(new Uint8Array(12)); const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k, b); const o = new Uint8Array(12 + ct.byteLength); o.set(iv); o.set(new Uint8Array(ct), 12); return o; }
const encMeta = async (k, o) => b64u(await encBytes(k, enc.encode(JSON.stringify(o))));

function client() {
  const jar = new Map();
  return async (method, p, body, raw = false) => {
    const headers = { 'X-Memo-Client': 'seed' };
    if (jar.size) headers.Cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    let payload;
    if (body !== undefined) { if (raw) { payload = body; headers['Content-Type'] = 'application/octet-stream' } else { payload = JSON.stringify(body); headers['Content-Type'] = 'application/json' } }
    const res = await fetch(BASE + p, { method, headers, body: payload });
    for (const sc of res.headers.getSetCookie?.() || []) { const [kv] = sc.split(';'); const i = kv.indexOf('='); if (kv.slice(i + 1)) jar.set(kv.slice(0, i), kv.slice(i + 1)); else jar.delete(kv.slice(0, i)); }
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('json')) { const d = await res.json(); if (!res.ok) throw new Error(d.error || res.status); return d; }
    if (!res.ok) throw new Error(res.status);
    return res;
  };
}

// 极简 PNG 生成（渐变）
const crcTable = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf) { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) { const t = Buffer.from(type); const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, crc]); }
function makePng(w, h, fn) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { const row = y * (w * 3 + 1); raw[row] = 0; for (let x = 0; x < w; x++) { const [r, g, b] = fn(x, y); const i = row + 1 + x * 3; raw[i] = r; raw[i + 1] = g; raw[i + 2] = b; } }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

async function main() {
  const admin = client();
  const status = await admin('GET', '/api/admin/status');
  if (status.setupRequired) {
    await admin('POST', '/api/admin/setup', { username: ADMIN_USER, password: ADMIN_PASS });
    console.log('管理员已创建');
  }
  const bots = await admin('GET', '/api/admin/bots');
  if (!bots.items.length) {
    await admin('POST', '/api/admin/bots', { name: '演示存储', token: '123456789:DEMO_mock_token_abcdefghijklmnopqrst', chatId: '100200300' });
    console.log('模拟机器人已绑定');
  }
  // 演示用户
  const user = client();
  const master = b32decode(DEMO_KEY);
  const proof = await proofOf(master);
  let account;
  const reg = await user('POST', '/api/user/register', { proof }).catch(() => null);
  if (reg) account = reg.account;
  else { const login = await user('POST', '/api/user/login', { account: process.env.DEMO_ACCOUNT || '', proof }); account = login.account; }
  const key = await encKeyOf(master, account);
  const cfg = await user('GET', '/api/config');
  const existing = await user('GET', '/api/user/memos?limit=1');
  if (existing.items.length === 0) {
    const texts = [
      ['欢迎使用备忘录', '这是一个端到端加密的备忘录。\n\n你的文字、图片和视频在浏览器里加密后，才会通过 VPS 中转到管理员的 Telegram 机器人。服务器和管理员都看不到内容。\n\n试试右上角切换深色模式，或点「新建」保存你自己的内容。', true],
      ['购物清单', '牛奶\n鸡蛋\n全麦面包\n咖啡豆\n西兰花\n三文鱼', false],
      ['项目灵感', '1. 用虚拟滚动支撑十万级条目\n2. 搜索索引在 Worker 里解密，主线程零阻塞\n3. 图片缩略图走 VPS 内存缓存，国内也能秒开\n4. 密钥用 base32 展示，方便手抄', true],
      ['读书笔记', '《深度工作》：专注是这个时代最稀缺的能力。把注意力当作资产来管理，而不是当作消耗品。', false],
      ['会议记录', '时间：周一 10:00\n议题：Q3 路线图\n结论：优先完成加密存储与多端同步，下周评审 UI。', false],
      ['旅行计划', '机票：已订\n酒店：待定\n行程：第一天博物馆，第二天海边，第三天老城闲逛。记得带转换插头。', false],
    ];
    for (const [title, body, pinned] of texts) {
      const bytes = enc.encode(body);
      const meta = await encMeta(key, { title, preview: body.slice(0, 80) });
      const created = await user('POST', '/api/user/memos', { type: 'text', size: bytes.length, meta, parts: 1 });
      await user('PUT', `/api/user/memos/${created.id}/parts/0`, await encBytes(key, bytes), true);
      await user('POST', `/api/user/memos/${created.id}/complete`);
      if (pinned) await user('PATCH', `/api/user/memos/${created.id}`, { pinned: true });
    }
    // 一张渐变图片
    const png = makePng(640, 420, (x, y) => [Math.round(103 + x / 640 * 80), Math.round(80 + y / 420 * 120), Math.round(164 + (x + y) / 1060 * 60)]);
    const thumb = makePng(320, 210, (x, y) => [Math.round(103 + x / 320 * 80), Math.round(80 + y / 210 * 120), Math.round(164 + (x + y) / 530 * 60)]);
    const meta = await encMeta(key, { title: '渐变示例.png', preview: '', mime: 'image/png', w: 640, h: 420 });
    const created = await user('POST', '/api/user/memos', { type: 'image', size: png.length, meta, parts: 1 });
    await user('PUT', `/api/user/memos/${created.id}/parts/0`, await encBytes(key, png), true);
    await user('PUT', `/api/user/memos/${created.id}/thumb`, await encBytes(key, thumb), true);
    await user('POST', `/api/user/memos/${created.id}/complete`);
    console.log('示例备忘录已创建');
  }
  console.log('\n========== 演示凭据 ==========');
  console.log(`管理界面:  ${BASE}/admin/`);
  console.log(`管理员:    ${ADMIN_USER} / ${ADMIN_PASS}`);
  console.log(`用户界面:  ${BASE}/`);
  console.log(`演示账号:  ${account}`);
  console.log(`演示密钥:  ${DEMO_KEY}`);
  console.log('==============================\n');
}
main().catch((e) => { console.error('seed failed:', e); process.exit(1); });
