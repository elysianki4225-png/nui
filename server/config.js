import {domainUrls} from './domain.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const MB = 1024 * 1024;

const defaults = {
  host: '127.0.0.1',
  port: 8787,
  dataDir: '/var/lib/nui-memo',
  // domain: 用户域名 + /admin 路径;  ip: 两个独立 nip.io 子域名
  mode: 'domain',
  userHost: '',
  adminHost: '',
  trustProxy: true,
  // 位于 Cloudflare 小黄云代理之后（Flexible / Full / Strict 均可）
  cloudflare: false,
  telegramApiBase: 'https://api.telegram.org',
  maxFileSize: 128 * MB,
  chunkSize: 16 * MB,
  thumbCacheMB: 64,
  uploadConcurrency: 3,
  uploadQueueMB: 96,
  dev: false,
};

function readJsonIfExists(file) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.error(`[config] 无法读取 ${file}: ${e.message}`);
    process.exit(1);
  }
  return null;
}

export function loadConfig() {
  const candidates = [
    process.env.MEMO_CONFIG,
    '/etc/nui-memo/config.json',
    path.resolve(process.cwd(), 'config.json'),
  ].filter(Boolean);
  let fileCfg = {};
  let usedFile = null;
  for (const c of candidates) {
    const j = readJsonIfExists(c);
    if (j) { fileCfg = j; usedFile = c; break; }
  }
  const cfg = { ...defaults, ...fileCfg };
  if (process.env.MEMO_HOST) cfg.host = process.env.MEMO_HOST;
  if (process.env.MEMO_PORT) cfg.port = parseInt(process.env.MEMO_PORT, 10);
  if (process.env.MEMO_DATA_DIR) cfg.dataDir = process.env.MEMO_DATA_DIR;
  if (process.env.MEMO_DEV === '1') cfg.dev = true;
  if (process.env.MEMO_TELEGRAM_API) cfg.telegramApiBase = process.env.MEMO_TELEGRAM_API;
  cfg.dataDir = path.resolve(cfg.dataDir);
  cfg.chunkSize = Math.min(Math.max(cfg.chunkSize, 1 * MB), 16 * MB);
  cfg.maxFileSize = Math.min(Math.max(cfg.maxFileSize, 1 * MB), 512 * MB);
  cfg.configFile = usedFile;
  cfg.hostname = os.hostname();
  // 运行时域名覆盖（管理面板「域名」页修改后持久化于此，重启后仍生效）
  try {
    const dj = path.join(cfg.dataDir, 'domain.json');
    if (fs.existsSync(dj)) {
      const d = JSON.parse(fs.readFileSync(dj, 'utf8'));
      for (const k of ['mode', 'userHost', 'adminHost', 'adminOrigin', 'nat', 'cdn', 'cdnName', 'sslMode', 'cfHttpPort', 'cfHttpsPort', 'realIpHeader', 'cfOnly']) {
        if (d[k] !== undefined) cfg[k] = d[k];
      }
      cfg.cloudflare = cfg.cdn === 'cloudflare';
    }
  } catch (e) { console.error('[config] 读取 domain.json 失败:', e.message); }
  // 兼容旧配置：仅有 cloudflare 布尔时推导 cdn
  if (!cfg.cdn) cfg.cdn = cfg.cloudflare ? 'cloudflare' : 'none';
  cfg.cloudflare = cfg.cdn === 'cloudflare';
  if (!cfg.realIpHeader) cfg.realIpHeader = cfg.cdn === 'cloudflare' ? 'cf-connecting-ip' : 'x-forwarded-for';
  if (!cfg.sslMode) cfg.sslMode = cfg.cdn === 'none' ? 'auto' : 'flexible';
  if (!cfg.userHost) cfg.userHost = `localhost:${cfg.port}`;
  if (cfg.mode === 'ip' && !cfg.adminHost) cfg.adminHost = cfg.userHost;
  cfg.userUrl = cfg.userHost.startsWith('http') ? cfg.userHost : `https://${cfg.userHost}`;
  cfg.adminUrl = cfg.mode === 'ip' || (cfg.adminHost && cfg.adminHost !== cfg.userHost)
    ? (cfg.adminHost.startsWith('http') ? cfg.adminHost : `https://${cfg.adminHost}`)
    : `${cfg.userUrl}/admin/`;
  if (cfg.dev) {
    cfg.userUrl = `http://${cfg.userHost}`;
    cfg.adminUrl = cfg.mode === 'ip' || (cfg.adminHost && cfg.adminHost !== cfg.userHost) ? `http://${cfg.adminHost}` : `${cfg.userUrl}/admin/`;
  }
  if(cfg.nat?.enabled || cfg.adminOrigin?.nat?.enabled)Object.assign(cfg,domainUrls(cfg,{dev:cfg.dev}));
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  return cfg;
}
