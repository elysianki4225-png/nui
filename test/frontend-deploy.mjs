// 跨域白名单 / Bearer 外部前端 / 广告 / 单文件导出 测试
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8951, BASE = `http://127.0.0.1:${PORT}`;
let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.error('  ✗ ' + n); } };
const dataDir = mkdtempSync(path.join(tmpdir(), 'nui-deploy-'));
const conf = path.join(dataDir, 'config.json');
writeFileSync(conf, JSON.stringify({ host: '127.0.0.1', port: PORT, dataDir, mode: 'domain', userHost: 'm.example.com', trustProxy: true, telegramApiBase: 'http://127.0.0.1:1' }));
const child = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], { env: { ...process.env, MEMO_CONFIG: conf, MEMO_DEV: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
let log = ''; child.stdout.on('data', d => log += d); child.stderr.on('data', d => log += d);
async function up() { for (let i = 0; i < 50; i++) { try { const r = await fetch(BASE + '/api/health'); if (r.ok) return; } catch {} await new Promise(r => setTimeout(r, 120)); } throw new Error('not up'); }
function jar() { const m = new Map(); return { async req(method, p, body, headers = {}) { const h = { 'X-Memo-Client': 't', ...headers }; if (m.size) h.Cookie = [...m].map(([k, v]) => `${k}=${v}`).join('; '); let payload; if (body !== undefined) { payload = JSON.stringify(body); h['Content-Type'] = 'application/json'; } const r = await fetch(BASE + p, { method, headers: h, body: payload }); for (const sc of r.headers.getSetCookie?.() || []) { const [kv] = sc.split(';'); const i = kv.indexOf('='); if (kv.slice(i + 1)) m.set(kv.slice(0, i), kv.slice(i + 1)); } return r; } }; }
try {
  await up();
  const a = jar();
  await a.req('POST', '/api/admin/setup', { username: 'admin', password: 'Deploy12345' });
  console.log('[CORS 管理]');
  let c = await (await a.req('GET', '/api/admin/cors')).json();
  ok(c.mode === 'off' && c.exportReady, '默认 off 且导出模板就绪');
  await a.req('PATCH', '/api/admin/cors', { mode: 'whitelist' });
  const add = await (await a.req('POST', '/api/admin/cors/origins', { text: 'https://app.github.io\ninvalid url with space\nhttps://x.example.com' })).json();
  ok(add.added === 2 && add.errors.length === 1, '批量添加白名单（无效被拒）');
  console.log('[CORS 预检 / 响应头]');
  const pre = await fetch(BASE + '/api/user/me', { method: 'OPTIONS', headers: { Origin: 'https://app.github.io', 'Access-Control-Request-Method': 'GET' } });
  ok(pre.status === 204 && pre.headers.get('access-control-allow-origin') === 'https://app.github.io', '白名单 Origin 预检 204 + ACAO');
  const preBad = await fetch(BASE + '/api/user/me', { method: 'OPTIONS', headers: { Origin: 'https://evil.io', 'Access-Control-Request-Method': 'GET' } });
  ok(!preBad.headers.get('access-control-allow-origin'), '非白名单 Origin 无 ACAO');
  console.log('[外部前端 Bearer 登录]');
  const reg = await (await fetch(BASE + '/api/user/register', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Memo-Client': 'web', Origin: 'https://app.github.io' }, body: JSON.stringify({ proof: 'a'.repeat(64) }) })).json();
  ok(reg.ok && !!reg.token, '跨域注册返回 token');
  const me = await fetch(BASE + '/api/user/me', { headers: { Authorization: `Bearer ${reg.token}`, 'X-Memo-Client': 'web', Origin: 'https://app.github.io' } });
  ok(me.status === 200, 'Bearer token 跨域鉴权成功');
  const meNo = await fetch(BASE + '/api/user/me', { headers: { 'X-Memo-Client': 'web' } });
  ok(meNo.status === 401, '无 token 401');
  console.log('[广告]');
  await a.req('PATCH', '/api/admin/ads', { enabled: true, mode: 'custom' });
  await a.req('POST', '/api/admin/ads/items', { title: '测试广告', url: 'https://example.com', image: 'https://example.com/a.png' });
  const cfg = await (await fetch(BASE + '/api/config')).json();
  ok(cfg.ads.enabled && cfg.ads.items.length === 1, '公开配置返回广告');
  await a.req('PATCH', '/api/admin/ads', { enabled: false });
  const cfg2 = await (await fetch(BASE + '/api/config')).json();
  ok(!cfg2.ads.enabled, '关闭后广告不返回');
  console.log('[单文件导出]');
  const exp = await a.req('GET', '/api/admin/export?base=https://m.example.com');
  const html = await exp.text();
  ok(exp.status === 200 && html.includes('"apiBase":"https://m.example.com"'), '导出注入 API 地址');
  ok(html.includes('__MEMO_WORKER__') && html.includes('<style>'), '单文件内联 worker 与样式');
  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  if (fail) console.error(log);
} catch (e) { console.error(e); console.error(log); fail++; }
finally { child.kill('SIGTERM'); setTimeout(() => { rmSync(dataDir, { recursive: true, force: true }); process.exit(fail ? 1 : 0); }, 500); }
