import {
  h, clear, icon, loadSprite, initTheme, toggleTheme, currentTheme, initRipple,
  toast, openDialog, confirmDialog, openMenu, GET, POST, PATCH, DEL, ApiError,
  formatBytes, formatDate, formatRelative, formatAccount, copyText, debounce,
} from '/assets/js/core.js';

const $app = document.getElementById('app');
const S = { view: 'loading', page: 'overview', status: null, username: null, el: {}, data: {} };

boot();
async function boot() {
  initTheme(); initRipple(); loadSprite();
  try { S.status = await GET('/api/admin/status'); } catch (e) { toast('无法连接服务器: ' + e.message, { type: 'error' }); }
  if (S.status?.setupRequired) setView('setup');
  else if (S.status?.loggedIn) setView('main');
  else setView('login');
}
function setView(v) { S.view = v; render(); }
function render() {
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
  { id: 'ipbans', icon: 'gpp_bad', label: 'IP 封禁' },
  { id: 'bots', icon: 'smart_toy', label: '机器人' },
  { id: 'settings', icon: 'settings', label: '设置' },
  { id: 'audit', icon: 'history', label: '审计' },
];

function renderMain() {
  const shell = h('div', { class: 'shell' });
  const rail = h('nav', { class: 'nav-rail' });
  rail.append(h('div', { style: { marginBottom: '8px', color: 'var(--md-primary)' }, title: '管理控制台' }, icon('admin_panel_settings', 'lg')));
  for (const p of PAGES) rail.append(h('button', { class: `nav-rail-item stateful ${S.page === p.id ? 'active' : ''}`, onClick: () => goPage(p.id) }, h('span', { class: 'nav-indicator' }, icon(p.icon)), h('span', {}, p.label)));
  const main = h('div', { class: 'main' });
  const topbar = h('header', { class: 'top-bar' },
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
  const navbar = h('nav', { class: 'nav-bar' });
  for (const p of PAGES) navbar.append(h('button', { class: `nav-bar-item stateful ${S.page === p.id ? 'active' : ''}`, onClick: () => goPage(p.id) }, h('span', { class: 'nav-indicator' }, icon(p.icon)), h('span', {}, p.label)));
  shell.append(rail, main, navbar);
  $app.append(shell);
  S.el = { content, rail, navbar };
  renderPage();
}

function goPage(page) {
  S.page = page;
  const idx = PAGES.findIndex((p) => p.id === page);
  [...S.el.rail.querySelectorAll('.nav-rail-item')].forEach((el, i) => el.classList.toggle('active', i === idx));
  [...S.el.navbar.querySelectorAll('.nav-bar-item')].forEach((el, i) => el.classList.toggle('active', i === idx));
  renderPage();
}

function renderPage() {
  const c = S.el.content;
  clear(c);
  const scroll = h('div', { class: 'admin-content' });
  const page = h('div', { class: 'admin-page view-enter' });
  scroll.append(page);
  c.append(scroll);
  S.el.page = page;
  ({ overview: renderOverview, users: renderUsers, ipbans: renderIpBans, bots: renderBots, settings: renderSettings, audit: renderAudit }[S.page] || renderOverview)(page);
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
      h('td', {}, h('span', { class: 'mono' }, formatAccount(u.account))),
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
        h('div', { class: 'flex-1' }, h('div', { class: 'mono md-title-s' }, formatAccount(u.account)),
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
