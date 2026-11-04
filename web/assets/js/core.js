// 共享前端核心：DOM 构建、主题、涟漪、Snackbar、对话框、菜单、API 客户端、工具函数

// ---------- DOM ----------
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked' || k === 'disabled' || k === 'selected') el[k] = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }

// ---------- 图标 ----------
let spriteReady = null;
export function loadSprite() {
  if (spriteReady) return spriteReady;
  spriteReady = fetch('/assets/icons.svg').then((r) => r.text()).then((svg) => {
    const div = h('div', { html: svg, style: { display: 'none' }, 'aria-hidden': 'true' });
    document.body.prepend(div);
  }).catch(() => {});
  return spriteReady;
}
export function icon(name, cls = '') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', `icon ${cls}`.trim());
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

// ---------- 主题 ----------
const THEME_KEY = 'memo-theme';
export function initTheme() {
  const saved = localStorage.getItem(THEME_KEY);
  const theme = saved || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  applyTheme(theme);
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
    if (!localStorage.getItem(THEME_KEY)) applyTheme(e.matches ? 'dark' : 'light');
  });
}
export function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = theme === 'dark' ? '#141218' : '#FEF7FF';
}
export function toggleTheme() {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  localStorage.setItem(THEME_KEY, next);
  applyTheme(next);
  return next;
}
export function currentTheme() { return document.documentElement.dataset.theme || 'light'; }

// ---------- 涟漪（事件委托，单监听器，无泄漏） ----------
export function initRipple() {
  document.addEventListener('pointerdown', (e) => {
    const target = e.target.closest('.stateful, .btn, .icon-btn, .fab, .chip, .list-item, .menu-item, .nav-bar-item, .nav-rail-item');
    if (!target || target.disabled) return;
    const rect = target.getBoundingClientRect();
    const size = Math.max(rect.width, rect.height);
    const ripple = h('span', { class: 'ripple' });
    ripple.style.width = ripple.style.height = `${size}px`;
    ripple.style.left = `${e.clientX - rect.left - size / 2}px`;
    ripple.style.top = `${e.clientY - rect.top - size / 2}px`;
    const pos = getComputedStyle(target).position;
    if (pos === 'static') target.style.position = 'relative';
    target.append(ripple);
    ripple.addEventListener('animationend', () => ripple.remove(), { once: true });
  }, { passive: true });
}

// ---------- Snackbar ----------
let snackStack = null;
export function toast(message, { type = 'info', duration = 3200, action } = {}) {
  if (!snackStack) { snackStack = h('div', { class: 'snackbar-stack' }); document.body.append(snackStack); }
  const iconName = type === 'success' ? 'check_circle' : type === 'error' ? 'error' : type === 'warning' ? 'warning' : 'info';
  const bar = h('div', { class: `snackbar ${type}`, role: 'status' },
    icon(iconName),
    h('span', { class: 'snackbar-msg' }, message),
    action ? h('button', { class: 'snackbar-action', onClick: () => { action.onClick?.(); dismiss(); } }, action.label) : null,
  );
  snackStack.append(bar);
  requestAnimationFrame(() => bar.classList.add('show'));
  let dismissed = false;
  function dismiss() {
    if (dismissed) return;
    dismissed = true;
    bar.classList.remove('show');
    setTimeout(() => bar.remove(), 320);
  }
  const timer = setTimeout(dismiss, duration);
  bar.addEventListener('click', (e) => { if (e.target === bar) { clearTimeout(timer); dismiss(); } });
  return dismiss;
}

// ---------- 对话框 ----------
export function openDialog({ title, titleIcon, content, actions = [], wide = false, fullMobile = false, onClose, dismissable = true } = {}) {
  const scrim = h('div', { class: 'dialog-scrim' });
  const dialog = h('div', { class: `dialog ${wide ? 'wide' : ''} ${fullMobile ? 'full-mobile' : ''}`, role: 'dialog', 'aria-modal': 'true' });
  if (title) dialog.append(h('h2', { class: 'dialog-title' }, titleIcon ? icon(titleIcon) : null, title));
  const contentEl = h('div', { class: 'dialog-content' });
  if (typeof content === 'string') contentEl.innerHTML = content;
  else if (content) contentEl.append(content);
  dialog.append(contentEl);
  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    scrim.classList.remove('show');
    document.removeEventListener('keydown', onKey);
    setTimeout(() => { scrim.remove(); onClose?.(); }, 300);
  }
  if (actions.length) {
    const bar = h('div', { class: 'dialog-actions' });
    for (const a of actions) {
      bar.append(h('button', {
        class: `btn ${a.variant ? 'btn-' + a.variant : 'btn-text'} stateful`,
        onClick: async () => {
          if (a.onClick) { const r = await a.onClick(close); if (r === false) return; }
          if (!a.keepOpen) close();
        },
      }, a.icon ? icon(a.icon) : null, a.label));
    }
    dialog.append(bar);
  }
  scrim.append(dialog);
  scrim.addEventListener('pointerdown', (e) => { if (e.target === scrim && dismissable) close(); });
  function onKey(e) { if (e.key === 'Escape' && dismissable) close(); }
  document.addEventListener('keydown', onKey);
  document.body.append(scrim);
  requestAnimationFrame(() => scrim.classList.add('show'));
  const focusable = dialog.querySelector('input, textarea, button');
  if (focusable) setTimeout(() => focusable.focus(), 60);
  return { close, el: dialog, content: contentEl, scrim };
}

