// 域名 / CDN 管理测试：校验、Caddyfile 生成、特权 dry-run 应用、API 热切换与重启持久化
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeDomain, buildCaddyfile, applyRequest, domainUrls } from '../server/domain.js';
import { isCloudflareIp } from '../server/domain-manager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.error('  ✗ ' + n); } };
const tmp = mkdtempSync(path.join(tmpdir(), 'nui-domain-'));

// 生成自签名证书用于 dry-run 上传测试
let certPem = '', keyPem = '';
try {
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(tmp, 't.key'), '-out', path.join(tmp, 't.crt'), '-days', '1', '-subj', '/CN=cert.example.com'], { stdio: 'ignore' });
  certPem = readFileSync(path.join(tmp, 't.crt'), 'utf8');
  keyPem = readFileSync(path.join(tmp, 't.key'), 'utf8');
} catch { /* openssl 不可用时跳过证书相关断言 */ }

console.log('[1] 校验 normalizeDomain');
ok(normalizeDomain({ userHost: 'm.example.com', cdn: 'none' }, {}).settings.sslMode === 'auto', '直连默认 sslMode=auto');
ok(normalizeDomain({ userHost: 'm.example.com', cdn: 'cloudflare', sslMode: 'auto' }, {}).settings.sslMode === 'flexible', 'CDN auto→flexible');
ok(normalizeDomain({ mode: 'ip', userHost: 'a.1.2.3.4.nip.io', cdn: 'cloudflare' }, {}).settings.mode === 'domain', 'CDN 强制域名模式');
ok(normalizeDomain({ userHost: 'm.example.com', cdn: 'cloudflare', cfHttpPort: 8080, cfHttpsPort: 8443 }, {}).warnings.some((w) => w.includes('非标准')), '非标准回源端口告警');
let threw = false; try { normalizeDomain({ userHost: 'http://bad/host' }, {}); } catch { threw = true; }
ok(threw, '非法域名抛错');
threw = false; try { normalizeDomain({ userHost: 'm.example.com', cdn: 'cloudflare', cfHttpPort: 8080, cfHttpsPort: 8080 }, {}); } catch { threw = true; }
ok(threw, '回源端口相同抛错');

console.log('[2] Caddyfile 生成矩阵');
const direct = buildCaddyfile(normalizeDomain({ userHost: 'd.example.com', cdn: 'none' }, {}).settings, {});
ok(direct.includes('d.example.com {') && direct.includes('Strict-Transport-Security') && !direct.includes('auto_https off'), '直连域名：自动 HTTPS + HSTS');
const ip = buildCaddyfile(normalizeDomain({ mode: 'ip', userHost: 'a.1.2.3.4.nip.io', adminHost: 'b.1.2.3.4.nip.io', cdn: 'none' }, {}).settings, {});
ok(ip.includes('a.1.2.3.4.nip.io {') && ip.includes('b.1.2.3.4.nip.io {'), 'IP 模式：两个独立站点');
const flex = buildCaddyfile(normalizeDomain({ userHost: 'm.example.com', cdn: 'cloudflare', sslMode: 'flexible', cfHttpPort: 8080, cfHttpsPort: 8443 }, {}).settings, { haveCert: false });
ok(flex.includes('auto_https off') && flex.includes('http://m.example.com:8080') && !flex.includes('https://m.example.com:8443') && !flex.includes('Strict-Transport-Security'), 'CF Flexible：HTTP 回源、无跳转、无 HSTS');
const strict = buildCaddyfile(normalizeDomain({ userHost: 'm.example.com', cdn: 'cloudflare', sslMode: 'strict', cfHttpPort: 8080, cfHttpsPort: 8443 }, {}).settings, { haveCert: true, certFile: '/c.pem', keyFile: '/c.key' });
ok(strict.includes('https://m.example.com:8443') && strict.includes('tls /c.pem /c.key'), 'CF Strict：HTTPS 回源 + 证书');
const custom = buildCaddyfile(normalizeDomain({ userHost: 'm.example.com', cdn: 'custom', sslMode: 'full', cfHttpPort: 80, cfHttpsPort: 443 }, {}).settings, { haveCert: true });
ok(custom.includes('auto_https off') && custom.includes('https://m.example.com:443'), '第三方 CDN 同样支持');

const guarded = buildCaddyfile(normalizeDomain({ userHost: 'm.example.com', cdn: 'cloudflare', cfOnly: true }, {}).settings, {});
ok(guarded.includes('@non_cf not remote_ip 173.245.48.0/20') && guarded.includes('respond @non_cf'), '运行时 CF-only 在 Caddy 层限制来源');
ok(guarded.includes('request_header @non_cf -CF-Connecting-IP'), '非 CF 来源不能伪造访客 IP 头');

