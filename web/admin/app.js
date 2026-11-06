import { renderRisk } from './risk.js';
import { renderAcceleration } from './acceleration.js';
import { renderStorage, renderAppearance } from './customize.js';
import { loadAppearance } from '/assets/js/appearance.js';
import {
  h, clear, icon, loadSprite, initTheme, toggleTheme, currentTheme, initRipple,
  toast, openDialog, confirmDialog, openMenu, GET, POST, PATCH, DEL, ApiError,
  formatBytes, formatDate, formatRelative, formatAccount, copyText, debounce, downloadBlob,
} from '/assets/js/core.js';

const $app = document.getElementById('app');
const S = { view: 'loading', page: 'overview', status: null, username: null, el: {}, data: {} };

boot();
async function boot() {
  initTheme(); initRipple(); loadSprite(); loadAppearance(true);
  try { S.status = await GET('/api/admin/status'); } catch (e) { toast('无法连接服务器: ' + e.message, { type: 'error' }); }
  if (S.status?.setupRequired) setView('setup');
  else if (S.status?.loggedIn) setView('main');
  else setView('login');
}
function setView(v) { S.view = v; render(); }
function render() {
  S.el.page?._disposeAcceleration?.();
  S.pageCleanup?.(); S.pageCleanup = null;
  clear($app);
  if (S.view === 'setup') renderSetup();
  else if (S.view === 'login') renderLogin();
  else if (S.view === 'main') renderMain();
}

// ============================ 初始化 / 登录 ============================
function authShell(title, subtitle, iconName) {
  const wrap = h('div', { class: 'auth-wrap' });
  const card = h('div', { class: 'auth-card' });
  card.append(h('div', { class: 'auth-logo' },
    h('div', { class: 'logo-badge' }, icon(iconName)),
    h('h1', {}, title), h('p', {}, subtitle)));
  wrap.append(card);
  $app.append(wrap);
  return card;
}

function renderSetup() {
  const card = authShell('初始化管理员', '首次使用，请设置管理员账号', 'admin_panel_settings');
  const user = h('input', { class: 'tf-input', placeholder: ' ', autocomplete: 'username', value: 'admin' });
  const pass = h('input', { class: 'tf-input', placeholder: ' ', type: 'password', autocomplete: 'new-password' });
  const pass2 = h('input', { class: 'tf-input', placeholder: ' ', type: 'password', autocomplete: 'new-password' });
  const err = h('div', { class: 'md-body-s', style: { color: 'var(--md-error)', minHeight: '18px', margin: '4px 0 8px' } });
  const btn = h('button', { class: 'btn btn-filled btn-block stateful', onClick: submit }, icon('check_circle'), '创建管理员');
  card.append(
    h('label', { class: 'tf auth-field' }, h('span', { class: 'tf-box' }, h('span', { class: 'tf-leading' }, icon('person')), user, h('span', { class: 'tf-label' }, '管理员用户名')), h('span', { class: 'tf-helper' }, '3-32 位字母、数字、_ . -')),
    h('label', { class: 'tf auth-field' }, h('span', { class: 'tf-box' }, h('span', { class: 'tf-leading' }, icon('lock')), pass, h('span', { class: 'tf-label' }, '密码')), h('span', { class: 'tf-helper' }, '至少 8 位')),
    h('label', { class: 'tf auth-field' }, h('span', { class: 'tf-box' }, h('span', { class: 'tf-leading' }, icon('lock')), pass2, h('span', { class: 'tf-label' }, '确认密码'))),
    err, btn,
    h('div', { class: 'auth-note' }, icon('privacy_tip'), h('span', {}, '管理员只能管理账号与封禁规则，无法查看任何用户的内容。')));
  async function submit() {
    err.textContent = '';
    if (pass.value !== pass2.value) { err.textContent = '两次密码不一致'; return; }
    btn.disabled = true;
    try {
      const r = await POST('/api/admin/setup', { username: user.value.trim(), password: pass.value });
      S.username = r.username;
      toast('管理员已创建', { type: 'success' });
      setView('main');
    } catch (e) { err.textContent = e.message; btn.disabled = false; }
  }
  pass2.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
}

function renderLogin() {
  const card = authShell('管理控制台', S.status?.siteName || '备忘录', 'admin_panel_settings');
  const user = h('input', { class: 'tf-input', placeholder: ' ', autocomplete: 'username' });
  const pass = h('input', { class: 'tf-input', placeholder: ' ', type: 'password', autocomplete: 'current-password' });
  const err = h('div', { class: 'md-body-s', style: { color: 'var(--md-error)', minHeight: '18px', margin: '4px 0 8px' } });
  const btn = h('button', { class: 'btn btn-filled btn-block stateful', onClick: submit }, icon('login'), '登录');
  card.append(
    h('label', { class: 'tf auth-field' }, h('span', { class: 'tf-box' }, h('span', { class: 'tf-leading' }, icon('person')), user, h('span', { class: 'tf-label' }, '用户名'))),
    h('label', { class: 'tf auth-field' }, h('span', { class: 'tf-box' }, h('span', { class: 'tf-leading' }, icon('lock')), pass, h('span', { class: 'tf-label' }, '密码'))),
    err, btn);
  async function submit() {
    err.textContent = ''; btn.disabled = true;
    try { const r = await POST('/api/admin/login', { username: user.value.trim(), password: pass.value }); S.username = r.username; setView('main'); }
    catch (e) { err.textContent = e.message; btn.disabled = false; }
  }
  pass.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  setTimeout(() => user.focus(), 80);
}

async function adminLogout() {
  try { await POST('/api/admin/logout'); } catch {}
  setView('login');
}

// ============================ 主壳 ============================
const PAGES = [
  { id: 'overview', icon: 'dashboard', label: '概览' },
  { id: 'users', icon: 'group', label: '用户' },
  { id: 'risk', icon: 'shield', label: '风控' },
  { id: 'ipbans', icon: 'gpp_bad', label: 'IP 封禁' },
  { id: 'bots', icon: 'smart_toy', label: '机器人' },
  { id: 'domain', icon: 'language', label: '域名' },
  { id: 'frontend', icon: 'devices', label: '前端/跨域' },
  { id: 'ads', icon: 'sell', label: '广告' },
  { id: 'storage', icon: 'storage', label: '存储' },
  { id: 'appearance', icon: 'palette', label: '主题' },
  { id: 'settings', icon: 'settings', label: '设置' },
  { id: 'audit', icon: 'history', label: '审计' },
];

function renderMain() {
  const shell = h('div', { class: 'shell shell-admin' });
  // 桌面：高密度导航 rail
  const rail = h('nav', { class: 'nav-rail' });
  rail.append(h('div', { style: { marginBottom: '8px', color: 'var(--md-primary)' }, title: '管理控制台' }, icon('admin_panel_settings', 'lg')));
  for (const p of PAGES) rail.append(h('button', { class: `nav-rail-item stateful ${S.page === p.id ? 'active' : ''}`, onClick: () => goPage(p.id) }, h('span', { class: 'nav-indicator' }, icon(p.icon)), h('span', {}, p.label)));
  const main = h('div', { class: 'main' });
  const topbar = h('header', { class: 'top-bar' },
    h('button', { class: 'icon-btn stateful nav-toggle', title: '打开菜单', 'aria-label': '打开菜单', onClick: () => openDrawer() }, icon('menu')),
    h('div', { class: 'top-bar-title' }, icon('admin_panel_settings'), h('span', {}, '管理控制台')),
    h('button', { class: 'icon-btn stateful', title: '切换主题', onClick: () => toggleTheme() }, icon(currentTheme() === 'dark' ? 'light_mode' : 'dark_mode')),
    h('button', { class: 'icon-btn stateful', title: '管理员', onClick: (e) => openMenu(e.currentTarget, [
      { label: S.username || '管理员', icon: 'person', onClick: () => {} },
      { divider: true },
      { label: '修改密码', icon: 'password', onClick: changePassword },
      { label: '切换主题', icon: currentTheme() === 'dark' ? 'light_mode' : 'dark_mode', onClick: () => toggleTheme() },
      { divider: true },
      { label: '退出登录', icon: 'logout', danger: true, onClick: adminLogout },
    ]) }, icon('account_circle')));
  const content = h('div', { class: 'content' });
  main.append(topbar, content);
  shell.append(rail, main);
  $app.append(shell);

  // 移动：汉堡 + M3 侧边抽屉（项多不溢出）
  const drawerItems = [];
  const drawer = h('nav', { class: 'nav-drawer', 'aria-label': '管理导航' },
    h('div', { class: 'drawer-head' },
      h('div', { class: 'drawer-logo' }, icon('admin_panel_settings')),
      h('div', { class: 'title' }, '管理控制台'),
      h('button', { class: 'icon-btn stateful', title: '关闭菜单', onClick: () => closeDrawer() }, icon('close'))),
    h('div', { class: 'drawer-section' }, '管理'));
  for (const p of PAGES) {
    const item = h('button', { class: `nav-drawer-item stateful ${S.page === p.id ? 'active' : ''}`, onClick: () => { goPage(p.id); closeDrawer(); } }, icon(p.icon), h('span', {}, p.label));
    drawerItems.push(item); drawer.append(item);
  }
  drawer.append(h('div', { class: 'drawer-divider' }), h('div', { class: 'drawer-section' }, '账户'));
  drawer.append(h('div', { class: 'drawer-foot' },
    h('button', { class: 'nav-drawer-item stateful', onClick: () => { closeDrawer(); changePassword(); } }, icon('password'), h('span', {}, '修改密码')),
    h('button', { class: 'nav-drawer-item stateful', onClick: () => { toggleTheme(); } }, icon(currentTheme() === 'dark' ? 'light_mode' : 'dark_mode'), h('span', {}, '切换主题')),
    h('button', { class: 'nav-drawer-item danger stateful', onClick: () => { closeDrawer(); adminLogout(); } }, icon('logout'), h('span', {}, '退出登录'))));
  const scrim = h('div', { class: 'drawer-scrim', onClick: (e) => { if (e.target === scrim) closeDrawer(); } }, drawer);
  $app.append(scrim);
  function openDrawer() { scrim.classList.add('show'); }
  function closeDrawer() { scrim.classList.remove('show'); }
  S.el = { content, rail, drawerItems, scrim, openDrawer, closeDrawer };
  renderPage();
}

function goPage(page) {
  S.page = page;
  const idx = PAGES.findIndex((p) => p.id === page);
  [...S.el.rail.querySelectorAll('.nav-rail-item')].forEach((el, i) => el.classList.toggle('active', i === idx));
  (S.el.drawerItems || []).forEach((el, i) => el.classList.toggle('active', i === idx));
  renderPage();
}

