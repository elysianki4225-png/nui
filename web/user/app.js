import {startEntryGate} from '/assets/js/entry-gate.js';
import { requestCaptcha } from '/assets/js/captcha.js';
import { Organization, installOrganizationDrag } from '/assets/js/organization.js';
import { loadAppearance } from '/assets/js/appearance.js';
import {
  API_BASE, closeOverlays, registerOverlay, h, clear, icon, loadSprite, initTheme, toggleTheme, currentTheme, initRipple,
  toast, openDialog, confirmDialog, openMenu, GET, POST, PUT, PATCH, DEL, ApiError,
  formatBytes, formatDate, formatRelative, formatAccount, copyText, debounce, downloadBlob, TYPE_META,
} from '/assets/js/core.js';
import { base32Encode, CryptoClient, generateKey, parseKey, formatKey, cryptoAvailable } from '/assets/js/crypto.js';
import { MediaManager } from '/assets/js/media.js';
import { VirtualView } from '/assets/js/virtual.js';

const $app = document.getElementById('app');
const REMEMBER_KEY = 'memo-remember';
const SAVED_LOGIN = 'memo-saved-login';
function savedLogin() { try { return JSON.parse(localStorage.getItem(SAVED_LOGIN) || 'null'); } catch { return null; } }
function forgetLogin() { localStorage.removeItem(SAVED_LOGIN); sessionStorage.removeItem(REMEMBER_KEY); }
function saveLogin() { localStorage.setItem(SAVED_LOGIN, JSON.stringify({ account: S.account, key: base32Encode(S.master) })); }


const S = {
  config: null, crypto: null, media: null, account: null, master: null,
  view: 'loading', tab: 'memos',
  memos: [], decrypted: new Map(), stats: null,
  filter: 'all', pinnedOnly: false, search: '', sort: 'newest', viewMode: localStorage.getItem('memo-view') || 'list',
  organization:null, folder:'', dragDispose:null,
  selection: new Set(), selectMode: false,
  syncing: false, syncAbort: null, nextCursor: null,
  virtual: null, detailAbort: null, lastActivity: Date.now(), autoLockTimer: null,
  shellBuilt: false, el: {},
};

// ============================ 启动 ============================
boot();
async function boot() {
  initTheme(); initRipple(); loadSprite();
  await startEntryGate($app,()=>{cleanupSession(false);sessionStorage.removeItem(REMEMBER_KEY);S.view='lock';clear($app);});
  loadAppearance();
  if (!cryptoAvailable()) {
    $app.append(h('div', { class: 'auth-wrap' }, h('div', { class: 'auth-card text-center' },
      icon('error', 'xl'), h('h2', {}, '需要安全环境'),
      h('p', { class: 'muted' }, '端到端加密需要 HTTPS（或 localhost）环境，请通过加密连接访问。'))));
    return;
  }
  try { S.config = await GET('/api/config'); } catch (e) { toast('无法连接服务器: ' + e.message, { type: 'error' }); }
  document.title = (S.config?.siteName || '备忘录');
  setInterval(checkAutoLock, 20_000);
  ['pointerdown', 'keydown', 'touchstart'].forEach((ev) => document.addEventListener(ev, () => { S.lastActivity = Date.now(); }, { passive: true }));
  const saved = savedLogin();
  if (saved?.account && saved?.key) {
    try { let current=null;try{current=await GET('/api/user/me');}catch{} S.account = saved.account; await unlockWith(parseKey(saved.key), current?.account!==saved.account); return; }
    catch { S.account = null; toast('自动登录未成功，请手动登录或稍后重试', { type: 'info' }); }
  }
  let me = null;
  try { me = await GET('/api/user/me'); } catch {}
  if (me && me.account) {
    S.account = me.account;
    const remembered = sessionStorage.getItem(REMEMBER_KEY);
    if (remembered) {
      try { await unlockWith(parseKey(remembered), false); return; } catch { sessionStorage.removeItem(REMEMBER_KEY); }
    }
    setView('lock');
  } else {
    setView('auth');
  }
}

function setView(view) { S.view = view; S.shellBuilt = false; render(); }

function render() {
  clear($app);
  if (S.view === 'auth') renderAuth();
  else if (S.view === 'lock') renderLock();
  else if (S.view === 'reveal') renderReveal();
  else if (S.view === 'main') renderMain();
}

// ============================ 认证 ============================
let authTab = 'login';
function renderAuth() {
  clear($app); // 切换登录/注册标签时重绘，避免卡片叠加
  const wrap = h('div', { class: 'auth-wrap' });
  const card = h('div', { class: 'auth-card' });
  card.append(h('div', { class: 'auth-logo' },
    h('div', { class: 'logo-badge' }, icon('sticky_note_2')),
    h('h1', {}, S.config?.siteName || '备忘录'),
    h('p', {}, '端到端加密 · 只有你能看到自己的内容')));
  const tabs = h('div', { class: 'auth-tabs' },
    h('button', { class: authTab === 'login' ? 'active' : '', onClick: () => { authTab = 'login'; renderAuth(); } }, '登录'),
    h('button', { class: authTab === 'register' ? 'active' : '', onClick: () => { authTab = 'register'; renderAuth(); } }, '注册新账号'));
  card.append(tabs);
  const body = h('div');
  card.append(body);
  if (authTab === 'login') buildLogin(body);
  else buildRegister(body);
  card.append(h('div', { class: 'auth-note' }, icon('enhanced_encryption'),
    h('span', {}, '你的文字、图片和视频在浏览器内加密后才上传，服务器与管理员都无法查看。请务必记住你的密钥。')));
  wrap.append(card);
  $app.append(wrap);
}

function buildLogin(body) {
  clear(body);
  const acct = h('input', { class: 'tf-input mono', placeholder: ' ', inputmode: 'numeric', autocomplete: 'username', maxlength: '19' });
  const key = h('input', { class: 'tf-input mono', placeholder: ' ', type: 'password', autocomplete: 'current-password', spellcheck: 'false' });
  const remember = h('input', { type: 'checkbox' });
  acct.addEventListener('input', () => { const d = acct.value.replace(/\D/g, '').slice(0, 16); acct.value = d.replace(/(.{4})/g, '$1 ').trim(); });
  const err = h('div', { class: 'md-body-s', style: { color: 'var(--md-error)', minHeight: '18px', margin: '4px 0 8px' } });
  const btn = h('button', { class: 'btn btn-filled btn-block stateful', onClick: doLogin }, icon('login'), '登录');
  body.append(
    h('label', { class: 'tf auth-field' }, h('span', { class: 'tf-box' }, h('span', { class: 'tf-leading' }, icon('badge')), acct, h('span', { class: 'tf-label' }, '数字账号')), h('span', { class: 'tf-helper' }, '16 位数字账号')),
    h('label', { class: 'tf auth-field' }, h('span', { class: 'tf-box' }, h('span', { class: 'tf-leading' }, icon('key')), key, h('span', { class: 'tf-label' }, '密钥')), h('span', { class: 'tf-helper' }, '注册时获得的 52 位密钥')),
    h('label', { class: 'check', style: { margin: '4px 0 12px' } }, remember, h('span', { class: 'check-box' }, icon('check')), h('span', { class: 'md-body-m' }, '记住账号与密钥，下次自动登录（仅私人设备；本机使用者可读取密钥）')),
    err, btn,
  );
  async function doLogin() {
    err.textContent = '';
    const account = acct.value.replace(/\D/g, '');
    let master;
    try { master = parseKey(key.value); } catch (e) { err.textContent = e.message; return; }
    if (!/^\d{16}$/.test(account)) { err.textContent = '请输入 16 位数字账号'; return; }
    btn.disabled = true;
    try {
      const proof = (await tempProof(master));
      await POST('/api/user/login', { account, proof, captchaToken:await requestCaptcha() });
      S.account = account;
      await unlockWith(master, false);
      if (remember.checked) { try { saveLogin(); } catch { toast('浏览器不允许保存凭据', { type: 'error' }); } } else forgetLogin();
    } catch (e) { err.textContent = e.message; btn.disabled = false; }
  }
  key.addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
}

function buildRegister(body) {
  clear(body);
  if (S.config && !S.config.registrationOpen) {
    body.append(h('div', { class: 'auth-note' }, icon('block'), h('span', {}, '管理员已关闭新用户注册。')));
    return;
  }
  body.append(
    h('p', { class: 'md-body-m muted', style: { margin: '0 0 16px', lineHeight: '1.6' } },
      '注册将生成一个类似 Mullvad 的 16 位数字账号和一把随机密钥。密钥只在你手中，丢失后无法找回，也无法查看已存内容。'),
    h('div', { class: 'auth-note', style: { marginTop: '0' } }, icon('privacy_tip'), h('span', {}, '无需邮箱或手机号；启用风控时会使用 IP 和浏览器基础特征防止滥用。')),
    h('button', { class: 'btn btn-filled btn-block stateful mt-16', onClick: doRegister }, icon('person_add'), '生成我的账号'),
  );
  async function doRegister() {
    const btn = body.querySelector('button.btn-filled');
    btn.disabled = true;
    try {
      const { master, keyString } = generateKey();
      const proof = await tempProof(master);
      const r = await POST('/api/user/register', { proof, captchaToken:await requestCaptcha() });
      S.account = r.account; S.master = master; S.pendingKey = keyString;
      setView('reveal');
    } catch (e) { toast(e.message, { type: 'error' }); btn.disabled = false; }
  }
}

async function tempProof(master) {
  const c = new CryptoClient();
  try { const { proof } = await c.proof(master.buffer); return proof; } finally { c.terminate(); }
}