console.log('[3] 特权 dry-run 应用（证书上传 / 配置合并 / 回退）');
const confFile = path.join(tmp, 'etc', 'config.json');
const caddyFile = path.join(tmp, 'caddy', 'Caddyfile');
const dataDir = path.join(tmp, 'data');
writeFileSync(path.join(tmp, 'seed.json'), '{}');
const paths = { confFile, caddyFile, certFile: path.join(tmp, 'etc', 'cf.pem'), keyFile: path.join(tmp, 'etc', 'cf.key'), dataDir, backendPort: 8787 };
if (certPem) {
  const r = applyRequest({ id: 't1', settings: { mode: 'domain', userHost: 'cert.example.com', cdn: 'cloudflare', sslMode: 'strict', cfHttpPort: 8080, cfHttpsPort: 8443 }, certPem, keyPem, paths }, { dryRun: true });
  ok(r.ok && r.haveCert, '上传证书后 haveCert=true');
  ok(r.caddyfile.includes('https://cert.example.com:8443') && r.caddyfile.includes('tls '), '生成 HTTPS 回源站点');
  const merged = JSON.parse(readFileSync(confFile, 'utf8'));
  ok(merged.cdn === 'cloudflare' && merged.sslMode === 'strict' && merged.cfHttpsPort === 8443, 'config.json 合并域名/CDN/端口');
  ok(existsSync(path.join(dataDir, 'domain.json')) && existsSync(path.join(dataDir, 'domain-result.json')), '写入 domain.json 与 result');
}
const r2 = applyRequest({ id: 't2', settings: { mode: 'domain', userHost: 'nocert.example.com', cdn: 'cloudflare', sslMode: 'strict' }, paths: { ...paths, certFile: path.join(tmp, 'none.pem'), keyFile: path.join(tmp, 'none.key') } }, { dryRun: true });
ok(!r2.ok && r2.rolledBack && r2.error.includes('缺少回源证书'), 'Strict 无证书拒绝静默降级并回滚');

console.log('[4] Cloudflare IP 判断');
ok(isCloudflareIp('104.16.1.1') && isCloudflareIp('172.67.1.1') && isCloudflareIp('2606:4700::1'), '识别 CF IPv4/IPv6');
ok(!isCloudflareIp('1.2.3.4') && !isCloudflareIp('2001:db8::1'), '非 CF IP 不误判');

// ---------------- 在线 API：热切换 + 重启持久化 ----------------
const PORT = 8911, PORT2 = 8912;
const BASE = `http://127.0.0.1:${PORT}`;
const dataDir2 = path.join(tmp, 'live');
const confFile2 = path.join(tmp, 'live-config.json');
writeFileSync(confFile2, JSON.stringify({ host: '127.0.0.1', port: PORT, dataDir: dataDir2, mode: 'ip', userHost: 'memo-abc.1.2.3.4.nip.io', adminHost: 'admin-abc.1.2.3.4.nip.io', trustProxy: true, cloudflare: false, telegramApiBase: 'http://127.0.0.1:1' }));
function startServer(port, conf) {
  const c = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], { env: { ...process.env, MEMO_CONFIG: conf, NUI_DOMAIN_APPLY: 'inline', NUI_CF_CERT_FILE: path.join(tmp, 'live-cf.pem'), NUI_CF_KEY_FILE: path.join(tmp, 'live-cf.key') }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; c.stdout.on('data', (d) => log += d); c.stderr.on('data', (d) => log += d); c._log = () => log; return c;
}
async function waitUp(base) { for (let i = 0; i < 60; i++) { try { const r = await fetch(base + '/api/health'); if (r.ok) return; } catch {} await new Promise((r) => setTimeout(r, 150)); } throw new Error('server not up'); }
function jar(base) { const m = new Map(); return { async req(method, p, body, headers = {}) { const h = { 'X-Memo-Client': 'domain-test', ...headers }; if (m.size) h.Cookie = [...m].map(([k, v]) => `${k}=${v}`).join('; '); let payload; if (body !== undefined) { payload = JSON.stringify(body); h['Content-Type'] = 'application/json'; } const r = await fetch(base + p, { method, headers: h, body: payload, redirect: 'manual' }); for (const sc of r.headers.getSetCookie?.() || []) { const [kv] = sc.split(';'); const i = kv.indexOf('='); if (kv.slice(i + 1)) m.set(kv.slice(0, i), kv.slice(i + 1)); else m.delete(kv.slice(0, i)); } return r; }, token: () => m.get('memo_admin') }; }