function renderPage() {
  S.el.page?._disposeAcceleration?.();
  S.pageCleanup?.(); S.pageCleanup = null;
  const c = S.el.content;
  clear(c);
  const scroll = h('div', { class: 'admin-content' });
  const page = h('div', { class: 'admin-page view-enter' });
  scroll.append(page);
  c.append(scroll);
  S.el.page = page;
  const cleanup = ({ risk:renderRisk, storage: renderStorage, appearance: renderAppearance, overview: renderOverview, users: renderUsers, ipbans: renderIpBans, bots: renderBots, domain: renderDomain, frontend: renderFrontend, ads: renderAds, settings: renderSettings, audit: renderAudit }[S.page] || renderOverview)(page);
  if (typeof cleanup === 'function') S.pageCleanup = cleanup;
}

function pageHead(title, ...actions) {
  return h('div', { class: 'admin-page-head' }, h('h2', {}, title), ...actions);
}
function loadingEl() {
  return h('div', { class: 'empty-state' }, h('svg', { class: 'progress-circular', viewBox: '0 0 50 50' }, h('circle', { cx: '25', cy: '25', r: '20' })));
}

// ============================ 概览 ============================
async function renderOverview(page) {
  page.append(pageHead('概览', h('button', { class: 'btn btn-tonal btn-sm stateful', onClick: () => renderPage() }, icon('refresh'), '刷新')));
  const grid = h('div', { class: 'stat-grid' });
  page.append(grid, loadingEl());
  let data;
  try { data = await GET('/api/admin/overview'); } catch (e) { page.append(h('p', { class: 'muted' }, e.message)); return; }
  page.querySelector('.empty-state')?.remove();
  const t = data.totals;
  const stats = [
    { label: '用户总数', value: t.users, icon: 'group', color: 'var(--md-primary)', bg: 'var(--md-primary-container)', sub: `24h 新增 ${data.new24h}` },
    { label: '备忘录总数', value: t.memos, icon: 'sticky_note_2', color: 'var(--md-tertiary)', bg: 'var(--md-tertiary-container)', sub: `加密存储 ${t.bytesHuman}` },
    { label: '24h 活跃', value: data.active24h, icon: 'bolt', color: 'var(--md-success)', bg: 'var(--md-success-container)', sub: `7 天活跃 ${data.active7d}` },
    { label: '封禁账号', value: t.bannedUsers, icon: 'block', color: 'var(--md-error)', bg: 'var(--md-error-container)', sub: `IP 规则 ${t.ipBans} 条` },
  ];
  for (const s of stats) {
    grid.append(h('div', { class: 'stat-card' },
      h('div', { class: 'stat-top' }, h('div', { class: 'stat-icon', style: { background: s.bg, color: s.color } }, icon(s.icon)), ),
      h('div', { class: 'stat-value' }, String(s.value)),
      h('div', { class: 'stat-label' }, s.label),
      h('div', { class: 'stat-trend muted' }, s.sub)));
  }
  // 存储状态
  const tg = data.telegram;
  const storagePanel = h('div', { class: 'panel' },
    h('div', { class: 'panel-head' }, icon('cloud_done'), h('h3', {}, 'Telegram 存储'),
      h('span', { class: `badge ${data.storageReady ? 'success' : 'warning'}` }, data.storageReady ? '已就绪' : '未配置')),
    h('div', { class: 'kv-grid' },
      kv('启用机器人', `${t.activeBots} / ${t.bots}`),
      kv('累计上传', String(tg.sentTotal)),
      kv('队列占用', formatBytes(tg.queueBytes)),
      kv('上传并发', String(tg.inFlight)),
      kv('缩略图缓存', `${tg.thumbCacheEntries} 项 · ${formatBytes(tg.thumbCacheBytes)}`),
      kv('错误次数', String(tg.errorTotal))));
  if (!data.storageReady) storagePanel.append(h('div', { class: 'auth-note mt-16' }, icon('warning'), h('span', {}, '尚未绑定存储机器人，用户无法保存内容。'),
    h('button', { class: 'btn btn-filled btn-sm stateful', style: { marginLeft: 'auto' }, onClick: () => goPage('bots') }, '去绑定')));
  // 系统信息
  const sys = data.system;
  const sysPanel = h('div', { class: 'panel' },
    h('div', { class: 'panel-head' }, icon('memory'), h('h3', {}, '系统状态')),
    h('div', { class: 'kv-grid' },
      kv('版本', `v${sys.version} · Node ${sys.node}`),
      kv('平台', sys.platform),
      kv('运行时长', formatDuration(sys.uptimeSec)),
      kv('负载', sys.loadavg.join(' / ')),
      kv('内存', `${sys.processRssMB} MB / ${sys.totalMemMB} MB`),
      kv('CPU 核心', String(sys.cpuCount))));
  const cols = h('div', { class: 'two-col' }, storagePanel, sysPanel);
  page.append(cols);
  // 最近审计
  const auditPanel = h('div', { class: 'panel' }, h('div', { class: 'panel-head' }, icon('history'), h('h3', {}, '最近操作'),
    h('button', { class: 'btn btn-text btn-sm stateful', onClick: () => goPage('audit') }, '查看全部')));
  if (data.recentAudit.length === 0) auditPanel.append(h('p', { class: 'muted' }, '暂无操作记录'));
  for (const a of data.recentAudit) auditPanel.append(auditRow(a));
  page.append(auditPanel);
}
function kv(k, v) { return h('div', { class: 'kv' }, h('div', { class: 'k' }, k), h('div', { class: 'v' }, v)); }
function formatDuration(sec) {
  const d = Math.floor(sec / 86400), hh = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  return d > 0 ? `${d} 天 ${hh} 小时` : hh > 0 ? `${hh} 小时 ${m} 分` : `${m} 分钟`;
}
function auditRow(a) {
  return h('div', { class: 'audit-item' },
    h('span', { class: 'a-time' }, formatDate(a.ts)),
    h('span', { class: 'a-action' }, a.action),
    h('span', { class: 'a-detail flex-1' }, `${a.actor} · ${a.detail}`));
}

// ============================ 用户管理 ============================
const userState = { query: '', filter: 'all', offset: 0, limit: 50, selected: new Set(), items: [], total: 0 };
async function renderUsers(page) {
  userState.selected.clear();
  const search = h('input', { placeholder: '搜索数字账号…', value: userState.query });
  search.addEventListener('input', debounce(() => { userState.query = search.value; userState.offset = 0; loadUsers(); }, 300));
  const filterSeg = h('div', { class: 'segmented' },
    ...[['all', '全部'], ['active', '正常'], ['banned', '已封禁']].map(([id, label]) =>
      h('button', { class: userState.filter === id ? 'selected' : '', onClick: (e) => { userState.filter = id; userState.offset = 0; [...filterSeg.children].forEach((b) => b.classList.remove('selected')); e.currentTarget.classList.add('selected'); loadUsers(); } }, label)));
  page.append(pageHead('用户管理', h('div', { class: 'search-bar', style: { maxWidth: '280px' } }, icon('search'), search), filterSeg));
  const bar = h('div', { class: 'selection-bar hidden', style: { borderRadius: '12px', marginBottom: '16px' } });
  const tableWrap = h('div', { class: 'table-wrap desktop-table' });
  const cards = h('div', { class: 'mobile-cards' });
  const pager = h('div', { class: 'pager' });
  page.append(bar, tableWrap, cards, pager);
  S.el.userBar = bar;

  async function loadUsers() {
    tableWrap.append(loadingEl());
    let data;
    try { data = await GET(`/api/admin/users?query=${encodeURIComponent(userState.query)}&filter=${userState.filter}&offset=${userState.offset}&limit=${userState.limit}`); }
    catch (e) { toast(e.message, { type: 'error' }); return; }
    userState.items = data.items; userState.total = data.total;
    clear(tableWrap); clear(cards);
    if (!data.items.length) { tableWrap.append(h('div', { class: 'empty-state' }, icon('group'), h('h3', {}, '暂无用户'), h('p', {}, '还没有用户注册。'))); }
    else {
      const table = h('table', { class: 'md-table' });
      const allCheck = h('input', { type: 'checkbox', onChange: () => { if (allCheck.checked) data.items.forEach((u) => userState.selected.add(u.account)); else userState.selected.clear(); renderUserRows(); } });
      table.append(h('thead', {}, h('tr', {},
        h('th', { style: { width: '40px' } }, h('label', { class: 'check' }, allCheck, h('span', { class: 'check-box' }, icon('check')))),
        h('th', {}, '账号'), h('th', {}, '备忘录'), h('th', {}, '存储'), h('th', {}, '注册时间'), h('th', {}, '最近活跃'), h('th', {}, '状态'), h('th', { class: 'text-right' }, '操作'))));
      const tbody = h('tbody');
      table.append(tbody);
      tableWrap.append(table);
      for (const u of data.items) {
        tbody.append(userRow(u));
        cards.append(userCard(u));
      }
    }
    clear(pager);
    const from = data.total === 0 ? 0 : userState.offset + 1;
    const to = Math.min(userState.offset + userState.limit, data.total);
    pager.append(
      h('button', { class: 'icon-btn stateful', disabled: userState.offset === 0, onClick: () => { userState.offset = Math.max(0, userState.offset - userState.limit); loadUsers(); } }, icon('chevron_left')),
      h('span', { class: 'info' }, `${from}-${to} / 共 ${data.total}`),
      h('button', { class: 'icon-btn stateful', disabled: to >= data.total, onClick: () => { userState.offset += userState.limit; loadUsers(); } }, icon('chevron_right')));
    updateUserBar();
  }

  function userRow(u) {
    const check = h('input', { type: 'checkbox', checked: userState.selected.has(u.account), onChange: () => { toggle(u.account); } });
    return h('tr', { class: userState.selected.has(u.account) ? 'selected' : '' },
      h('td', {}, h('label', { class: 'check' }, check, h('span', { class: 'check-box' }, icon('check')))),
      h('td', {}, h('span', { class: 'mono' }, formatAccount(u.account)), publicProfile(u)),
      h('td', {}, String(u.stats.count)),
      h('td', {}, formatBytes(u.stats.bytes)),
      h('td', { class: 'muted' }, formatDate(u.createdAt)),
      h('td', { class: 'muted' }, formatRelative(u.lastSeen)),
      h('td', {}, u.banned ? h('span', { class: 'badge' }, '已封禁') : h('span', { class: 'badge success' }, '正常')),
      h('td', { class: 'text-right' }, userActions(u)));
  }
  function userCard(u) {
    const check = h('input', { type: 'checkbox', checked: userState.selected.has(u.account), onChange: () => toggle(u.account) });
    return h('div', { class: 'm-card' },
      h('div', { class: 'm-row' }, h('label', { class: 'check' }, check, h('span', { class: 'check-box' }, icon('check'))),
        h('div', { class: 'flex-1' }, h('div', { class: 'mono md-title-s' }, formatAccount(u.account)), publicProfile(u),
          h('div', { class: 'muted md-body-s' }, `${u.stats.count} 条 · ${formatBytes(u.stats.bytes)} · ${formatRelative(u.lastSeen)}`)),
        u.banned ? h('span', { class: 'badge' }, '封禁') : h('span', { class: 'badge success' }, '正常')),
      h('div', { class: 'm-actions' }, userActions(u)));
  }
  function userActions(u) {
    return h('div', { class: 'row gap-4 end' },
      h('button', { class: 'icon-btn stateful', title: u.banned ? '解封' : '封禁', onClick: () => batchAction([u.account], u.banned ? 'unban' : 'ban') }, icon(u.banned ? 'lock_open' : 'block')),
      h('button', { class: 'icon-btn stateful danger', title: '删除', onClick: () => batchAction([u.account], 'delete') }, icon('delete')));
  }
  function toggle(account) { if (userState.selected.has(account)) userState.selected.delete(account); else userState.selected.add(account); renderUserRows(); updateUserBar(); }
  function renderUserRows() {
    // 重新渲染勾选状态
    clear(tableWrap); clear(cards);
    if (!userState.items.length) return;
    const table = h('table', { class: 'md-table' });
    const allCheck = h('input', { type: 'checkbox', checked: userState.items.every((u) => userState.selected.has(u.account)), onChange: () => { if (allCheck.checked) userState.items.forEach((u) => userState.selected.add(u.account)); else userState.selected.clear(); renderUserRows(); updateUserBar(); } });
    table.append(h('thead', {}, h('tr', {}, h('th', { style: { width: '40px' } }, h('label', { class: 'check' }, allCheck, h('span', { class: 'check-box' }, icon('check')))), h('th', {}, '账号'), h('th', {}, '备忘录'), h('th', {}, '存储'), h('th', {}, '注册时间'), h('th', {}, '最近活跃'), h('th', {}, '状态'), h('th', { class: 'text-right' }, '操作'))));
    const tbody = h('tbody'); table.append(tbody); tableWrap.append(table);
    for (const u of userState.items) { tbody.append(userRow(u)); cards.append(userCard(u)); }
  }
  function updateUserBar() {
    const n = userState.selected.size;
    bar.classList.toggle('hidden', n === 0);
    clear(bar);
    if (!n) return;
    bar.append(h('span', { class: 'count' }, `已选 ${n} 个账号`),
      h('button', { class: 'btn btn-text btn-sm stateful', onClick: () => batchAction([...userState.selected], 'ban') }, icon('block'), '封禁'),
      h('button', { class: 'btn btn-text btn-sm stateful', onClick: () => batchAction([...userState.selected], 'unban') }, icon('lock_open'), '解封'),
      h('button', { class: 'btn btn-text btn-sm stateful', style: { color: 'var(--md-error)' }, onClick: () => batchAction([...userState.selected], 'delete') }, icon('delete'), '删除'),
      h('button', { class: 'icon-btn stateful', onClick: () => { userState.selected.clear(); renderUserRows(); updateUserBar(); } }, icon('close')));
  }
  async function batchAction(accounts, action) {
    if (action === 'delete') {
      const ok = await confirmDialog({ title: '删除账号', message: `将永久删除 ${accounts.length} 个账号及其全部内容（Telegram 中的密文也会被清除）。确定吗？`, confirmLabel: '删除', danger: true, icon: 'delete_forever' });
      if (!ok) return;
    }
    try {
      const r = await POST('/api/admin/users/batch', { accounts, action });
      toast(`已${{ ban: '封禁', unban: '解封', delete: '删除' }[action]} ${r.affected} 个账号`, { type: 'success' });
      userState.selected.clear();
      loadUsers();
    } catch (e) { toast(e.message, { type: 'error' }); }
  }
  loadUsers();
}