function renderReveal() {
  const keyString = S.pendingKey;
  const wrap = h('div', { class: 'auth-wrap' });
  const card = h('div', { class: 'auth-card' });
  card.append(h('div', { class: 'auth-logo' },
    h('div', { class: 'logo-badge', style: { background: 'var(--md-success)', color: '#fff' } }, icon('check_circle')),
    h('h1', {}, '账号已创建'), h('p', {}, '请立即保存以下信息')));
  card.append(h('div', { class: 'key-reveal' },
    h('div', { class: 'key-label' }, icon('badge', 'sm'), '数字账号'),
    h('div', { class: 'key-value', style: { fontSize: '18px', letterSpacing: '2px' } }, formatAccount(S.account)),
    h('div', { class: 'key-actions' }, h('button', { class: 'btn btn-tonal btn-sm stateful', onClick: () => copyText(S.account).then((ok) => toast(ok ? '账号已复制' : '复制失败', { type: ok ? 'success' : 'error' })) }, icon('content_copy'), '复制账号'))));
  card.append(h('div', { class: 'key-reveal' },
    h('div', { class: 'key-label' }, icon('key', 'sm'), '密钥（务必牢记，无法找回）'),
    h('div', { class: 'key-value' }, formatKey(keyString)),
    h('div', { class: 'key-actions' },
      h('button', { class: 'btn btn-tonal btn-sm stateful', onClick: () => copyText(keyString).then((ok) => toast(ok ? '密钥已复制' : '复制失败', { type: ok ? 'success' : 'error' })) }, icon('content_copy'), '复制密钥'),
      h('button', { class: 'btn btn-outlined btn-sm stateful', onClick: () => downloadBlob(new Blob([`备忘录账号: ${S.account}\n密钥: ${keyString}\n\n请妥善保管，丢失无法找回。\n`], { type: 'text/plain' }), `备忘录凭据-${S.account}.txt`) }, icon('download'), '下载凭据'))));
  const confirm = h('input', { type: 'checkbox' });
  const continueBtn = h('button', { class: 'btn btn-filled btn-block stateful', disabled: true, onClick: async () => { await unlockWith(S.master, true); } }, icon('arrow_forward'), '进入备忘录');
  confirm.addEventListener('change', () => { continueBtn.disabled = !confirm.checked; });
  card.append(h('label', { class: 'check', style: { margin: '8px 0 16px' } }, confirm, h('span', { class: 'check-box' }, icon('check')), h('span', { class: 'md-body-m' }, '我已安全保存账号和密钥')), continueBtn);
  wrap.append(card);
  $app.append(wrap);
}

// ============================ 锁屏 ============================
function renderLock() {
  const wrap = h('div', { class: 'lock-wrap' });
  const card = h('div', { class: 'auth-card', style: { maxWidth: '400px' } });
  card.append(h('div', { class: 'auth-logo' },
    h('div', { class: 'logo-badge' }, icon('lock')),
    h('h1', {}, '已锁定'), h('p', {}, formatAccount(S.account))));
  const key = h('input', { class: 'tf-input mono', placeholder: ' ', type: 'password', spellcheck: 'false' });
  const err = h('div', { class: 'md-body-s', style: { color: 'var(--md-error)', minHeight: '18px', margin: '4px 0 8px' } });
  const btn = h('button', { class: 'btn btn-filled btn-block stateful', onClick: doUnlock }, icon('lock_open'), '解锁');
  card.append(
    h('label', { class: 'tf auth-field' }, h('span', { class: 'tf-box' }, h('span', { class: 'tf-leading' }, icon('key')), key, h('span', { class: 'tf-label' }, '输入密钥解锁'))),
    err, btn,
    h('button', { class: 'btn btn-text btn-block stateful mt-8', onClick: logout }, icon('logout'), '切换账号'),
  );
  wrap.append(card);
  $app.append(wrap);
  setTimeout(() => key.focus(), 80);
  async function doUnlock() {
    err.textContent = '';
    let master;
    try { master = parseKey(key.value); } catch (e) { err.textContent = e.message; return; }
    btn.disabled = true;
    try { await unlockWith(master, true); } catch (e) { err.textContent = e.message; btn.disabled = false; }
  }
  key.addEventListener('keydown', (e) => { if (e.key === 'Enter') doUnlock(); });
}

async function unlockWith(master, verify) {
  if (verify) {
    const proof = await tempProof(master);
    await POST('/api/user/login', { account: S.account, proof, captchaToken:await requestCaptcha() });
  }
  S.master = master;
  S.crypto = new CryptoClient();
  await S.crypto.init(master.buffer, S.account);
  S.media = new MediaManager(S.crypto);
  S.organization = new Organization(S.crypto);
  const organization = S.organization;
  try { await organization.load(); } catch(e) { toast('文件夹加载失败：'+e.message,{type:'error'}); }
  if(S.organization!==organization || organization.closed)return;
  if(organization.data.order.length)S.sort='manual';
  S.lastActivity = Date.now();
  setView('main');
  syncMemos();
}

function lock() {
  if (S.view !== 'main') return;
  cleanupSession(false);
  forgetLogin();
  setView('lock');
}

async function logout() {
  try { await POST('/api/user/logout'); } catch {}
  cleanupSession(true);
  forgetLogin();
  S.account = null;
  authTab = 'login';
  setView('auth');
}

function cleanupSession(full) {
  closeOverlays();
  S.dragDispose?.(); S.dragDispose=null; S.organization?.close(); S.organization=null; S.folder='';
  S.syncing = false;
  S.syncAbort?.abort();
  S.detailAbort?.abort();
  S.virtual?.destroy(); S.virtual = null;
  S.media?.clear(); S.media = null;
  S.crypto?.terminate(); S.crypto = null;
  S.master = null; S.memos = []; S.decrypted.clear(); S.selection.clear(); S.selectMode = false;
  S.shellBuilt = false;
}

function checkAutoLock() {
  const mins = S.config?.autoLockMinutes || 0;
  if (S.view === 'main' && mins > 0 && Date.now() - S.lastActivity > mins * 60_000) {
    lock();
    toast('已自动锁定，请重新输入密钥', { type: 'info' });
  }
}

// ============================ 主界面 ============================
const NAV = [
  { id: 'memos', icon: 'sticky_note_2', label: '备忘录' },
  { id: 'settings', icon: 'settings', label: '设置' },
];

function renderMain() {
  const shell = h('div', { class: 'shell shell-user' });
  const rail = h('nav', { class: 'nav-rail' });
  rail.append(h('div', { class:'site-logo', style: { marginBottom: '8px', color: 'var(--md-primary)' } }, icon('sticky_note_2', 'lg')));
  for (const n of NAV) {
    rail.append(h('button', { class: `nav-rail-item stateful ${S.tab === n.id ? 'active' : ''}`, onClick: () => switchTab(n.id) },
      h('span', { class: 'nav-indicator' }, icon(n.icon)), h('span', {}, n.label)));
  }
  const main = h('div', { class: 'main' });
  const topbar = h('header', { class: 'top-bar' },
    h('button', { class: 'icon-btn stateful nav-toggle', title: '打开菜单', 'aria-label': '打开菜单', onClick: () => S.el.openDrawer?.() }, icon('menu')),
    h('div', { class: 'top-bar-title' }, h('span',{class:'site-logo'},icon('sticky_note_2')), h('span', {}, S.config?.siteName || '备忘录')),
    h('button', { class: 'icon-btn stateful', title: '切换主题', onClick: (e) => { toggleTheme(); } }, icon(currentTheme() === 'dark' ? 'light_mode' : 'dark_mode')),
    h('button', { class: 'icon-btn stateful', title: '账号', onClick: (e) => accountMenu(e.currentTarget) }, icon('account_circle')),
  );
  const content = h('div', { class: 'content' });
  main.append(topbar, content);
  const fab = h('button', { class: 'fab fab-main extended stateful', title: '新建备忘录', onClick: () => openEditor() }, icon('add'), h('span', {}, '新建'));
  shell.append(rail, main, fab);
  $app.append(shell);

  // 移动端侧边抽屉
  const drawerItems = [];
  const drawer = h('nav', { class: 'nav-drawer', 'aria-label': '导航' },
    h('div', { class: 'drawer-head' },
      h('div', { class: 'drawer-logo' }, icon('sticky_note_2')),
      h('div', { class: 'title' }, S.config?.siteName || '备忘录'),
      h('button', { class: 'icon-btn stateful', title: '关闭菜单', onClick: () => S.el.closeDrawer?.() }, icon('close'))),
    h('div', { class: 'drawer-section' }, formatAccount(S.account)));
  for (const n of NAV) {
    const item = h('button', { class: `nav-drawer-item stateful ${S.tab === n.id ? 'active' : ''}`, onClick: () => { switchTab(n.id); S.el.closeDrawer?.(); } }, icon(n.icon), h('span', {}, n.label));
    drawerItems.push(item); drawer.append(item);
  }
  drawer.append(h('div', { class: 'drawer-divider' }),
    h('div', { class: 'drawer-foot' },
      h('button', { class: 'nav-drawer-item stateful', onClick: () => { S.el.closeDrawer?.(); lock(); } }, icon('lock'), h('span', {}, '立即锁定')),
      h('button', { class: 'nav-drawer-item stateful', onClick: () => { toggleTheme(); } }, icon(currentTheme() === 'dark' ? 'light_mode' : 'dark_mode'), h('span', {}, '切换主题')),
      h('button', { class: 'nav-drawer-item danger stateful', onClick: () => { S.el.closeDrawer?.(); logout(); } }, icon('logout'), h('span', {}, '退出登录'))));
  const scrim = h('div', { class: 'drawer-scrim', onClick: (e) => { if (e.target === scrim) S.el.closeDrawer?.(); } }, drawer);
  $app.append(scrim);

  S.el = { content, topbar, fab, rail, drawerItems, scrim,
    openDrawer: () => scrim.classList.add('show'), closeDrawer: () => scrim.classList.remove('show') };
  S.shellBuilt = true;
  renderTab();
}

