import {checkDragPreview} from './drag-preview.mjs';
// Optional isolated real-browser audit. Set NUI_BROWSER_DEPS to npm prefix containing
// playwright-core and @sparticuz/chromium. No production data or external services used.
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
const prefix=process.env.NUI_BROWSER_DEPS||'/tmp/nui-browser';
const require=createRequire(path.join(prefix,'package.json'));
const {chromium:playwright}=require('playwright-core');
const {default:chromium}=await import(path.join(prefix,'node_modules/@sparticuz/chromium/build/esm/index.js'));
const {inflate}=await import(path.join(prefix,'node_modules/@sparticuz/chromium/build/esm/lambdafs.js'));
const libs=await inflate(path.join(prefix,'node_modules/@sparticuz/chromium/bin/al2023.tar.br'));
process.env.LD_LIBRARY_PATH=path.join(libs,'lib')+':'+(process.env.LD_LIBRARY_PATH||'');
const dir=await mkdtemp(path.join(tmpdir(),'nui-browser-release-')), base='http://localhost:8796';
const child=spawn(process.execPath,['server/index.js'],{env:{...process.env,MEMO_HOST:'127.0.0.1',MEMO_PORT:'8796',MEMO_DATA_DIR:dir,MEMO_DEV:'1'},stdio:['ignore','pipe','pipe']});
// A layout-only test misses invisible borderless inputs. Inspect the rendered control.
async function auditFields(page) {
 const bad=await page.locator('.tf-input').evaluateAll(inputs=>inputs.filter(el=>el.getClientRects().length&&getComputedStyle(el).visibility!=='hidden').flatMap(el=>{
  const box=el.closest('.tf-box')||el,css=getComputedStyle(box),r=box.getBoundingClientRect();
  const invisible=['Top','Right','Bottom','Left'].some(side=>parseFloat(css['border'+side+'Width'])<1||css['border'+side+'Style']==='none'||css['border'+side+'Color']==='rgba(0, 0, 0, 0)');
  const overflow=r.left< -1||r.right>innerWidth+1;
  const placeholder=getComputedStyle(el,'::placeholder').color;
  const lostHint=!el.closest('.tf-box')&&el.placeholder?.trim()&&placeholder==='rgba(0, 0, 0, 0)';
  return invisible||overflow||lostHint?[{label:el.getAttribute('aria-label')||el.placeholder,invisible,overflow,lostHint}]:[];
 }));
 assert.deepEqual(bad,[],'form controls need visible borders, hints and viewport bounds');
}
let logs='',browser;child.stdout.on('data',b=>logs+=b);child.stderr.on('data',b=>logs+=b);
try {
 for(let i=0;i<100;i++){try{if((await fetch(base+'/api/health')).ok)break;}catch{}await new Promise(r=>setTimeout(r,50));}
 browser=await playwright.launch({executablePath:await chromium.executablePath(),args:chromium.args,headless:true});
 const admin=await browser.newPage(), errors=[];admin.on('pageerror',e=>errors.push(e.message));
 await admin.goto(base+'/admin/');
 await admin.evaluate(async()=>{
  const post=async(path,body)=>{const r=await fetch(path,{method:'POST',headers:{'X-Memo-Client':'audit','Content-Type':'application/json'},body:JSON.stringify(body)});if(!r.ok)throw new Error(await r.text());return r.json();};
  await post('/api/admin/setup',{username:'admin',password:'isolated-test-password'});
  await post('/api/admin/storage/start',{target:'local'});await post('/api/admin/storage/step',{});
 });await admin.reload();
 for(const label of ['概览','用户','IP 封禁','机器人','域名','前端/跨域','广告','存储','主题','风控','设置','审计']) {
  await admin.locator('.nav-rail-item').filter({hasText:label}).click();await admin.waitForTimeout(120);
  assert(await admin.locator('.admin-page').textContent(),label);await auditFields(admin);
 }
 // CAPTCHA empty fields, keyboard focus, responsive bounds and real disabled-save roundtrip.
 await admin.locator('.nav-rail-item').filter({hasText:'风控'}).click();
 await admin.getByLabel('Site Key',{exact:true}).waitFor();
 for(const theme of ['light','dark'])for(const width of [320,360,768,1440]){
  await admin.setViewportSize({width,height:900});
  await admin.evaluate(t=>document.documentElement.dataset.theme=t,theme);
  await auditFields(admin);
  const site=admin.getByLabel('Site Key',{exact:true});await site.fill('test-public-key');await site.focus();
  assert.notEqual(await site.evaluate(e=>getComputedStyle(e).boxShadow),'none','focused field must be visible');
  await admin.keyboard.press('Tab');assert(await admin.getByLabel('Secret Key',{exact:true}).evaluate(e=>e===document.activeElement));
  await site.fill('');
 }
 await admin.getByLabel('启用注册和两端登录的人机验证',{exact:true}).check();
 assert(await admin.getByRole('button',{name:'验证配置并保存',exact:true}).isVisible());
 await admin.getByLabel('启用注册和两端登录的人机验证',{exact:true}).uncheck();
 // Diagnostic failure remains readable in the form and does not expose/erase the entered secret.
 const failureText='服务商确认 Site Key 与 Secret Key 不匹配，请使用同一账户下适用的密钥';
 await admin.route('**/api/admin/captcha',async route=>{
  if(route.request().method()==='PATCH')return route.fulfill({status:400,json:{ok:false,error:failureText,code:'CAPTCHA_KEY_MISMATCH'}});
  return route.continue();
 });
 await admin.getByLabel('Secret Key',{exact:true}).fill('private-input-test');
 await admin.getByRole('button',{name:'保存（关闭验证）',exact:true}).click();
 const diagnostic=admin.locator('[data-captcha-section] [role=status]');
 await diagnostic.filter({hasText:'CAPTCHA_KEY_MISMATCH'}).waitFor();
 assert((await diagnostic.textContent()).includes(failureText));assert(!(await diagnostic.textContent()).includes('private-input-test'));
 assert.equal(await admin.getByLabel('Secret Key',{exact:true}).inputValue(),'private-input-test');
 await admin.unroute('**/api/admin/captcha');await admin.getByLabel('Secret Key',{exact:true}).fill('');
 console.log('PASS CAPTCHA failure stays inline with safe error code and preserves form for correction');
 const saved=admin.waitForResponse(r=>r.url().endsWith('/api/admin/captcha')&&r.request().method()==='PATCH');
 await admin.getByRole('button',{name:'保存（关闭验证）',exact:true}).click();assert.equal((await saved).status(),200);
 await admin.getByLabel('Site Key',{exact:true}).waitFor();
 await admin.evaluate(()=>document.documentElement.dataset.theme='light');await admin.setViewportSize({width:1440,height:900});
 console.log('PASS form visibility: all admin pages; CAPTCHA light/dark 320/360/768/1440px, placeholders, focus/Tab and disabled-save');
 // Long IPv6, unbroken notes/logs and failed batch input must not widen the page.
 const ipv6='2001:0db8:1234:5678:9abc:def0:1234:0001-2001:0db8:1234:5678:9abc:def0:1234:ffff';
 const longText='unbroken-log-segment'.repeat(150);
 await admin.route('**/api/admin/ip-bans?*',route=>route.fulfill({json:{ok:true,items:[{id:'overflow-test',rule:ipv6,family:6,note:longText,createdAt:1,enabled:true}],total:1}}));
 await admin.route('**/api/admin/ip-bans',route=>route.fulfill({json:{ok:true,added:0,errors:[{rule:ipv6+' '+longText,error:longText}]}}));
 await admin.route('**/api/admin/audit?*',route=>route.fulfill({json:{ok:true,items:[{ts:1,actor:ipv6,action:longText,detail:longText}]}}));
 const fits=async()=>{
  const bad=await admin.evaluate(()=>[...document.querySelectorAll('.admin-content,.admin-page,.m-card,.audit-item,.a-detail,.dialog,.dialog-content')].filter(e=>e.getClientRects().length).filter(e=>{const r=e.getBoundingClientRect();return r.right>innerWidth+1||r.left< -1||e.scrollWidth>e.clientWidth+1;}).map(e=>e.className));
  assert.deepEqual(bad,[],'long admin content overflow');
 };
 for(const [width,height] of [[320,700],[360,780],[768,1024],[1440,900]]) {
  await admin.setViewportSize({width,height});
  // Drawer and desktop use the same navigation state; desktop rail is hidden on phones.
  if(width<1024) {await admin.getByRole('button',{name:'打开菜单',exact:true}).click();await admin.locator('.nav-drawer-item').filter({hasText:'IP 封禁'}).click();}
  else await admin.locator('.nav-rail-item').filter({hasText:'IP 封禁'}).click();
  await admin.getByText(ipv6,{exact:true}).last().waitFor({state:'attached'});await fits();
  await admin.getByRole('button',{name:'添加规则',exact:true}).click();
  await admin.locator('.dialog textarea').fill(ipv6+' '+longText);
  await admin.waitForTimeout(220);await fits();
  await admin.getByRole('button',{name:'添加',exact:true}).click();
  await admin.waitForFunction(()=>document.querySelector('.dialog-content')?.textContent.includes('条失败'));await fits();
  await admin.getByRole('button',{name:'取消',exact:true}).click();
  if(width<1024){await admin.getByRole('button',{name:'打开菜单',exact:true}).click();await admin.locator('.nav-drawer-item').filter({hasText:'审计'}).click();}
  else await admin.locator('.nav-rail-item').filter({hasText:'审计'}).click();
  await admin.locator('.a-detail').waitFor();await fits();
  assert((await admin.locator('.a-detail').textContent()).includes(longText),'log text must not be truncated');
 }
 await admin.unroute('**/api/admin/ip-bans?*');await admin.unroute('**/api/admin/audit?*');await admin.unroute('**/api/admin/ip-bans');
 await admin.setViewportSize({width:1440,height:900});
 console.log('PASS admin IPv6 and long logs/dialog input fit 320/360/768/1440px without truncation');
 await admin.locator('.nav-rail-item').filter({hasText:'域名'}).click();
 await admin.locator('.acceleration > summary').click();
 await admin.locator('.acceleration textarea').waitFor();
 assert.equal(await admin.locator('.acceleration input[type=checkbox]').isChecked(),false);
 await admin.locator('.acceleration input[type=checkbox]').check();
 await admin.locator('.acceleration textarea').fill('127.0.0.1');
 await admin.getByRole('button',{name:'检测候选兼容性（不保存）'}).click();
 await admin.locator('.acceleration [role=status]').filter({hasText:'仅允许公网 IP'}).waitFor();
 await admin.getByRole('button',{name:'管理界面',exact:true}).click();
 await admin.getByLabel('管理端使用独立配置',{exact:true}).check();
 await admin.getByRole('button',{name:'Cloudflare 小黄云',exact:true}).click();
 await admin.locator('.domain-advanced > summary').first().click();
 await admin.getByRole('button',{name:'严格 · Strict',exact:true}).click();
 await admin.getByLabel('回源 HTTP 端口',{exact:true}).fill('8080');
 await admin.getByLabel('回源 HTTPS 端口',{exact:true}).fill('8443');
 await admin.getByLabel('证书 PEM（certificate）',{exact:true}).fill('draft-admin-cert');
 await admin.getByLabel('私钥 PEM（private key）',{exact:true}).fill('draft-admin-key');
 await admin.getByRole('button',{name:'加密 · Full',exact:true}).click();
 assert.equal(await admin.getByLabel('证书 PEM（certificate）',{exact:true}).inputValue(),'draft-admin-cert');
 for(const [width,height] of [[360,780],[768,1024],[1440,900],[780,360]]) {await admin.setViewportSize({width,height});assert(await admin.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));}
 await admin.setViewportSize({width:1440,height:900});
 await admin.locator('.nav-rail-item').filter({hasText:'主题'}).click();await admin.locator('input[type=file]').waitFor();await admin.getByLabel('素材用途').selectOption('pet');
 await admin.locator('input[type=file]').setInputFiles({name:'pet.gif',mimeType:'image/gif',buffer:Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7','base64')});
 await admin.getByRole('button',{name:'本机压缩 / 抠图并预览'}).click();
 await admin.waitForFunction(()=>!Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='确认预览并上传').disabled);
 await admin.getByRole('button',{name:'确认预览并上传'}).click();await admin.getByText('素材已上传。桌宠需开启上方开关；背景按设备自动显示。').waitFor();
 await admin.getByLabel('开启桌宠',{exact:true}).check();await admin.getByRole('button',{name:'保存主题设置'}).click();await admin.locator('.site-pet').waitFor();
 for(const [width,height] of [[360,780],[768,1024],[1440,900],[780,360]]) {
  await admin.setViewportSize({width,height});const m=await admin.evaluate(()=>{const r=document.querySelector('.site-pet').getBoundingClientRect();return{w:innerWidth,h:innerHeight,s:document.documentElement.scrollWidth,l:r.left,r:r.right,t:r.top,b:r.bottom};});
  assert(m.s<=m.w+1&&m.l>=0&&m.r<=m.w&&m.t>=0&&m.b<=m.h,JSON.stringify(m));
 }
 // Exercise each SDK adapter and cancellation locally; external provider code is mocked.
 const challenge=await browser.newPage();challenge.on('pageerror',e=>errors.push(e.message));await challenge.goto(base+'/admin/');
 // A real Turnstile explicit SDK rejects ready(); an always-successful mock hid this bug.
 await challenge.route('https://www.google.com/recaptcha/api.js*',r=>r.fulfill({contentType:'application/javascript',body:"window.grecaptcha={ready(){throw new Error('SDK initialization failed');}};"}));
 const initFailure=await challenge.evaluate(async()=>{const {requestCaptcha}=await import('/assets/js/captcha.js');try{await requestCaptcha({enabled:true,provider:'recaptcha',siteKey:'test'});}catch(e){return e.code;}});
 assert.equal(initFailure,'CAPTCHA_SDK_INIT');await challenge.waitForFunction(()=>!document.querySelector('.dialog-scrim'));
 await challenge.unroute('https://www.google.com/recaptcha/api.js*');
 await challenge.route('https://js.hcaptcha.com/1/api.js*',r=>r.abort());
 const networkFailure=await challenge.evaluate(async()=>{const {requestCaptcha}=await import('/assets/js/captcha.js');try{await requestCaptcha({enabled:true,provider:'hcaptcha',siteKey:'test'});}catch(e){return e.code;}});
 assert.equal(networkFailure,'CAPTCHA_SDK_NETWORK');await challenge.waitForFunction(()=>!document.querySelector('.dialog-scrim'));
 await challenge.unroute('https://js.hcaptcha.com/1/api.js*');

 for(const [provider,global,url] of [['turnstile','turnstile','https://challenges.cloudflare.com/turnstile/v0/api.js*'],['recaptcha','grecaptcha','https://www.google.com/recaptcha/api.js*'],['hcaptcha','hcaptcha','https://js.hcaptcha.com/1/api.js*']]){
  await challenge.route(url,r=>r.fulfill({contentType:'application/javascript',body:`window.${global}={ready:cb=>{if('${provider}'==='turnstile')throw new Error('ready is unsupported in explicit mode');setTimeout(cb,20);},render:(el,o)=>{setTimeout(()=>o.callback('verified-${provider}'),20);return 1;},remove:()=>{},reset:()=>{}};`}));
  const token=await challenge.evaluate(async provider=>{const {requestCaptcha}=await import('/assets/js/captcha.js');return requestCaptcha({enabled:true,provider,siteKey:'test-site'});},provider);
  assert.equal(token,'verified-'+provider);await challenge.waitForFunction(()=>!document.querySelector('.dialog-scrim'));
 }
 await challenge.evaluate(async()=>{window.turnstile.render=(el,o)=>{window.lateCaptcha=o.callback;return 2;};const {requestCaptcha}=await import('/assets/js/captcha.js');window.pendingCaptcha=requestCaptcha({enabled:true,provider:'turnstile',siteKey:'test'}).then(()=> 'accepted',()=> 'cancelled');});
 await challenge.getByRole('button',{name:'取消',exact:true}).click();assert.equal(await challenge.evaluate(()=>window.pendingCaptcha),'cancelled');
 await challenge.evaluate(()=>window.lateCaptcha?.('late-token'));assert.equal(await challenge.evaluate(()=>window.pendingCaptcha),'cancelled');
 await challenge.goto('about:blank');console.log('PASS CAPTCHA explicit-mode Turnstile (ready rejects), initialization/network failure and retry, three adapters under CSP, modal cleanup and late-callback cancellation (mock SDKs)');
 const user=await browser.newPage();user.on('pageerror',e=>errors.push(e.message));await user.goto(base+'/');
 await user.evaluate(async()=>{
  const enc=new TextEncoder(), raw=new Uint8Array(32), key=await crypto.subtle.importKey('raw',raw,'HKDF',false,['deriveBits','deriveKey']);
  const bits=await crypto.subtle.deriveBits({name:'HKDF',hash:'SHA-256',salt:enc.encode('nui-memo-auth-salt-v1'),info:enc.encode('auth')},key,256);
  const proof=Array.from(new Uint8Array(bits)).map(b=>b.toString(16).padStart(2,'0')).join('');
  const post=async(p,b)=>{const r=await fetch(p,{method:'POST',headers:{'X-Memo-Client':'audit','Content-Type':'application/json'},body:JSON.stringify(b)});if(!r.ok)throw new Error(await r.text());return r.json();};
  const {account}=await post('/api/user/register',{proof});
  const aes=await crypto.subtle.deriveKey({name:'HKDF',hash:'SHA-256',salt:enc.encode(account),info:enc.encode('nui-memo-enc-v1')},key,{name:'AES-GCM',length:256},false,['encrypt']);
  const encrypt=async text=>{const iv=crypto.getRandomValues(new Uint8Array(12)),ct=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv},aes,enc.encode(text))),out=new Uint8Array(12+ct.length);out.set(iv);out.set(ct,12);return out;};
  const meta=btoa(String.fromCharCode(...await encrypt(JSON.stringify({title:'Release browser memo',preview:'verified text'})))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  const content=await encrypt('verified text');const {id}=await post('/api/user/memos',{type:'text',size:enc.encode('verified text').length,parts:1,meta});
  const r=await fetch(`/api/user/memos/${id}/parts/0`,{method:'PUT',headers:{'X-Memo-Client':'audit','Content-Type':'application/octet-stream'},body:content});if(!r.ok)throw new Error(await r.text());await post(`/api/user/memos/${id}/complete`,{});
  localStorage.setItem('memo-saved-login',JSON.stringify({account,key:'A'.repeat(52)}));
 });await user.reload();await user.getByText('Release browser memo',{exact:true}).waitFor();
 for(let i=0;i<8;i++)await user.locator('.memo-toolbar .chip').first().click();
 assert.equal(await user.locator('.search-bar').count(),1);assert(!(await user.locator('body').textContent()).includes('nullnull'));
 await user.reload();await user.getByText('Release browser memo',{exact:true}).waitFor();
 await user.setViewportSize({width:360,height:780});assert(await user.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
 // Organization is encrypted by the real worker and survives reload.
 for(const name of ['Folder A','Folder B']) {
  await user.getByRole('button',{name:'新建文件夹',exact:true}).click();
  await user.getByLabel('文件夹名称').waitFor();await auditFields(user);
  await user.getByLabel('文件夹名称').fill(name);
  await user.getByRole('button',{name:'保存',exact:true}).click();
  await user.getByText(name,{exact:true}).waitFor();
 }
 const memoRow=()=>user.locator('.memo-item').filter({hasText:'Release browser memo'});
 await memoRow().getByRole('button',{name:'整理',exact:true}).click();
 await user.getByText('移到 Folder A',{exact:true}).click();
 await user.waitForFunction(()=>![...document.querySelectorAll('.memo-title')].some(e=>e.textContent==='Release browser memo'));
 await user.getByText('Folder A',{exact:true}).click();await user.getByText('Release browser memo',{exact:true}).waitFor();
 await memoRow().getByRole('button',{name:'整理',exact:true}).click();await user.getByText('移到全部文件',{exact:true}).click();
 await user.getByRole('button',{name:'全部文件',exact:true}).click();
 const row=name=>user.locator('.memo-item').filter({hasText:name});
 const drag=async(from,to,touch=false)=>{
  await row(from).scrollIntoViewIfNeeded();
  await user.waitForTimeout(260); // settle viewport and previous 200ms FLIP before sampling coordinates
  const a=await row(from).getByRole('button',{name:'拖动排序',exact:true}).boundingBox(),b=await row(to).boundingBox();
  const x=a.x+a.width/2,y=a.y+a.height/2,tx=b.x+b.width/2,ty=b.y+b.height/2;
  if(touch){const cdp=await user.context().newCDPSession(user);await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});await user.waitForTimeout(240);await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:tx,y:ty}]});await user.waitForTimeout(100);await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await cdp.detach();}
  else{await user.mouse.move(x,y);await user.mouse.down();await user.waitForTimeout(240);await user.mouse.move(tx,ty,{steps:8});await user.waitForTimeout(100);await user.mouse.up();}
  await user.waitForFunction(name=>document.querySelector('.memo-item .memo-title')?.textContent===name,from);
  assert.equal(await user.locator('.org-ghost').count(),0);
 };
 await user.setViewportSize({width:1440,height:900});await drag('Folder B','Folder A');
 await user.setViewportSize({width:360,height:780});await drag('Folder A','Folder B',true);
 await user.setViewportSize({width:1440,height:900});await drag('Release browser memo','Folder A');
 await user.setViewportSize({width:360,height:780});await drag('Folder A','Release browser memo',true);
 await user.reload();await user.getByText('Folder A',{exact:true}).waitFor();
 assert.equal(await user.locator('.memo-item .memo-title').first().textContent(),'Folder A');
 assert(await user.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
 const encrypted=await user.evaluate(async()=>await (await fetch('/api/user/organization')).json());
 assert(encrypted.revision>=6&&!JSON.stringify(encrypted).includes('Folder A'));
 await row('Folder A').getByRole('button',{name:'整理',exact:true}).click();
 await user.getByText('重命名文件夹',{exact:true}).click();await user.getByLabel('文件夹名称').fill('Renamed folder');
 await user.getByRole('button',{name:'保存',exact:true}).click();await user.getByText('Renamed folder',{exact:true}).waitFor();
 await memoRow().getByRole('button',{name:'整理',exact:true}).click();await user.getByText('移到 Renamed folder',{exact:true}).click();
 await user.waitForFunction(()=>![...document.querySelectorAll('.memo-title')].some(e=>e.textContent==='Release browser memo'));
 await row('Renamed folder').getByRole('button',{name:'整理',exact:true}).click();
 await user.getByText('删除文件夹（保留内容）',{exact:true}).click();await user.getByRole('button',{name:'删除',exact:true}).click();
 await user.getByText('Release browser memo',{exact:true}).waitFor();
 assert.equal(await user.getByText('Renamed folder',{exact:true}).count(),0);
 console.log('PASS Chromium: encrypted folders, membership moves, mouse + touch long-press sorting, drag cleanup and persisted order');
 await user.setViewportSize({width:1440,height:900});
 await user.locator('.nav-rail-item').filter({hasText:'设置'}).click();await user.getByLabel('网名',{exact:true}).waitFor();
 for(const theme of ['light','dark'])for(const width of [320,768,1440]){await user.setViewportSize({width,height:900});await user.evaluate(t=>document.documentElement.dataset.theme=t,theme);await auditFields(user);}
 console.log('PASS user folder dialogs and public profile input visibility in light/dark mobile/desktop');
 // With admission confirmed disabled, a transient status-check outage must not clear drafts/UI.
 await user.route('**/api/entry',r=>r.abort());
 await user.evaluate(()=>window.dispatchEvent(new Event('online')));await user.waitForTimeout(300);
 assert(await user.locator('#app').evaluate(e=>!e.hidden&&e.textContent.length>0));
 assert.equal(await user.locator('.entry-gate').count(),0);await user.unroute('**/api/entry');
 console.log('PASS disabled entry gate: transient status-check failure does not lock private UI');
 // Entry-screen behavior with controlled server admission state and SDK callbacks.
 const visitor=await browser.newPage();visitor.on('pageerror',e=>errors.push(e.message));
 let required=true,meRequests=0;
 await visitor.addInitScript(base=>{window.__MEMO_CONFIG__={apiBase:base};},base);
 const gateReply=()=>({ok:true,enabled:true,required,captcha:{enabled:true,provider:'turnstile',siteKey:'gate-test'}});
 await visitor.route('**/api/entry',r=>{if(r.request().method()==='POST'){required=false;return r.fulfill({json:{...gateReply(),admissionToken:'opaque-export-pass'}});}return r.fulfill({json:{...gateReply(),required:required||r.request().headers()['x-memo-entry']!=='opaque-export-pass'}});});
 await visitor.route('https://challenges.cloudflare.com/turnstile/v0/api.js*',r=>r.fulfill({contentType:'application/javascript',body:"window.turnstile={render:(el,o)=>{window.finishEntry=o.callback;return 1;},remove:()=>{}};"}));
 visitor.on('request',r=>{if(r.url().endsWith('/api/user/me'))meRequests++;});
 await visitor.setViewportSize({width:320,height:740});await visitor.goto(base+'/');
 await visitor.waitForFunction(()=>typeof window.finishEntry==='function');
 assert.equal(meRequests,0,'must not recover account before entry verification');assert(await visitor.locator('#app').evaluate(e=>e.hidden&&e.inert));
 await visitor.getByRole('button',{name:'取消',exact:true}).click();
 await visitor.waitForFunction(()=>!document.querySelector('.dialog-scrim'));
 assert(await visitor.locator('#app').evaluate(e=>e.hidden));assert.equal(await visitor.locator('.entry-gate').count(),1);
 await visitor.getByRole('button',{name:'开始验证',exact:true}).click();await visitor.locator('.dialog-scrim').waitFor();
 const visitorRecovered=visitor.waitForResponse(r=>r.url().endsWith('/api/user/me'));
 await visitor.evaluate(()=>window.finishEntry('entry-ok'));await visitor.locator('.entry-gate').waitFor({state:'detached'});await visitorRecovered;
 assert(meRequests>0);await visitor.reload();await visitor.waitForFunction(()=>!document.querySelector('#app').hidden&&document.querySelector('#app').textContent.length>0);assert.equal(await visitor.locator('.entry-gate').count(),0);
 await visitor.goto('about:blank');
 // An IP rejection of a write locks decrypted UI; the write is not retried after admission.
 let userRequired=true,writes=0;
 await user.route('**/api/entry',r=>{if(r.request().method()==='POST')userRequired=false;return r.fulfill({json:{ok:true,enabled:true,required:userRequired,captcha:{enabled:true,provider:'turnstile',siteKey:'gate-test'}}});});
 await user.route('https://challenges.cloudflare.com/turnstile/v0/api.js*',r=>r.fulfill({contentType:'application/javascript',body:"window.turnstile={render:(el,o)=>{window.finishEntry=o.callback;return 1;},remove:()=>{}};"}));
 await user.route('**/api/user/memos/batch-delete',r=>{writes++;return r.fulfill({status:403,json:{ok:false,code:'ENTRY_REQUIRED',error:'IP changed'}});});
 const code=await user.evaluate(async()=>{const {POST}=await import('/assets/js/core.js');try{await POST('/api/user/memos/batch-delete',{ids:['fake']});}catch(e){return e.code;}});
 assert.equal(code,'ENTRY_REQUIRED');await user.waitForFunction(()=>typeof window.finishEntry==='function');
 assert(await user.locator('#app').evaluate(e=>e.hidden&&e.inert&&e.textContent===''));
 await Promise.all([user.waitForEvent('load'),user.evaluate(()=>window.finishEntry('new-ip-ok'))]);
 await user.getByText('Release browser memo',{exact:true}).waitFor();assert.equal(writes,1,'never replay a rejected mutation');
 console.log('PASS entry screen: first visit blocks account recovery, cancel stays blocked, acceptance/reload, IP rejection locks private UI and never replays writes');
 // Export-mode avatar requests must carry admission/auth headers; <img src> cannot do this.
 await user.addInitScript(base=>{window.__MEMO_CONFIG__={apiBase:base};localStorage.setItem('memo-entry:'+base,'avatar-admission');},base);
 let avatarRequests=0;
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aGYQAAAAASUVORK5CYII=','base64');
 await user.route('**/api/user/profile',r=>r.fulfill({json:{ok:true,profile:{nickname:'avatar-test',bio:'public',avatar:'/api/avatars/avatar-test'}}}));
 await user.route('**/api/avatars/avatar-test?*',r=>{avatarRequests++;assert.equal(r.request().headers()['x-memo-entry'],'avatar-admission');assert(r.request().headers().authorization?.startsWith('Bearer '));return r.fulfill({contentType:'image/png',body:png});});
 await user.reload();await user.getByText('Release browser memo',{exact:true}).waitFor();
 await user.locator('.nav-rail-item').filter({hasText:'设置'}).click();
 await user.waitForFunction(()=>{const img=document.querySelector('.profile-avatar');return img&&!img.hidden&&img.complete&&img.naturalWidth>0;});
 assert.equal(avatarRequests,1);assert((await user.locator('.profile-avatar').getAttribute('src')).startsWith('data:image/'));
 console.log('PASS exported avatar uses authenticated admission-aware fetch and renders a local data URL');
 await checkDragPreview(user);
 assert.deepEqual(errors,[]);console.log('PASS Chromium: 12 admin pages, acceleration default-off/unsafe-target refusal/responsive form, native GIF processing/upload, desktop/tablet/mobile/landscape bounds, registration/HKDF/AES-GCM/Worker decryption, remembered reload, repeated filters; no page errors');
} catch(e){console.error(logs);throw e;} finally {await browser?.close();child.kill('SIGTERM');await new Promise(r=>child.once('exit',r));await rm(dir,{recursive:true,force:true});}