// ============================ IP 封禁 ============================
const banState = { query: '', selected: new Set(), items: [] };
async function renderIpBans(page) {
  banState.selected.clear();
  page.append(pageHead('IP 封禁',
    h('button', { class: 'btn btn-filled btn-sm stateful', onClick: openAddBan }, icon('add'), '添加规则')));
  page.append(h('div', { class: 'auth-note', style: { marginBottom: '16px' } }, icon('info'),
    h('span', {}, '支持单个 IP、CIDR 网段（1.2.3.0/24、2001:db8::/32）、通配符（1.2.3.*）与区间（1.2.3.4-1.2.3.9），IPv4 / IPv6 均可，可批量粘贴。')));
  const search = h('input', { placeholder: '搜索规则或备注…', value: banState.query });
  search.addEventListener('input', debounce(() => { banState.query = search.value; loadBans(); }, 300));
  const bar = h('div', { class: 'selection-bar hidden', style: { borderRadius: '12px', marginBottom: '16px' } });
  const listWrap = h('div');
  page.append(h('div', { class: 'search-bar', style: { maxWidth: '320px', marginBottom: '16px' } }, icon('search'), search), bar, listWrap);

  async function loadBans() {
    clear(listWrap); listWrap.append(loadingEl());
    let data;
    try { data = await GET(`/api/admin/ip-bans?query=${encodeURIComponent(banState.query)}`); } catch (e) { toast(e.message, { type: 'error' }); return; }
    banState.items = data.items;
    clear(listWrap);
    if (!data.items.length) { listWrap.append(h('div', { class: 'empty-state' }, icon('gpp_bad'), h('h3', {}, '暂无封禁规则'), h('p', {}, '点击右上角「添加规则」封禁 IP 或网段。'))); return; }
    const table = h('table', { class: 'md-table' });
    const allCheck = h('input', { type: 'checkbox', onChange: () => { if (allCheck.checked) data.items.forEach((b) => banState.selected.add(b.id)); else banState.selected.clear(); reload(); } });
    table.append(h('thead', {}, h('tr', {}, h('th', { style: { width: '40px' } }, h('label', { class: 'check' }, allCheck, h('span', { class: 'check-box' }, icon('check')))), h('th', {}, '规则'), h('th', {}, '类型'), h('th', {}, '备注'), h('th', {}, '添加时间'), h('th', {}, '状态'), h('th', { class: 'text-right' }, '操作'))));
    const tbody = h('tbody'); table.append(tbody);
    const wrap = h('div', { class: 'table-wrap desktop-table' }, table);
    const cards = h('div', { class: 'mobile-cards' });
    for (const b of data.items) {
      const check = h('input', { type: 'checkbox', checked: banState.selected.has(b.id), onChange: () => { toggleSel(b.id); } });
      tbody.append(h('tr', { class: banState.selected.has(b.id) ? 'selected' : '' },
        h('td', {}, h('label', { class: 'check' }, check, h('span', { class: 'check-box' }, icon('check')))),
        h('td', {}, h('span', { class: 'mono' }, b.rule)),
        h('td', {}, h('span', { class: 'badge neutral' }, b.family === 6 ? 'IPv6' : 'IPv4')),
        h('td', { class: 'muted' }, b.note || '—'),
        h('td', { class: 'muted' }, formatDate(b.createdAt)),
        h('td', {}, b.enabled ? h('span', { class: 'badge success' }, '生效') : h('span', { class: 'badge neutral' }, '停用')),
        h('td', { class: 'text-right' }, banActions(b))));
      cards.append(h('div', { class: 'm-card' },
        h('div', { class: 'm-row' }, h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: banState.selected.has(b.id), onChange: () => toggleSel(b.id) }), h('span', { class: 'check-box' }, icon('check'))),
          h('div', { class: 'flex-1' }, h('div', { class: 'mono md-title-s' }, b.rule), h('div', { class: 'muted md-body-s' }, `${b.family === 6 ? 'IPv6' : 'IPv4'} · ${b.note || '无备注'}`)),
          b.enabled ? h('span', { class: 'badge success' }, '生效') : h('span', { class: 'badge neutral' }, '停用')),
        h('div', { class: 'm-actions' }, banActions(b))));
    }
    listWrap.append(wrap, cards);
    updateBar();
  }
  function banActions(b) {
    return h('div', { class: 'row gap-4 end' },
      h('button', { class: 'icon-btn stateful', title: b.enabled ? '停用' : '启用', onClick: () => batchBan([b.id], b.enabled ? 'disable' : 'enable') }, icon(b.enabled ? 'pause' : 'play_arrow')),
      h('button', { class: 'icon-btn stateful danger', title: '删除', onClick: () => batchBan([b.id], 'delete') }, icon('delete')));
  }
  function toggleSel(id) { if (banState.selected.has(id)) banState.selected.delete(id); else banState.selected.add(id); loadBans(); }
  function reload() { loadBans(); }
  function updateBar() {
    const n = banState.selected.size;
    bar.classList.toggle('hidden', n === 0);
    clear(bar);
    if (!n) return;
    bar.append(h('span', { class: 'count' }, `已选 ${n} 条`),
      h('button', { class: 'btn btn-text btn-sm stateful', onClick: () => batchBan([...banState.selected], 'enable') }, icon('play_arrow'), '启用'),
      h('button', { class: 'btn btn-text btn-sm stateful', onClick: () => batchBan([...banState.selected], 'disable') }, icon('pause'), '停用'),
      h('button', { class: 'btn btn-text btn-sm stateful', style: { color: 'var(--md-error)' }, onClick: () => batchBan([...banState.selected], 'delete') }, icon('delete'), '删除'),
      h('button', { class: 'icon-btn stateful', onClick: () => { banState.selected.clear(); loadBans(); } }, icon('close')));
  }
  async function batchBan(ids, action) {
    if (action === 'delete') { const ok = await confirmDialog({ title: '删除规则', message: `删除 ${ids.length} 条封禁规则？`, confirmLabel: '删除', danger: true }); if (!ok) return; }
    try { const r = await POST('/api/admin/ip-bans/batch', { ids, action }); toast(`已操作 ${r.affected} 条`, { type: 'success' }); banState.selected.clear(); loadBans(); }
    catch (e) { toast(e.message, { type: 'error' }); }
  }
  function openAddBan() {
    const ta = h('textarea', { class: 'tf-input batch-area', placeholder: ' ', rows: '6' });
    const result = h('div', { class: 'md-body-s', style: { marginTop: '8px' } });
    openDialog({
      title: '添加封禁规则', titleIcon: 'gpp_bad', wide: true,
      content: h('div', {},
        h('p', { class: 'md-body-m muted', style: { marginTop: 0 } }, '每行一条规则，可在规则后加空格写备注。例如：'),
        h('pre', { class: 'mono md-body-s', style: { background: 'var(--md-surface-container)', padding: '12px', borderRadius: '8px', overflow: 'auto' } }, '1.2.3.4  spam\n10.0.0.0/8  internal\n2001:db8::/32\n1.2.3.*  region'),
        h('label', { class: 'tf', style: { marginTop: '12px' } }, h('span', { class: 'tf-box', style: { alignItems: 'flex-start' } }, ta, h('span', { class: 'tf-label' }, '批量规则'))),
        result),
      actions: [
        { label: '取消', variant: 'text' },
        { label: '添加', variant: 'filled', icon: 'add', keepOpen: true, onClick: async (close) => {
          try {
            const r = await POST('/api/admin/ip-bans', { text: ta.value });
            let msg = `成功添加 ${r.added} 条`;
            if (r.errors.length) msg += `，${r.errors.length} 条失败：` + r.errors.slice(0, 3).map((e) => `${e.rule}(${e.error})`).join('；');
            result.textContent = msg;
            result.style.color = r.errors.length ? 'var(--md-warning)' : 'var(--md-success)';
            toast(`已添加 ${r.added} 条规则`, { type: 'success' });
            loadBans();
            if (!r.errors.length) close();
          } catch (e) { toast(e.message, { type: 'error' }); return false; }
        } },
      ],
    });
  }
  loadBans();
}