function switchTab(tab) {
  if (S.tab === tab) return;
  S.tab = tab;
  exitSelectMode();
  const idx = NAV.findIndex((n) => n.id === tab);
  [...S.el.rail.querySelectorAll('.nav-rail-item')].forEach((el, i) => el.classList.toggle('active', i === idx));
  (S.el.drawerItems || []).forEach((el, i) => el.classList.toggle('active', i === idx));
  S.el.fab.classList.toggle('hidden', tab !== 'memos');
  renderTab();
}

function renderTab() {
  S.dragDispose?.(); S.dragDispose=null;
  S.virtual?.destroy(); S.virtual = null;
  clear(S.el.content);
  if (S.tab === 'memos') renderMemos();
  else if (S.tab === 'settings') renderSettings();
}

function accountMenu(anchor) {
  openMenu(anchor, [
    { label: formatAccount(S.account), icon: 'badge', onClick: () => switchTab('settings') },
    { divider: true },
    { label: '设置', icon: 'settings', onClick: () => switchTab('settings') },
    { label: '立即锁定', icon: 'lock', onClick: lock },
    { label: '切换主题', icon: currentTheme() === 'dark' ? 'light_mode' : 'dark_mode', onClick: () => toggleTheme() },
    { divider: true },
    { label: '退出登录', icon: 'logout', danger: true, onClick: logout },
  ]);
}

// ============================ 备忘录视图 ============================
const FILTERS = [
  { id: 'all', label: '全部', icon: 'apps' },
  { id: 'text', label: '文字', icon: 'text_snippet' },
  { id: 'image', label: '图片', icon: 'image' },
  { id: 'video', label: '视频', icon: 'movie' },
  { id: 'file', label: '文件', icon: 'insert_drive_file' },
];

// 广告位（管理员可开关 / 自定义 / 接入广告网络）
function adSlot() {
  const ads = S.config?.ads;
  if (!ads || !ads.enabled) return null;
  const wrap = h('div', { class: 'ad-slot' });
  wrap.append(h('span', { class: 'ad-tag' }, '广告'));
  if (ads.mode === 'html' && ads.html) {
    const frame = h('iframe', { class: 'ad-frame', sandbox: 'allow-scripts allow-popups allow-popups-to-escape-sandbox', title: '广告' });
    frame.srcdoc = ads.html;
    wrap.append(frame);
  } else if (ads.items && ads.items.length) {
    const row = h('div', { class: 'ad-row' });
    for (const it of ads.items.slice(0, 4)) {
      const card = h('a', { class: 'ad-card stateful', href: it.url || '#', target: '_blank', rel: 'noopener noreferrer' },
        it.image ? h('img', { src: it.image, alt: it.title, loading: 'lazy' }) : null,
        h('span', { class: 'ad-title' }, it.title));
      row.append(card);
    }
    wrap.append(row);
  } else return null;
  return wrap;
}

function organizationToolbar() {
  const org=S.organization;
  return h('div',{class:'row wrap gap-8',style:{padding:'8px 16px'}},
    h('button',{class:'btn btn-text btn-sm',onClick:()=>{S.folder='';S.selection.clear();renderMemos();}},'全部文件'),
    S.folder ? h('span',{style:{minWidth:0,overflowWrap:'anywhere'}},org.data.folders.find(f=>f.id===S.folder)?.name || '文件夹') : null,
    h('button',{class:'btn btn-tonal btn-sm',disabled:!org.ready,onClick:()=>editFolder()},'新建文件夹'),
    h('span',{class:'muted md-body-s'},org.ready?'按住拖动柄排序；箭头键也可调整位置。文件夹名称与排序已加密。':'文件夹未加载，刷新后重试'));
}
async function changeOrganization(fn) {
  const org=S.organization;
  try {await org.change(fn);if(org===S.organization&&S.view==='main')refreshList();}
  catch(e){toast(e.message,{type:'error'});}
}
function editFolder(folder) {
  const input=h('input',{class:'tf-input',value:folder?.name||'',maxLength:80,placeholder:'输入文件夹名称','aria-label':'文件夹名称'});
  openDialog({title:folder?'重命名文件夹':'新建文件夹',content:input,actions:[{label:'取消',variant:'text'},{label:'保存',variant:'filled',keepOpen:true,onClick:async close=>{
    const name=input.value.trim();if(!name){toast('请输入文件夹名称');return false;}
    const org=S.organization;
    try{await org.change(d=>{if(folder){const f=d.folders.find(x=>x.id===folder.id);if(!f)throw new Error('文件夹不存在');f.name=name;}else d.folders.push({id:crypto.randomUUID(),name});});if(org===S.organization)refreshList();close();}catch(e){toast(e.message,{type:'error'});return false;}
  }}]});
}
function renderFolder(folder,grid) {
  const item=h('div',{class:grid?'memo-cell':'memo-item',onClick:()=>{S.folder=folder.id;S.selection.clear();renderMemos();}},
    h('div',{class:grid?'cell-media':'memo-type'},icon('folder','lg')),h('div',{class:grid?'cell-info':'memo-body'},h('div',{class:'memo-title'},folder.name),h('div',{class:'memo-sub'},'文件夹')));
  decorateOrganization(item,folder);return item;
}
function decorateOrganization(item,memo) {
  if(!S.organization?.ready||S.selectMode)return;
  const key=(memo._folder?'f:':'m:')+memo.id;item.dataset.orderKey=key;
  const handle=h('button',{class:'icon-btn org-drag',title:'按住拖动排序（或方向键）','aria-label':'拖动排序',onClick:e=>e.stopPropagation(),onKeydown:e=>{
    if(!['ArrowUp','ArrowDown'].includes(e.key))return;e.preventDefault();e.stopPropagation();
    const keys=getVisibleItems().map(m=>(m._folder?'f:':'m:')+m.id),i=keys.indexOf(key),j=i+(e.key==='ArrowUp'?-1:1);
    if(j>=0&&j<keys.length)reorderOrganization(key,keys[j],e.key==='ArrowDown');
  }},icon('drag_indicator'));
  const menu=h('button',{class:'icon-btn',title:'整理','aria-label':'整理',onClick:e=>{e.stopPropagation();
    const entries=memo._folder ? [
      {label:'重命名文件夹',onClick:()=>editFolder(memo)},
      {label:'删除文件夹（保留内容）',danger:true,onClick:async()=>{if(await confirmDialog({title:'删除文件夹？',message:'里面的备忘录会移回全部文件，不会删除内容。',confirmLabel:'删除'}))changeOrganization(d=>{d.folders=d.folders.filter(f=>f.id!==memo.id);for(const [id,folder] of Object.entries(d.locations))if(folder===memo.id)delete d.locations[id];d.order=d.order.filter(k=>k!==key);});}}
    ] : [{label:'移到全部文件',onClick:()=>changeOrganization(d=>{delete d.locations[memo.id];})},...S.organization.data.folders.map(f=>({label:'移到 '+f.name,onClick:()=>changeOrganization(d=>{d.locations[memo.id]=f.id;})}))];
    openMenu(e.currentTarget,entries);
  }},icon('more_vert'));
  item.append(h('div',{class:'org-controls'},handle,menu));
}
async function reorderOrganization(from,to,after=false) {
  const organization=S.organization;
  const visible=getVisibleItems().map(m=>(m._folder?'f:':'m:')+m.id);
  const positions=new Map([...S.el.scroll.querySelectorAll('[data-order-key]')].map(el=>[el.dataset.orderKey,el.getBoundingClientRect()]));
  S.sort='manual';
  await changeOrganization(d=>{
    const shown=new Set(visible);
    const keys=[...d.order.filter(k=>!shown.has(k)),...visible].filter(k=>k!==from);
    let at=keys.indexOf(to);if(at<0)return;if(after)at++;keys.splice(at,0,from);d.order=keys;
  });
  if(S.organization!==organization||S.view!=='main'||matchMedia('(prefers-reduced-motion: reduce)').matches)return;
  requestAnimationFrame(()=>{for(const el of S.el.scroll?.querySelectorAll('[data-order-key]')||[]){const old=positions.get(el.dataset.orderKey);if(!old)continue;const now=el.getBoundingClientRect();el.animate?.([{transform:`translate(${old.x-now.x}px,${old.y-now.y}px)`},{transform:'none'}],{duration:200,easing:'cubic-bezier(.2,.8,.2,1)'});}});
}

