import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Store} from '../server/store.js';
const dir=await mkdtemp(path.join(tmpdir(),'nui-captcha-')),base='http://127.0.0.1:8995';let child;
const env={...process.env,MEMO_HOST:'127.0.0.1',MEMO_PORT:'8995',MEMO_DATA_DIR:dir,MEMO_DEV:'1'};
const start=async()=>{child=spawn(process.execPath,['server/index.js'],{env,stdio:'ignore'});for(let i=0;i<100;i++){try{if((await fetch(base+'/api/health')).ok)return;}catch{}await new Promise(r=>setTimeout(r,50));}throw new Error('startup');};
const stop=()=>new Promise(r=>{child.once('exit',r);child.kill('SIGTERM');});
const client=()=>{let cookie='';return async(method,p,body)=>{const r=await fetch(base+p,{method,headers:{Cookie:cookie,'X-Memo-Client':'test','Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});if(r.headers.getSetCookie().length)cookie=r.headers.getSetCookie().map(x=>x.split(';')[0]).join('; ');return {status:r.status,data:r.headers.get('content-type')?.includes('json')?await r.json():await r.text()};};};
try{
 await start();const a=client(),u=client(),guest=client();await a('POST','/api/admin/setup',{username:'admin',password:'test-password-123'});const registered=await u('POST','/api/user/register',{proof:'a'.repeat(64)});

 for(const body of [null,[],true,42])assert.equal((await a('PATCH','/api/admin/settings',body)).status,400);
 assert.equal((await fetch(base+'/api/admin/settings',{headers:{Cookie:'nui_admin=%ZZ'}})).status,401);
 const payload="</script>$&$`$'";
 assert.equal((await a('PATCH','/api/admin/settings',{siteName:payload})).status,200);
 const exported=await a('GET','/api/admin/export?base=https://memo.example');assert.equal(exported.status,200);assert(!exported.data.includes(payload));assert(exported.data.includes('\\u003c/script>'));assert.equal(JSON.parse(exported.data.match(/window\.__MEMO_CONFIG__ = (.*);/)[1]).siteName,payload);
 assert.equal((await a('GET','/api/admin/export?base=https://user:pass@memo.example')).status,400);
 await a('PATCH','/api/admin/settings',{siteName:'备忘录'});
 await stop();const store=new Store(dir);await store.load();store.log({t:'settings.set',settings:{captcha:{enabled:true,provider:'turnstile',siteKey:'public-test',secret:'DO-NOT-EXPOSE-SECRET',hostnames:['localhost'],version:0}}});await store.close();await start();
 for(const [url,body] of [['/api/user/register',{proof:'b'.repeat(64)}],['/api/user/login',{account:registered.data.account,proof:'a'.repeat(64)}],['/api/admin/login',{username:'admin',password:'test-password-123'}]]){const r=await guest('POST',url,body);assert.equal(r.data.code,'CAPTCHA_REQUIRED');}
 for(const [method,p,body] of [['GET','/api/captcha'],['GET','/api/admin/captcha'],['GET','/api/admin/settings'],['PATCH','/api/admin/settings',{motd:'test'}]]){const r=await a(method,p,body);assert.equal(r.status,200);assert(!JSON.stringify(r.data).includes('DO-NOT-EXPOSE-SECRET'));}
 assert.equal((await u('GET','/api/user/me')).status,200,'existing user session remains valid');
 await stop();const migrating=new Store(dir);await migrating.load();migrating.log({t:'settings.set',settings:{storageMigration:{target:'local'}}});await migrating.close();await start();
 assert.equal((await a('PATCH','/api/admin/settings',{motd:'blocked'})).status,503);
 assert.equal((await guest('PATCH','/api/admin/risk',{enabled:false,autoBlock:false})).status,401);
 assert.equal((await a('PATCH','/api/admin/risk',{enabled:false,autoBlock:false})).status,200);
 assert.equal((await a('PATCH','/api/admin/captcha',{enabled:false,version:0})).status,200);
 assert.equal((await guest('POST','/api/user/login',{account:registered.data.account,proof:'a'.repeat(64)})).status,200);
 await stop();const s=new Store(dir);await s.load();s.log({t:'settings.set',settings:{storageMigration:null,captcha:{...s.state.settings.captcha,enabled:true}}});await s.close();
 execFileSync(process.execPath,['server/cli.js','reset-admin'],{env:{...env,NUI_NEW_PASS:'recovered-password'},stdio:'ignore'});await start();
 assert.equal((await guest('POST','/api/admin/login',{username:'admin',password:'recovered-password'})).status,200);
 console.log('PASS all three auth gates, no secret in public/admin settings responses, existing-session continuity, admin disable and SSH recovery');
}finally{if(child&&child.exitCode===null)await stop();await rm(dir,{recursive:true,force:true});}
