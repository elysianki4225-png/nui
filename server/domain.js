import net from 'node:net';
// 域名 / CDN 管理核心：校验、Caddyfile 生成、特权应用（供 root helper 调用）。
// 既被后端 import，也可独立运行：
//   node domain.js caddyfile            # 从环境变量读取参数，打印 Caddyfile
//   node domain.js apply --request f    # 读取请求 JSON，应用域名/证书/Caddy 配置
import fs from 'node:fs';
import path from 'node:path';
import { X509Certificate, createPrivateKey, createPublicKey } from 'node:crypto';
import { execFileSync } from 'node:child_process';

export const CDN_PROVIDERS = ['none', 'cloudflare', 'custom'];
export const SSL_MODES = ['auto', 'flexible', 'full', 'strict'];
export const REAL_IP_HEADERS = ['cf-connecting-ip', 'x-forwarded-for', 'x-real-ip', 'true-client-ip'];
// Cloudflare 小黄云默认代理的回源端口（其它端口需 Spectrum/企业版，否则不生效）
export const CF_PROXY_HTTP_PORTS = [80, 8080, 8880, 2052, 2082, 2086, 2095];
export const CF_PROXY_HTTPS_PORTS = [443, 2053, 2083, 2087, 2096, 8443];

export const CF_V4 = ['173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18', '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20', '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13', '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22'];
export const CF_V6 = ['2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32', '2405:8100::/32', '2a06:98c0::/29', '2c0f:f248::/32'];

// 系统路径（可被环境变量覆盖，便于测试 / 非标准安装）
export const SYS = {
  confFile: process.env.NUI_CONF_FILE || '/etc/nui-memo/config.json',
  caddyFile: process.env.NUI_CADDY_FILE || '/etc/caddy/Caddyfile',
  certFile: process.env.NUI_CF_CERT_FILE || '/etc/nui-memo/cf-origin.pem',
  keyFile: process.env.NUI_CF_KEY_FILE || '/etc/nui-memo/cf-origin.key',
  adminCertFile: process.env.NUI_ADMIN_CERT_FILE || '/etc/nui-memo/admin-origin.pem',
  adminKeyFile: process.env.NUI_ADMIN_KEY_FILE || '/etc/nui-memo/admin-origin.key',
  caddyBin: process.env.NUI_CADDY_BIN || '/usr/local/bin/caddy',
  service: process.env.NUI_SERVICE || 'nui-memo',
  caddyService: process.env.NUI_CADDY_SERVICE || 'caddy',
  backendPort: parseInt(process.env.NUI_BACKEND_PORT || '8787', 10),
  dataDir: process.env.NUI_DATA_DIR || '/var/lib/nui-memo',
};

const HOST_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export function isValidHost(host) {
  if (typeof host !== 'string') return false;
  const h = host.trim().toLowerCase();
  if (!h || h.length > 253) return false;
  if (h.includes('://') || h.includes('/') || h.includes(':') || h.includes(' ')) return false;
  return HOST_RE.test(h);
}

export function behindCdn(cfg) {
  return !!cfg && cfg.cdn && cfg.cdn !== 'none';
}

export function defaultRealIpHeader(cdn) {
  return cdn === 'cloudflare' ? 'cf-connecting-ip' : 'x-forwarded-for';
}

/** 由现有配置推导当前域名设置 */
export function settingsFromCfg(cfg) {
  const cdn = cfg.cdn || (cfg.cloudflare ? 'cloudflare' : 'none');
  return {
    mode: cfg.mode === 'ip' ? 'ip' : 'domain',
    userHost: (cfg.userHost || '').toLowerCase(),
    adminHost: (cfg.adminHost || '').toLowerCase(),
    adminOrigin: cfg.adminOrigin || null,
    nat: cfg.nat || null,
    cdn,
    cdnName: cfg.cdnName || (cdn === 'cloudflare' ? 'Cloudflare' : cdn === 'custom' ? '第三方 CDN' : ''),
    sslMode: cfg.sslMode || (cdn === 'none' ? 'auto' : 'flexible'),
    cfHttpPort: parseInt(cfg.cfHttpPort, 10) || 80,
    cfHttpsPort: parseInt(cfg.cfHttpsPort, 10) || 443,
    realIpHeader: cfg.realIpHeader || defaultRealIpHeader(cdn),
    cfOnly: !!cfg.cfOnly,
  };
}