// ============================ 机器人 ============================
async function renderBots(page) {
  page.append(pageHead('存储机器人', h('button', { class: 'btn btn-filled btn-sm stateful', onClick: openAddBot }, icon('add'), '绑定机器人')));
  page.append(h('div', { class: 'auth-note', style: { marginBottom: '16px' } }, icon('info'),
    h('span', {}, '所有用户的加密内容都存入你绑定的 Telegram 机器人聊天。可绑定多个机器人分担流量。先向机器人发送一条消息，再点「自动检测」获取 Chat ID。')));
  const listWrap = h('div');
  page.append(listWrap);
  async function loadBots() {
    clear(listWrap); listWrap.append(loadingEl());
    let data;
    try { data = await GET('/api/admin/bots'); } catch (e) { toast(e.message, { type: 'error' }); return; }
    clear(listWrap);
    if (!data.items.length) { listWrap.append(h('div', { class: 'empty-state' }, icon('smart_toy'), h('h3', {}, '尚未绑定机器人'), h('p', {}, '绑定一个 Telegram 机器人后，用户才能保存内容。'))); return; }
    const statMap = new Map(data.stats.bots.map((b) => [b.id, b]));
    for (const b of data.items) {
      const st = statMap.get(b.id) || {};
      const dot = !b.enabled ? 'off' : b.lastError ? 'err' : 'ok';
      listWrap.append(h('div', { class: 'panel', style: { marginBottom: '16px' } },
        h('div', { class: 'panel-head' },
          h('span', { class: `status-dot ${dot}` }),
          h('h3', {}, b.name),
          b.username ? h('span', { class: 'muted md-body-s' }, '@' + b.username) : null,
          h('span', { class: `badge ${b.enabled ? 'success' : 'neutral'}` }, b.enabled ? '启用' : '停用'),
          h('button', { class: 'icon-btn stateful', title: b.enabled ? '停用' : '启用', onClick: async () => { try { await POST(`/api/admin/bots/${b.id}/toggle`); loadBots(); } catch (e) { toast(e.message, { type: 'error' }); } } }, icon(b.enabled ? 'pause' : 'play_arrow')),
          h('button', { class: 'icon-btn stateful danger', title: '移除', onClick: async () => { const ok = await confirmDialog({ title: '移除机器人', message: '移除后，存储在该机器人中的内容将无法访问。确定移除？', confirmLabel: '移除', danger: true }); if (!ok) return; try { await DEL(`/api/admin/bots/${b.id}`); toast('已移除', { type: 'success' }); loadBots(); } catch (e) { toast(e.message, { type: 'error' }); } } }, icon('delete'))),
        h('div', { class: 'kv-grid' },
          kv('Chat ID', b.chatId),
          kv('队列', `${st.queue || 0} 个待发送`),
          kv('已发送', String(st.sent || 0)),
          kv('冷却', st.cooldownMs ? `${(st.cooldownMs / 1000).toFixed(1)}s` : '无'),
          kv('最近成功', b.lastOkAt ? formatRelative(b.lastOkAt) : '—'),
          kv('Token', maskToken(b.token))),
        b.lastError ? h('div', { class: 'auth-note mt-16', style: { background: 'var(--md-error-container)', color: 'var(--md-on-error-container)' } }, icon('error'), h('span', {}, b.lastError)) : null));
    }
  }
  function openAddBot() {
    const name = h('input', { class: 'tf-input', placeholder: ' ', value: '存储机器人' });
    const token = h('input', { class: 'tf-input mono', placeholder: ' ', spellcheck: 'false' });
    const chat = h('input', { class: 'tf-input mono', placeholder: ' ', spellcheck: 'false' });
    const detectResult = h('div', { class: 'mt-8' });
    const testResult = h('div', { class: 'md-body-s', style: { marginTop: '8px', minHeight: '18px' } });
    const detectBtn = h('button', { class: 'btn btn-outlined btn-sm stateful', onClick: detect }, icon('search'), '自动检测 Chat');
    const testBtn = h('button', { class: 'btn btn-tonal btn-sm stateful', onClick: test }, icon('check_circle'), '测试连接');
    async function detect() {
      detectBtn.disabled = true;
      try {
        const r = await POST('/api/admin/bots/detect', { token: token.value.trim() });
        clear(detectResult);
        if (!r.chats.length) { detectResult.append(h('span', { class: 'muted md-body-s' }, '未检测到聊天，请先向机器人发送一条消息（或将其加入群组）后重试。')); }
        else {
          detectResult.append(h('div', { class: 'md-body-s muted mb-8' }, '检测到以下聊天，点击填入：'));
          const row = h('div', { class: 'chip-row' });
          for (const c of r.chats) row.append(h('button', { class: 'chip stateful', onClick: () => { chat.value = c.id; toast('已填入 Chat ID', { type: 'success' }); } }, icon('chat'), `${c.title} (${c.id})`));
          detectResult.append(row);
        }
      } catch (e) { toast(e.message, { type: 'error' }); }
      detectBtn.disabled = false;
    }
    async function test() {
      testBtn.disabled = true; testResult.textContent = '测试中…'; testResult.style.color = '';
      try {
        const r = await POST('/api/admin/bots/test', { token: token.value.trim(), chatId: chat.value.trim() });
        testResult.textContent = `✓ @${r.bot.username}` + (r.chat ? ` · 聊天「${r.chat.title}」可访问` : '');
        testResult.style.color = 'var(--md-success)';
      } catch (e) { testResult.textContent = e.message; testResult.style.color = 'var(--md-error)'; }
      testBtn.disabled = false;
    }
    openDialog({
      title: '绑定 Telegram 机器人', titleIcon: 'smart_toy', wide: true,
      content: h('div', {},
        h('label', { class: 'tf editor-field' }, h('span', { class: 'tf-box' }, name, h('span', { class: 'tf-label' }, '名称'))),
        h('label', { class: 'tf editor-field' }, h('span', { class: 'tf-box' }, token, h('span', { class: 'tf-label' }, 'Bot Token')), h('span', { class: 'tf-helper' }, '从 @BotFather 获取')),
        h('label', { class: 'tf editor-field' }, h('span', { class: 'tf-box' }, chat, h('span', { class: 'tf-label' }, 'Chat ID'))),
        h('div', { class: 'row gap-8 wrap' }, detectBtn, testBtn),
        detectResult, testResult),
      actions: [
        { label: '取消', variant: 'text' },
        { label: '绑定', variant: 'filled', icon: 'add', keepOpen: true, onClick: async (close) => {
          try { await POST('/api/admin/bots', { name: name.value.trim(), token: token.value.trim(), chatId: chat.value.trim() }); toast('绑定成功', { type: 'success' }); close(); loadBots(); }
          catch (e) { toast(e.message, { type: 'error' }); return false; }
        } },
      ],
    });
  }
  loadBots();
}
function maskToken(t) { if (!t) return ''; return t.length <= 12 ? t.slice(0, 3) + '•••' : t.slice(0, 6) + '••••••' + t.slice(-4); }

// 异步分段选择器：先捕获按钮引用（避免 await 后 e.currentTarget 为 null），
// 乐观更新选中态，失败回滚，busy 防重复点击。
function asyncSeg(options, current, apply) {
  const el = h('div', { class: 'segmented', style: { flexWrap: 'wrap' } });
  const btns = new Map();
  const mark = (id) => { for (const [k, b] of btns) b.classList.toggle('selected', k === id); };
  let busy = false;
  for (const [id, label] of options) {
    const btn = h('button', { class: id === current ? 'selected' : '' }, label);
    btn.addEventListener('click', async () => {
      if (busy || btn.classList.contains('selected')) return;
      busy = true;
      const prev = [...btns.entries()].find(([, b]) => b.classList.contains('selected'))?.[0];
      mark(id);
      try { await apply(id); }
      catch (err) { mark(prev); toast(err.message, { type: 'error' }); }
      busy = false;
    });
    btns.set(id, btn); el.append(btn);
  }
  return el;
}

