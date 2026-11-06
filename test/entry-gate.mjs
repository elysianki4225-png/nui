import assert from 'node:assert/strict';
import {EntryGate} from '../server/entry-gate.js';
import {Store} from '../server/store.js';
import {spawn} from 'node:child_process';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
let now=1000;const state={settings:{captcha:{enabled:true,provider:'turnstile',entryGate:true,version:1}}};
const gate=new EntryGate({state},{clock:()=>now}),pass=gate.issue('1.2.3.4');
assert.equal(pass.expires,87400);assert(gate.valid(pass.admissionToken,'1.2.3.4'));assert(!gate.valid(pass.admissionToken,'1.2.3.5'));
assert(!gate.valid(pass.admissionToken+'x','1.2.3.4'));assert(!gate.valid('bad','1.2.3.4'));assert(!new EntryGate({state}).valid(pass.admissionToken,'1.2.3.4'));
state.settings.captcha.version++;assert(!gate.valid(pass.admissionToken,'1.2.3.4'));state.settings.captcha.version--;
now=pass.expires;assert(!gate.valid(pass.admissionToken,'1.2.3.4'));
state.settings.captcha.entryGate=false;assert(gate.allowed({headers:{}},'1.2.3.4'));state.settings.captcha.entryGate=true;
assert(gate.protects('/api/user/register'));assert(gate.protects('/api/profiles/name'));assert(gate.protects('/api/avatars/name'));assert(!gate.protects('/api/admin/captcha'));
const dir=await mkdtemp(path.join(tmpdir(),'nui-entry-')),base='http://127.0.0.1:8997';let child,logs='';
const config=path.join(dir,'config.json');
await writeFile(config,JSON.stringify({host:'127.0.0.1',port:8997,dataDir:dir,mode:'domain',userHost:'localhost',trustProxy:true,realIpHeader:'x-forwarded-for'}));
const store=new Store(dir);await store.load();store.log({t:'settings.set',settings:{captcha:{enabled:true,provider:'turnstile',entryGate:true,version:1,siteKey:'test-site',secret:'test-secret',hostnames:['localhost']}}});await store.close();
const script=`globalThis.fetch=async(url,opts)=>{const t=new URLSearchParams(opts.body).get('response');return new Response(JSON.stringify({success:!t.startsWith('bad'),hostname:'localhost',action:'auth',challenge_ts:new Date().toISOString()}));};await import(${JSON.stringify(new URL('../server/index.js',import.meta.url).href)});`;
const start=async()=>{child=spawn(process.execPath,['--input-type=module','-e',script],{env:{...process.env,MEMO_CONFIG:config,MEMO_DEV:'1'},stdio:['ignore','pipe','pipe']});child.stdout.on('data',b=>logs+=b);child.stderr.on('data',b=>logs+=b);for(let n=0;n<100;n++){try{if((await fetch(base+'/api/health')).ok)return;}catch{}await new Promise(r=>setTimeout(r,50));}throw Error(logs);};
const stop=()=>new Promise(r=>{child.once('exit',r);child.kill('SIGTERM');});
const jar=new Map();let ip='1.2.3.4';
async function request(method,url,body,extra={}){const r=await fetch(base+url,{method,headers:{'X-Memo-Client':'test','X-Forwarded-For':ip,Cookie:[...jar].map(([k,v])=>k+'='+v).join('; '),'Content-Type':'application/json',...extra},body:body===undefined?undefined:JSON.stringify(body)});for(const c of r.headers.getSetCookie()){const kv=c.split(';')[0],i=kv.indexOf('=');jar.set(kv.slice(0,i),kv.slice(i+1));}return {status:r.status,data:await r.json(),cookies:r.headers.getSetCookie()};}
try{
 await start();
 assert.equal((await request('GET','/api/entry')).data.required,true);
 for(const url of ['/api/user/me','/api/user/memos','/api/user/memos/fake/content','/api/profiles/test','/api/avatars/test'])assert.equal((await request('GET',url)).data.code,'ENTRY_REQUIRED');
 assert.equal((await request('POST','/api/user/register',{proof:'a'.repeat(64)})).data.code,'ENTRY_REQUIRED');
 assert.equal((await request('POST','/api/admin/setup',{username:'admin',password:'test-password-123'})).status,200);
 assert.equal((await request('POST','/api/entry',{captchaToken:'bad-challenge'})).status,400);assert(!jar.has('memo_entry'));
 let r=await request('POST','/api/entry',{captchaToken:'entry-one'});assert.equal(r.status,200);assert(r.cookies.some(c=>c.includes('HttpOnly')&&c.includes('Max-Age=86400')));
 const first=r.data.admissionToken;assert.equal((await request('GET','/api/entry')).data.required,false);
 const registered=await request('POST','/api/user/register',{proof:'a'.repeat(64),captchaToken:'register-one'});assert.equal(registered.status,200);
 assert.equal((await request('GET','/api/user/me')).status,200);
 // Export header transport, and a stale/forged header cannot fall back to a valid cookie.
 assert.equal((await request('GET','/api/entry',undefined,{'X-Memo-Entry':first,Cookie:''})).data.required,false);
 assert.equal((await request('GET','/api/user/me',undefined,{'X-Memo-Entry':'forged'})).data.code,'ENTRY_REQUIRED');
 ip='1.2.3.5';assert.equal((await request('GET','/api/entry')).data.required,true);assert.equal((await request('GET','/api/user/me')).data.code,'ENTRY_REQUIRED');
 assert.equal((await request('GET','/api/admin/captcha')).status,200,'admin recovery must remain available');
 assert.equal((await request('POST','/api/entry',{captchaToken:'no-csrf'},{'X-Memo-Client':''})).data.code,'CSRF');
 const oldCfg=(await request('GET','/api/admin/captcha')).data;
 assert.equal((await request('PATCH','/api/admin/captcha',{enabled:true,entryGate:true,provider:'hcaptcha',version:oldCfg.version})).data.code,'BAD_ENTRY_GATE');
 assert.equal((await request('PATCH','/api/admin/captcha',{enabled:true,entryGate:'yes',provider:'turnstile',version:oldCfg.version})).data.code,'BAD_ENTRY_GATE');
 assert.equal((await request('POST','/api/entry',{captchaToken:'entry-two'})).status,200);assert.equal((await request('GET','/api/user/me')).status,200);
 await stop();await start();assert.equal((await request('GET','/api/entry')).data.required,true,'restart invalidates in-memory signed passes');
 // Storage read-only mode must not block entry verification or disabling the gate.
 await stop();const s=new Store(dir);await s.load();s.log({t:'settings.set',settings:{storageMigration:{target:'local'}}});await s.close();await start();
 assert.equal((await request('POST','/api/entry',{captchaToken:'migration-entry'})).status,200);
 assert.equal((await request('PATCH','/api/admin/captcha',{enabled:false,entryGate:false,version:1})).status,200);
 assert.equal((await request('GET','/api/user/me',undefined,{'X-Memo-Entry':'expired'})).status,200);
 assert.equal((await request('GET','/api/entry')).data.required,false);
 console.log('PASS entry gate: 24h/IP/version/restart/tamper, API/media protection, failure closed, real HTTP cookie/header, admin recovery and migration compatibility');
}catch(e){console.error(logs);throw e;}finally{if(child&&child.exitCode===null)await stop();await rm(dir,{recursive:true,force:true});}