/** 校验并规范化域名设置；返回 { settings, warnings }，非法时抛错 */
export function normalizeDomain(input, base = {}) {
  const warnings = [];
  const cur = settingsFromCfg(base);
  const src = { ...cur, ...(input || {}) };
  let cdn = CDN_PROVIDERS.includes(src.cdn) ? src.cdn : 'none';
  let mode = src.mode === 'ip' ? 'ip' : 'domain';
  const userHost = String(src.userHost || '').trim().toLowerCase();
  let adminHost = String(src.adminHost || '').trim().toLowerCase();
  if (input?.mode === 'domain' && base.mode === 'ip' && !Object.hasOwn(input,'adminHost')) adminHost = '';

  if (!isValidHost(userHost)) throw new Error(`无效域名: ${src.userHost || '(空)'}（需为不含端口/协议的合法主机名）`);
  if (cdn !== 'none' && mode === 'ip') {
    // CDN 代理必须使用真实域名
    mode = 'domain';
    warnings.push('CDN 代理模式需使用自定义域名，已自动切换为域名模式。');
  }
  if (mode === 'ip') {
    if (!adminHost) adminHost = userHost;
    if (!isValidHost(adminHost)) throw new Error(`无效管理子域名: ${src.adminHost}`);
    if (adminHost === userHost) warnings.push('IP 模式下建议用户/管理使用不同子域名。');
  } else if (adminHost && !isValidHost(adminHost)) {
    throw new Error('无效管理域名');
  }

  if (mode === 'domain' && adminHost === userHost) adminHost = '';

  let sslMode = SSL_MODES.includes(src.sslMode) ? src.sslMode : (cdn === 'none' ? 'auto' : 'flexible');
  if (cdn === 'none') sslMode = 'auto';
  else if (sslMode === 'auto') sslMode = 'flexible';

  let nat = null;
  if(src.nat?.enabled) {
    nat={enabled:true,publicIp:String(src.nat.publicIp||'').trim()};
    if(nat.publicIp && !net.isIP(nat.publicIp))throw new Error('NAT 公网 IP 无效');
    if(!nat.publicIp)warnings.push('NAT 未填写服务商的入口公网 IP；探测到的出口 IP 不一定是入口 IP，请手动核对 DNS 记录。');
    for(const [key,fallback] of [['publicHttpPort',80],['publicHttpsPort',443]]) {
      const value=Number(src.nat[key] ?? fallback);
      if(!Number.isInteger(value)||value<1||value>65535)throw new Error('NAT 公网端口必须为 1–65535 的整数');
      nat[key]=value;
    }
    if(nat.publicHttpPort===nat.publicHttpsPort)throw new Error('NAT 公网 HTTP/HTTPS 端口不能相同');
    warnings.push(`NAT 映射需在服务商配置：公网 HTTP ${nat.publicHttpPort} → 内部 HTTP ${src.cfHttpPort}，公网 HTTPS ${nat.publicHttpsPort} → 内部 HTTPS ${src.cfHttpsPort}；程序不会自动创建映射。`);
    if(cdn==='none')warnings.push('NAT 直连必须提供浏览器信任的域名证书（可通过 DNS 验证签发）；不自动申请证书，不能使用仅受 CF 信任的 Origin CA 证书。');
    for(const key of ['cfHttpPort','cfHttpsPort'])if(!Number.isInteger(Number(src[key]))||Number(src[key])<1||Number(src[key])>65535)throw new Error('NAT 内部监听端口无效');
  }
  let cfHttpPort = parseInt(src.cfHttpPort, 10);
  let cfHttpsPort = parseInt(src.cfHttpsPort, 10);
  if (!Number.isFinite(cfHttpPort) || cfHttpPort < 1 || cfHttpPort > 65535) cfHttpPort = 80;
  if (!Number.isFinite(cfHttpsPort) || cfHttpsPort < 1 || cfHttpsPort > 65535) cfHttpsPort = 443;
  if (cdn === 'none' && !nat) { cfHttpPort = 80; cfHttpsPort = 443; }
  if ((cdn !== 'none' || nat) && cfHttpPort === cfHttpsPort) throw new Error('回源 HTTP 与 HTTPS 端口不能相同');

  const requestedHeader = input && Object.hasOwn(input,'realIpHeader') ? input.realIpHeader : cdn !== cur.cdn ? defaultRealIpHeader(cdn) : src.realIpHeader;
  let realIpHeader = REAL_IP_HEADERS.includes(requestedHeader) ? requestedHeader : defaultRealIpHeader(cdn);
  const cdnName = String(src.cdnName || '').slice(0, 40) || (cdn === 'cloudflare' ? 'Cloudflare' : cdn === 'custom' ? '第三方 CDN' : '');
  const cfOnly = !!src.cfOnly;

  const targetHttp=nat?.publicHttpPort || cfHttpPort,targetHttps=nat?.publicHttpsPort || cfHttpsPort;
  if (cdn !== 'none' && (targetHttp !== 80 || targetHttps !== 443)) {
    warnings.push(`回源公网端口为非标准端口（HTTP ${targetHttp} / HTTPS ${targetHttps}），请在 CDN 的回源规则中把目标端口设为对应值，而不是 NAT 内部端口。`);
  }
  if (cdn === 'cloudflare' && sslMode === 'strict') warnings.push('Strict 模式需要有效的 Origin CA 证书（或受信任证书），否则回源会失败。');
  if (cdn !== 'none' && sslMode === 'flexible') warnings.push('Flexible 回源为 HTTP，源站已禁用强制 HTTPS 跳转以避免重定向循环。');

  const settings = { mode, userHost, adminHost, nat, cdn, cdnName, sslMode, cfHttpPort, cfHttpsPort, realIpHeader, cfOnly };
  if (src.adminOrigin != null) {
    if (!adminHost || adminHost === userHost) throw new Error('独立管理回源需要不同的管理域名');
    if (typeof src.adminOrigin !== 'object' || Array.isArray(src.adminOrigin)) throw new Error('无效管理回源配置');
    for (const k of ['cfHttpPort','cfHttpsPort']) if (src.adminOrigin[k] != null && (!Number.isInteger(Number(src.adminOrigin[k])) || Number(src.adminOrigin[k]) < 1 || Number(src.adminOrigin[k]) > 65535)) throw new Error('管理端回源端口必须为 1–65535 的整数');
    const admin = normalizeDomain({ ...src.adminOrigin, mode:'domain', userHost:adminHost, adminHost:'', adminOrigin:null });
    settings.adminOrigin = Object.fromEntries(['nat','cdn','cdnName','sslMode','cfHttpPort','cfHttpsPort','realIpHeader','cfOnly'].map(k=>[k,admin.settings[k]]));
    warnings.push(...admin.warnings.map(w=>'管理端：'+w));
  } else settings.adminOrigin = null;
  if (adminHost && adminHost !== userHost) {
    const a = settings.adminOrigin || settings;
    const ports = x => x.cdn === 'none' && !x.nat?.enabled ? [80,443] : [x.cfHttpPort,x.cfHttpsPort];
    const [uh,us]=ports(settings),[ah,as]=ports(a);
    if (uh === as || us === ah) throw new Error('两端 HTTP 与 HTTPS 监听端口冲突，请勿把同一端口同时用于两种协议');
  }
  return { settings, warnings };
}