// ============================ 域名 / CDN 管理 ============================
async function renderDomain(page) {
  page.append(pageHead('域名管理', h('button', { class: 'btn btn-tonal btn-sm stateful', onClick: () => renderPage() }, icon('refresh'), '刷新')));
  page.append(h('div', { class: 'auth-note', style: { marginBottom: '16px' } }, icon('info'),
    h('span', {}, '选择访问方式，填写域名后保存。已有 nip.io 地址也能随时更换；端口、证书等选项在高级设置中。')));
  const wrap = h('div', { class: 'domain-page' });
  let advancedOpen = false;
  page.append(wrap, loadingEl());
  let data;
  try { data = await GET('/api/admin/domain'); } catch (e) { toast(e.message, { type: 'error' }); return; }
  page.querySelector('.empty-state')?.remove();

  if (!page.isConnected) return;
  const draft = { ...data.settings, adminOrigin:data.settings.adminOrigin ? {...data.settings.adminOrigin} : null, adminCertPem:'',adminKeyPem:'',adminCfApiToken:'', certPem: '', keyPem: '', cfApiToken: '' };
  let endpoint = 'user';
  let diagnosticEpoch = 0;
  const originKeys = ['cdn','cdnName','sslMode','cfHttpPort','cfHttpsPort','realIpHeader','cfOnly'];
  const adminView = {};
  for (const key of originKeys) Object.defineProperty(adminView,key,{
    get:()=> (draft.adminOrigin || draft)[key], set:value=>{ draft.adminOrigin[key]=value; }
  });
  for (const [key,rootKey] of Object.entries({userHost:'adminHost',mode:'mode',certPem:'adminCertPem',keyPem:'adminKeyPem',cfApiToken:'adminCfApiToken'})) {
    Object.defineProperty(adminView,key,{get:()=>draft[rootKey],set:value=>{draft[rootKey]=value;}});
  }
  let f = draft;
  const haveCert = () => endpoint === 'admin' ? data.haveAdminCert : data.haveCert;
  const expanded = {user:false,admin:false};
  let savedAdminOrigin = draft.adminOrigin;
  function selectEndpoint(value) {
    diagnosticEpoch++;
    expanded[endpoint] = advancedOpen;
    endpoint = value; f = value === 'admin' ? adminView : draft;
    advancedOpen = expanded[value];
    clear(dnsResult); clear(diagResult); clear(cfVerifyResult);
    renderForm();
  }
  const statusPanel = h('div', { class: 'panel' });
  const formWrap = h('div');
  const resultWrap = h('div');
  wrap.append(statusPanel, formWrap, resultWrap);
  page._disposeAcceleration = renderAcceleration(wrap);

  function urlRow(label, url) {
    return h('div', { class: 'kv' }, h('div', { class: 'k' }, ['用户界面','管理界面'].includes(label) ? h('button',{class:'btn btn-text btn-sm',onClick:()=>selectEndpoint(label === '用户界面' ? 'user' : 'admin')},label,' · 配置') : label),
      h('div', { class: 'v row gap-4', style: { alignItems: 'center', flexWrap: 'wrap' } },
        h('a', { href: url, target: '_blank', rel: 'noopener', class: 'mono', style: { wordBreak: 'break-all' } }, url),
        h('button', { class: 'icon-btn stateful', title: '复制', onClick: () => copyText(url) }, icon('content_copy'))));
  }
  function renderStatus(d) {
    clear(statusPanel);
    const modeLabel = d.applyMode === 'systemd' || d.applyMode === 'sudo' ? '自动应用' : d.applyMode === 'inline' ? '热更新' : '手动应用';
    statusPanel.append(
      h('div', { class: 'panel-head' }, icon('public'), h('h3', {}, '当前访问'),
        h('span', { class: `badge ${d.canApply ? 'success' : 'warning'}` }, modeLabel),
        d.settings.cdn !== 'none' ? h('span', { class: `badge ${d.haveCert ? 'success' : 'neutral'}` }, d.haveCert ? '已装回源证书' : 'HTTP 回源无需证书') : null),
      h('div', { class: 'kv-grid' }, urlRow('用户界面', d.urls.userUrl), urlRow('管理界面', d.urls.adminUrl)));
    if (!d.canApply) statusPanel.append(h('div', { class: 'auth-note mt-16' }, icon('warning'),
      h('span', {}, '当前未启用特权自动应用：保存后后端会热更新，但 Caddy 与证书需按返回的 Caddyfile 手动应用。用一键脚本部署可启用自动应用。')));
  }
  renderStatus(data);

  function seg(options, get, set) {
    const el = h('div', { class: 'segmented', style: { flexWrap: 'wrap' } });
    for (const [id, label] of options) {
      el.append(h('button', { class: get() === id ? 'selected' : '', onClick: (e) => { set(id); [...el.children].forEach((b) => b.classList.remove('selected')); e.currentTarget.classList.add('selected'); renderForm(); } }, label));
    }
    return el;
  }
  function field(label, input, helper) {
    input.setAttribute('aria-label',label);
    return h('label', { class: 'tf editor-field' }, h('span', { class: 'tf-box' }, input, h('span', { class: 'tf-label' }, label)), helper ? h('span', { class: 'tf-helper' }, helper) : null);
  }
  function text(key, placeholder, opts = {}) {
    const input = h('input', { class: 'tf-input', placeholder: ' ', value: f[key] ?? '', ...opts });
    input.addEventListener('input', () => { f[key] = input.value; if (key === 'userHost' || key === 'adminHost') { diagnosticEpoch++; clear(dnsResult); clear(diagResult); const help = formWrap.querySelector('.domain-dns-help'); if (help) help.replaceWith(dnsHelp()); } });
    return input;
  }
  function num(key, min, max) {
    const input = h('input', { class: 'tf-input', type: 'number', min: String(min), max: String(max), placeholder: ' ', value: String(f[key] ?? '') });
    input.addEventListener('input', () => { f[key] = parseInt(input.value, 10); });
    return input;
  }

  const dnsResult = h('div', { class: 'md-body-s', style: { marginTop: '8px' } });
  const diagResult = h('div', { style: { marginTop: '12px' } });
  const cfVerifyResult = h('span', { class: 'md-body-s' });

  // DNS 记录助手：根据本机公网 IP 给出建议记录
  function dnsHelp() {
    const ip = data.serverIp;
    if (!ip) return h('p', { class: 'muted md-body-s' }, '未能自动获取本机公网 IP，可在 VPS 上运行 curl ip.sb 查看，并据此添加 DNS 记录。');
    const isV6 = ip.includes(':');
    const rows = [
      ['类型', isV6 ? 'AAAA' : 'A'],
      ['完整域名', f.userHost || '@'],
      ['记录值', ip],
      ['TTL', '自动 / 600'],
    ];
    const grid = h('div', { class: 'kv-grid' });
    for (const [k, v] of rows) {
      grid.append(h('div', { class: 'kv' }, h('div', { class: 'k' }, k),
        h('div', { class: 'v row gap-4', style: { alignItems: 'center' } }, h('span', { class: 'mono', style: { wordBreak: 'break-all' } }, v),
          k === '记录值' || k === '完整域名' ? h('button', { class: 'icon-btn stateful', style: { width: '28px', height: '28px' }, title: '复制', onClick: () => copyText(v) }, icon('content_copy', 'sm')) : null)));
    }
    return h('div', { class: 'domain-dns-help' },
      h('div', { class: 'md-body-s muted', style: { margin: '4px 0 8px' } }, f.cdn === 'cloudflare' ? '添加以下 DNS 记录并开启小黄云。主机记录只填域名前缀（例如 a），根域名填 @。' : f.cdn === 'custom' ? '按 CDN 厂商要求配置 CNAME，并将回源地址设为下方 IP。' : '在 DNS 服务商添加以下记录，关闭代理。'),
      grid);
  }

  // Cloudflare 受支持回源端口快选 + 非支持端口提示
  function portPicks() {
    const http = data.cfPorts?.http || [80, 8080, 8880, 2052, 2082, 2086, 2095];
    const https = data.cfPorts?.https || [443, 2053, 2083, 2087, 2096, 8443];
    const chipRow = (label, ports, key) => h('div', { style: { margin: '4px 0 8px' } },
      h('div', { class: 'md-body-s muted', style: { marginBottom: '4px' } }, label),
      h('div', { class: 'chip-row' }, ...ports.map((p) => h('button', {
        class: `chip stateful ${f[key] === p ? 'selected' : ''}`,
        onClick: () => { f[key] = p; renderForm(); },
      }, String(p)))));
    const badHttp = !http.includes(f.cfHttpPort);
    const badHttps = !https.includes(f.cfHttpsPort);
    return h('div', {},
      chipRow('Cloudflare 支持的 HTTP 回源端口', http, 'cfHttpPort'),
      chipRow('Cloudflare 支持的 HTTPS 回源端口', https, 'cfHttpsPort'),
      (badHttp || badHttps || f.cfHttpPort !== 80 || f.cfHttpsPort !== 443) ? h('div', { class: 'auth-note', style: { marginTop: '4px' } }, icon('warning'),
        h('span', {}, '非标准回源端口需在 CDN 配置回源端口规则；仅在此修改不会自动更改 Cloudflare 的回源目标。')) : null);
  }

  function renderForm() {
    clear(formWrap);
    const acceleration = wrap.querySelector('.acceleration');
    if (acceleration) acceleration.hidden = endpoint === 'admin';
    const tabs = h('div',{class:'segmented',role:'group','aria-label':'选择配置入口',style:{marginBottom:'16px',display:'flex'}},
      ...[['user','用户界面'],['admin','管理界面']].map(([id,label])=>h('button',{class:endpoint===id?'selected':'','aria-pressed':String(endpoint===id),onClick:()=>selectEndpoint(id),style:{flex:'1'}},label)));
    formWrap.append(tabs,h('h3',{},endpoint==='user'?'用户界面配置':'管理界面配置'),h('p',{class:'muted md-body-s'},'两端草稿分别保留，应用时一起校验保存。仅修改管理端不会改变用户域名。'));
    if(endpoint==='admin') {
      const independent=h('input',{type:'checkbox',checked:!!draft.adminOrigin,onChange:()=>{
        if(!independent.checked) savedAdminOrigin=draft.adminOrigin;
        draft.adminOrigin=independent.checked ? savedAdminOrigin || Object.fromEntries(originKeys.map(k=>[k,draft[k]])) : null;
        renderForm();
      }});
      formWrap.append(h('label',{class:'row gap-8'},independent,h('span',{},'管理端使用独立配置')));
      if(!draft.adminOrigin) {
        formWrap.append(h('div',{class:'panel'},field('管理域名（可选）',text('userHost','admin.example.com')),
          h('p',{class:'auth-note'},'当前沿用用户端回源配置。启用独立配置后，可单独设置 CDN、端口、证书、Token 和诊断。共享证书必须覆盖两个域名。'),
          h('button',{class:'btn btn-filled',onClick:apply},'应用更改')));
        return;
      }
    }
    const cdnOn = f.cdn !== 'none';
    // 域名 panel
    const domainPanel = h('div', { class: 'panel' },
      h('div', { class: 'panel-head' }, icon('language'), h('h3', {}, '2. 填写访问域名')),
      endpoint === 'user' ? h('div', { style: { marginBottom: '12px' } }, seg([['domain', '自定义域名'], ['ip', 'nip.io / IP']], () => f.mode, (v) => { f.mode = v; })) : null,
      field(endpoint === 'admin' ? '管理域名' : '用户域名', text('userHost', 'm.example.com', { spellcheck: 'false' }), '不含协议与端口，例如 m.example.com'),
      h('div', { class: 'row gap-8 wrap', style: { marginTop: '4px' } },
        h('button', { class: 'btn btn-outlined btn-sm stateful', onClick: checkDns }, icon('dns'), '检测 DNS 解析'),
        h('button', { class: 'btn btn-tonal btn-sm stateful', onClick: runProbe }, icon('fact_check'), '一键诊断（CDN / 证书 / 回源）')),
      dnsResult, f.mode === 'domain' ? dnsHelp() : h('p', { class: 'muted' }, '保留自动生成的地址，无需手动添加 DNS 记录。'), diagResult);
    // CDN panel
    const cdnPanel = h('div', { class: 'panel' },
      h('div', { class: 'panel-head' }, icon('cloud'), h('h3', {}, '1. 选择访问方式')),
      h('div', { style: { marginBottom: '12px' } }, seg([['none', '直连（无 CDN）'], ['cloudflare', 'Cloudflare 小黄云'], ['custom', '第三方 CDN']], () => f.cdn, (v) => { f.cdn = v; if (v !== 'none' && !['flexible', 'full', 'strict'].includes(f.sslMode)) f.sslMode = haveCert() ? 'strict' : 'flexible'; if (v === 'cloudflare') f.realIpHeader = 'cf-connecting-ip'; else if (v === 'custom') f.realIpHeader = 'x-forwarded-for'; })),
      f.cdn === 'custom' ? field('CDN 名称', text('cdnName', '例如 阿里云 CDN / 腾讯云 EdgeOne')) : null,
      cdnOn ? h('div', { class: 'domain-technical' },
        h('div', { class: 'md-body-s muted', style: { margin: '4px 0 8px' } }, '加密模式（CDN 到源站）'),
        h('div', { style: { marginBottom: '12px' } }, seg([['flexible', '简易 · Flexible'], ['full', '加密 · Full'], ['strict', '严格 · Strict']], () => f.sslMode, (v) => { f.sslMode = v; })),
        h('div', { class: 'two-col' },
          field('回源 HTTP 端口', num('cfHttpPort', 1, 65535), 'Flexible 使用，默认 80'),
          field('回源 HTTPS 端口', num('cfHttpsPort', 1, 65535), 'Full/Strict 使用，默认 443，可填冷门端口')),
        f.cdn === 'cloudflare' ? portPicks() : null,
        h('label', { class: 'tf editor-field' }, h('span', { class: 'tf-box' },
          (() => { const sel = h('select', { class: 'tf-input' }, ...[['cf-connecting-ip', 'CF-Connecting-IP（Cloudflare）'], ['x-forwarded-for', 'X-Forwarded-For（首个 IP）'], ['x-real-ip', 'X-Real-IP'], ['true-client-ip', 'True-Client-IP']].map(([v, l]) => h('option', { value: v, selected: f.realIpHeader === v }, l))); sel.addEventListener('change', () => { f.realIpHeader = sel.value; }); return sel; })(),
          h('span', { class: 'tf-label' }, '真实访客 IP 头'))),
        f.cdn === 'cloudflare' ? h('div', { class: 'settings-row', style: { padding: '8px 0' } },
          h('div', { class: 's-content' }, h('div', { class: 's-title' }, '仅允许 Cloudflare IP 回源'), h('div', { class: 's-sub' }, '反向代理仅放行 CF 节点；安装器已设置的 UFW 限制需通过 SSH 调整')),
          (() => { const sw = h('input', { type: 'checkbox', checked: f.cfOnly }); sw.addEventListener('change', () => { f.cfOnly = sw.checked; }); return h('label', { class: 'switch' }, sw, h('span', { class: 'switch-track' }, h('span', { class: 'switch-thumb' }))); })()) : null,
      ) : h('p', { class: 'muted md-body-m' }, "直连模式由 Caddy 自动申请 Let's Encrypt 证书（需域名解析到本机且开放 80/443）。"));
    // 证书 panel（仅 CDN）
    let certPanel = null;
    if (cdnOn) {
      const certTa = h('textarea', { value: f.certPem, class: 'tf-input mono', placeholder: ' ', rows: '3', spellcheck: 'false' });
      certTa.addEventListener('input', () => { f.certPem = certTa.value; });
      const keyTa = h('textarea', { value: f.keyPem, class: 'tf-input mono', placeholder: ' ', rows: '3', spellcheck: 'false' });
      keyTa.addEventListener('input', () => { f.keyPem = keyTa.value; });
      certPanel = h('div', { class: 'panel' },
        h('div', { class: 'panel-head' }, icon('lock'), h('h3', {}, '回源证书（Full / Strict）'),
          h('span', { class: `badge ${haveCert() ? 'success' : 'neutral'}` }, haveCert() ? '已安装' : '未安装')),
        h('p', { class: 'muted md-body-m', style: { marginTop: 0 } }, 'Strict 需要受 CDN 信任的回源证书。Cloudflare 可在 SSL/TLS → Origin Server 创建 Origin CA 证书后粘贴到下方；或填写 API Token 自动签发。留空则沿用已安装证书或仅用 Flexible。'),
        field('证书 PEM（certificate）', certTa),
        field('私钥 PEM（private key）', keyTa),
        f.cdn === 'cloudflare' ? h('div', {},
          field('Cloudflare API Token（可选，自动签发）', text('cfApiToken', '需 SSL and Certificates 权限', { spellcheck: 'false', type: 'password', autocomplete: 'off' })),
          h('div', { class: 'row gap-8 wrap', style: { alignItems: 'center' } },
            h('button', { class: 'btn btn-outlined btn-sm stateful', onClick: verifyToken }, icon('verified_user'), '验证 Token'),
            cfVerifyResult)) : null);
    }
    // 操作
    const actions = h('div', { class: 'row end gap-8 wrap', style: { marginTop: '16px' } },
      h('button', { class: 'btn btn-outlined stateful', onClick: preview }, icon('description'), '预览 Caddyfile'),
      h('button', { class: 'btn btn-filled stateful', onClick: apply }, icon('save'), '应用更改'));
    const advanced = h('details', { class: 'domain-advanced panel', open: advancedOpen },
      h('summary', {}, '高级设置 · 加密、端口、证书与防火墙'));
    advanced.addEventListener('toggle', () => { if (advanced.isConnected) advancedOpen = advanced.open; });
    const technical = cdnPanel.querySelector('.domain-technical');
    if (technical) advanced.append(technical);
    if (certPanel) advanced.append(certPanel);
    advanced.append(actions.firstChild);
    if (cdnOn) cdnPanel.append(h('p', { class: 'auth-note' }, icon('info'), h('span', {},
      f.sslMode === 'flexible' ? '当前为简易连接：无需回源证书。请在 CDN 控制台将 SSL 模式设为 Flexible（源站链路为 HTTP）。需要全程加密时，在高级设置中选 Strict 并配置证书。' : `当前为 ${f.sslMode === 'strict' ? 'Strict' : 'Full'} 加密连接，请确保 CDN 控制台模式一致，并配置回源证书。`)));
    formWrap.append(domainPanel, cdnPanel, advanced,
      h('p', { class: 'muted md-body-s' }, '保存会重载代理；更换域名后需在新地址重新登录。CDN 控制台设置不会自动修改。'), actions);
  }

  async function checkDns() {
    const target = f, epoch = diagnosticEpoch;
    clear(dnsResult); dnsResult.append(h('span', { class: 'muted' }, '解析中…'));
    try {
      const r = await POST('/api/admin/domain/check', { host: f.userHost });
      if(f !== target || epoch !== diagnosticEpoch) return;
      clear(dnsResult);
      if (r.error) { dnsResult.append(h('span', { style: { color: 'var(--md-error)' } }, r.error)); return; }
      dnsResult.append(h('span', { class: 'muted' }, '解析到：'), h('span', { class: 'mono' }, r.addresses.join(', ')),
        r.cloudflare ? h('span', { class: 'badge success', style: { marginLeft: '8px' } }, 'Cloudflare 边缘') : h('span', { class: 'badge neutral', style: { marginLeft: '8px' } }, '非 CF IP'),
        r.matchesServer === true ? h('span', { class: 'badge success', style: { marginLeft: '8px' } }, '指向本机') :
        r.matchesServer === false && !r.cloudflare && f.cdn === 'none' ? h('span', { class: 'badge warning', style: { marginLeft: '8px' } }, '与本机 IP 不一致') : null);
    } catch (e) { if(f !== target || epoch !== diagnosticEpoch) return; clear(dnsResult); dnsResult.append(h('span', { style: { color: 'var(--md-error)' } }, e.message)); }
  }

  // 一键诊断：DNS / 边缘 HTTPS / TLS 证书 / 本机回源
  async function runProbe() {
    const target = f, epoch = diagnosticEpoch;
    clear(diagResult); diagResult.append(h('span', { class: 'muted md-body-s' }, '诊断中（最多约 10 秒）…'));
    let r;
    try { r = await POST('/api/admin/domain/probe', { host: f.userHost }); if(f !== target || epoch !== diagnosticEpoch) return; }
    catch (e) { if(f !== target || epoch !== diagnosticEpoch) return; clear(diagResult); diagResult.append(h('span', { style: { color: 'var(--md-error)' } }, e.message)); return; }
    clear(diagResult);
    const line = (label, ok, detail) => h('div', { class: 'kv' },
      h('div', { class: 'k row gap-4', style: { alignItems: 'center' } }, icon(ok ? 'check_circle' : 'error', 'sm'), label),
      h('div', { class: 'v mono md-body-s', style: { wordBreak: 'break-all', color: ok ? 'var(--md-success)' : 'var(--md-error)' } }, detail));
    const grid = h('div', { class: 'kv-grid' });
    if (r.dns) grid.append(line('DNS 解析', !r.dns.error, r.dns.error || r.dns.addresses.join(', ')));
    if (r.https) grid.append(line('HTTPS 边缘', r.https.ok, r.https.ok ? `${r.https.status} · ${r.https.latencyMs}ms${r.https.viaCloudflare ? ' · 经 Cloudflare' : ''}` : (r.https.error || `HTTP ${r.https.status}`)));
    if (r.http) grid.append(line('HTTP 边缘', r.http.ok, r.http.ok ? `${r.http.status} · ${r.http.latencyMs}ms` : (r.http.error || `HTTP ${r.http.status}`)));
    if (r.tls) grid.append(line('边缘证书', r.tls.daysLeft > 15, `${r.tls.issuer || r.tls.subject} · 剩余 ${r.tls.daysLeft} 天`));
    if (r.origin) grid.append(line('后端进程自检', r.origin.ok, r.origin.ok ? `正常 · ${r.origin.latencyMs}ms` : (r.origin.error || '失败')));
    diagResult.append(
      h('div', { class: 'md-body-s muted', style: { margin: '4px 0 8px' } }, '诊断结果'),
      grid,
      h('div', { class: 'auth-note', style: { marginTop: '8px' } }, icon('info'), h('div', {}, ...(r.hints || []).map(hint => h('p', { style: { margin: '4px 0' } }, hint)))));
  }

  async function verifyToken() {
    const target = f, epoch = diagnosticEpoch;
    clear(cfVerifyResult); cfVerifyResult.append(h('span', { class: 'muted' }, '验证中…'));
    try {
      const r = await POST('/api/admin/domain/cf-verify', { token: f.cfApiToken });
      if(f !== target || epoch !== diagnosticEpoch) return;
      clear(cfVerifyResult);
      cfVerifyResult.append(r.ok
        ? h('span', { class: 'badge success' }, `Token 有效（${r.status}）`)
        : h('span', { class: 'badge warning' }, r.error || 'Token 无效'));
    } catch (e) { if(f !== target || epoch !== diagnosticEpoch) return; clear(cfVerifyResult); cfVerifyResult.append(h('span', { class: 'badge warning' }, e.message)); }
  }

  async function preview() {
    try {
      const r = await POST('/api/admin/domain/preview', draft);
      const pre = h('pre', { class: 'mono md-body-s', style: { background: 'var(--md-surface-container)', padding: '12px', borderRadius: '8px', overflow: 'auto', maxHeight: '320px', whiteSpace: 'pre-wrap', wordBreak: 'break-all' } }, r.caddyfile);
      openDialog({
        title: 'Caddyfile 预览', titleIcon: 'description', wide: true,
        content: h('div', {}, r.warnings.length ? h('div', { class: 'auth-note', style: { marginBottom: '12px' } }, icon('warning'), h('span', {}, r.warnings.join(' '))) : null, pre),
        actions: [{ label: '复制', variant: 'tonal', icon: 'content_copy', onClick: () => copyText(r.caddyfile) }, { label: '关闭', variant: 'text' }],
      });
    } catch (e) { toast(e.message, { type: 'error' }); }
  }

  async function apply() {
    const f = draft;
    if (f.adminOrigin) {
      if (!f.adminHost || f.adminHost === f.userHost) { toast('独立回源需要不同的管理域名',{type:'error'}); return; }
      if (!!f.adminCertPem.trim() !== !!f.adminKeyPem.trim()) { toast('管理端证书与私钥必须同时填写',{type:'error'}); return; }
      if (f.adminOrigin.cdn !== 'none' && ['full','strict'].includes(f.adminOrigin.sslMode) && !data.haveAdminCert && !(f.adminCertPem.trim() && f.adminKeyPem.trim()) && !(f.adminOrigin.cdn === 'cloudflare' && f.adminCfApiToken.trim())) {selectEndpoint('admin'); advancedOpen=true; renderForm(); toast('管理端加密回源需要独立证书或 Cloudflare Token',{type:'error'});return;}
    }
    if (f.cdn !== 'none' && f.sslMode !== 'flexible' && !data.haveCert && !(f.certPem.trim() && f.keyPem.trim()) && !(f.cdn === 'cloudflare' && f.cfApiToken.trim())) {
      selectEndpoint('user'); advancedOpen = true; renderForm();
      toast('加密回源需要证书：请配置证书或选择简易 Flexible 模式', { type: 'error' }); return;
    }
    if (!!f.certPem.trim() !== !!f.keyPem.trim()) { toast('请同时填写证书和私钥', { type: 'error' }); return; }
    const ok = await confirmDialog({ title: '应用域名更改', message: '将更新域名 / CDN / 回源端口并重载代理。若域名发生变化，当前会话会失效，需要到新域名重新登录。确定继续？', confirmLabel: '应用', icon: 'language' });
    if (!ok) return;
    clear(resultWrap);
    let r;
    try { r = await POST('/api/admin/domain', f); }
    catch (e) { clear(resultWrap); toast(e.message, { type: 'error' }); return; }
    if (r.applying) {
      // 特权应用：先展示新网址（域名变更后旧域名可能立即不可达），再后台轮询结果
      showResult({ ok: true, applying: true, urls: r.urls, warnings: r.warnings, settings: r.settings });
      let result = null;
      for (let i = 0; i < 30; i++) {
        await new Promise((res) => setTimeout(res, 1500));
        try { const p = await GET(`/api/admin/domain/result?id=${encodeURIComponent(r.id)}`); if (p.result) { result = p.result; break; } } catch {}
      }
      if (result) showResult(result);
      else resultWrap.append(h('div', { class: 'auth-note mt-16' }, icon('info'), h('span', {}, '若长时间未生效，请检查服务状态（systemctl status nui-memo caddy），或直接打开上方新网址确认。')));
      return;
    }
    showResult(r);
  }

  function showResult(r) {
    clear(resultWrap);
    const title = r.applying ? '正在应用' : r.ok ? '已应用' : '应用失败';
    const panel = h('div', { class: 'panel' },
      h('div', { class: 'panel-head' }, icon(r.applying ? 'schedule' : r.ok ? 'check_circle' : 'error'), h('h3', {}, title),
        h('span', { class: `badge ${r.ok ? 'success' : 'warning'}` }, r.applying ? '重载中' : r.ok ? '成功' : '失败')));
    if (r.applying) panel.append(h('div', { class: 'auth-note mt-16' }, icon('info'), h('span', {}, '服务可能短暂重启。若域名已变更，当前会话会失效，请打开下方新管理网址重新登录。')));
    if (r.error) panel.append(h('div', { class: 'auth-note', style: { background: 'var(--md-error-container)', color: 'var(--md-on-error-container)' } }, icon('error'), h('span', {}, r.error)));
    if (r.warnings && r.warnings.length) panel.append(h('div', { class: 'auth-note mt-16' }, icon('warning'), h('span', {}, r.warnings.join(' '))));
    if (r.ok && r.urls) {
      panel.append(h('div', { class: 'kv-grid mt-16' }, urlRow('新用户界面', r.urls.userUrl), urlRow('新管理界面', r.urls.adminUrl)),
        h('div', { class: 'row gap-8 wrap mt-16' },
          h('a', { class: 'btn btn-filled btn-sm stateful', href: r.urls.adminUrl, target: '_blank', rel: 'noopener' }, icon('open_in_new'), '打开新管理界面'),
          h('a', { class: 'btn btn-outlined btn-sm stateful', href: r.urls.userUrl, target: '_blank', rel: 'noopener' }, icon('open_in_new'), '打开用户界面')));
    }
    if (r.caddyfile && (r.manual || !r.ok)) {
      panel.append(h('div', { class: 'md-body-s muted mt-16' }, r.instructions || '请手动应用以下 Caddyfile：'),
        h('pre', { class: 'mono md-body-s', style: { background: 'var(--md-surface-container)', padding: '12px', borderRadius: '8px', overflow: 'auto', maxHeight: '280px', whiteSpace: 'pre-wrap', wordBreak: 'break-all' } }, r.caddyfile));
    }
    resultWrap.append(panel);
    if (r.ok && !r.applying) { toast('域名设置已应用', { type: 'success' }); GET('/api/admin/domain').then(renderStatus).catch(() => {}); }
  }

  renderForm();
  if (data.lastResult && !data.lastResult.ok) showResult(data.lastResult);
}