function renderMemos() {
  S.dragDispose?.(); S.dragDispose=null;
  S.virtual?.destroy(); S.virtual = null;
  const c = S.el.content;
  clear(c);
  c.classList.add('view-enter');
  // 搜索栏
  const searchInput = h('input', { placeholder: '搜索备忘录…', value: S.search });
  const searchClear = h('button', { class: 'icon-btn stateful', style: { width: '32px', height: '32px' }, onClick: () => { searchInput.value = ''; S.search = ''; refreshList(); } }, icon('close', 'sm'));
  searchInput.addEventListener('input', debounce(() => { S.search = searchInput.value.trim(); refreshList(); }, 200));
  const searchBar = h('div', { class: 'search-bar', style: { margin: '8px 16px 0' } }, icon('search'), searchInput, searchClear);
  // 工具栏
  const chipRow = h('div', { class: 'chip-row' });
  for (const f of FILTERS) {
    chipRow.append(h('button', { class: `chip stateful ${S.filter === f.id && !S.pinnedOnly ? 'selected' : ''}`, onClick: () => { S.filter = f.id; S.pinnedOnly = false; renderMemos(); } }, icon(f.icon), f.label));
  }
  chipRow.append(h('button', { class: `chip stateful ${S.pinnedOnly ? 'selected' : ''}`, onClick: () => { S.pinnedOnly = !S.pinnedOnly; renderMemos(); } }, icon('push_pin'), '置顶'));
  const sortBtn = h('button', { class: 'icon-btn stateful', title: '排序', onClick: (e) => openMenu(e.currentTarget, [
    { label:'手动排序',icon:'drag_indicator',selected:S.sort==='manual',onClick:()=>{S.sort='manual';refreshList();} },
    { label: '最新优先', icon: 'schedule', selected: S.sort === 'newest', onClick: () => { S.sort = 'newest'; refreshList(); } },
    { label: '最早优先', icon: 'history', selected: S.sort === 'oldest', onClick: () => { S.sort = 'oldest'; refreshList(); } },
    { label: '标题 A→Z', icon: 'sort', selected: S.sort === 'title', onClick: () => { S.sort = 'title'; refreshList(); } },
  ]) }, icon('sort'));
  const viewBtn = h('button', { class: 'icon-btn stateful', title: '切换视图', onClick: () => { S.viewMode = S.viewMode === 'list' ? 'grid' : 'list'; localStorage.setItem('memo-view', S.viewMode); renderMemos(); } }, icon(S.viewMode === 'list' ? 'grid_view' : 'view_list'));
  const selectBtn = h('button', { class: 'icon-btn stateful', title: '批量管理', onClick: () => enterSelectMode() }, icon('checklist'));
  const count = h('span', { class: 'memo-count' });
  const toolbar = h('div', { class: 'memo-toolbar' }, chipRow, count, sortBtn, viewBtn, selectBtn);
  // 选择条
  const selBar = h('div', { class: 'selection-bar hidden' });
  // 存储未就绪提示
  let banner = null;
  if (S.config && !S.config.storageReady) {
    banner = h('div', { class: 'auth-note', style: { margin: '8px 16px 0' } }, icon('cloud_off'), h('span', {}, '管理员尚未配置存储机器人，暂时无法保存新内容，但你仍可浏览已有备忘录。'));
  }
  // 列表
  const scroll = h('div', { class: 'memo-scroll' });
  const empty = h('div', { class: 'empty-state hidden' }, icon('sticky_note_2'), h('h3', {}, '还没有备忘录'), h('p', {}, '点击右下角「新建」按钮，保存你的第一条加密备忘录。'));
  const syncStatus = h('div', { class: 'memo-count', style: { padding: '6px 16px', textAlign: 'center' } });
  const ad = adSlot();
  c.append(...[S.organization ? organizationToolbar() : null, searchBar, toolbar, selBar, banner, ad, scroll, empty, syncStatus].filter(Boolean));
  S.el = { ...S.el, scroll, empty, count, selBar, syncStatus, searchInput };

  const columns = S.viewMode === 'grid' ? gridColumns(scroll.clientWidth) : 1;
  S.virtual = new VirtualView(scroll, {
    rowHeight: S.viewMode === 'grid' ? 190 : 84,
    columns,
    renderRow: (items, startIdx) => S.viewMode === 'grid' ? renderGridRow(items, startIdx) : renderListItem(items[0], startIdx),
  });
  if(S.organization?.ready)S.dragDispose=installOrganizationDrag(scroll,reorderOrganization);
  refreshList();
}

function gridColumns(width) { return Math.max(2, Math.min(8, Math.floor((width || 360) / 170))); }

function getVisibleItems() {
  const org=S.organization?.data;
  let items = S.memos;
  if(org)items=items.filter(m=>(org.locations[m.id]||'')===(S.folder||''));
  if (S.filter !== 'all') items = items.filter((m) => m.type === S.filter);
  if (S.pinnedOnly) items = items.filter((m) => m.pinned);
  if (S.search) {
    const q = S.search.toLowerCase();
    items = items.filter((m) => {
      const d = S.decrypted.get(m.id);
      return d && ((d.title || '').toLowerCase().includes(q) || (d.preview || '').toLowerCase().includes(q));
    });
  }
  const arr = [...items];
  if(org && !S.folder && S.filter==='all' && !S.pinnedOnly && !S.selectMode)arr.unshift(...org.folders.filter(f=>!S.search||f.name.toLowerCase().includes(S.search.toLowerCase())).map(f=>({...f,_folder:true,createdAt:0,pinned:false})));
  const ranks=new Map((org?.order||[]).map((key,i)=>[key,i]));
  arr.sort((a, b) => {
    if(S.sort==='manual')return (ranks.get((a._folder?'f:':'m:')+a.id)??1e9)-(ranks.get((b._folder?'f:':'m:')+b.id)??1e9);
    if(!!a._folder!==!!b._folder)return a._folder?-1:1;
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    if (S.sort === 'oldest') return a.createdAt - b.createdAt;
    if (S.sort === 'title') {
      const ta = (a._folder ? a.name : S.decrypted.get(a.id)?.title || '').toLowerCase();
      const tb = (b._folder ? b.name : S.decrypted.get(b.id)?.title || '').toLowerCase();
      return ta.localeCompare(tb);
    }
    return b.createdAt - a.createdAt;
  });
  return arr;
}

function refreshList() {
  if (!S.virtual) return;
  const items = getVisibleItems();
  if (S.viewMode === 'grid') S.virtual.setColumns(gridColumns(S.el.scroll.clientWidth));
  S.virtual.setItems(items, { keepScroll: true });
  S.el.count.textContent = `${items.length} 条`;
  S.el.empty.classList.toggle('hidden', items.length > 0 || S.syncing);
  if (S.syncing) S.el.syncStatus.textContent = `正在同步并解密索引… 已加载 ${S.memos.length} 条`;
  else S.el.syncStatus.textContent = '';
  updateSelBar();
}
const throttledRefresh = (() => { let t = null; return () => { if (t) return; t = setTimeout(() => { t = null; refreshList(); }, 400); }; })();

async function syncMemos() {
  if (S.syncing || !S.crypto) return;
  S.syncing = true;
  S.memos = []; S.decrypted.clear(); S.nextCursor = null;
  const controller = S.syncAbort = new AbortController();
  const cryptoClient = S.crypto;
  refreshList();
  try {
    let guard = 0;
    do {
      const params = new URLSearchParams({ limit: '200' });
      if (S.nextCursor) params.set('cursor', S.nextCursor);
      const r = await GET('/api/user/memos?' + params.toString(), { signal: controller.signal });
      controller.signal.throwIfAborted();
      if (S.crypto !== cryptoClient) return;
      S.stats = r.stats;
      S.memos.push(...r.items);
      S.nextCursor = r.nextCursor;
      const { items: dec } = await cryptoClient.decryptMetaBatch(r.items.map((m) => ({ id: m.id, meta: m.meta })));
      controller.signal.throwIfAborted();
      for (const d of dec) if (d.obj) S.decrypted.set(d.id, d.obj);
      throttledRefresh();
      guard++;
    } while (S.nextCursor && guard < 5000 && !S.syncAbort.signal.aborted && S.crypto);
  } catch (e) {
    if (e.name !== 'AbortError' && S.crypto) toast('同步失败: ' + e.message, { type: 'error' });
  } finally {
    if (S.syncAbort === controller) { S.syncing = false; if (S.virtual) refreshList(); }
  }
}

function typeIconEl(memo, size = '') {
  const tm = TYPE_META[memo.type] || TYPE_META.file;
  return icon(tm.icon, size);
}

function renderListItem(memo) {
  if (!memo) return h('div');
  if(memo._folder)return renderFolder(memo,false);
  const d = S.decrypted.get(memo.id);
  const title = d?.title || (memo.type === 'text' ? '文字备忘录' : '未命名');
  const preview = d?.preview || '';
  const selected = S.selection.has(memo.id);
  const thumbWrap = h('div', { class: 'memo-type' });
  if ((memo.type === 'image' || memo.type === 'video') && memo.thumb) {
    const img = h('img', { alt: '', loading: 'lazy' });
    thumbWrap.append(img);
    loadThumb(memo, img);
    if (memo.type === 'video') thumbWrap.append(h('span', { style: { position: 'absolute', color: '#fff' } }, icon('play_arrow', 'sm')));
  } else {
    thumbWrap.append(typeIconEl(memo));
  }
  const check = h('label', { class: 'check memo-check', style: { display: S.selectMode ? 'flex' : 'none' }, onClick: (e) => e.stopPropagation() },
    h('input', { type: 'checkbox', checked: selected, onChange: () => toggleSelect(memo.id) }), h('span', { class: 'check-box' }, icon('check')));
  const item = h('div', { class: `memo-item stateful ${selected ? 'selected' : ''}`, onClick: () => S.selectMode ? toggleSelect(memo.id) : openDetail(memo) },
    check, thumbWrap,
    h('div', { class: 'memo-body' },
      h('div', { class: 'memo-title' }, memo.pinned ? icon('push_pin', 'pin') : null, h('span', { class: 'truncate' }, title)),
      preview ? h('div', { class: 'memo-preview' }, preview) : null,
      h('div', { class: 'memo-sub' }, h('span', {}, formatRelative(memo.createdAt)), h('span', {}, '·'), h('span', {}, formatBytes(memo.size)), h('span', {}, '·'), h('span', {}, TYPE_META[memo.type]?.label || '文件'))),
    h('div', { class: 'memo-end' }, icon('chevron_right')),
  );
  decorateOrganization(item,memo);
  return item;
}