export function domainUrls(s, { dev = false } = {}) {
  const scheme = dev ? 'http' : 'https';
  const url=(host,origin)=>`${scheme}://${host}${!dev && origin.cdn==='none' && origin.nat?.enabled && origin.nat.publicHttpsPort!==443 ? ':'+origin.nat.publicHttpsPort : ''}`;
  const userUrl = url(s.userHost,s);
  const adminUrl = s.adminHost && s.adminHost !== s.userHost ? url(s.adminHost,s.adminOrigin||s) : `${userUrl}/admin/`;
  return { userUrl, adminUrl };
}

/** 生成 Caddyfile（安装脚本与运行时共用，保证一致） */
function buildSingleCaddyfile(s, opts = {}) {
  const backendPort = opts.backendPort || SYS.backendPort;
  const certFile = opts.certFile || SYS.certFile;
  const keyFile = opts.keyFile || SYS.keyFile;
  const haveCert = !!opts.haveCert;
  const cdnOn = s.cdn && s.cdn !== 'none';
  const L = [];
  L.push('# 由 nui-memo 生成（安装脚本 / 管理面板域名管理共用）');
  L.push('{');
  L.push('    admin off');
  if (cdnOn || s.nat?.enabled) L.push('    auto_https off');
  L.push('}');
  const proxy = [
    `    encode zstd gzip`,
    `    reverse_proxy 127.0.0.1:${backendPort}`,
  ];
  if (s.cdn === 'cloudflare') {
    // Trust CF visitor headers only when the TCP peer is actually a CF edge.
    // The named matcher also makes the runtime cfOnly switch effective without root firewall edits.
    proxy.unshift(`    @non_cf not remote_ip ${[...CF_V4, ...CF_V6].join(' ')}`,
      '    request_header @non_cf -CF-Connecting-IP',
      '    request_header @non_cf -True-Client-IP',
      '    request_header @non_cf -X-Real-IP',
      ...(s.cfOnly ? ['    respond @non_cf "Cloudflare origin access only" 403'] : []));
  }
  const headerNoHsts = ['    header {', '        -Server', '        X-Content-Type-Options "nosniff"', '        Referrer-Policy "no-referrer"', '    }'];
  const headerHsts = ['    header {', '        -Server', '        Strict-Transport-Security "max-age=31536000; includeSubDomains"', '        X-Content-Type-Options "nosniff"', '        Referrer-Policy "no-referrer"', '    }'];
  if(s.nat?.enabled && !cdnOn) {
    const port=s.nat.publicHttpsPort===443?'':':'+s.nat.publicHttpsPort;
    L.push(`http://${s.userHost}:${s.cfHttpPort} {`, `    redir https://${s.userHost}${port}{uri} 308`, '}');
    L.push(`https://${s.userHost}:${s.cfHttpsPort} {`, `    tls ${certFile} ${keyFile}`, ...proxy, ...headerNoHsts, '}');
  } else if (cdnOn) {
    L.push('');
    L.push(`# CDN 灵活(Flexible)回源：HTTP，不强制跳转，避免重定向循环`);
    L.push(`http://${s.userHost}:${s.cfHttpPort} {`);
    L.push(...proxy, ...headerNoHsts, '}');
    if (haveCert) {
      L.push('');
      L.push(`# CDN 完全/严格(Full/Strict)回源：HTTPS + 回源证书`);
      L.push(`https://${s.userHost}:${s.cfHttpsPort} {`);
      L.push(`    tls ${certFile} ${keyFile}`);
      L.push(...proxy, ...headerNoHsts, '}');
    }
  } else if (s.mode === 'ip') {
    for (const host of [s.userHost, s.adminHost || s.userHost]) {
      L.push('');
      L.push(`${host} {`);
      L.push(...proxy, ...headerHsts, '}');
    }
  } else {
    L.push('');
    L.push(`${s.userHost} {`);
    L.push(...proxy, ...headerHsts, '}');
  }
  return L.join('\n') + '\n';
}

