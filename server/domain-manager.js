// 运行时域名管理：供管理面板 API 调用。
// 应用机制：systemd path 触发 root helper（生产）/ inline（开发/测试）/ manual（无特权时给出 Caddyfile 与指引）。
import fs from 'node:fs';
import path from 'node:path';
import dns from 'node:dns';
import tls from 'node:tls';
import { randomId } from './util.js';
import {
  SYS, normalizeDomain, settingsFromCfg, domainUrls, buildCaddyfile,
  atomicWrite, behindCdn, isValidHost, CF_PROXY_HTTP_PORTS, CF_PROXY_HTTPS_PORTS,
} from './domain.js';

// Cloudflare 官方 IP 段（用于「是否套了小黄云」的粗略判断）
const CF_V4 = ['173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18', '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20', '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13', '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22'];
const CF_V6 = ['2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32', '2405:8100::/32', '2a06:98c0::/29', '2c0f:f248::/32'];

function ipInCidr(ip, cidr) {
  const [net, bitsStr] = cidr.split('/');
  const bits = parseInt(bitsStr, 10);
  if (ip.includes(':') !== net.includes(':')) return false;
  if (!ip.includes(':')) {
    const toNum = (x) => x.split('.').reduce((a, b) => ((a << 8) >>> 0) + parseInt(b, 10), 0) >>> 0;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (toNum(ip) & mask) === (toNum(net) & mask);
  }
  const expand = (x) => {
    const [h, t] = x.split('::');
    const ex = (seg) => seg ? seg.split(':').flatMap((p) => p.includes('.') ? [((parseInt(p.split('.')[0], 10) << 8) + parseInt(p.split('.')[1], 10)).toString(16), ((parseInt(p.split('.')[2], 10) << 8) + parseInt(p.split('.')[3], 10)).toString(16)] : [p]) : [];
    const head = ex(h), tail = ex(t);
    const fill = new Array(8 - head.length - tail.length).fill('0');
    return [...head, ...fill, ...tail].map((p) => parseInt(p || '0', 16));
  };
  const a = expand(ip), b = expand(net);
  for (let i = 0; i < 8; i++) {
    const rem = bits - i * 16;
    if (rem <= 0) break;
    const m = rem >= 16 ? 0xffff : (0xffff << (16 - rem)) & 0xffff;
    if ((a[i] & m) !== (b[i] & m)) return false;
  }
  return true;
}
export function isCloudflareIp(ip) {
  const list = ip.includes(':') ? CF_V6 : CF_V4;
  return list.some((c) => ipInCidr(ip, c));
}

export class DomainManager {
  constructor(cfg, store) {
    this.cfg = cfg;
    this.store = store;
    this.dataDir = cfg.dataDir;
    this.requestFile = path.join(this.dataDir, 'domain-request.json');
    this.resultFile = path.join(this.dataDir, 'domain-result.json');
    this.domainFile = path.join(this.dataDir, 'domain.json');
    this.certFile = process.env.NUI_CF_CERT_FILE || SYS.certFile;
    this.keyFile = process.env.NUI_CF_KEY_FILE || SYS.keyFile;
    this.applyMode = this.detectMode();
  }

  detectMode() {
    if (process.env.NUI_DOMAIN_APPLY) return process.env.NUI_DOMAIN_APPLY.split(':')[0];
    const marker = process.env.NUI_DOMAIN_APPLY_FILE || '/etc/nui-memo/domain-apply.json';
    try {
      const j = JSON.parse(fs.readFileSync(marker, 'utf8'));
      if (j.mode) { this.applyCommand = j.command || null; return j.mode; }
    } catch {}
    return 'manual';
  }

  haveCert() {
    try { return fs.existsSync(this.certFile) && fs.existsSync(this.keyFile); } catch { return false; }
  }