function renderGridRow(items, startIdx) {
  const cols = S.virtual?.columns || gridColumns(S.el.scroll.clientWidth);
  const row = h('div', { class: 'memo-grid-row', style: { gridTemplateColumns: `repeat(${cols}, 1fr)` } });
  for (const memo of items) row.append(renderGridCell(memo));
  return row;
}

function renderGridCell(memo) {
  if(memo._folder)return renderFolder(memo,true);
  const d = S.decrypted.get(memo.id);
  const title = d?.title || (memo.type === 'text' ? '文字备忘录' : '未命名');
  const selected = S.selection.has(memo.id);
  const media = h('div', { class: 'cell-media' });
  if ((memo.type === 'image' || memo.type === 'video') && memo.thumb) {
    const img = h('img', { alt: '', loading: 'lazy' });
    media.append(img);
    loadThumb(memo, img);
  } else if (memo.type === 'text') {
    media.append(h('div', { style: { padding: '12px', fontSize: '12px', color: 'var(--md-on-surface-variant)', lineHeight: '1.5', overflow: 'hidden', width: '100%', height: '100%' } }, d?.preview || ''));
  } else {
    media.append(typeIconEl(memo, 'lg'));
  }
  const cell = h('div', { class: `memo-cell stateful ${selected ? 'selected' : ''}`, onClick: () => S.selectMode ? toggleSelect(memo.id) : openDetail(memo) },
    media,
    h('div', { class: 'cell-info' }, h('div', { class: 'cell-title' }, title), h('div', { class: 'cell-sub' }, formatRelative(memo.createdAt))),
    h('div', { class: 'cell-badge' }, icon(TYPE_META[memo.type]?.icon || 'insert_drive_file', 'sm')),
    memo.pinned ? h('span', { class: 'cell-pin' }, icon('push_pin', 'sm')) : null,
    S.selectMode ? h('label', { class: 'check cell-check', onClick: (e) => e.stopPropagation() }, h('input', { type: 'checkbox', checked: selected, onChange: () => toggleSelect(memo.id) }), h('span', { class: 'check-box' }, icon('check'))) : null,
  );
  decorateOrganization(cell,memo);
  return cell;
}

function loadThumb(memo, img) {
  S.media.thumbUrl(memo).then((url) => { if (img.isConnected) img.src = url; }).catch(() => {
    if (img.isConnected) { img.replaceWith(icon('broken_image')); }
  });
}

// ---- 选择模式 ----
function enterSelectMode() { S.selectMode = true; refreshList(); }
function exitSelectMode() { S.selectMode = false; S.selection.clear(); if (S.virtual) refreshList(); }
function toggleSelect(id) { if (S.selection.has(id)) S.selection.delete(id); else S.selection.add(id); refreshList(); }
function updateSelBar() {
  const bar = S.el.selBar;
  if (!bar) return;
  if (!S.selectMode) { bar.classList.add('hidden'); return; }
  bar.classList.remove('hidden');
  clear(bar);
  bar.append(
    h('button', { class: 'icon-btn stateful', onClick: exitSelectMode }, icon('close')),
    h('span', { class: 'count' }, `已选 ${S.selection.size} 项`),
    h('button', { class: 'btn btn-text btn-sm stateful', onClick: () => { const all = getVisibleItems().filter(m=>!m._folder); if (S.selection.size === all.length) S.selection.clear(); else all.forEach((m) => S.selection.add(m.id)); refreshList(); } }, icon('select_all'), '全选'),
    h('button', { class: 'icon-btn stateful', title: '置顶/取消', onClick: batchPin }, icon('push_pin')),
    h('button', { class: 'icon-btn stateful danger', title: '删除', onClick: batchDelete }, icon('delete')),
  );
}
async function batchPin() {
  if (!S.selection.size) return;
  const ids = [...S.selection];
  const anyUnpinned = ids.some((id) => !S.memos.find((m) => m.id === id)?.pinned);
  try {
    for (let i = 0; i < ids.length; i += 1000) await POST('/api/user/memos/batch-pin', { ids: ids.slice(i, i + 1000), pinned: anyUnpinned });
    ids.forEach((id) => { const m = S.memos.find((x) => x.id === id); if (m) m.pinned = anyUnpinned; });
    toast(anyUnpinned ? '已置顶' : '已取消置顶', { type: 'success' });
    exitSelectMode();
  } catch (e) { toast(e.message, { type: 'error' }); syncMemos(); }
}
async function batchDelete() {
  if (!S.selection.size) return;
  const ok = await confirmDialog({ title: '删除备忘录', message: `确定删除选中的 ${S.selection.size} 条备忘录吗？此操作不可恢复。`, confirmLabel: '删除', danger: true, icon: 'delete' });
  if (!ok) return;
  try {
    const ids = [...S.selection];
    for (let i = 0; i < ids.length; i += 1000) await POST('/api/user/memos/batch-delete', { ids: ids.slice(i, i + 1000) });
    const set = S.selection;
    S.memos = S.memos.filter((m) => !set.has(m.id));
    set.forEach((id) => { S.decrypted.delete(id); S.media.release(id); });
    toast('已删除', { type: 'success' });
    exitSelectMode();
  } catch (e) { toast(e.message, { type: 'error' }); syncMemos(); }
}

// ============================ 详情 ============================
async function openDetail(memo) {
  S.dragDispose?.(); S.dragDispose=null;
  S.detailAbort?.abort();
  S.detailAbort = new AbortController();
  const signal = S.detailAbort.signal;
  const d = S.decrypted.get(memo.id) || {};
  const c = S.el.content;
  clear(c);
  S.virtual?.destroy(); S.virtual = null;
  const tm = TYPE_META[memo.type] || TYPE_META.file;
  const head = h('div', { class: 'detail-head' },
    h('button', { class: 'icon-btn stateful', title: '返回', 'aria-label': '返回', onClick: closeDetail }, icon('arrow_back')),
    h('span', { class: 'md-title-m flex-1 truncate' }, d.title || tm.label),
    h('button', { class: 'icon-btn stateful', title: memo.pinned ? '取消置顶' : '置顶', onClick: () => togglePin(memo) }, icon('push_pin')),
    h('button', { class: 'icon-btn stateful', title: '更多', onClick: (e) => openMenu(e.currentTarget, [
      { label: '下载', icon: 'download', onClick: () => downloadMemo(memo, d) },
      ...(memo.type === 'text' ? [{ label: '编辑', icon: 'edit', onClick: () => editTextMemo(memo, d) }] : []),
      { label: memo.pinned ? '取消置顶' : '置顶', icon: 'push_pin', onClick: () => togglePin(memo) },
      { divider: true },
      { label: '删除', icon: 'delete', danger: true, onClick: () => deleteMemo(memo) },
    ]) }, icon('more_vert')),
  );
  const body = h('div', { class: 'detail-body' });
  body.append(h('div', { class: 'detail-title-row' }, h('div', { class: 'detail-title' }, d.title || tm.label)),
    h('div', { class: 'detail-meta' },
      h('span', {}, icon(tm.icon, 'sm'), tm.label),
      h('span', {}, icon('schedule', 'sm'), formatDate(memo.createdAt)),
      h('span', {}, icon('storage', 'sm'), formatBytes(memo.size))));
  const contentArea = h('div');
  body.append(contentArea);
  const actions = h('div', { class: 'detail-actions' });
  body.append(actions);
  c.append(head, body);
  c.classList.add('view-enter');

  const loading = h('div', { class: 'detail-loading' }, h('svg', { class: 'progress-circular', viewBox: '0 0 50 50' }, h('circle', { cx: '25', cy: '25', r: '20' })), h('span', {}, '正在解密…'));
  contentArea.append(loading);

  try {
    if (memo.type === 'text') {
      const text = await S.media.text(memo, { signal });
      loading.remove();
      contentArea.append(h('div', { class: 'detail-text' }, text));
      actions.append(
        h('button', { class: 'btn btn-tonal stateful', onClick: () => copyText(text).then((ok) => toast(ok ? '已复制' : '复制失败', { type: ok ? 'success' : 'error' })) }, icon('content_copy'), '复制'),
        h('button', { class: 'btn btn-outlined stateful', onClick: () => editTextMemo(memo, d, text) }, icon('edit'), '编辑'),
        h('button', { class: 'btn btn-outlined stateful', onClick: () => downloadBlob(new Blob([text], { type: 'text/plain' }), (d.title || '备忘录') + '.txt') }, icon('download'), '下载'),
      );
    } else if (memo.type === 'image') {
      const { url } = await S.media.content(memo, d.mime || 'image/jpeg', { signal });
      loading.remove();
      const img = h('img', { src: url, alt: d.title || '', style: { cursor: 'zoom-in' }, onClick: () => openLightbox(url, d.title) });
      contentArea.append(h('div', { class: 'detail-media' }, img));
      actions.append(h('button', { class: 'btn btn-tonal stateful', onClick: () => downloadMemo(memo, d) }, icon('download'), '下载原图'));
    } else if (memo.type === 'video') {
      const { url } = await S.media.content(memo, d.mime || 'video/mp4', { signal, onProgress: (p) => { loading.querySelector('span').textContent = `正在解密… ${Math.round(p * 100)}%`; } });
      loading.remove();
      contentArea.append(h('div', { class: 'detail-media' }, h('video', { src: url, controls: true, playsinline: true, preload: 'metadata' })));
      actions.append(h('button', { class: 'btn btn-tonal stateful', onClick: () => downloadMemo(memo, d) }, icon('download'), '下载视频'));
    } else {
      loading.remove();
      contentArea.append(h('div', { class: 'detail-media', style: { flexDirection: 'column', gap: '12px', padding: '40px' } },
        icon(tm.icon, 'xl'), h('div', { class: 'md-title-m' }, d.title || '文件'), h('div', { class: 'muted md-body-m' }, formatBytes(memo.size))));
      actions.append(h('button', { class: 'btn btn-filled stateful', onClick: () => downloadMemo(memo, d) }, icon('download'), '下载文件'));
    }
  } catch (e) {
    if (e.name === 'AbortError') return;
    loading.remove();
    contentArea.append(h('div', { class: 'empty-state' }, icon('error'), h('h3', {}, '解密失败'), h('p', {}, e.message)));
  }

  function closeDetail() { S.detailAbort?.abort(); renderTab(); }
  async function togglePin(m) {
    try { const r = await PATCH(`/api/user/memos/${m.id}`, { pinned: !m.pinned }); m.pinned = r.memo.pinned; toast(m.pinned ? '已置顶' : '已取消置顶', { type: 'success' }); openDetail(m); }
    catch (e) { toast(e.message, { type: 'error' }); }
  }
  async function deleteMemo(m) {
    const ok = await confirmDialog({ title: '删除备忘录', message: '确定删除这条备忘录吗？此操作不可恢复。', confirmLabel: '删除', danger: true, icon: 'delete' });
    if (!ok) return;
    try { await DEL(`/api/user/memos/${m.id}`); S.memos = S.memos.filter((x) => x.id !== m.id); S.decrypted.delete(m.id); S.media.release(m.id); toast('已删除', { type: 'success' }); renderTab(); }
    catch (e) { toast(e.message, { type: 'error' }); }
  }
}