export function confirmDialog({ title, message, confirmLabel = '确定', danger = false, icon: ic }) {
  return new Promise((resolve) => {
    openDialog({
      title, titleIcon: ic || (danger ? 'warning' : 'help'),
      content: h('p', { style: { margin: '0', lineHeight: '1.6' } }, message),
      onClose: () => resolve(false),
      actions: [
        { label: '取消', variant: 'text', onClick: () => resolve(false) },
        { label: confirmLabel, variant: danger ? 'danger' : 'filled', onClick: () => resolve(true) },
      ],
    });
  });
}

// ---------- 菜单 ----------
export function openMenu(anchor, items) {
  const scrim = h('div', { class: 'menu-scrim' });
  const menu = h('div', { class: 'menu', role: 'menu' });
  for (const item of items) {
    if (item.divider) { menu.append(h('div', { class: 'menu-divider' })); continue; }
    menu.append(h('div', {
      class: `menu-item stateful ${item.danger ? 'danger' : ''} ${item.selected ? 'selected' : ''}`,
      role: 'menuitem',
      onClick: () => { close(); item.onClick?.(); },
    }, item.icon ? icon(item.icon) : null, h('span', { class: 'flex-1' }, item.label), item.selected ? icon('check', 'sm') : null));
  }
  function close() {
    menu.classList.remove('show');
    document.removeEventListener('keydown', onKey);
    setTimeout(() => { scrim.remove(); menu.remove(); }, 180);
  }
  function onKey(e) { if (e.key === 'Escape') close(); }
  scrim.addEventListener('pointerdown', close);
  document.addEventListener('keydown', onKey);
  document.body.append(scrim, menu);
  const rect = anchor.getBoundingClientRect();
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  let left = rect.right - mw;
  let top = rect.bottom + 4;
  if (left < 8) left = 8;
  if (left + mw > innerWidth - 8) left = innerWidth - mw - 8;
  if (top + mh > innerHeight - 8) top = Math.max(8, rect.top - mh - 4);
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  requestAnimationFrame(() => menu.classList.add('show'));
  return close;
}

// ---------- API 客户端 ----------
export class ApiError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}
export async function api(method, path, body, { raw = false, signal } = {}) {
  const headers = { 'X-Memo-Client': 'web' };
  let payload;
  if (body !== undefined) {
    if (raw) { payload = body; headers['Content-Type'] = 'application/octet-stream'; }
    else { payload = JSON.stringify(body); headers['Content-Type'] = 'application/json'; }
  }
  const res = await fetch(path, { method, headers, body: payload, credentials: 'same-origin', signal });
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) {
    const data = await res.json();
    if (!res.ok || data.ok === false) throw new ApiError(res.status, data.error || `请求失败 (${res.status})`, data.code);
    return data;
  }
  if (!res.ok) throw new ApiError(res.status, `请求失败 (${res.status})`);
  return res;
}
export const GET = (p, o) => api('GET', p, undefined, o);
export const POST = (p, b, o) => api('POST', p, b ?? {}, o);
export const PUT = (p, b, o) => api('PUT', p, b, { ...o, raw: true });
export const PATCH = (p, b, o) => api('PATCH', p, b, o);
export const DEL = (p, o) => api('DELETE', p, undefined, o);

// ---------- 格式化 ----------
export function formatBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}
export function formatDate(ts) {
  if (!ts) return '—';
  const d = new Date(ts * 1000);
  const pad = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
export function formatRelative(ts) {
  if (!ts) return '—';
  const diff = Date.now() / 1000 - ts;
  if (diff < 60) return '刚刚';
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  if (diff < 7 * 86400) return `${Math.floor(diff / 86400)} 天前`;
  return formatDate(ts).slice(0, 10);
}
export function formatAccount(acct) {
  return String(acct || '').replace(/\D/g, '').replace(/(.{4})/g, '$1 ').trim();
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = h('textarea', { style: { position: 'fixed', opacity: '0' } });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch {}
    ta.remove();
    return ok;
  }
}

export function debounce(fn, ms = 250) {
  let t;
  const wrapped = (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  wrapped.cancel = () => clearTimeout(t);
  return wrapped;
}
export function rafThrottle(fn) {
  let scheduled = false, lastArgs;
  return (...args) => {
    lastArgs = args;
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => { scheduled = false; fn(...lastArgs); });
  };
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// 类型图标 / 名称
export const TYPE_META = {
  text: { icon: 'text_snippet', label: '文字' },
  image: { icon: 'image', label: '图片' },
  video: { icon: 'movie', label: '视频' },
  file: { icon: 'insert_drive_file', label: '文件' },
};