  // 推导本机公网 IP：配置 publicIp > nip.io 主机名内嵌 IP > null
  serverIp() {
    if (this.cfg.publicIp) return String(this.cfg.publicIp);
    for (const host of [this.cfg.userHost, this.cfg.adminHost]) {
      const m = String(host || '').match(/(\d{1,3}(?:\.\d{1,3}){3})\.nip\.io$/i) || String(host || '').match(/(\d{1,3}(?:\.\d{1,3}){3})\.sslip\.io$/i);
      if (m) return m[1];
      const v6 = String(host || '').match(/([0-9a-f-]+)\.nip\.io$/i);
      if (v6 && v6[1].includes('-') && !/\d{1,3}\./.test(v6[1])) return v6[1].replace(/-/g, ':');
    }
    return null;
  }

  current() {
    const settings = settingsFromCfg(this.cfg);
    return {
      settings,
      urls: domainUrls(settings, { dev: this.cfg.dev }),
      haveCert: this.haveCert(),
      applyMode: this.applyMode,
      canApply: this.applyMode !== 'manual',
      certFile: this.certFile,
      lastResult: this.readResult(),
      serverIp: this.serverIp(),
      cfPorts: { http: CF_PROXY_HTTP_PORTS, https: CF_PROXY_HTTPS_PORTS },
    };
  }

  readResult() {
    try { return JSON.parse(fs.readFileSync(this.resultFile, 'utf8')); } catch { return null; }
  }

  async check(host) {
    const h = String(host || '').trim().toLowerCase();
    const serverIp = this.serverIp();
    const out = { host: h, addresses: [], cloudflare: false, serverIp, matchesServer: null, error: null };
    try {
      const [v4, v6] = await Promise.allSettled([dns.promises.resolve4(h), dns.promises.resolve6(h)]);
      if (v4.status === 'fulfilled') out.addresses.push(...v4.value);
      if (v6.status === 'fulfilled') out.addresses.push(...v6.value);
      if (!out.addresses.length) out.error = '无法解析该域名（请检查 DNS 记录）';
      out.cloudflare = out.addresses.some(isCloudflareIp);
      if (serverIp && out.addresses.length) out.matchesServer = out.addresses.includes(serverIp);
    } catch (e) { out.error = e.message; }
    return out;
  }

  // 一键诊断：DNS + 边缘 HTTPS/HTTP + TLS 证书 + 本机回源，返回结构化结果与建议
  async probe(input = {}) {
    const host = String(input.host || this.cfg.userHost || '').trim().toLowerCase();
    const out = { host, dns: null, https: null, http: null, origin: null, tls: null, hints: [] };
    if (!isValidHost(host) && !/^\d{1,3}(\.\d{1,3}){3}$/.test(host) && !host.includes(':')) {
      out.hints.push('无效的诊断目标主机名。'); return out;
    }
    out.dns = await this.check(host);
    if (out.dns.error) out.hints.push(`DNS：${out.dns.error}`);
    else if (out.dns.cloudflare) out.hints.push('DNS 解析到 Cloudflare 边缘，小黄云已生效。');
    else if (out.dns.matchesServer === false) out.hints.push(`域名解析结果与本机公网 IP（${out.dns.serverIp}）不一致；若未套 CDN，请修正 A/AAAA 记录。`);

    // 本机回源自检（不经过 CDN / Caddy）
    out.origin = await this.#probeUrl(`http://127.0.0.1:${this.cfg.port}/api/health`);
    if (!out.origin.ok) out.hints.push('本机后端自检失败：nui-memo 服务可能未运行或端口不符。');

    const scheme = input.scheme || (this.cfg.dev ? 'http' : 'https');
    if (scheme === 'https' || input.scheme === 'https') {
      out.https = await this.#probeUrl(`https://${host}/api/health`);
      out.tls = await this.#probeTls(host, 443);
      if (out.https.ok) {
        if (out.https.viaCloudflare) out.hints.push('HTTPS 经由 Cloudflare 返回（检测到 CF 响应头）。');
        if (out.tls && out.tls.daysLeft != null && out.tls.daysLeft < 15) out.hints.push(`边缘证书将在 ${out.tls.daysLeft} 天后到期，请及时续期。`);
      } else if (out.dns.cloudflare) {
        if (out.https.status === 521) out.hints.push('521：Cloudflare 连接源站被拒绝。请先保存此页配置，再检查 Caddy 是否启动、80/443 回源端口是否放行，以及 CF 控制台的 SSL 模式是否一致。非标准端口还需配置 CDN 回源端口规则。');
        else if (out.https.status === 525 || out.https.status === 526) out.hints.push('源站 TLS 握手或证书校验失败：检查回源证书是否有效、覆盖当前域名，以及 CDN SSL 模式是否匹配。');
        else out.hints.push('DNS 已套 CF 但 HTTPS 探测失败：请检查 CF SSL 模式与源站回源证书（Flexible 用 HTTP，Full/Strict 需有效回源证书）。');
        out.hints.push('后端进程自检正常不代表公网回源正常；该自检不经过 Caddy、防火墙或 Cloudflare。');
      }
    }
    if (scheme === 'http' || input.scheme === 'http' || this.cfg.sslMode === 'flexible') {
      out.http = await this.#probeUrl(`http://${host}/api/health`);
    }
    if (!out.hints.length) out.hints.push('未发现明显问题。');
    return out;
  }

