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
const {default:chromium}=await import(path.join(prefix,'node_modules/@sparticuz/chromium/build/index.js'));
const {inflate}=await import(path.join(prefix,'node_modules/@sparticuz/chromium/build/lambdafs.js'));
const libs=await inflate(path.join(prefix,'node_modules/@sparticuz/chromium/bin/al2023.tar.br'));
process.env.LD_LIBRARY_PATH=path.join(libs,'lib')+':'+(process.env.LD_LIBRARY_PATH||'');
const dir=await mkdtemp(path.join(tmpdir(),'nui-browser-release-')), base='http://localhost:8796';
const child=spawn(process.execPath,['server/index.js'],{env:{...process.env,MEMO_HOST:'127.0.0.1',MEMO_PORT:'8796',MEMO_DATA_DIR:dir,MEMO_DEV:'1'},stdio:['ignore','pipe','pipe']});
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
  assert(await admin.locator('.admin-page').textContent(),label);
 }
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
 assert.deepEqual(errors,[]);console.log('PASS Chromium: 12 admin pages, acceleration default-off/unsafe-target refusal/responsive form, native GIF processing/upload, desktop/tablet/mobile/landscape bounds, registration/HKDF/AES-GCM/Worker decryption, remembered reload, repeated filters; no page errors');
} catch(e){console.error(logs);throw e;} finally {await browser?.close();child.kill('SIGTERM');await new Promise(r=>child.once('exit',r));await rm(dir,{recursive:true,force:true});}