async function downloadMemo(memo, d) {
  try {
    toast('正在解密并准备下载…');
    const { blob } = await S.media.content(memo, d.mime);
    downloadBlob(blob, d.title || `备忘录-${memo.id}`);
  } catch (e) { toast(e.message, { type: 'error' }); }
}

function openLightbox(url, title) {
  const box = h('div', { class: 'lightbox' },
    h('img', { src: url, alt: title || '' }),
    h('div', { class: 'lightbox-bar' },
      h('button', { class: 'icon-btn stateful', onClick: async () => { try { downloadBlob(await (await fetch(url)).blob(), title || 'image'); } catch (e) { toast(e.message, { type: 'error' }); } } }, icon('download')),
      h('button', { class: 'icon-btn stateful', onClick: close }, icon('close'))));
  const unregister = registerOverlay(() => close(true));
  function close(immediate = false) { unregister(); box.classList.remove('show'); if (immediate === true) box.remove(); else setTimeout(() => box.remove(), 300); document.removeEventListener('keydown', onKey); }
  function onKey(e) { if (e.key === 'Escape') close(); }
  box.addEventListener('click', (e) => { if (e.target === box) close(); });
  document.addEventListener('keydown', onKey);
  document.body.append(box);
  requestAnimationFrame(() => box.classList.add('show'));
}

// ============================ 编辑器 ============================
function openEditor() {
  if (S.config && !S.config.storageReady) { toast('管理员尚未配置存储机器人，无法保存', { type: 'error' }); return; }
  let mode = 'text';
  const tabs = h('div', { class: 'auth-tabs', style: { marginBottom: '20px' } });
  const body = h('div');
  const dlg = openDialog({ title: '新建备忘录', titleIcon: 'note_add', wide: true, fullMobile: true, content: h('div', {}, tabs, body), dismissable: true });
  function setMode(m) { mode = m; clear(tabs); tabs.append(
    h('button', { class: m === 'text' ? 'active' : '', onClick: () => setMode('text') }, '文字'),
    h('button', { class: m === 'files' ? 'active' : '', onClick: () => setMode('files') }, '图片 / 视频 / 文件'));
    buildMode(); }
  function buildMode() { clear(body); if (mode === 'text') buildTextEditor(body, dlg); else buildFileEditor(body, dlg); }
  setMode('text');
}

function buildTextEditor(body, dlg) {
  const title = h('input', { class: 'tf-input', placeholder: ' ', maxlength: '120' });
  const text = h('textarea', { class: 'tf-input', placeholder: ' ', rows: '8', style: { minHeight: '180px' } });
  const err = h('div', { class: 'md-body-s', style: { color: 'var(--md-error)', minHeight: '18px' } });
  const save = h('button', { class: 'btn btn-filled stateful', onClick: doSave }, icon('save'), '保存');
  body.append(
    h('label', { class: 'tf editor-field' }, h('span', { class: 'tf-box' }, title, h('span', { class: 'tf-label' }, '标题（可选）'))),
    h('label', { class: 'tf editor-field' }, h('span', { class: 'tf-box', style: { alignItems: 'flex-start' } }, text, h('span', { class: 'tf-label' }, '写点什么…'))),
    err, h('div', { class: 'row end gap-8' }, h('button', { class: 'btn btn-text stateful', onClick: () => dlg.close() }, '取消'), save));
  setTimeout(() => text.focus(), 80);
  async function doSave() {
    const content = text.value;
    if (!content.trim()) { err.textContent = '内容不能为空'; return; }
    const bytes = new TextEncoder().encode(content);
    if (bytes.length > S.config.maxFileSize) { err.textContent = '内容过大'; return; }
    save.disabled = true; save.textContent = '保存中…';
    try {
      const t = title.value.trim() || content.split('\n')[0].slice(0, 40) || '文字备忘录';
      const memo = await uploadBlob({ type: 'text', bytes: bytes.buffer, mime: 'text/plain', metaObj: { title: t, preview: content.slice(0, 120) } });
      await addMemoLocal(memo);
      toast('已保存', { type: 'success' });
      dlg.close();
    } catch (e) { err.textContent = e.message; save.disabled = false; clear(save); save.append(icon('save'), '保存'); }
  }
}

function buildFileEditor(body, dlg) {
  const queue = [];
  const list = h('div', { class: 'upload-list' });
  const input = h('input', { type: 'file', multiple: true, style: { display: 'none' } });
  const drop = h('div', { class: 'editor-drop', onClick: () => input.click() },
    icon('cloud_upload'), h('div', { class: 'md-title-m' }, '点击选择或拖拽文件到此处'),
    h('div', { class: 'md-body-s muted mt-8' }, `支持图片、视频及任意文件 · 单个不超过 ${formatBytes(S.config.maxFileSize)} · 可多选`));
  const err = h('div', { class: 'md-body-s', style: { color: 'var(--md-error)', minHeight: '18px', marginTop: '8px' } });
  const save = h('button', { class: 'btn btn-filled stateful', disabled: true, onClick: doSave }, icon('cloud_upload'), '加密并保存');
  drop.append(input);
  body.append(drop, list, err, h('div', { class: 'row end gap-8 mt-16' }, h('button', { class: 'btn btn-text stateful', onClick: () => dlg.close() }, '取消'), save));
  ['dragover', 'dragenter'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('dragover'); }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('dragover'); }));
  drop.addEventListener('drop', (e) => addFiles(e.dataTransfer.files));
  input.addEventListener('change', () => { addFiles(input.files); input.value = ''; });
  const onPaste = (e) => { const files = [...(e.clipboardData?.files || [])]; if (files.length) { e.preventDefault(); addFiles(files); } };
  document.addEventListener('paste', onPaste);
  const origClose = dlg.close;
  dlg.close = () => { document.removeEventListener('paste', onPaste); origClose(); };

  function addFiles(files) {
    for (const f of files) {
      if (f.size > S.config.maxFileSize) { err.textContent = `「${f.name}」超过大小限制`; continue; }
      const type = f.type.startsWith('image/') ? 'image' : f.type.startsWith('video/') ? 'video' : 'file';
      const item = { file: f, type, status: 'ready', progress: 0 };
      queue.push(item);
      renderItem(item);
    }
    save.disabled = queue.length === 0;
  }
  function renderItem(item) {
    const bar = h('div', { class: 'progress-linear' }, h('span', { style: { transform: 'scaleX(0)' } }));
    const status = h('span', { class: 'u-size' }, formatBytes(item.file.size));
    const row = h('div', { class: 'upload-item' }, icon(TYPE_META[item.type].icon),
      h('span', { class: 'u-name' }, item.file.name), status, bar,
      h('button', { class: 'icon-btn stateful', style: { width: '32px', height: '32px' }, onClick: () => { const i = queue.indexOf(item); if (i >= 0) queue.splice(i, 1); row.remove(); save.disabled = queue.length === 0; } }, icon('close', 'sm')));
    item._bar = bar; item._status = status; item._row = row;
    list.append(row);
  }
  async function doSave() {
    save.disabled = true;
    let okCount = 0;
    for (const item of queue) {
      if (item.status === 'done') continue;
      try {
        item._status.textContent = '加密中…';
        const bytes = await item.file.arrayBuffer();
        let thumbBlob = null, w = 0, hgt = 0, dur = 0;
        if (item.type === 'image') { const t = await makeImageThumb(item.file); if (t) { thumbBlob = t.blob; w = t.w; hgt = t.h; } }
        else if (item.type === 'video') { const t = await makeVideoThumb(item.file); if (t) { thumbBlob = t.blob; w = t.w; hgt = t.h; dur = t.dur; } }
        const metaObj = { title: item.file.name, preview: '', mime: item.file.type || 'application/octet-stream', w, h: hgt, dur };
        const memo = await uploadBlob({
          type: item.type, bytes, mime: metaObj.mime, metaObj, thumbBlob,
          onProgress: (p) => { item._bar.firstChild.style.transform = `scaleX(${p})`; item._status.textContent = `${Math.round(p * 100)}%`; },
        });
        await addMemoLocal(memo);
        item.status = 'done'; item._bar.firstChild.style.transform = 'scaleX(1)'; item._status.textContent = '已保存';
        item._row.querySelector('.icon-btn').remove();
        okCount++;
      } catch (e) {
        item._status.textContent = '失败'; item._status.style.color = 'var(--md-error)';
        err.textContent = `「${item.file.name}」: ${e.message}`;
      }
    }
    if (okCount) { toast(`已保存 ${okCount} 个文件`, { type: 'success' }); }
    if (queue.every((i) => i.status === 'done')) dlg.close();
    else save.disabled = false;
  }
}