  async #probeUrl(url) {
    const t0 = Date.now();
    const res = { ok: false, status: 0, latencyMs: 0, viaCloudflare: false, server: '', error: null };
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      const r = await fetch(url, { signal: ctrl.signal, redirect: 'manual', headers: { 'User-Agent': 'nui-memo-probe' } });
      clearTimeout(timer);
      res.status = r.status; res.latencyMs = Date.now() - t0;
      res.server = r.headers.get('server') || '';
      res.viaCloudflare = !!(r.headers.get('cf-ray') || /cloudflare/i.test(res.server));
      res.ok = r.status > 0 && r.status < 500;
    } catch (e) { res.error = e.name === 'AbortError' ? '超时（8s）' : (e.cause?.code || e.message); res.latencyMs = Date.now() - t0; }
    return res;
  }

  #probeTls(host, port) {
    return new Promise((resolve) => {
      const done = (v) => { try { sock.destroy(); } catch {} resolve(v); };
      const sock = tls.connect({ host, port, servername: host, rejectUnauthorized: false, timeout: 8000 }, () => {
        try {
          const c = sock.getPeerCertificate();
          if (!c || !c.valid_to) return done(null);
          const daysLeft = Math.floor((new Date(c.valid_to).getTime() - Date.now()) / 86400000);
          done({ issuer: c.issuer?.O || c.issuer?.CN || '', subject: c.subject?.CN || '', validTo: c.valid_to, daysLeft });
        } catch { done(null); }
      });
      sock.on('timeout', () => done(null));
      sock.on('error', () => done(null));
    });
  }

  // 验证 Cloudflare API Token（可用 NUI_CF_API_BASE 覆盖以便测试）
  async verifyCfToken(token) {
    const t = String(token || '').trim();
    if (!t) return { ok: false, error: '请填写 API Token' };
    const base = (process.env.NUI_CF_API_BASE || 'https://api.cloudflare.com/client/v4').replace(/\/+$/, '');
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 10000);
      const r = await fetch(`${base}/user/tokens/verify`, { headers: { Authorization: `Bearer ${t}` }, signal: ctrl.signal });
      clearTimeout(timer);
      const j = await r.json();
      if (j.success && j.result) return { ok: true, status: j.result.status || 'active', expiresOn: j.result.expires_on || null };
      return { ok: false, error: (j.errors && j.errors[0] && j.errors[0].message) || 'Token 无效' };
    } catch (e) { return { ok: false, error: e.name === 'AbortError' ? '验证超时' : (e.message || '无法连接 Cloudflare API') }; }
  }

  preview(input) {
    const { settings, warnings } = normalizeDomain(input, this.cfg);
    const haveCert = this.haveCert();
    const caddyfile = buildCaddyfile(settings, { haveCert, backendPort: this.cfg.port, certFile: this.certFile, keyFile: this.keyFile });
    return { settings, warnings, caddyfile, urls: domainUrls(settings, { dev: this.cfg.dev }), haveCert };
  }

  applyToCfg(s) {
    const cfg = this.cfg;
    cfg.mode = s.mode; cfg.userHost = s.userHost; cfg.adminHost = s.adminHost;
    cfg.cdn = s.cdn; cfg.cdnName = s.cdnName; cfg.sslMode = s.sslMode;
    cfg.cfHttpPort = s.cfHttpPort; cfg.cfHttpsPort = s.cfHttpsPort;
    cfg.realIpHeader = s.realIpHeader; cfg.cfOnly = s.cfOnly;
    cfg.cloudflare = s.cdn === 'cloudflare';
    const urls = domainUrls(s, { dev: cfg.dev });
    cfg.userUrl = urls.userUrl; cfg.adminUrl = urls.adminUrl;
  }

  persistRuntime(s) {
    try { atomicWrite(this.domainFile, JSON.stringify(s, null, 2)); } catch (e) { console.error('[domain] 写入 domain.json 失败:', e.message); }
  }

  async apply(input, extras = {}) {
    const { settings, warnings } = normalizeDomain(input, this.cfg);
    const id = randomId(8);
    const urls = domainUrls(settings, { dev: this.cfg.dev });
    const mode = this.applyMode;

    if (mode === 'inline' || mode === 'manual') {
      // 无特权：热更新后端行为 + 持久化运行时覆盖；manual 额外给出 Caddyfile 供手动应用
      this.applyToCfg(settings);
      this.persistRuntime(settings);
      const result = {
        id, ok: true, settings, urls, warnings, appliedAt: Math.floor(Date.now() / 1000),
        inline: mode === 'inline', manual: mode === 'manual', haveCert: this.haveCert(),
      };
      if (mode === 'manual') {
        result.caddyfile = buildCaddyfile(settings, { haveCert: this.haveCert(), backendPort: this.cfg.port, certFile: this.certFile, keyFile: this.keyFile });
        result.instructions = '当前环境未启用特权自动应用。请将下方 Caddyfile 覆盖到 /etc/caddy/Caddyfile 后执行 systemctl reload caddy，并重启 nui-memo 服务。';
        warnings.push('无特权自动应用：后端已热更新，但 Caddy/证书需手动应用（见返回的 Caddyfile）。');
      }
      try { atomicWrite(this.resultFile, JSON.stringify(result, null, 2)); } catch {}
      this.store.audit(this.store.state.admin?.username || 'admin', 'domain.update', `${settings.userHost} · CDN=${settings.cdn} · SSL=${settings.sslMode} · 回源=${settings.cfHttpPort}/${settings.cfHttpsPort}`);
      return result;
    }

    // systemd / sudo：写请求文件，由 root helper 应用（会重载 Caddy 并重启后端）
    const req = {
      id, settings,
      certPem: extras.certPem || undefined, keyPem: extras.keyPem || undefined, cfApiToken: extras.cfApiToken || undefined,
      paths: {
        confFile: this.cfg.configFile || SYS.confFile, caddyFile: SYS.caddyFile,
        certFile: this.certFile, keyFile: this.keyFile, dataDir: this.dataDir,
        backendPort: this.cfg.port, caddyBin: SYS.caddyBin,
      },
    };
    // 先热更新后端，保证重启前的请求也按新域名处理
    this.applyToCfg(settings);
    this.persistRuntime(settings);
    // 直接写入（open/write/close），确保 systemd PathChanged(IN_CLOSE_WRITE) 能触发
    fs.writeFileSync(this.requestFile, JSON.stringify(req), { mode: 0o600 });
    this.store.audit(this.store.state.admin?.username || 'admin', 'domain.apply', `${settings.userHost} · CDN=${settings.cdn} · SSL=${settings.sslMode}（${mode}）`);
    if (mode === 'sudo' && this.applyCommand) {
      const { execFile } = await import('node:child_process');
      await new Promise((resolve) => {
        const parts = this.applyCommand.split(' ');
        execFile(parts[0], [...parts.slice(1), this.requestFile], { timeout: 60000 }, () => resolve());
      });
      const r = this.readResult();
      if (r && r.id === id) return r;
    }
    return { id, ok: true, applying: true, settings, urls, warnings, applyMode: mode };
  }

  poll(id) {
    const r = this.readResult();
    if (r && r.id === id) return r;
    return null;
  }
}
