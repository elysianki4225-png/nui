// 域名 / CDN 管理核心：校验、Caddyfile 生成、特权应用（供 root helper 调用）。
// 既被后端 import，也可独立运行：
//   node domain.js caddyfile            # 从环境变量读取参数，打印 Caddyfile
//   node domain.js apply --request f    # 读取请求 JSON，应用域名/证书/Caddy 配置
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const CDN_PROVIDERS = ['none', 'cloudflare', 'custom'];
export const SSL_MODES = ['auto', 'flexible', 'full', 'strict'];
export const REAL_IP_HEADERS = ['cf-connecting-ip', 'x-forwarded-for', 'x-real-ip', 'true-client-ip'];
// Cloudflare 小黄云默认代理的回源端口（其它端口需 Spectrum/企业版，否则不生效）
export const CF_PROXY_HTTP_PORTS = [80, 8080, 8880, 2052, 2082, 2086, 2095];
export const CF_PROXY_HTTPS_PORTS = [443, 2053, 2083, 2087, 2096, 8443];

// 系统路径（可被环境变量覆盖，便于测试 / 非标准安装）
export const SYS = {
  confFile: process.env.NUI_CONF_FILE || '/etc/nui-memo/config.json',
  caddyFile: process.env.NUI_CADDY_FILE || '/etc/caddy/Caddyfile',
  certFile: process.env.NUI_CF_CERT_FILE || '/etc/nui-memo/cf-origin.pem',
  keyFile: process.env.NUI_CF_KEY_FILE || '/etc/nui-memo/cf-origin.key',
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
  } else {
    adminHost = '';
  }

  let sslMode = SSL_MODES.includes(src.sslMode) ? src.sslMode : (cdn === 'none' ? 'auto' : 'flexible');
  if (cdn === 'none') sslMode = 'auto';
  else if (sslMode === 'auto') sslMode = 'flexible';

  let cfHttpPort = parseInt(src.cfHttpPort, 10);
  let cfHttpsPort = parseInt(src.cfHttpsPort, 10);
  if (!Number.isFinite(cfHttpPort) || cfHttpPort < 1 || cfHttpPort > 65535) cfHttpPort = 80;
  if (!Number.isFinite(cfHttpsPort) || cfHttpsPort < 1 || cfHttpsPort > 65535) cfHttpsPort = 443;
  if (cdn === 'none') { cfHttpPort = 80; cfHttpsPort = 443; }
  if (cdn !== 'none' && cfHttpPort === cfHttpsPort) throw new Error('回源 HTTP 与 HTTPS 端口不能相同');

  let realIpHeader = REAL_IP_HEADERS.includes(src.realIpHeader) ? src.realIpHeader : defaultRealIpHeader(cdn);
  const cdnName = String(src.cdnName || '').slice(0, 40) || (cdn === 'cloudflare' ? 'Cloudflare' : cdn === 'custom' ? '第三方 CDN' : '');
  const cfOnly = !!src.cfOnly;

  if (cdn !== 'none' && (cfHttpPort !== 80 || cfHttpsPort !== 443)) {
    warnings.push(`回源端口为非标准端口（HTTP ${cfHttpPort} / HTTPS ${cfHttpsPort}），请在 CDN 的回源规则中把目标端口设为对应值。`);
  }
  if (cdn === 'cloudflare') {
    if (!CF_PROXY_HTTP_PORTS.includes(cfHttpPort)) warnings.push(`Cloudflare 小黄云默认不代理 HTTP 端口 ${cfHttpPort}（支持：${CF_PROXY_HTTP_PORTS.join(', ')}），请改用受支持端口或确认已开通 Spectrum。`);
    if (!CF_PROXY_HTTPS_PORTS.includes(cfHttpsPort)) warnings.push(`Cloudflare 小黄云默认不代理 HTTPS 端口 ${cfHttpsPort}（支持：${CF_PROXY_HTTPS_PORTS.join(', ')}），请改用受支持端口或确认已开通 Spectrum。`);
  }
  if (cdn === 'cloudflare' && sslMode === 'strict') warnings.push('Strict 模式需要有效的 Origin CA 证书（或受信任证书），否则回源会失败。');
  if (cdn !== 'none' && sslMode === 'flexible') warnings.push('Flexible 回源为 HTTP，源站已禁用强制 HTTPS 跳转以避免重定向循环。');

  const settings = { mode, userHost, adminHost, cdn, cdnName, sslMode, cfHttpPort, cfHttpsPort, realIpHeader, cfOnly };
  return { settings, warnings };
}

export function domainUrls(s, { dev = false } = {}) {
  const scheme = dev ? 'http' : 'https';
  const userUrl = `${scheme}://${s.userHost}`;
  const adminUrl = s.mode === 'ip' ? `${scheme}://${s.adminHost || s.userHost}` : `${userUrl}/admin/`;
  return { userUrl, adminUrl };
}

