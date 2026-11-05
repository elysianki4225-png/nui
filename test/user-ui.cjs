// npm install --prefix /tmp/nui-ui-test jsdom@24
// NUI_JSDOM_MODULE=/tmp/nui-ui-test/node_modules/jsdom node test/user-ui.cjs
const { JSDOM } = require(process.env.NUI_JSDOM_MODULE || 'jsdom');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), assert = require('node:assert/strict');
const dom = new JSDOM('<main></main>', { url: 'https://memo.example' });
const source = fs.readFileSync(path.join(__dirname, '../web/user/app.js'), 'utf8');
const core = fs.readFileSync(path.join(__dirname, '../web/assets/js/core.js'), 'utf8');
let destroyed = 0;
const S = { el: { content: dom.window.document.querySelector('main') }, search: '', filter: 'all', viewMode: 'list', account: '1234567890123456', master: new Uint8Array(32) };
const context = { S, document: dom.window.document, localStorage: dom.window.localStorage, sessionStorage: dom.window.sessionStorage,
  icon: () => dom.window.document.createElement('i'), debounce: f => f, refreshList() {}, adSlot: () => null,
  FILTERS: [{ id: 'all', icon: 'list', label: '全部' }, { id: 'image', icon: 'image', label: '图片' }],
  VirtualView: class { destroy() { destroyed++; } }, base32Encode: () => 'A'.repeat(52) };
vm.createContext(context);
vm.runInContext(core.slice(core.indexOf('export function h('), core.indexOf('// ---------- 图标')).replaceAll('export ', ''), context);
vm.runInContext(source.slice(source.indexOf('function renderMemos()'), source.indexOf('function getVisibleItems()')), context);
context.renderMemos();
for (let i = 0; i < 10; i++) dom.window.document.querySelectorAll('.chip')[1].click();
assert.equal(dom.window.document.querySelectorAll('.search-bar').length, 1);
assert.equal(dom.window.document.querySelectorAll('.memo-toolbar').length, 1);
assert.equal(destroyed, 10);
assert(!dom.window.document.body.textContent.includes('null'));
vm.runInContext(source.slice(source.indexOf('const REMEMBER_KEY'), source.indexOf('const S =')), context);
assert.equal(context.savedLogin(), null);
context.saveLogin(); assert.equal(context.savedLogin().account, S.account);
assert.equal(JSON.parse(dom.window.localStorage.getItem('memo-saved-login')).key.length, 52);
context.forgetLogin(); assert.equal(context.savedLogin(), null);
dom.window.localStorage.setItem('memo-saved-login', 'invalid'); assert.equal(context.savedLogin(), null);
console.log('PASS: repeated filtering, virtual cleanup, null text, opt-in credentials, clear credentials, malformed storage');
