// 运行时域名管理：供管理面板 API 调用。
// 应用机制：systemd path 触发 root helper（生产）/ inline（开发/测试）/ manual（无特权时给出 Caddyfile 与指引）。
import fs from 'node:fs';
import path from 'node:path';
import dns from 'node:dns';
import { randomId } from './util.js';
import {
  SYS, normalizeDomain, settingsFromCfg, domainUrls, buildCaddyfile,
  atomicWrite, behindCdn,
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
    };
  }

  readResult() {
    try { return JSON.parse(fs.readFileSync(this.resultFile, 'utf8')); } catch { return null; }
  }

  async check(host) {
    const h = String(host || '').trim().toLowerCase();
    const out = { host: h, addresses: [], cloudflare: false, error: null };
    try {
      const [v4, v6] = await Promise.allSettled([dns.promises.resolve4(h), dns.promises.resolve6(h)]);
      if (v4.status === 'fulfilled') out.addresses.push(...v4.value);
      if (v6.status === 'fulfilled') out.addresses.push(...v6.value);
      if (!out.addresses.length) out.error = '无法解析该域名（请检查 DNS 记录）';
      out.cloudflare = out.addresses.some(isCloudflareIp);
    } catch (e) { out.error = e.message; }
    return out;
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