async function uploadBlob({ type, bytes, mime, metaObj, thumbBlob, onProgress }) {
  const meta = (await S.crypto.encryptMeta(metaObj)).meta;
  const size = bytes.byteLength;
  const parts = Math.max(1, Math.ceil(size / S.config.chunkSize));
  const destinationFolder = S.folder, organization = S.organization;
  const created = await POST('/api/user/memos', { type, size, meta, parts });
  const id = created.id;
  const { parts: cipherParts } = await S.crypto.encryptBytes(bytes, S.config.chunkSize);
  const totalSteps = cipherParts.length + (thumbBlob ? 1 : 0);
  for (let i = 0; i < cipherParts.length; i++) {
    await PUT(`/api/user/memos/${id}/parts/${i}`, cipherParts[i]);
    onProgress?.((i + 1) / totalSteps);
  }
  if (thumbBlob) {
    const tb = await thumbBlob.arrayBuffer();
    const { parts: [tc] } = await S.crypto.encryptBytes(tb, tb.byteLength || 1);
    await PUT(`/api/user/memos/${id}/thumb`, tc);
    onProgress?.(1);
  }
  const done = await POST(`/api/user/memos/${id}/complete`);
  if(destinationFolder && organization===S.organization && organization?.ready) { try { await organization.change(d=>{if(d.folders.some(f=>f.id===destinationFolder))d.locations[id]=destinationFolder;}); } catch(e) {toast('内容已保存，但移动到文件夹失败：'+e.message,{type:'error'});} }
  return done.memo;
}

// 增量更新本地索引，避免每次保存都全量重拉
async function addMemoLocal(memo) {
  if (!memo) return;
  S.memos = S.memos.filter((m) => m.id !== memo.id);
  S.memos.unshift(memo);
  try { const { obj } = await S.crypto.decryptMeta(memo.meta); if (obj) S.decrypted.set(memo.id, obj); } catch {}
  if (S.stats) { S.stats.count++; S.stats.bytes += memo.size || 0; }
  if (S.virtual) refreshList();
}
function removeMemoLocal(id) {
  S.memos = S.memos.filter((m) => m.id !== id);
  S.decrypted.delete(id);
  S.media?.release(id);
  if (S.virtual) refreshList();
}

async function makeImageThumb(file) {
  try {
    const bmp = await createImageBitmap(file);
    const w0 = bmp.width, h0 = bmp.height;
    const scale = Math.min(1, 320 / Math.max(w0, h0));
    const w = Math.max(1, Math.round(w0 * scale)), hh = Math.max(1, Math.round(h0 * scale));
    const canvas = h('canvas'); canvas.width = w; canvas.height = hh;
    canvas.getContext('2d').drawImage(bmp, 0, 0, w, hh);
    bmp.close?.();
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.72));
    return blob ? { blob, w: w0, h: h0 } : null;
  } catch { return null; }
}

function makeVideoThumb(file) {
  return new Promise((resolve) => {
    try {
      const url = URL.createObjectURL(file);
      const v = h('video', { muted: true, playsinline: true, preload: 'metadata' });
      v.src = url;
      let done = false;
      const cleanup = () => { URL.revokeObjectURL(url); v.removeAttribute('src'); try { v.load(); } catch {} };
      const finish = (res) => { if (done) return; done = true; clearTimeout(to); cleanup(); resolve(res); };
      const to = setTimeout(() => finish(null), 4000);
      v.onloadeddata = () => { try { v.currentTime = Math.min(0.1, (v.duration || 1) / 2); } catch { finish(null); } };
      v.onseeked = () => {
        try {
          const scale = Math.min(1, 320 / Math.max(v.videoWidth, v.videoHeight));
          const w = Math.max(1, Math.round(v.videoWidth * scale)), hh = Math.max(1, Math.round(v.videoHeight * scale));
          const c = h('canvas'); c.width = w; c.height = hh;
          c.getContext('2d').drawImage(v, 0, 0, w, hh);
          c.toBlob((b) => finish(b ? { blob: b, w: v.videoWidth, h: v.videoHeight, dur: v.duration } : null), 'image/jpeg', 0.72);
        } catch { finish(null); }
      };
      v.onerror = () => finish(null);
    } catch { resolve(null); }
  });
}

async function editTextMemo(memo, d, existingText) {
  let text = existingText;
  if (text == null) { try { text = await S.media.text(memo); } catch (e) { toast(e.message, { type: 'error' }); return; } }
  const title = h('input', { class: 'tf-input', placeholder: ' ', value: d.title || '', maxlength: '120' });
  const ta = h('textarea', { class: 'tf-input', placeholder: ' ', rows: '10', style: { minHeight: '220px' }, value: text });
  const dlg = openDialog({
    title: '编辑备忘录', titleIcon: 'edit', wide: true, fullMobile: true,
    content: h('div', {},
      h('label', { class: 'tf editor-field' }, h('span', { class: 'tf-box' }, title, h('span', { class: 'tf-label' }, '标题'))),
      h('label', { class: 'tf editor-field' }, h('span', { class: 'tf-box', style: { alignItems: 'flex-start' } }, ta, h('span', { class: 'tf-label' }, '内容'))),
      h('p', { class: 'md-body-s muted' }, '编辑会重新加密并替换原内容。')),
    actions: [
      { label: '取消', variant: 'text' },
      { label: '保存', variant: 'filled', icon: 'save', keepOpen: true, onClick: async (close) => {
        const content = ta.value;
        if (!content.trim()) { toast('内容不能为空', { type: 'error' }); return false; }
        try {
          const organization=S.organization;
          if(organization && !organization.ready)throw new Error('文件夹索引尚未加载，请刷新后再编辑');
          const bytes = new TextEncoder().encode(content);
          const metaObj = { title: title.value.trim() || content.split('\n')[0].slice(0, 40) || '文字备忘录', preview: content.slice(0, 120) };
          const meta = (await S.crypto.encryptMeta(metaObj)).meta;
          const { parts: [cipher] } = await S.crypto.encryptBytes(bytes.buffer, bytes.byteLength || 1);
          // 先创建新内容，成功后再删除旧内容，避免中途失败丢数据
          const created = await POST('/api/user/memos', { type: 'text', size: bytes.byteLength, meta, parts: 1 });
          await PUT(`/api/user/memos/${created.id}/parts/0`, cipher);
          const done = await POST(`/api/user/memos/${created.id}/complete`);
          if(organization && organization===S.organization)await organization.change(d=>{
            if(d.locations[memo.id])d.locations[created.id]=d.locations[memo.id];
            delete d.locations[memo.id];d.order=d.order.map(k=>k==='m:'+memo.id?'m:'+created.id:k);
          });
          await DEL(`/api/user/memos/${memo.id}`);
          removeMemoLocal(memo.id);
          await addMemoLocal(done.memo);
          toast('已更新', { type: 'success' });
          close();
          renderTab();
        } catch (e) { toast(e.message, { type: 'error' }); return false; }
      } },
    ],
  });
}