/** 生成 Caddyfile（安装脚本与运行时共用，保证一致） */
export function buildCaddyfile(s, opts = {}) {
  const backendPort = opts.backendPort || SYS.backendPort;
  const certFile = opts.certFile || SYS.certFile;
  const keyFile = opts.keyFile || SYS.keyFile;
  const haveCert = !!opts.haveCert;
  const cdnOn = s.cdn && s.cdn !== 'none';
  const L = [];
  L.push('# 由 nui-memo 生成（安装脚本 / 管理面板域名管理共用）');
  L.push('{');
  L.push('    admin off');
  if (cdnOn) L.push('    auto_https off');
  L.push('}');
  const proxy = [
    `    encode zstd gzip`,
    `    reverse_proxy 127.0.0.1:${backendPort}`,
  ];
  const headerNoHsts = ['    header {', '        -Server', '        X-Content-Type-Options "nosniff"', '        Referrer-Policy "no-referrer"', '    }'];
  const headerHsts = ['    header {', '        -Server', '        Strict-Transport-Security "max-age=31536000; includeSubDomains"', '        X-Content-Type-Options "nosniff"', '        Referrer-Policy "no-referrer"', '    }'];
  if (cdnOn) {
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

/** 把域名设置写入 config.json（保留其它字段） */
export function mergeConfigFile(confFile, s) {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(confFile, 'utf8')); } catch { cfg = {}; }
  Object.assign(cfg, {
    mode: s.mode, userHost: s.userHost, adminHost: s.adminHost,
    cloudflare: s.cdn === 'cloudflare', cdn: s.cdn, cdnName: s.cdnName,
    sslMode: s.sslMode, cfHttpPort: s.cfHttpPort, cfHttpsPort: s.cfHttpsPort,
    realIpHeader: s.realIpHeader, cfOnly: s.cfOnly,
  });
  atomicWrite(confFile, JSON.stringify(cfg, null, 2) + '\n', 0o640);
  return cfg;
}

export function atomicWrite(file, data, mode) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, data, mode != null ? { mode } : undefined);
  fs.renameSync(tmp, file);
  if (mode != null) { try { fs.chmodSync(file, mode); } catch {} }
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
  const dataDir = p.dataDir || SYS.dataDir;
  const backendPort = p.backendPort || SYS.backendPort;
  const caddyBin = p.caddyBin || SYS.caddyBin;
  const result = { id: req.id || null, ok: false, warnings: [], appliedAt: Math.floor(Date.now() / 1000) };
  const writeResult = () => { try { atomicWrite(path.join(dataDir, 'domain-result.json'), JSON.stringify(result, null, 2)); } catch {} };
  try {
    let base = {};
    try { base = JSON.parse(fs.readFileSync(confFile, 'utf8')); } catch {}
    const { settings, warnings } = normalizeDomain(req.settings, base);
    result.warnings = warnings;
    result.settings = settings;
    result.urls = domainUrls(settings);

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
        result.warnings.push(`自动签发 Origin CA 证书失败：${e.message}；将仅启用 HTTP 回源（Flexible）。`);
      }
    } else {
      haveCert = fs.existsSync(certFile) && fs.existsSync(keyFile);
    }
    if ((settings.sslMode === 'full' || settings.sslMode === 'strict') && !haveCert) {
      result.warnings.push('未提供回源证书，已回退为 Flexible（HTTP 回源）。如需 Full/Strict，请上传 Origin CA 证书或填写 CF API Token。');
      settings.sslMode = 'flexible';
    }
    result.haveCert = haveCert;

    // 写 config + 运行时域名覆盖
    const merged = mergeConfigFile(confFile, settings);
    result.configFile = confFile;
    try { atomicWrite(path.join(dataDir, 'domain.json'), JSON.stringify(settings, null, 2)); } catch {}

    // 生成并校验 Caddyfile
    const caddyText = buildCaddyfile(settings, { backendPort, certFile, keyFile, haveCert });
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
      try { execFileSync('systemctl', ['reload', SYS.caddyService], { stdio: 'pipe' }); }
      catch { execFileSync('systemctl', ['restart', SYS.caddyService], { stdio: 'pipe' }); }
      // 重启后端以加载新域名（异步，避免阻塞当前进程）
      try { execFileSync('systemctl', ['restart', '--no-block', SYS.service], { stdio: 'pipe' }); } catch {}
    }
    result.ok = true;
    writeResult();
    return result;
  } catch (e) {
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
      s = {
        mode: env.NUI_MODE || 'domain', userHost: env.NUI_USER_HOST || '', adminHost: env.NUI_ADMIN_HOST || '',
        cdn: env.NUI_CDN || (env.NUI_CLOUDFLARE === '1' ? 'cloudflare' : 'none'),
        cdnName: env.NUI_CDN_NAME || '', sslMode: env.NUI_SSL_MODE || 'auto',
        cfHttpPort: parseInt(env.NUI_CF_HTTP_PORT || '80', 10), cfHttpsPort: parseInt(env.NUI_CF_HTTPS_PORT || '443', 10),
        realIpHeader: env.NUI_REAL_IP_HEADER || '', cfOnly: env.NUI_CF_ONLY === '1',
      };
    }
    const { settings } = normalizeDomain(s, {});
    const haveCert = (process.env.NUI_HAVE_CERT === '1') || (fs.existsSync(SYS.certFile) && fs.existsSync(SYS.keyFile));
    process.stdout.write(buildCaddyfile(settings, { haveCert, backendPort: parseInt(process.env.NUI_BACKEND_PORT || String(SYS.backendPort), 10) }));
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