// ============================ 前端 / 跨域 ============================
async function renderFrontend(page) {
  page.append(pageHead('前端 / 跨域', h('button', { class: 'btn btn-tonal btn-sm stateful', onClick: () => renderPage() }, icon('refresh'), '刷新')));
  page.append(h('div', { class: 'auth-note', style: { marginBottom: '16px' } }, icon('info'),
    h('span', {}, '把用户界面导出为单文件 index.html（自动写入 API 地址），可部署到 GitHub Pages 等任意静态托管；在此配置跨域白名单或关闭跨域限制后即可开箱即用。')));
  const wrap = h('div'); page.append(wrap, loadingEl());
  let data; try { data = await GET('/api/admin/cors'); } catch (e) { toast(e.message, { type: 'error' }); return; }
  page.querySelector('.empty-state')?.remove();

  // 跨域模式
  const modeSeg = asyncSeg([['off', '关闭跨域'], ['whitelist', '白名单'], ['open', '允许所有']], data.mode,
    async (id) => { await PATCH('/api/admin/cors', { mode: id }); toast('跨域模式已更新', { type: 'success' }); });
  // 白名单
  const listWrap = h('div');
  const addBtn = h('button', { class: 'btn btn-filled btn-sm stateful', onClick: openAdd }, icon('add'), '批量添加');
  async function loadOrigins() {
    const d = await GET('/api/admin/cors');
    clear(listWrap);
    if (!d.origins.length) { listWrap.append(h('p', { class: 'muted' }, '暂无白名单。添加前端 Origin（如 https://xxx.github.io）。')); return; }
    const row = h('div', { class: 'chip-row' });
    for (const o of d.origins) row.append(h('span', { class: 'chip selected' }, icon('public'), o,
      h('button', { class: 'icon-btn stateful', style: { width: '24px', height: '24px' }, title: '移除', onClick: async () => { await POST('/api/admin/cors/origins/batch', { origins: [o] }); loadOrigins(); } }, icon('close', 'sm'))));
    listWrap.append(row);
  }
  function openAdd() {
    const ta = h('textarea', { class: 'tf-input batch-area', rows: '5', placeholder: ' ' });
    openDialog({
      title: '批量添加跨域白名单', titleIcon: 'public', wide: true,
      content: h('div', {}, h('p', { class: 'muted md-body-m', style: { marginTop: 0 } }, '每行一个 Origin，例如 https://name.github.io 或 https://app.example.com'),
        h('label', { class: 'tf' }, h('span', { class: 'tf-box', style: { alignItems: 'flex-start' } }, ta, h('span', { class: 'tf-label' }, 'Origins')))),
      actions: [{ label: '取消', variant: 'text' }, { label: '添加', variant: 'filled', keepOpen: true, onClick: async (close) => { try { const r = await POST('/api/admin/cors/origins', { text: ta.value }); toast(`已添加 ${r.added} 个`, { type: 'success' }); close(); loadOrigins(); } catch (e) { toast(e.message, { type: 'error' }); return false; } } }],
    });
  }
  // 导出
  const baseInput = h('input', { class: 'tf-input mono', placeholder: ' ', value: data.userUrl || '' });
  const exportBtn = h('button', { class: 'btn btn-filled stateful', onClick: doExport }, icon('download'), '导出 index.html');
  async function doExport() {
    exportBtn.disabled = true;
    try {
      const res = await GET(`/api/admin/export?base=${encodeURIComponent(baseInput.value.trim())}`);
      const blob = await res.blob();
      downloadBlob(blob, 'index.html');
      toast('已导出 index.html，部署到静态托管并配置跨域即可使用', { type: 'success' });
    } catch (e) { toast(e.message, { type: 'error' }); }
    exportBtn.disabled = false;
  }
  wrap.append(
    h('div', { class: 'panel' }, h('div', { class: 'panel-head' }, icon('public'), h('h3', {}, '跨域限制')), modeSeg,
      h('div', { class: 'mt-16' }, h('div', { class: 'row between wrap gap-8', style: { marginBottom: '8px' } }, h('span', { class: 'md-title-s' }, '白名单'), addBtn), listWrap)),
    h('div', { class: 'panel' }, h('div', { class: 'panel-head' }, icon('devices'), h('h3', {}, '导出单文件前端'),
      h('span', { class: `badge ${data.exportReady ? 'success' : 'warning'}` }, data.exportReady ? '模板就绪' : '模板未构建')),
      h('p', { class: 'muted md-body-m', style: { marginTop: 0 } }, '导出的 index.html 已内联全部样式/脚本/图标/加密 Worker，并自动写入下方 API 地址，无需手动修改。'),
      h('label', { class: 'tf editor-field' }, h('span', { class: 'tf-box' }, baseInput, h('span', { class: 'tf-label' }, 'API 地址（你的用户域名）'))),
      h('div', { class: 'row end' }, exportBtn)));
  loadOrigins();
}

