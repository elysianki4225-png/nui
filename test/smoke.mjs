// 端到端冒烟测试：启动模拟 Telegram + 真实后端，验证完整链路
import { spawn } from 'node:child_process';
import { webcrypto as crypto } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockTelegram } from './mock-telegram.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const enc = new TextEncoder();
const dec = new TextDecoder();
const PORT = 8791;
const BASE = `http://127.0.0.1:${PORT}`;
let passed = 0, failed = 0;
function ok(cond, name) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}`); }
}

// ---- 与前端一致的密钥派生 / 加解密 ----
const AUTH_SALT = enc.encode('nui-memo-auth-salt-v1');
const AUTH_INFO = enc.encode('auth');
const ENC_INFO = enc.encode('nui-memo-enc-v1');
const b64u = (buf) => Buffer.from(buf).toString('base64url');
const unb64u = (s) => new Uint8Array(Buffer.from(s, 'base64url'));

async function deriveProof(master) {
  const key = await crypto.subtle.importKey('raw', master, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: AUTH_SALT, info: AUTH_INFO }, key, 256);
  return Buffer.from(bits).toString('hex');
}
async function deriveEncKey(master, account) {
  const key = await crypto.subtle.importKey('raw', master, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: enc.encode(account), info: ENC_INFO }, key, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function encryptBytes(key, bytes) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes);
  const out = new Uint8Array(12 + ct.byteLength);
  out.set(iv, 0); out.set(new Uint8Array(ct), 12);
  return out;
}
async function decryptBytes(key, blob) {
  const iv = blob.slice(0, 12);
  const ct = blob.slice(12);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  return new Uint8Array(pt);
}
const encryptMeta = async (key, obj) => b64u(await encryptBytes(key, enc.encode(JSON.stringify(obj))));
const decryptMeta = async (key, s) => JSON.parse(dec.decode(await decryptBytes(key, unb64u(s))));

// ---- 带 cookie 的 HTTP 客户端 ----
function makeClient() {
  const cookies = new Map();
  return async function req(method, p, body, raw = false) {
    const headers = { 'X-Memo-Client': 'smoke' };
    if (cookies.size) headers.Cookie = [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    let payload;
    if (body !== undefined) {
      if (raw) { payload = body; headers['Content-Type'] = 'application/octet-stream'; }
      else { payload = JSON.stringify(body); headers['Content-Type'] = 'application/json'; }
    }
    const res = await fetch(BASE + p, { method, headers, body: payload });
    for (const sc of res.headers.getSetCookie?.() || []) {
      const [kv] = sc.split(';');
      const idx = kv.indexOf('=');
      const k = kv.slice(0, idx), v = kv.slice(idx + 1);
      if (v) cookies.set(k, v); else cookies.delete(k);
    }
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) return { status: res.status, data: await res.json() };
    return { status: res.status, buf: Buffer.from(await res.arrayBuffer()), headers: res.headers };
  };
}

async function waitServer(timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) return true; } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('server did not start');
}

async function main() {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'nui-memo-test-'));
  const mock = await startMockTelegram(9097);
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: {
      ...process.env,
      MEMO_PORT: String(PORT), MEMO_HOST: '127.0.0.1', MEMO_DATA_DIR: dataDir,
      MEMO_DEV: '1', MEMO_TELEGRAM_API: 'http://127.0.0.1:9097',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  child.stdout.on('data', (d) => { serverLog += d; });
  child.stderr.on('data', (d) => { serverLog += d; });
  try {
    await waitServer();
    console.log('\n[1] 健康检查与配置');
    const anon = makeClient();
    let r = await anon('GET', '/api/health');
    ok(r.status === 200 && r.data.ok, 'health 返回 ok');
    r = await anon('GET', '/api/config');
    ok(r.data.siteName === '备忘录', '默认站点名为 备忘录');

    console.log('\n[2] 管理员初始化与登录');
    const admin = makeClient();
    r = await admin('GET', '/api/admin/status');
    ok(r.data.setupRequired === true, '首次进入需要初始化');
    r = await admin('POST', '/api/admin/setup', { username: 'admin', password: 'SuperSecret123' });
    ok(r.status === 200 && r.data.ok, '管理员初始化成功');
    r = await admin('GET', '/api/admin/status');
    ok(r.data.setupRequired === false && r.data.loggedIn === true, '初始化后已登录');

    console.log('\n[3] 绑定 Telegram 机器人（模拟）');
    r = await admin('POST', '/api/admin/bots', { name: '测试机器人', token: '123456:ABCDEF_mock_token_0123456789', chatId: '100200300' });
    ok(r.status === 200 && r.data.ok, '机器人绑定成功');
    r = await admin('GET', '/api/config');
    ok(r.data.storageReady === true, 'storageReady 为 true');

    console.log('\n[4] 用户注册（数字账号 + 密钥）');
    const user = makeClient();
    const master = crypto.getRandomValues(new Uint8Array(32));
    const proof = await deriveProof(master);
    r = await user('POST', '/api/user/register', { proof });
    ok(r.status === 200 && /^\d{16}$/.test(r.data.account), '注册返回 16 位数字账号');
    const account = r.data.account;
    const encKey = await deriveEncKey(master, account);

    console.log('\n[5] 创建加密文本备忘录');
    const text = '这是一条端到端加密的备忘录。\n第二行内容，管理员无法看到。';
    const meta = await encryptMeta(encKey, { title: '测试备忘录', preview: text.slice(0, 40) });
    r = await user('POST', '/api/user/memos', { type: 'text', size: enc.encode(text).length, meta, parts: 1 });
    ok(r.status === 200 && r.data.id, '创建占位成功');
    const memoId = r.data.id;
    const cipher = await encryptBytes(encKey, enc.encode(text));
    r = await user('PUT', `/api/user/memos/${memoId}/parts/0`, cipher, true);
    ok(r.status === 200 && r.data.ok, '密文分块上传到 Telegram');
    r = await user('POST', `/api/user/memos/${memoId}/complete`);
    ok(r.status === 200 && r.data.memo, '完成上传');

    console.log('\n[6] 列表 / 中转下载 / 解密');
    r = await user('GET', '/api/user/memos');
    ok(r.data.items.length === 1, '列表返回 1 条');
    const decryptedMeta = await decryptMeta(encKey, r.data.items[0].meta);
    ok(decryptedMeta.title === '测试备忘录', '元数据可解密且标题正确');
    r = await user('GET', `/api/user/memos/${memoId}/content?part=0`);
    ok(r.status === 200 && r.buf.length === cipher.length, 'VPS 中转返回密文字节');
    const plain = await decryptBytes(encKey, new Uint8Array(r.buf));
    ok(dec.decode(plain) === text, '解密后内容与原文一致');

    console.log('\n[7] 图片（缩略图 + 原图）');
    const imgBytes = crypto.getRandomValues(new Uint8Array(50000));
    const thumbBytes = crypto.getRandomValues(new Uint8Array(3000));
    const imgMeta = await encryptMeta(encKey, { title: 'photo.jpg', preview: '', mime: 'image/jpeg', w: 800, h: 600 });
    r = await user('POST', '/api/user/memos', { type: 'image', size: imgBytes.length, meta: imgMeta, parts: 1 });
    const imgId = r.data.id;
    await user('PUT', `/api/user/memos/${imgId}/parts/0`, await encryptBytes(encKey, imgBytes), true);
    await user('PUT', `/api/user/memos/${imgId}/thumb`, await encryptBytes(encKey, thumbBytes), true);
    r = await user('POST', `/api/user/memos/${imgId}/complete`);
    ok(r.status === 200, '图片备忘录完成');
    r = await user('GET', `/api/user/memos/${imgId}/thumb`);
    const decThumb = await decryptBytes(encKey, new Uint8Array(r.buf));
    ok(decThumb.length === thumbBytes.length, '缩略图中转并可解密');

    console.log('\n[8] 管理员只能看到账号，看不到内容');
    r = await admin('GET', '/api/admin/users');
    ok(r.data.total === 1 && r.data.items[0].account === account, '管理员可见账号');
    ok(r.data.items[0].stats.count === 2, '管理员可见数量统计');
    ok(!('meta' in r.data.items[0]) && !('parts' in r.data.items[0]), '管理员接口不返回任何密文/内容');
    r = await admin('GET', '/api/admin/overview');
    ok(r.data.totals.memos === 2, '概览统计正确');

    console.log('\n[9] IP 封禁（CIDR / 批量 / IPv6）');
    r = await admin('POST', '/api/admin/ip-bans', { text: '10.9.9.0/24\n2001:db8::/32\n1.2.3.4-1.2.3.9\nbad-rule' });
    ok(r.data.added === 3 && r.data.errors.length === 1, '批量添加 3 条有效 + 1 条报错');
    r = await admin('GET', '/api/admin/ip-bans');
    ok(r.data.total === 3, '封禁列表共 3 条');

    console.log('\n[10] 封禁账号 / 批量管理');
    r = await admin('POST', '/api/admin/users/batch', { accounts: [account], action: 'ban' });
    ok(r.data.affected === 1, '封禁账号成功');
    r = await user('GET', '/api/user/me');
    ok(r.status === 401, '被封禁后会话失效');
    r = await admin('POST', '/api/admin/users/batch', { accounts: [account], action: 'unban' });
    ok(r.data.affected === 1, '解封成功');

    console.log('\n[11] 重新登录 / 删除 / 注销');
    const user2 = makeClient();
    r = await user2('POST', '/api/user/login', { account, proof });
    ok(r.status === 200, '凭密钥重新登录');
    r = await user2('DELETE', `/api/user/memos/${memoId}`);
    ok(r.status === 200, '删除备忘录');
    r = await user2('GET', '/api/user/memos');
    ok(r.data.items.length === 1, '删除后剩 1 条');
    r = await user2('POST', '/api/user/delete-account', { proof });
    ok(r.status === 200, '自助注销账号');
    r = await admin('GET', '/api/admin/users');
    ok(r.data.total === 0, '注销后账号清空');

    console.log('\n[12] 安全：CSRF / 限流 / 错误密钥');
    const noCsrf = await fetch(BASE + '/api/user/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    ok(noCsrf.status === 403, '缺少 X-Memo-Client 被拒绝 (CSRF)');
    const user3 = makeClient();
    const wrongProof = await deriveProof(crypto.getRandomValues(new Uint8Array(32)));
    r = await user3('POST', '/api/user/register', { proof: wrongProof });
    const acct3 = r.data.account;
    const user4 = makeClient();
    r = await user4('POST', '/api/user/login', { account: acct3, proof: await deriveProof(crypto.getRandomValues(new Uint8Array(32))) });
    ok(r.status === 401, '错误密钥登录失败');

    console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
    if (failed > 0) { console.error('\n--- 服务器日志 ---\n' + serverLog); process.exitCode = 1; }
  } catch (e) {
    console.error('测试异常:', e);
    console.error('\n--- 服务器日志 ---\n' + serverLog);
    process.exitCode = 1;
  } finally {
    child.kill('SIGTERM');
    mock.server.close();
    setTimeout(() => { rmSync(dataDir, { recursive: true, force: true }); process.exit(process.exitCode || 0); }, 800);
  }
}

main();
