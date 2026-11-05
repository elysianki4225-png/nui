import assert from 'node:assert/strict';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { publicIP, normalizeAcceleration, inspectPlan, probeAddress, planGuide } from '../server/acceleration.js';
let count=0;const check=(value,label)=>{assert(value,label);count++;console.log('PASS '+label);};
const plan={enabled:true,kind:'ip',ips:['104.16.0.1'],cname:''};
const current={settings:{cdn:'cloudflare',mode:'domain',userHost:'memo.example.com',adminHost:''},urls:{userUrl:'https://memo.example.com',adminUrl:'https://memo.example.com/admin/'}};
for(const ip of ['127.0.0.1','10.0.0.1','172.16.3.4','192.168.1.1','169.254.169.254','100.64.0.1','0.0.0.0','192.0.2.1','192.88.99.1','198.18.0.1','224.0.0.1','255.255.255.255','::1','::ffff:127.0.0.1','64:ff9b::a00:1','2002:7f00:1::','2001:db8::1','fc00::1','fe80::1','ff02::1','3fff::1','localhost','2130706433','0x7f000001'])assert(!publicIP(ip),ip);
check(publicIP('104.16.0.1')&&publicIP('2606:4700::1111'),'public IP filtering excludes private/reserved/mapped/translation ranges');
assert.throws(()=>normalizeAcceleration({...plan,ips:['104.16.0.1:443']},'cloudflare'));
assert.throws(()=>normalizeAcceleration({...plan,ips:Array(9).fill('104.16.0.1')},'cloudflare'));
assert.throws(()=>normalizeAcceleration(plan,'none'));
assert.throws(()=>normalizeAcceleration({...plan,ips:['8.8.8.8']},'cloudflare'));
check(!normalizeAcceleration({...plan,enabled:false,ips:['8.8.8.8']},'cloudflare').enabled,'old third-party candidates can still be disabled after switching CDN');
for(const cname of ['https://example.com','example.com:443','example.com/path','foo.local','127.0.0.1'])assert.throws(()=>normalizeAcceleration({...plan,kind:'cname',cname},'cloudflare'));
check(normalizeAcceleration({...plan,ips:['104.16.0.1','104.16.0.1']},'cloudflare').ips.length===1,'schema limits, domain format, CF ranges and duplicate handling');
const cname={...plan,kind:'cname',ips:[],cname:'edge.example.net'};let calls=0;
await assert.rejects(inspectPlan(cname,current,{resolve:async()=>['104.16.0.1','127.0.0.1'],probe:async()=>{calls++;}}),/非公网/);
await assert.rejects(inspectPlan(cname,current,{resolve:async()=>['8.8.8.8'],probe:async()=>{calls++;}}),/非 Cloudflare/);
await assert.rejects(inspectPlan({...cname,cname:current.settings.userHost},current),/循环/);
check(calls===0,'unsafe mixed DNS, wrong CDN and CNAME loops never initiate a request');
let active=0,peak=0;
const addresses=Array.from({length:8},(_,i)=>`104.16.0.${i+1}`);
const result=await inspectPlan({...plan,ips:addresses},current,{probe:async(host,ip)=>{assert.equal(host,current.settings.userHost);active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,5));active--;return{address:ip,ok:true};}});
check(peak===2&&result.results.length===8,'bounded concurrency and full ordered result list');
check(planGuide({...plan,forHost:'old.example.com',forCdn:'cloudflare'},current).records.length===0,'changed website suppresses stale DNS instructions');
const original=https.request;let options, destroyed=0;
function fakeResponse(status,content){https.request=(opts,cb)=>{options=opts;const req=new EventEmitter();req.destroy=()=>{destroyed++;};req.end=()=>queueMicrotask(()=>{const res=new PassThrough();res.statusCode=status;cb(res);res.end(content);});return req;};}
try {
 fakeResponse(200,JSON.stringify({ok:true,version:'2.0.0',uptime:1}));
 let r=await probeAddress(current.settings.userHost,'104.16.0.1');
 check(r.ok&&options.hostname==='104.16.0.1'&&options.servername===current.settings.userHost&&options.headers.Host===current.settings.userHost&&options.rejectUnauthorized===true&&options.port===443&&!options.headers.Cookie&&!options.headers.Authorization,'fixed validated IP with original Host/SNI, verified TLS and no credentials');
 fakeResponse(302,'redirect');r=await probeAddress(current.settings.userHost,'104.16.0.1');check(!r.ok&&r.error.includes('重定向'),'redirects are not followed');
 fakeResponse(200,'x'.repeat(17000));r=await probeAddress(current.settings.userHost,'104.16.0.1');check(!r.ok&&r.error.includes('过大'),'response body capped at 16KB and request destroyed');
 fakeResponse(200,'<html>challenge</html>');r=await probeAddress(current.settings.userHost,'104.16.0.1');check(!r.ok,'HTTP 200 challenge page is not a successful site check');
 check(destroyed===4,'completed checks release their sockets');
 const controller=new AbortController();https.request=()=>{const req=new EventEmitter();req.destroy=()=>{destroyed++;};req.end=()=>{};return req;};
 const pending=probeAddress(current.settings.userHost,'104.16.0.1',controller.signal);controller.abort();const aborted=await pending;
 check(!aborted.ok&&destroyed===5,'cancellation destroys pending request and clears timeout');
 https.request=()=>{const req=new EventEmitter();req.destroy=()=>{};req.end=()=>queueMicrotask(()=>req.emit('error',Object.assign(new Error('certificate expired'),{code:'CERT_HAS_EXPIRED'})));return req;};
 r=await probeAddress(current.settings.userHost,'104.16.0.1');check(!r.ok&&r.error.includes('CERT_HAS_EXPIRED'),'TLS certificate errors are reported as failure');
 https.request=()=>{const req=new EventEmitter();req.destroy=()=>{};req.end=()=>{};return req;};
 const keepAlive=setInterval(()=>{},1000);try{r=await probeAddress(current.settings.userHost,'104.16.0.1');check(!r.ok&&r.error.includes('超时'),'silent sockets are terminated by an absolute six-second deadline');}finally{clearInterval(keepAlive);}
} finally {https.request=original;}
check(planGuide(plan,current).sharedAdmin&&planGuide({...plan,enabled:false},current).records.length===0,'guide warns about shared admin hostname and disabled plan has no records');