// ============================ 广告 ============================
async function renderAds(page) {
  page.append(pageHead('广告投放', h('button', { class: 'btn btn-tonal btn-sm stateful', onClick: () => renderPage() }, icon('refresh'), '刷新')));
  const wrap = h('div'); page.append(wrap, loadingEl());
  let data; try { data = await GET('/api/admin/ads'); } catch (e) { toast(e.message, { type: 'error' }); return; }
  page.querySelector('.empty-state')?.remove();
  const a = data.ads;
  const enabled = h('input', { type: 'checkbox', checked: a.enabled });
  enabled.addEventListener('change', async () => { try { await PATCH('/api/admin/ads', { enabled: enabled.checked }); toast(enabled.checked ? '广告已开启' : '广告已关闭', { type: 'success' }); } catch (e) { toast(e.message, { type: 'error' }); } });
  const modeSeg = asyncSeg([['custom', '自有广告'], ['html', '广告网络代码']], a.mode,
    async (id) => { await PATCH('/api/admin/ads', { mode: id }); toast('广告模式已更新', { type: 'success' }); });
  // 自有广告列表
  const listWrap = h('div');
  async function loadItems() {
    const d = await GET('/api/admin/ads');
    clear(listWrap);
    if (!d.ads.items.length) { listWrap.append(h('p', { class: 'muted' }, '暂无自有广告。')); return; }
    for (const it of d.ads.items) {
      listWrap.append(h('div', { class: 'settings-row' },
        h('div', { class: 's-content' }, h('div', { class: 's-title' }, it.title), h('div', { class: 's-sub truncate' }, it.url || it.image || '—')),
        h('label', { class: 'switch' }, (() => { const sw = h('input', { type: 'checkbox', checked: it.enabled }); sw.addEventListener('change', async () => { await POST('/api/admin/ads/items/batch', { ids: [it.id], action: sw.checked ? 'enable' : 'disable' }); }); return sw; })(), h('span', { class: 'switch-track' }, h('span', { class: 'switch-thumb' }))),
        h('button', { class: 'icon-btn stateful danger', title: '删除', onClick: async () => { await POST('/api/admin/ads/items/batch', { ids: [it.id], action: 'delete' }); loadItems(); } }, icon('delete'))));
    }
  }
  function openAdd() {
    const title = h('input', { class: 'tf-input', placeholder: ' ' });
    const image = h('input', { class: 'tf-input', placeholder: ' ', spellcheck: 'false' });
    const url = h('input', { class: 'tf-input', placeholder: ' ', spellcheck: 'false' });
    openDialog({
      title: '添加自有广告', titleIcon: 'sell',
      content: h('div', {},
        h('label', { class: 'tf editor-field' }, h('span', { class: 'tf-box' }, title, h('span', { class: 'tf-label' }, '标题'))),
        h('label', { class: 'tf editor-field' }, h('span', { class: 'tf-box' }, image, h('span', { class: 'tf-label' }, '图片 URL（https，可选）'))),
        h('label', { class: 'tf editor-field' }, h('span', { class: 'tf-box' }, url, h('span', { class: 'tf-label' }, '点击跳转链接（https，可选）')))),
      actions: [{ label: '取消', variant: 'text' }, { label: '添加', variant: 'filled', keepOpen: true, onClick: async (close) => { try { await POST('/api/admin/ads/items', { title: title.value, image: image.value, url: url.value }); toast('已添加', { type: 'success' }); close(); loadItems(); } catch (e) { toast(e.message, { type: 'error' }); return false; } } }],
    });
  }
  // 广告网络代码
  const htmlTa = h('textarea', { class: 'tf-input mono', rows: '6', placeholder: ' ', spellcheck: 'false' });
  htmlTa.value = a.html || '';
  const saveHtml = h('button', { class: 'btn btn-outlined btn-sm stateful', onClick: async () => { try { await PATCH('/api/admin/ads', { html: htmlTa.value }); toast('广告代码已保存', { type: 'success' }); } catch (e) { toast(e.message, { type: 'error' }); } } }, icon('save'), '保存代码');
  wrap.append(
    h('div', { class: 'panel' }, h('div', { class: 'panel-head' }, icon('sell'), h('h3', {}, '投放开关')),
      h('div', { class: 'settings-row', style: { padding: '8px 0', borderBottom: 'none' } }, h('div', { class: 's-content' }, h('div', { class: 's-title' }, '启用广告'), h('div', { class: 's-sub' }, '在用户界面展示广告位')),
        h('label', { class: 'switch' }, enabled, h('span', { class: 'switch-track' }, h('span', { class: 'switch-thumb' })))),
      h('div', { class: 'mt-16' }, modeSeg)),
    h('div', { class: 'panel' }, h('div', { class: 'panel-head' }, icon('sell'), h('h3', {}, '自有广告'),
      h('button', { class: 'btn btn-filled btn-sm stateful', onClick: openAdd }, icon('add'), '添加')), listWrap),
    h('div', { class: 'panel' }, h('div', { class: 'panel-head' }, icon('integration_instructions'), h('h3', {}, '广告网络代码（AdSense 等）')),
      h('p', { class: 'muted md-body-m', style: { marginTop: 0 } }, '粘贴广告网络的 HTML/JS 代码，将在沙箱 iframe 中渲染。自有广告模式不受影响。'),
      h('label', { class: 'tf editor-field' }, h('span', { class: 'tf-box', style: { alignItems: 'flex-start' } }, htmlTa, h('span', { class: 'tf-label' }, '广告代码'))),
      h('div', { class: 'row end' }, saveHtml)));
  loadItems();
}

