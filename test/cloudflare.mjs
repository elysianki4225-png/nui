// 验证 Cloudflare 小黄云下的后端行为：真实访客 IP、Flexible 回源仍发 Secure Cookie、不下发 HSTS
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8907; const BASE = `http://127.0.0.1:${PORT}`;
let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.error('  ✗ ' + n); } };
const dataDir = mkdtempSync(path.join(tmpdir(), 'nui-cf-'));
const confFile = path.join(dataDir, 'config.json');
writeFileSync(confFile, JSON.stringify({ host: '127.0.0.1', port: PORT, dataDir, mode: 'domain', userHost: 'memo.example.com', adminHost: '', trustProxy: true, cloudflare: true, telegramApiBase: 'http://127.0.0.1:1' }));
const child = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], { env: { ...process.env, MEMO_CONFIG: confFile, MEMO_DEV: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
let log = ''; child.stdout.on('data', d => log += d); child.stderr.on('data', d => log += d);
async function up() { for (let i = 0; i < 50; i++) { try { const r = await fetch(BASE + '/api/health'); if (r.ok) return; } catch {} await new Promise(r => setTimeout(r, 150)); } throw new Error('not up'); }
function jar() { const m = new Map(); return { async req(method, p, body, headers = {}) { const h = { 'X-Memo-Client': 'cf', ...headers }; if (m.size) h.Cookie = [...m].map(([k, v]) => `${k}=${v}`).join('; '); let payload; if (body !== undefined) { payload = JSON.stringify(body); h['Content-Type'] = 'application/json'; } const r = await fetch(BASE + p, { method, headers: h, body: payload, redirect: 'manual' }); for (const sc of r.headers.getSetCookie?.() || []) { const [kv] = sc.split(';'); const i = kv.indexOf('='); if (kv.slice(i + 1)) m.set(kv.slice(0, i), kv.slice(i + 1)); else m.delete(kv.slice(0, i)); } return r; }, cookies: m }; }
try {
  await up();
  console.log('[Cloudflare 后端行为]');
  const c = jar();
  // Flexible 回源：x-forwarded-proto=http，但访客经 CF 是 https
  const r1 = await c.req('POST', '/api/admin/setup', { username: 'admin', password: 'Cloudflare123' }, { 'cf-connecting-ip': '203.0.113.9', 'x-forwarded-proto': 'http', 'cf-visitor': '{"scheme":"https"}' });
  ok(r1.status === 200, '管理员初始化成功');
  const sc = r1.headers.getSetCookie?.().find(x => x.startsWith('memo_admin=')) || '';
  ok(/Secure/.test(sc), 'Flexible 回源仍下发 Secure Cookie');
  const health = await fetch(BASE + '/api/health', { headers: { 'cf-connecting-ip': '203.0.113.9', 'x-forwarded-proto': 'http' } });
  ok(!health.headers.get('strict-transport-security'), 'CF 模式不下发 HSTS（交给边缘）');
  // 用 CF-Connecting-IP 封禁
  const ban = await c.req('POST', '/api/admin/ip-bans', { text: '198.51.100.77' });
  const banJson = await ban.json();
  ok(banJson.added === 1, '添加 IP 封禁');
  const blocked = await fetch(BASE + '/api/config', { headers: { 'cf-connecting-ip': '198.51.100.77', 'X-Memo-Client': 'cf' } });
  ok(blocked.status === 403, 'CF-Connecting-IP 命中封禁 -> 403');
  const allowed = await fetch(BASE + '/api/config', { headers: { 'cf-connecting-ip': '203.0.113.10', 'X-Memo-Client': 'cf' } });
  ok(allowed.status === 200, '其它访客 IP 正常');
  // XFF 兜底
  const blockedXff = await fetch(BASE + '/api/config', { headers: { 'x-forwarded-for': '198.51.100.77, 172.68.0.1', 'X-Memo-Client': 'cf' } });
  ok(blockedXff.status === 403, '无 CF 头时 XFF 首个 IP 命中封禁');
  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  if (fail) console.error(log);
} catch (e) { console.error(e); console.error(log); fail++; }
finally { child.kill('SIGTERM'); setTimeout(() => { rmSync(dataDir, { recursive: true, force: true }); process.exit(fail ? 1 : 0); }, 600); }