const dir=await mkdtemp(path.join(tmpdir(),'nui-acceleration-')),port=8983,base=`http://127.0.0.1:${port}`;
const config=path.join(dir,'config.json');const initial=JSON.stringify({host:'127.0.0.1',port,dataDir:dir,mode:'domain',userHost:'memo.example.com',cdn:'cloudflare',cloudflare:true});await writeFile(config,initial);
let child,logs='';
const start=async()=>{child=spawn(process.execPath,['server/index.js'],{env:{...process.env,MEMO_CONFIG:config,MEMO_DEV:'1'},stdio:['ignore','pipe','pipe']});child.stdout.on('data',b=>logs+=b);child.stderr.on('data',b=>logs+=b);for(let i=0;i<100;i++){try{if((await fetch(base+'/api/health')).ok)return;}catch{}await new Promise(r=>setTimeout(r,50));}throw new Error(logs);};
const stop=async()=>{const c=child;child=null;const exited=new Promise(r=>c.once('exit',r));c.kill('SIGTERM');await exited;};
const client=()=>{let cookie='';return async(method,p,body)=>{const r=await fetch(base+p,{method,headers:{'X-Memo-Client':'test','Content-Type':'application/json',Cookie:cookie},body:body===undefined?undefined:JSON.stringify(body)});if(r.headers.getSetCookie().length)cookie=r.headers.getSetCookie().map(x=>x.split(';')[0]).join('; ');return{status:r.status,data:await r.json()};};};
try {
 await start();const admin=client(),anon=client(),user=client();
 let r=await anon('GET','/api/admin/domain/acceleration');check(r.status===401,'anonymous cannot read admin acceleration settings');
 await admin('POST','/api/admin/setup',{username:'admin',password:'acceleration-test-password'});
 await user('POST','/api/user/register',{proof:'a'.repeat(64)});
 r=await user('PATCH','/api/admin/domain/acceleration',plan);check(r.status===401,'ordinary user cannot configure acceleration');
 r=await admin('GET','/api/admin/domain/acceleration');check(!r.data.plan.enabled,'default disabled for existing installations');
 r=await admin('PATCH','/api/admin/domain/acceleration',plan);check(r.status===200&&r.data.guide.records[0].value===plan.ips[0],'save provides DNS guide only');
 r=await admin('POST','/api/admin/domain/acceleration/check',{...plan,ips:['127.0.0.1']});check(r.status===400,'API rejects internal probing');
 check(await readFile(config,'utf8')===initial,'saving/checking never rewrites runtime config');
 await assert.rejects(access(path.join(dir,'domain.json')));check(true,'does not create domain overrides or apply requests');
 await stop();await start();await admin('POST','/api/admin/login',{username:'admin',password:'acceleration-test-password'});
 r=await admin('GET','/api/admin/domain/acceleration');check(r.data.plan.enabled&&r.data.plan.ips[0]===plan.ips[0],'candidate plan persists across restart');
 await admin('POST','/api/admin/storage/start',{target:'local'});
 r=await admin('PATCH','/api/admin/domain/acceleration',{...plan,enabled:false});check(r.status===503,'existing migration read-only lock also protects this setting');
 await admin('POST','/api/admin/storage/cancel');
 r=await admin('PATCH','/api/admin/domain/acceleration',{...plan,enabled:false});check(r.status===200&&!r.data.plan.enabled&&r.data.guide.records.length===0,'can disable without changing site access');
 check(await readFile(config,'utf8')===initial,'disabling keeps original entry configuration byte-identical');
 console.log(`${count} acceleration checks passed`);
}catch(e){console.error(logs);throw e;}finally{if(child)await stop();await rm(dir,{recursive:true,force:true});}