// ============================ 设置 ============================
function renderSettings() {
  const c = S.el.content;
  c.classList.add('view-enter');
  const scroll = h('div', { class: 'settings-scroll' });
  const stats = S.stats || { count: 0, bytes: 0, images: 0, videos: 0, texts: 0, files: 0 };
  // 账号
  const g1 = h('div', { class: 'settings-group' }, h('h3', {}, '账号'),
    h('div', { class: 'settings-card' },
      h('div', { class: 'account-hero' },
        h('div', { class: 'avatar' }, icon('person')),
        h('div', { class: 'acct-num' }, formatAccount(S.account)),
        h('div', { class: 'muted md-body-s' }, '数字账号 · 端到端加密')),
      h('div', { class: 'settings-row' }, h('div', { class: 's-icon' }, icon('storage')),
        h('div', { class: 's-content' }, h('div', { class: 's-title' }, `${stats.count} 条备忘录 · ${formatBytes(stats.bytes)}`),
          h('div', { class: 's-sub' }, `文字 ${stats.texts} · 图片 ${stats.images} · 视频 ${stats.videos} · 文件 ${stats.files}`))),
      h('div', { class: 'settings-row' }, h('div', { class: 's-icon' }, icon('content_copy')),
        h('div', { class: 's-content' }, h('div', { class: 's-title' }, '复制账号'), h('div', { class: 's-sub' }, '分享账号用于登录（仍需密钥）')),
        h('button', { class: 'btn btn-tonal btn-sm stateful', onClick: () => copyText(S.account).then((ok) => toast(ok ? '已复制' : '复制失败', { type: ok ? 'success' : 'error' })) }, '复制')),
    ));
  // 外观与安全
  const themeSwitch = h('input', { type: 'checkbox', checked: currentTheme() === 'dark', onChange: () => toggleTheme() });
  const g2 = h('div', { class: 'settings-group' }, h('h3', {}, '外观与安全'),
    h('div', { class: 'settings-card' },
      h('div', { class: 'settings-row' }, h('div', { class: 's-icon' }, icon('dark_mode')),
        h('div', { class: 's-content' }, h('div', { class: 's-title' }, '深色模式'), h('div', { class: 's-sub' }, '切换亮色 / 暗色主题')),
        h('label', { class: 'switch' }, themeSwitch, h('span', { class: 'switch-track' }, h('span', { class: 'switch-thumb' })))),
      h('div', { class: 'settings-row' }, h('div', { class: 's-icon' }, icon('timer')),
        h('div', { class: 's-content' }, h('div', { class: 's-title' }, '自动锁定'), h('div', { class: 's-sub' }, S.config?.autoLockMinutes ? `无操作 ${S.config.autoLockMinutes} 分钟后锁定` : '管理员已关闭自动锁定')),
        h('button', { class: 'btn btn-outlined btn-sm stateful', onClick: lock }, icon('lock'), '立即锁定')),
      h('div', { class: 'settings-row' }, h('div', { class: 's-icon' }, icon('enhanced_encryption')),
        h('div', { class: 's-content' }, h('div', { class: 's-title' }, '端到端加密'), h('div', { class: 's-sub' }, 'AES-256-GCM · 密钥仅存于你的浏览器'))),
    ));
  // 数据
  const g3 = h('div', { class: 'settings-group' }, h('h3', {}, '数据与存储'),
    h('div', { class: 'settings-card' },
      h('div', { class: 'settings-row' }, h('div', { class: 's-icon' }, icon('cloud_done')),
        h('div', { class: 's-content' }, h('div', { class: 's-title' }, '内容存储'), h('div', { class: 's-sub' }, '密文存储位置由管理员统一配置，可为服务器磁盘或 Telegram'))),
      h('div', { class: 'settings-row' }, h('div', { class: 's-icon' }, icon('refresh')),
        h('div', { class: 's-content' }, h('div', { class: 's-title' }, '重新同步'), h('div', { class: 's-sub' }, '重新拉取并解密全部备忘录索引')),
        h('button', { class: 'btn btn-tonal btn-sm stateful', onClick: () => { toast('正在同步…'); syncMemos(); } }, '同步')),
    ));
  // 危险区
  const g4 = h('div', { class: 'settings-group' }, h('h3', { style: { color: 'var(--md-error)' } }, '危险操作'),
    h('div', { class: 'settings-card' },
      h('div', { class: 'settings-row' }, h('div', { class: 's-icon', style: { color: 'var(--md-error)' } }, icon('logout')),
        h('div', { class: 's-content' }, h('div', { class: 's-title' }, '退出登录'), h('div', { class: 's-sub' }, '退出当前账号')),
        h('button', { class: 'btn btn-outlined btn-sm stateful', onClick: logout }, '退出')),
      h('div', { class: 'settings-row' }, h('div', { class: 's-icon', style: { color: 'var(--md-error)' } }, icon('delete_forever')),
        h('div', { class: 's-content' }, h('div', { class: 's-title' }, '注销账号'), h('div', { class: 's-sub' }, '永久删除账号及全部内容，不可恢复')),
        h('button', { class: 'btn btn-danger btn-sm stateful', onClick: deleteAccount }, '注销')),
    ));
  const about = h('div', { class: 'text-center muted md-body-s', style: { padding: '16px' } },
    `${S.config?.siteName || '备忘录'} v${S.config?.version || '1.0.0'} · 端到端加密备忘录`);
  const remember = h('input', { type: 'checkbox', checked: savedLogin()?.account === S.account });
  remember.addEventListener('change', async () => {
    if (remember.checked) {
      const ok = await confirmDialog({ title: '记住此设备？', message: '账号和密钥将保存在此浏览器，关闭后仍保留。本机使用者或恶意扩展可读取，请勿在公共设备开启。清除浏览器数据后仍需自行保管的密钥。', confirmLabel: '记住' });
      if (!ok) { remember.checked = false; return; }
      try { saveLogin(); } catch { remember.checked = false; toast('保存失败，请检查浏览器存储权限', { type: 'error' }); }
    } else forgetLogin();
  });
  g2.append(h('div', { class: 'settings-card' },
    h('label', { class: 'settings-row' }, h('div', { class: 's-content' }, h('div', { class: 's-title' }, '记住账号与密钥'), h('div', { class: 's-sub' }, '仅此浏览器生效；关闭、锁定或退出会清除已记住的凭据')), remember),
    h('button', { class: 'btn btn-tonal', onClick: async () => {
      if (await confirmDialog({ title: '复制密钥', message: '密钥可解密所有备忘录。请勿分享，复制后注意清理剪贴板。', confirmLabel: '复制' })) {
        const ok = await copyText(base32Encode(S.master)); toast(ok ? '密钥已复制' : '复制失败');
      }
    } }, icon('key'), '复制密钥')));
  const profile = h('div', { class: 'settings-group' });
  scroll.append(g1, profile, g2, g3, g4, about);
  loadProfileEditor(profile);
  c.append(scroll);
}

async function loadProfileEditor(container) {
  try {
    const { profile } = await GET('/api/user/profile');
    if (!container.isConnected) return;
    const name = h('input', { class: 'tf-input', value: profile.nickname, maxlength: 24, placeholder: '网名（唯一）', 'aria-label': '网名' });
    const bio = h('textarea', { class: 'tf-input', value: profile.bio, maxlength: 280, placeholder: '账户简介（最多 280 字）', 'aria-label': '账户简介' });
    const avatar = h('img', { class: 'profile-avatar', alt: '头像', hidden: true });
    let avatarRevision=0;
    async function showAvatar(url){
      const revision=++avatarRevision;avatar.hidden=true;avatar.removeAttribute('src');
      if(!url)return;
      // An <img src> cannot attach the exported frontend's admission header.
      // Use the shared authenticated client; data URLs need no object-URL lifecycle.
      const response=await GET(url+'?v='+Date.now()),blob=await response.blob();
      if(!container.isConnected||revision!==avatarRevision)return;
      const data=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(new Error('头像读取失败'));reader.readAsDataURL(blob);});
      if(!container.isConnected||revision!==avatarRevision)return;
      avatar.src=data;avatar.hidden=false;
    }
    const file = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp', 'aria-label': '上传头像' });
    const error = h('p', { role: 'status', class: 'md-body-s' });
    const save = h('button', { class: 'btn btn-filled', onClick: async () => {
      save.disabled = true; error.textContent = '';
      try {
        await PATCH('/api/user/profile', { nickname: name.value, bio: bio.value });
        error.textContent = '网名与简介已保存，正在处理头像…';
        if (file.files[0]) {
          const image = await avatarJPEG(file.files[0]);
          await PUT('/api/user/profile/avatar', image);
        }
        error.textContent = '公开资料已保存';
        const updated = await GET('/api/user/profile');
        await showAvatar(updated.profile.avatar);
        file.value = '';
      } catch (e) { error.textContent = (error.textContent ? '网名与简介已保存；头像未完成：' : '') + e.message; } finally { save.disabled = false; }
    } }, '保存公开资料');
    container.append(h('h3', {}, '公开资料'), h('div', { class: 'settings-card profile-editor' },
      h('p', { class: 'muted' }, '头像、网名和简介公开，管理员及知道网名的人可查看。请勿填写密钥或私密内容；备忘录内容仍为端到端加密。'),
      avatar, h('label', {}, '网名', name), h('label', {}, '账户简介', bio), file,
      h('p', { class: 'muted md-body-s' }, 'JPEG / PNG / WebP，最大 5MB；自动裁剪为 256 像素头像。存储由管理员配置。'),
      h('div', { class: 'row wrap gap-8' }, save, h('button', { class: 'btn btn-outlined', onClick: async () => {
        try { await DEL('/api/user/profile/avatar'); await showAvatar(null); file.value = ''; error.textContent = '头像已移除'; } catch (e) { error.textContent = e.message; }
      } }, '移除头像')), error));
    try{await showAvatar(profile.avatar);}catch(e){if(container.isConnected)error.textContent='头像加载失败：'+e.message;}
  } catch (e) { if (container.isConnected) container.append(h('p', {}, '资料加载失败：' + e.message)); }
}

async function avatarJPEG(file) {
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 5 * 1024 * 1024) throw new Error('请选择不超过 5MB 的 JPEG、PNG 或 WebP 图片');
  const bitmap = await createImageBitmap(file);
  try {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 256;
    const ctx = canvas.getContext('2d'); const size = Math.min(bitmap.width, bitmap.height);
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 256, 256);
    ctx.drawImage(bitmap, (bitmap.width - size) / 2, (bitmap.height - size) / 2, size, size, 0, 0, 256, 256);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.85));
    if (!blob) throw new Error('头像转换失败');
    return blob;
  } finally { bitmap.close(); }
}

async function deleteAccount() {
  const ok = await confirmDialog({ title: '注销账号', message: '这将永久删除你的账号和所有备忘录，且无法恢复。确定继续吗？', confirmLabel: '继续注销', danger: true, icon: 'delete_forever' });
  if (!ok) return;
  const key = h('input', { class: 'tf-input mono', placeholder: ' ', type: 'password' });
  openDialog({
    title: '验证密钥', titleIcon: 'key',
    content: h('div', {}, h('p', { class: 'md-body-m muted', style: { marginTop: 0 } }, '请输入你的密钥以确认注销。'),
      h('label', { class: 'tf' }, h('span', { class: 'tf-box' }, key, h('span', { class: 'tf-label' }, '密钥')))),
    actions: [
      { label: '取消', variant: 'text' },
      { label: '永久注销', variant: 'danger', keepOpen: true, onClick: async (close) => {
        try {
          const master = parseKey(key.value);
          const proof = await tempProof(master);
          await POST('/api/user/delete-account', { proof });
          toast('账号已注销', { type: 'success' });
          close();
          cleanupSession(true);
          S.account = null;
          setView('auth');
        } catch (e) { toast(e.message, { type: 'error' }); return false; }
      } },
    ],
  });
}