export function originForRequest(req, cfg) {
  const host = String(req.headers?.host || '').split(':')[0].toLowerCase();
  return cfg.adminHost && host === cfg.adminHost && cfg.adminOrigin ? { ...cfg, ...cfg.adminOrigin, cloudflare:cfg.adminOrigin.cdn === 'cloudflare' } : cfg;
}

export function buildCaddyfile(s, opts = {}) {
  const endpoints = [{ ...s, mode:'domain', adminHost:'', adminOrigin:null }];
  if (s.adminHost && s.adminHost !== s.userHost) endpoints.push({ ...s, ...(s.adminOrigin || {}), mode:'domain', userHost:s.adminHost, adminHost:'', adminOrigin:null });
  const backend = opts.backendPort || SYS.backendPort;
  for (const e of endpoints) if ((e.cdn === 'none' && !e.nat?.enabled ? [80,443] : [e.cfHttpPort,e.cfHttpsPort]).includes(backend)) throw new Error('回源监听端口不能占用后端服务端口');
  if (endpoints.length === 1) return buildSingleCaddyfile(endpoints[0],opts);
  const mixed = endpoints.some(e=>e.cdn !== 'none' || e.nat?.enabled);
  const parts = endpoints.map((e,i)=>{
    const options = i === 1 && s.adminOrigin ? { ...opts, haveCert:opts.haveAdminCert, certFile:opts.adminCertFile || SYS.adminCertFile, keyFile:opts.adminKeyFile || SYS.adminKeyFile } : opts;
    const text=buildSingleCaddyfile(e,options);
    const body=text.slice(text.indexOf('\n}\n')+3);
    return body + (mixed && e.cdn === 'none' && !e.nat?.enabled ? `\nhttp://${e.userHost}:80 {\n    redir https://${e.userHost}{uri} 308\n}\n` : '');
  });
  return '# 双入口配置：同协议可共享端口，不同协议不能混用\n{\n    admin off\n' + (mixed?'    auto_https disable_redirects\n':'') + '}\n' + parts.join('\n');
}

