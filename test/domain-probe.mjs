// 域名/CDN 诊断增强测试：serverIp 推导 / CF 端口告警 / 一键诊断 / CF Token 验证
import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeDomain } from '../server/domain.js';
import { DomainManager } from '../server/domain-manager.js';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.error('  ✗ ' + n); } };

console.log('[纯函数]');
const tmp = mkdtempSync(path.join(tmpdir(), 'nui-probe-'));
const dm = new DomainManager({ dataDir: tmp, port: 1, userHost: 'memo-ab.1.2.3.4.nip.io', adminHost: '', dev: true }, {});
ok(dm.serverIp() === '1.2.3.4', '从 nip.io 主机名推导公网 IP');
const dm2 = new DomainManager({ dataDir: tmp, port: 1, userHost: 'm.example.com', publicIp: '9.9.9.9', dev: true }, {});
ok(dm2.serverIp() === '9.9.9.9', '优先使用配置 publicIp');
const { warnings } = normalizeDomain({ mode: 'domain', userHost: 'm.example.com', cdn: 'cloudflare', cfHttpPort: 8081, cfHttpsPort: 443 }, {});
ok(warnings.some((w) => w.includes('8081')), 'CF 非支持 HTTP 端口产生告警');
const cur = dm2.current();
ok(Array.isArray(cur.cfPorts.http) && cur.cfPorts.https.includes(8443), 'current() 返回 CF 端口列表');

// CF API mock
const mock = http.createServer((req, res) => {
  if (req.url.includes('/user/tokens/verify')) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ success: true, result: { status: 'active' } })); }
  else { res.statusCode = 404; res.end('{}'); }
});
await new Promise((r) => mock.listen(8971, '127.0.0.1', r));

const PORT = 8972, BASE = `http://127.0.0.1:${PORT}`;
const conf = path.join(tmp, 'config.json');
writeFileSync(conf, JSON.stringify({ host: '127.0.0.1', port: PORT, dataDir: tmp, mode: 'domain', userHost: 'm.example.com', publicIp: '9.9.9.9', trustProxy: true, telegramApiBase: 'http://127.0.0.1:1' }));
const child = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], { env: { ...process.env, MEMO_CONFIG: conf, MEMO_DEV: '1', NUI_CF_API_BASE: 'http://127.0.0.1:8971' }, stdio: ['ignore', 'pipe', 'pipe'] });
let log = ''; child.stdout.on('data', (d) => log += d); child.stderr.on('data', (d) => log += d);
async function up() { for (let i = 0; i < 50; i++) { try { const r = await fetch(BASE + '/api/health'); if (r.ok) return; } catch {} await new Promise((r) => setTimeout(r, 120)); } throw new Error('not up'); }
function jar() { const m = new Map(); return { async req(method, p, body) { const h = { 'X-Memo-Client': 't' }; if (m.size) h.Cookie = [...m].map(([k, v]) => `${k}=${v}`).join('; '); let payload; if (body !== undefined) { payload = JSON.stringify(body); h['Content-Type'] = 'application/json'; } const r = await fetch(BASE + p, { method, headers: h, body: payload }); for (const sc of r.headers.getSetCookie?.() || []) { const [kv] = sc.split(';'); const i = kv.indexOf('='); if (kv.slice(i + 1)) m.set(kv.slice(0, i), kv.slice(i + 1)); } return r; } }; }
try {
  await up();
  const a = jar();
  await a.req('POST', '/api/admin/setup', { username: 'admin', password: 'Probe12345' });
  console.log('[API 诊断]');
  const d = await (await a.req('GET', '/api/admin/domain')).json();
  ok(d.serverIp === '9.9.9.9' && Array.isArray(d.cfPorts.http), 'GET domain 返回 serverIp + cfPorts');
  const chk = await (await a.req('POST', '/api/admin/domain/check', { host: 'm.example.com' })).json();
  ok('serverIp' in chk && 'matchesServer' in chk, 'check 返回 serverIp/matchesServer 字段');
  const probe = await (await a.req('POST', '/api/admin/domain/probe', { host: 'm.example.com' })).json();
  ok(probe.origin && probe.origin.ok === true, '一键诊断：本机回源自检通过');
  ok(probe.dns && Array.isArray(probe.hints), '一键诊断：返回 DNS 与建议');
  const probeHttps = await (await a.req('POST', '/api/admin/domain/probe', { host: 'm.example.com', scheme: 'https' })).json();
  ok('https' in probeHttps && 'tls' in probeHttps, 'HTTPS 诊断含 https/tls 字段（无证书时为 null）');
  const ver = await (await a.req('POST', '/api/admin/domain/cf-verify', { token: 'dummy-token' })).json();
  ok(ver.ok === true && ver.status === 'active', 'CF Token 验证（mock）返回有效');
  const verBad = await (await a.req('POST', '/api/admin/domain/cf-verify', { token: '' })).json();
  ok(verBad.ok === false, '空 Token 验证返回失败');
  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  if (fail) console.error(log);
} catch (e) { console.error(e); console.error(log); fail++; }
finally { child.kill('SIGTERM'); mock.close(); setTimeout(() => { rmSync(tmp, { recursive: true, force: true }); process.exit(fail ? 1 : 0); }, 500); }
