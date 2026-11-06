// 运维 CLI（供 SSH 管理面板 n-ui 调用，零依赖）。
// 用法:
//   NUI_NEW_PASS=... [NUI_NEW_USER=...] node server/cli.js reset-admin   # 重置/初始化管理员
//   node server/cli.js info                                            # 输出概览 JSON
// 注意: reset-admin 会直接改写存储，调用方应先停止服务、完成后再启动，避免内存态覆盖。
import { loadConfig } from './config.js';
import { Store } from './store.js';
import { hashSecret } from './security.js';
import { nowSec, VERSION } from './util.js';

const cmd = process.argv[2];

async function resetAdmin() {
  const cfg = loadConfig();
  const store = new Store(cfg.dataDir);
  await store.load();
  const pass = String(process.env.NUI_NEW_PASS || '');
  const prev = store.state.admin;
  const user = String(process.env.NUI_NEW_USER || prev?.username || 'admin').trim();
  if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(user)) { console.error('用户名需为 3-32 位字母、数字、_ . -'); process.exit(2); }
  if (pass.length < 8 || pass.length > 128) { console.error('密码长度需为 8-128 位'); process.exit(2); }
  store.log({ t: 'admin.set', admin: { username: user, passHash: hashSecret(pass), createdAt: prev?.createdAt || nowSec() } });
  // Emergency recovery also disables a misconfigured CAPTCHA without erasing its keys.
  if(store.state.settings.captcha)store.log({t:'settings.set',settings:{captcha:{...store.state.settings.captcha,enabled:false,version:(store.state.settings.captcha.version||0)+1},riskBlocks:[]}});
  // Replacing admin above also disables calculator disguise for SSH recovery.
  // 重置密码后使所有管理员会话失效
  for (const [hash, s] of Object.entries(store.state.sessions)) {
    if (s.kind === 'admin') store.log({ t: 'session.delete', tokenHash: hash });
  }
  store.audit(user, 'admin.reset', 'SSH 面板重置管理员凭据');
  await store.close();
  console.log(JSON.stringify({ ok: true, username: user, hadAdmin: !!prev }));
}

async function info() {
  const cfg = loadConfig();
  const store = new Store(cfg.dataDir);
  await store.load();
  const out = {
    ok: true, version: VERSION, admin: store.state.admin?.username || null,
    totals: store.totals(), userUrl: cfg.userUrl, adminUrl: cfg.adminUrl, dataDir: cfg.dataDir,
  };
  await store.close();
  console.log(JSON.stringify(out));
}

async function main() {
  if (cmd === 'reset-admin') return resetAdmin();
  if (cmd === 'info') return info();
  console.error('用法: node cli.js <reset-admin|info>');
  process.exit(2);
}
main().catch((e) => { console.error(e.message || String(e)); process.exit(1); });