function validateOriginCertificate(cert, key, hosts) {
  const parsed = new X509Certificate(cert);
  if (Date.parse(parsed.validTo) <= Date.now() || Date.parse(parsed.validFrom) > Date.now()) throw new Error('回源证书未生效或已过期');
  if (!parsed.publicKey.export({type:'spki',format:'der'}).equals(createPublicKey(createPrivateKey(key)).export({type:'spki',format:'der'}))) throw new Error('回源证书与私钥不匹配');
  for (const host of hosts) if (!parsed.checkHost(host)) throw new Error(`回源证书不覆盖 ${host}，请配置对应证书`);
}

/** 把域名设置写入 config.json（保留其它字段） */
export function mergeConfigFile(confFile, s) {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(confFile, 'utf8')); } catch { cfg = {}; }
  Object.assign(cfg, {
    mode: s.mode, userHost: s.userHost, adminHost: s.adminHost, nat:s.nat || null, adminOrigin:s.adminOrigin || null,
    cloudflare: s.cdn === 'cloudflare', cdn: s.cdn, cdnName: s.cdnName,
    sslMode: s.sslMode, cfHttpPort: s.cfHttpPort, cfHttpsPort: s.cfHttpsPort,
    realIpHeader: s.realIpHeader, cfOnly: s.cfOnly,
  });
  atomicWrite(confFile, JSON.stringify(cfg, null, 2) + '\n', 0o640);
  return cfg;
}

