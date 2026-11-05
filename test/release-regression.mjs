import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../server/store.js';
const dir=await mkdtemp(path.join(tmpdir(),'nui-release-'));
const port=8794, base=`http://127.0.0.1:${port}`;
const server=spawn(process.execPath,['server/index.js'],{env:{...process.env,MEMO_HOST:'127.0.0.1',MEMO_PORT:String(port),MEMO_DATA_DIR:dir,MEMO_DEV:'1'},stdio:['ignore','pipe','pipe']});
let logs='';server.stdout.on('data',b=>logs+=b);server.stderr.on('data',b=>logs+=b);
let count=0;const check=(value,label)=>{assert(value,label);count++;console.log('PASS '+label);};
const client=()=>{let cookie='';return async(method,url,body,extra={})=>{
 const headers={'X-Memo-Client':'release',...extra};if(cookie)headers.Cookie=cookie;
 if(body!=null&&!Buffer.isBuffer(body))headers['Content-Type']='application/json';
 const r=await fetch(base+url,{method,headers,body:body==null?undefined:Buffer.isBuffer(body)?body:JSON.stringify(body)});
 const set=r.headers.getSetCookie();if(set.length)cookie=set.map(x=>x.split(';')[0]).join('; ');
 return {status:r.status,data:r.headers.get('content-type')?.includes('application/json')?await r.json():await r.text()};
};};
try {
 for(let i=0;i<100;i++){try{if((await fetch(base+'/api/health')).ok)break;}catch{}await new Promise(r=>setTimeout(r,50));}
 const admin=client(), user=client(), other=client();
 // Hold first setup after its initial check, complete a competing setup, then release it.
 let request;
 const slow=new Promise((resolve,reject)=>{request=http.request(base+'/api/admin/setup',{method:'POST',headers:{'X-Memo-Client':'release','Content-Type':'application/json'}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});request.on('error',reject);request.write('{"username":"first",');});
 await new Promise(r=>setTimeout(r,50));
 let r=await admin('POST','/api/admin/setup',{username:'admin',password:'release-test-password'});check(r.status===200,'first completed setup succeeds');
 request.end('"password":"overwritten-password"}');check(await slow===409,'concurrent setup cannot overwrite administrator');
 await admin('POST','/api/admin/storage/start',{target:'local'});await admin('POST','/api/admin/storage/step');
 r=await user('POST','/api/user/register',{proof:'a'.repeat(64)});check(r.status===200,'register on local-only installation');
 await other('POST','/api/user/register',{proof:'b'.repeat(64)});
 r=await user('GET','/api/user/me',null,{Authorization:'Bearer invalid'});check(r.status===401,'invalid Bearer cannot fall back to valid cookies');
 r=await admin('PATCH','/api/admin/settings',{siteName:'attack'},{Origin:'https://evil.invalid',Authorization:'Bearer invalid'});check(r.status===401,'fake Bearer cannot bypass cookie CSRF');
 r=await admin('PATCH','/api/admin/settings',{siteName:'attack'},{Origin:'https://evil.invalid'});check(r.status===403,'cross-origin cookie mutation rejected');
 r=await user('POST','/api/user/memos',{type:'file',size:1,parts:1,meta:'opaque'});const id=r.data.id;
 r=await other('GET',`/api/user/memos/${id}`);check(r.status===404,'cross-account memo access rejected');
 r=await user('PUT',`/api/user/memos/${id}/parts/0junk`,Buffer.alloc(29));check(r.status===400,'invalid numeric part index rejected');
 const concurrent=await Promise.all([user('PUT',`/api/user/memos/${id}/parts/0`,Buffer.alloc(29)),user('PUT',`/api/user/memos/${id}/parts/0`,Buffer.alloc(29))]);
 check(concurrent.filter(x=>x.status===200).length===1&&concurrent.some(x=>x.status===409),'duplicate concurrent part upload cannot overwrite');
 r=await user('POST',`/api/user/memos/${id}/complete`);check(r.status===200,'valid encrypted size completes');
 r=await user('POST','/api/user/memos',{type:'file',size:1,parts:1,meta:'opaque'});const wrong=r.data.id;
 await user('PUT',`/api/user/memos/${wrong}/parts/0`,Buffer.alloc(30));r=await user('POST',`/api/user/memos/${wrong}/complete`);check(r.status===400,'declared size cannot bypass content limits');
 r=await user('POST','/api/user/memos',{type:'file',size:2,parts:2,meta:'opaque'});const sparse=r.data.id;
 await user('PUT',`/api/user/memos/${sparse}/parts/1`,Buffer.alloc(29));
 r=await user('DELETE',`/api/user/memos/${sparse}`);check(r.status===200,'sparse unfinished upload can be deleted');
 r=await user('GET','/api/profiles/%25');check(r.status===404,'literal percent URL is decoded once');
 r=await user('GET','/assets/%25');check(r.status===404,'literal percent static URL does not produce HTTP 500');
 r=await admin('POST','/api/admin/password',{current:'release-test-password',next:'new-release-password'});check(r.status===200,'admin password change succeeds');
 r=await admin('GET','/api/admin/settings');check(r.status===401,'password change invalidates existing admin sessions');
 // Corrupt-state recovery must fail closed and preserve evidence, never overwrite with empty state.
 const corrupt=path.join(dir,'corrupt');await import('node:fs/promises').then(fs=>fs.mkdir(corrupt));
 await writeFile(path.join(corrupt,'snapshot.json'),'{broken');
 await assert.rejects(new Store(corrupt).load(),/快照损坏/);check(await readFile(path.join(corrupt,'snapshot.json'),'utf8')==='{broken','corrupt snapshot is preserved and startup refused');
 const good=new Store(path.join(dir,'closed'));await good.load();await good.close();await assert.rejects(good.flushDurable(),/已关闭/);check(true,'closed metadata store cannot authorize source deletion');
 check(!logs.includes('unhandledRejection')&&!logs.includes('uncaughtException'),'no unhandled server errors');
 console.log(`${count} release regressions passed`);
} catch(e){console.error(logs);throw e;} finally {server.kill('SIGTERM');await new Promise(r=>server.once('exit',r));await rm(dir,{recursive:true,force:true});}