const child = startServer(PORT, confFile2);
try {
  await waitUp(BASE);
  console.log('[5] 在线 API：nip.io → 自定义域名 + CF 冷门端口');
  const c = jar(BASE);
  ok((await c.req('POST', '/api/admin/setup', { username: 'admin', password: 'DomainTest123' })).status === 200, '管理员初始化');
  let d = await (await c.req('GET', '/api/admin/domain')).json();
  ok(d.settings.mode === 'ip' && d.applyMode === 'inline' && d.canApply, '读取当前域名（nip.io / inline）');
  const pv = await (await c.req('POST', '/api/admin/domain/preview', { mode: 'domain', userHost: 'm.example.com', cdn: 'cloudflare', sslMode: 'strict', cfHttpPort: 8080, cfHttpsPort: 8443 })).json();
  ok(pv.caddyfile.includes('http://m.example.com:8080') && pv.warnings.length > 0, '预览 Caddyfile + 告警');
  const chk = await (await c.req('POST', '/api/admin/domain/check', { host: 'invalid.invalid' })).json();
  ok(chk.error || chk.addresses.length === 0, 'DNS 检测无效域名返回错误');
  const ap = await (await c.req('POST', '/api/admin/domain', { mode: 'domain', userHost: 'm.example.com', cdn: 'cloudflare', sslMode: 'flexible', cfHttpPort: 8080, cfHttpsPort: 8443, cfOnly: true })).json();
  ok(ap.ok && ap.urls.userUrl === 'https://m.example.com', '应用切换：nip.io → 自定义域名');
  d = await (await c.req('GET', '/api/admin/domain')).json();
  ok(d.settings.userHost === 'm.example.com' && d.settings.cdn === 'cloudflare' && d.settings.cfHttpsPort === 8443, '后端热更新生效');
  ok(existsSync(path.join(dataDir2, 'domain.json')), '运行时 domain.json 已持久化');
  // 新域名下管理端可访问（Host 头）
  const adminPage = await fetch(BASE + '/admin/', { headers: { Host: 'm.example.com' } });
  ok(adminPage.status === 200 && (await adminPage.text()).includes('/admin/app.js'), '新域名 /admin/ 返回管理 SPA');

  console.log('[6] 第三方 CDN + 自定义真实 IP 头');
  const ap2 = await (await c.req('POST', '/api/admin/domain', { mode: 'domain', userHost: 'm.example.com', cdn: 'custom', cdnName: 'EdgeOne', sslMode: 'flexible', realIpHeader: 'x-real-ip', cfHttpPort: 80, cfHttpsPort: 443 })).json();
  ok(ap2.ok, '切换到第三方 CDN');
  await c.req('POST', '/api/admin/ip-bans', { text: '203.0.113.50' });
  const blocked = await fetch(BASE + '/api/config', { headers: { 'x-real-ip': '203.0.113.50', 'X-Memo-Client': 't' } });
  ok(blocked.status === 403, 'X-Real-IP 命中封禁');
  const allowed = await fetch(BASE + '/api/config', { headers: { 'x-real-ip': '203.0.113.51', 'X-Memo-Client': 't' } });
  ok(allowed.status === 200, '其它 IP 正常');

  console.log('[7] 重启后持久化（新进程读取 domain.json）');
  child.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 500));
  const confFile3 = path.join(tmp, 'live-config2.json');
  writeFileSync(confFile3, JSON.stringify({ ...JSON.parse(readFileSync(confFile2, 'utf8')), port: PORT2 }));
  const child2 = startServer(PORT2, confFile3);
  try {
    await waitUp(`http://127.0.0.1:${PORT2}`);
    const c2 = jar(`http://127.0.0.1:${PORT2}`);
    ok((await c2.req('POST', '/api/admin/login', { username: 'admin', password: 'DomainTest123' })).status === 200, '重启后管理员登录');
    const d2 = await (await c2.req('GET', '/api/admin/domain')).json();
    ok(d2.settings.userHost === 'm.example.com' && d2.settings.cdn === 'custom' && d2.settings.realIpHeader === 'x-real-ip', '重启后域名/CDN 设置仍生效');
  } finally { child2.kill('SIGTERM'); }
} catch (e) { console.error(e); console.error(child._log()); fail++; }
finally {
  child.kill('SIGTERM');
  setTimeout(() => { rmSync(tmp, { recursive: true, force: true }); console.log(`\n结果: ${pass} 通过, ${fail} 失败`); process.exit(fail ? 1 : 0); }, 700);
}