// ============================ 设置 ============================
async function renderSettings(page) {
  page.append(pageHead('设置'));
  const wrap = h('div');
  page.append(wrap, loadingEl());
  let data;
  try { data = await GET('/api/admin/settings'); } catch (e) { toast(e.message, { type: 'error' }); return; }
  page.querySelector('.empty-state')?.remove();
  const s = data.settings;
  const siteName = h('input', { class: 'tf-input', placeholder: ' ', value: s.siteName, maxlength: '30' });
  const motd = h('textarea', { class: 'tf-input', placeholder: ' ', rows: '2', value: s.motd || '' });
  const regSwitch = h('input', { type: 'checkbox', checked: s.registrationOpen });
  const maxFile = h('input', { class: 'tf-input', type: 'number', min: '1', max: '512', value: String(s.maxFileSizeMB) });
  const userDays = h('input', { class: 'tf-input', type: 'number', min: '1', max: '365', value: String(s.userSessionDays) });
  const adminHours = h('input', { class: 'tf-input', type: 'number', min: '1', max: '168', value: String(s.adminSessionHours) });
  const autoLock = h('input', { class: 'tf-input', type: 'number', min: '0', max: '1440', value: String(s.autoLockMinutes) });
  const saveBtn = h('button', { class: 'btn btn-filled stateful', onClick: save }, icon('save'), '保存设置');
  wrap.append(
    h('div', { class: 'panel' }, h('div', { class: 'panel-head' }, icon('tune'), h('h3', {}, '站点')),
      h('label', { class: 'tf editor-field' }, h('span', { class: 'tf-box' }, siteName, h('span', { class: 'tf-label' }, '站点名称'))),
      h('label', { class: 'tf editor-field' }, h('span', { class: 'tf-box', style: { alignItems: 'flex-start' } }, motd, h('span', { class: 'tf-label' }, '公告（可选）'))),
      h('div', { class: 'settings-row', style: { padding: '8px 0' } }, h('div', { class: 's-content' }, h('div', { class: 's-title' }, '开放注册'), h('div', { class: 's-sub' }, '允许新用户注册账号')),
        h('label', { class: 'switch' }, regSwitch, h('span', { class: 'switch-track' }, h('span', { class: 'switch-thumb' }))))),
    h('div', { class: 'panel' }, h('div', { class: 'panel-head' }, icon('security'), h('h3', {}, '限制与安全')),
      h('div', { class: 'two-col' },
        h('label', { class: 'tf editor-field' }, h('span', { class: 'tf-box' }, maxFile, h('span', { class: 'tf-label' }, '单文件上限 (MB)'))),
        h('label', { class: 'tf editor-field' }, h('span', { class: 'tf-box' }, autoLock, h('span', { class: 'tf-label' }, '自动锁定 (分钟，0=关闭)'))),
        h('label', { class: 'tf editor-field' }, h('span', { class: 'tf-box' }, userDays, h('span', { class: 'tf-label' }, '用户会话 (天)'))),
        h('label', { class: 'tf editor-field' }, h('span', { class: 'tf-box' }, adminHours, h('span', { class: 'tf-label' }, '管理员会话 (小时)'))))),
    h('div', { class: 'row end gap-8' }, saveBtn),
    h('div', { class: 'panel mt-24' }, h('div', { class: 'panel-head' }, icon('password'), h('h3', {}, '管理员密码')),
      h('p', { class: 'muted md-body-m' }, '修改密码后需要重新登录。'),
      h('button', { class: 'btn btn-outlined stateful', onClick: changePassword }, icon('password'), '修改密码')));
  async function save() {
    saveBtn.disabled = true;
    try {
      await PATCH('/api/admin/settings', {
        siteName: siteName.value, motd: motd.value, registrationOpen: regSwitch.checked,
        maxFileSizeMB: parseInt(maxFile.value, 10), autoLockMinutes: parseInt(autoLock.value, 10),
        userSessionDays: parseInt(userDays.value, 10), adminSessionHours: parseInt(adminHours.value, 10),
      });
      toast('设置已保存', { type: 'success' });
    } catch (e) { toast(e.message, { type: 'error' }); }
    saveBtn.disabled = false;
  }
}

function changePassword() {
  const cur = h('input', { class: 'tf-input', placeholder: ' ', type: 'password' });
  const next = h('input', { class: 'tf-input', placeholder: ' ', type: 'password' });
  const next2 = h('input', { class: 'tf-input', placeholder: ' ', type: 'password' });
  openDialog({
    title: '修改密码', titleIcon: 'password',
    content: h('div', {},
      h('label', { class: 'tf editor-field' }, h('span', { class: 'tf-box' }, cur, h('span', { class: 'tf-label' }, '当前密码'))),
      h('label', { class: 'tf editor-field' }, h('span', { class: 'tf-box' }, next, h('span', { class: 'tf-label' }, '新密码'))),
      h('label', { class: 'tf editor-field' }, h('span', { class: 'tf-box' }, next2, h('span', { class: 'tf-label' }, '确认新密码')))),
    actions: [
      { label: '取消', variant: 'text' },
      { label: '修改', variant: 'filled', keepOpen: true, onClick: async (close) => {
        if (next.value !== next2.value) { toast('两次新密码不一致', { type: 'error' }); return false; }
        try { await POST('/api/admin/password', { current: cur.value, next: next.value }); toast('密码已修改，请重新登录', { type: 'success' }); close(); setTimeout(adminLogout, 800); }
        catch (e) { toast(e.message, { type: 'error' }); return false; }
      } },
    ],
  });
}

// ============================ 审计 ============================
async function renderAudit(page) {
  page.append(pageHead('审计日志', h('button', { class: 'btn btn-tonal btn-sm stateful', onClick: () => renderPage() }, icon('refresh'), '刷新')));
  const panel = h('div', { class: 'panel' });
  page.append(panel, loadingEl());
  let data;
  try { data = await GET('/api/admin/audit?limit=500'); } catch (e) { toast(e.message, { type: 'error' }); return; }
  page.querySelector('.empty-state')?.remove();
  if (!data.items.length) { panel.append(h('p', { class: 'muted' }, '暂无审计记录')); return; }
  for (const a of data.items) panel.append(auditRow(a));
}

function publicProfile(user) {
  const p = user.profile;
  if (!p?.nickname) return null;
  return h('div', { class: 'public-profile' }, p.avatar ? h('img', { src: p.avatar, alt: '头像', class: 'profile-avatar', loading: 'lazy' }) : null,
    h('div', {}, h('strong', {}, p.nickname), h('p', { class: 'muted md-body-s' }, p.bio || '暂无简介')));
}