export function atomicWrite(file, data, mode, owner) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let previous;
  try { previous = fs.statSync(file); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  try {
    fs.writeFileSync(tmp, data, { mode: mode ?? (previous ? previous.mode & 0o777 : 0o644), flag: 'wx' });
    // rename replaces the inode: explicitly carry forward owner/group, not just mode.
    const ownership = owner || previous;
    if (ownership) {
      const current = fs.statSync(tmp);
      if (current.uid !== ownership.uid || current.gid !== ownership.gid) fs.chownSync(tmp, ownership.uid, ownership.gid);
    }
    fs.chmodSync(tmp, mode ?? (previous ? previous.mode & 0o777 : 0o644));
    const fd = fs.openSync(tmp, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file);
  } finally { try { fs.unlinkSync(tmp); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
}

function looksLikePem(s, kind) {
  if (typeof s !== 'string') return false;
  if (kind === 'cert') return /-----BEGIN [A-Z ]*CERTIFICATE-----/.test(s);
  return /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(s);
}

/** 通过 Cloudflare API 自动签发 Origin CA 证书，返回 { cert, key } 或抛错 */
export function issueCloudflareOriginCert(domain, token) {
  const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'nui-cf-'));
  try {
    const keyFile = path.join(tmp, 'origin.key');
    const csrFile = path.join(tmp, 'origin.csr');
    execFileSync('openssl', ['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyFile, '-out', csrFile, '-subj', `/CN=${domain}`], { stdio: 'ignore' });
    const csr = fs.readFileSync(csrFile, 'utf8');
    const body = JSON.stringify({ hostnames: [domain, `*.${domain}`], requested_validity: 5475, request_type: 'origin-rsa', csr });
    const resp = execFileSync('curl', ['-fsS', '--max-time', '30', '-X', 'POST', 'https://api.cloudflare.com/client/v4/certificates',
      '-H', `Authorization: Bearer ${token}`, '-H', 'Content-Type: application/json', '--data', body], { encoding: 'utf8' });
    const j = JSON.parse(resp);
    if (!j.success || !j.result || !j.result.certificate) throw new Error((j.errors && j.errors[0] && j.errors[0].message) || 'Cloudflare API 返回失败');
    return { cert: j.result.certificate, key: fs.readFileSync(keyFile, 'utf8') };
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

/**
 * 特权应用：读取请求 JSON，写入证书 / config / Caddyfile，校验并重载。
 * dryRun=true 时跳过 caddy/systemctl（用于测试 / 无 root 环境）。
 */
export function applyRequest(req, { dryRun = false } = {}) {
  // 安全：生产（非 dryRun）只信任 root 控制的环境变量 SYS，忽略请求里的 paths，
  // 防止低权限进程借 root helper 写任意路径。dryRun（测试）才允许 req.paths。
  const p = dryRun ? (req.paths || {}) : {};
  const confFile = p.confFile || SYS.confFile;
  const caddyFile = p.caddyFile || SYS.caddyFile;
  const certFile = p.certFile || SYS.certFile;
  const keyFile = p.keyFile || SYS.keyFile;
  const adminCertFile = p.adminCertFile || SYS.adminCertFile;
  const adminKeyFile = p.adminKeyFile || SYS.adminKeyFile;
  const dataDir = p.dataDir || SYS.dataDir;
  const backendPort = p.backendPort || SYS.backendPort;
  const caddyBin = p.caddyBin || SYS.caddyBin;
  const result = { id: req.id || null, ok: false, warnings: [], appliedAt: Math.floor(Date.now() / 1000) };
  const writeResult = () => { try { atomicWrite(path.join(dataDir, 'domain-result.json'), JSON.stringify(result, null, 2)); } catch {} };
  let backups = [], captured = false, reloadAttempted = false;
  try {
    backups = [confFile, caddyFile, certFile, keyFile, adminCertFile, adminKeyFile, path.join(dataDir, 'domain.json')].map(file => {
      if (!fs.existsSync(file)) return { file, exists: false };
      const stat = fs.statSync(file);
      return { file, exists: true, bytes: fs.readFileSync(file), mode: stat.mode & 0o777, uid: stat.uid, gid: stat.gid };
    });
    captured = true;
    let base = {};
    if (fs.existsSync(confFile)) base = JSON.parse(fs.readFileSync(confFile, 'utf8'));
    const { settings, warnings } = normalizeDomain(req.settings, base);
    result.warnings = warnings;
    result.settings = settings;
    result.urls = domainUrls(settings);

    // Validate listener topology before writing any files.
    buildCaddyfile(settings, { backendPort });
    if (!!req.certPem !== !!req.keyPem || !!req.adminCertPem !== !!req.adminKeyPem) throw new Error('每个入口的证书与私钥必须成对填写');
    // 证书处理
    let haveCert = false;
    if (req.certPem && req.keyPem) {
      if (!looksLikePem(req.certPem, 'cert') || !looksLikePem(req.keyPem, 'key')) throw new Error('证书或私钥不是有效的 PEM 格式');
      if (!dryRun) {
        atomicWrite(certFile, req.certPem.endsWith('\n') ? req.certPem : req.certPem + '\n', 0o644);
        atomicWrite(keyFile, req.keyPem.endsWith('\n') ? req.keyPem : req.keyPem + '\n', 0o640);
        try { execFileSync('chown', ['root:caddy', certFile, keyFile], { stdio: 'ignore' }); } catch {}
      }
      haveCert = true;
    } else if (req.cfApiToken && settings.cdn === 'cloudflare' && settings.sslMode !== 'flexible') {
      try {
        const { cert, key } = issueCloudflareOriginCert(settings.userHost, req.cfApiToken);
        if (!dryRun) {
          atomicWrite(certFile, cert.endsWith('\n') ? cert : cert + '\n', 0o644);
          atomicWrite(keyFile, key.endsWith('\n') ? key : key + '\n', 0o640);
          try { execFileSync('chown', ['root:caddy', certFile, keyFile], { stdio: 'ignore' }); } catch {}
        }
        haveCert = true;
        result.certIssued = true;
      } catch (e) {
        throw new Error('自动签发 Origin CA 证书失败，请检查 Token 权限与域名；原配置保持不变。');
      }
    } else {
      haveCert = fs.existsSync(certFile) && fs.existsSync(keyFile);
    }
    if ((settings.sslMode === 'full' || settings.sslMode === 'strict' || (settings.nat?.enabled && settings.cdn==='none')) && !haveCert) {
      throw new Error('Full/Strict 缺少回源证书，已取消应用，避免静默降级为 HTTP。请提供证书或明确选择 Flexible。');
    }
    result.haveCert = haveCert;
    let haveAdminCert = fs.existsSync(adminCertFile) && fs.existsSync(adminKeyFile);
    if (settings.adminOrigin && req.adminCertPem && req.adminKeyPem) {
      if (!looksLikePem(req.adminCertPem,'cert') || !looksLikePem(req.adminKeyPem,'key')) throw new Error('管理端证书或私钥不是 PEM 格式');
      if (!dryRun) {
        validateOriginCertificate(req.adminCertPem,req.adminKeyPem,[settings.adminHost]);
        atomicWrite(adminCertFile,req.adminCertPem+'\n',0o644);
        atomicWrite(adminKeyFile,req.adminKeyPem+'\n',0o640);
        execFileSync('chown',['root:caddy',adminCertFile,adminKeyFile]);
      }
      haveAdminCert = true;
    }
    if (settings.adminOrigin?.cdn === 'cloudflare' && settings.adminOrigin.sslMode !== 'flexible' && req.adminCfApiToken && !(req.adminCertPem && req.adminKeyPem)) {
      try {
        if (!dryRun) {
          const {cert,key} = issueCloudflareOriginCert(settings.adminHost,req.adminCfApiToken);
          validateOriginCertificate(cert,key,[settings.adminHost]);
          atomicWrite(adminCertFile,cert+'\n',0o644);
          atomicWrite(adminKeyFile,key+'\n',0o640);
          execFileSync('chown',['root:caddy',adminCertFile,adminKeyFile],{stdio:'ignore'});
        }
        haveAdminCert=true; result.adminCertIssued=true;
      } catch {
        // execFile errors may contain curl arguments including the secret token.
        throw new Error('管理端自动签发 Origin CA 证书失败，请检查 Token 权限与域名；原配置将恢复');
      }
    }
    if (settings.adminOrigin && (['full','strict'].includes(settings.adminOrigin.sslMode) || (settings.adminOrigin.nat?.enabled && settings.adminOrigin.cdn==='none')) && !haveAdminCert) throw new Error('管理端 Full/Strict 缺少独立回源证书，已取消应用');
    if (!dryRun && haveCert && (settings.cdn !== 'none' || settings.nat?.enabled)) validateOriginCertificate(fs.readFileSync(certFile),fs.readFileSync(keyFile),[settings.userHost,...(!settings.adminOrigin && settings.adminHost && settings.adminHost !== settings.userHost ? [settings.adminHost] : [])]);
    if (!dryRun && settings.adminOrigin && haveAdminCert && (settings.adminOrigin.cdn !== 'none' || settings.adminOrigin.nat?.enabled)) validateOriginCertificate(fs.readFileSync(adminCertFile),fs.readFileSync(adminKeyFile),[settings.adminHost]);
    result.haveAdminCert = haveAdminCert;

    // 写 config + 运行时域名覆盖
    const merged = mergeConfigFile(confFile, settings);
    result.configFile = confFile;
    atomicWrite(path.join(dataDir, 'domain.json'), JSON.stringify(settings, null, 2));

    // 生成并校验 Caddyfile
    const caddyText = buildCaddyfile(settings, { backendPort, certFile, keyFile, haveCert, haveAdminCert, adminCertFile, adminKeyFile });
    result.caddyfile = caddyText;
    if (dryRun) {
      atomicWrite(caddyFile, caddyText, 0o644);
    } else {
      const tmpCaddy = `${caddyFile}.pending`;
      atomicWrite(tmpCaddy, caddyText, 0o644);
      try {
        execFileSync(caddyBin, ['validate', '--config', tmpCaddy], { stdio: 'pipe' });
      } catch (e) {
        try { fs.unlinkSync(tmpCaddy); } catch {}
        throw new Error(`Caddyfile 校验失败：${(e.stderr || e.message || '').toString().slice(0, 400)}`);
      }
      fs.renameSync(tmpCaddy, caddyFile);
      reloadAttempted = true;
      try { execFileSync('systemctl', ['reload', SYS.caddyService], { stdio: 'pipe' }); }
      catch { execFileSync('systemctl', ['restart', SYS.caddyService], { stdio: 'pipe' }); }
      // 重启后端以加载新域名（异步，避免阻塞当前进程）
      try { execFileSync('systemctl', ['restart', '--no-block', SYS.service], { stdio: 'pipe' }); } catch {}
    }
    result.ok = true;
    writeResult();
    return result;
  } catch (e) {
    if (captured) {
      try {
        for (const backup of backups) {
          if (backup.exists) atomicWrite(backup.file, backup.bytes, backup.mode, backup);
          else if (fs.existsSync(backup.file)) fs.unlinkSync(backup.file);
        }
        if (reloadAttempted && !dryRun) {
          try { execFileSync('systemctl', ['reload', SYS.caddyService], { stdio:'pipe' }); }
          catch { execFileSync('systemctl', ['restart', SYS.caddyService], { stdio:'pipe' }); }
        }
        result.rolledBack = true;
      } catch (rollback) { result.warnings.push(`回滚失败，请立即检查源站配置：${rollback.message}`); }
    }
    result.ok = false;
    result.error = e.message || String(e);
    writeResult();
    return result;
  }
}

// ---------------- CLI ----------------
function readStdin() {
  return new Promise((resolve) => {
    let s = '';
    process.stdin.on('data', (d) => s += d);
    process.stdin.on('end', () => resolve(s));
    setTimeout(() => resolve(s), 3000).unref();
  });
}

async function cli() {
  const cmd = process.argv[2];
  if (cmd === 'caddyfile') {
    let s;
    const useEnv = !!process.env.NUI_USER_HOST;
    const raw = process.env.NUI_CADDY_OPTS || (!useEnv && !process.stdin.isTTY ? await readStdin() : '');
    if (raw && raw.trim()) {
      s = JSON.parse(raw);
    } else {
      const env = process.env;
      const saved = env.NUI_CONF_FILE ? JSON.parse(fs.readFileSync(env.NUI_CONF_FILE,'utf8')) : {};
      s = {
        nat:saved.nat || null, adminOrigin:saved.adminOrigin || null,
        mode: env.NUI_MODE || 'domain', userHost: env.NUI_USER_HOST || '', adminHost: env.NUI_ADMIN_HOST || (saved.adminOrigin ? saved.adminHost : '') || '',
        cdn: env.NUI_CDN || (env.NUI_CLOUDFLARE === '1' ? 'cloudflare' : 'none'),
        cdnName: env.NUI_CDN_NAME || '', sslMode: env.NUI_SSL_MODE || 'auto',
        cfHttpPort: parseInt(env.NUI_CF_HTTP_PORT || '80', 10), cfHttpsPort: parseInt(env.NUI_CF_HTTPS_PORT || '443', 10),
        realIpHeader: env.NUI_REAL_IP_HEADER || '', cfOnly: env.NUI_CF_ONLY === '1',
      };
    }
    const { settings } = normalizeDomain(s, {});
    const haveCert = (process.env.NUI_HAVE_CERT === '1') || (fs.existsSync(SYS.certFile) && fs.existsSync(SYS.keyFile));
    if(settings.nat?.enabled && settings.cdn==='none') {
      if(!haveCert)throw new Error('NAT 直连需要证书和私钥');
      validateOriginCertificate(fs.readFileSync(SYS.certFile),fs.readFileSync(SYS.keyFile),[settings.userHost,...(!settings.adminOrigin && settings.adminHost?[settings.adminHost]:[])]);
    }
    process.stdout.write(buildCaddyfile(settings, { haveCert, haveAdminCert:fs.existsSync(SYS.adminCertFile) && fs.existsSync(SYS.adminKeyFile), backendPort: parseInt(process.env.NUI_BACKEND_PORT || String(SYS.backendPort), 10) }));
    return;
  }
  if (cmd === 'apply') {
    const idx = process.argv.indexOf('--request');
    const reqFile = idx >= 0 ? process.argv[idx + 1] : null;
    if (!reqFile) { console.error('用法: node domain.js apply --request <file> [--dry-run]'); process.exit(2); }
    const req = JSON.parse(fs.readFileSync(reqFile, 'utf8'));
    const dryRun = process.argv.includes('--dry-run') || req.dryRun === true || process.env.NUI_DOMAIN_DRYRUN === '1';
    const result = applyRequest(req, { dryRun });
    // 处理完成后移除请求文件，避免 systemd path 重复触发
    try { fs.unlinkSync(reqFile); } catch {}
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    process.exit(result.ok ? 0 : 1);
  }
  console.error('用法: node domain.js <caddyfile|apply> ...');
  process.exit(2);
}

if (process.argv[1] && process.argv[1].endsWith('domain.js')) {
  cli().catch((e) => { console.error(e); process.exit(1); });
}
