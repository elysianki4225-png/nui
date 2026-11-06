import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Store} from '../server/store.js';
import {readJson,parseCookies} from '../server/util.js';
import {Captcha} from '../server/captcha.js';
import {DomainManager} from '../server/domain-manager.js';
for(const body of ['null','[]','true','42','"text"','{'])await assert.rejects(readJson(Readable.from([Buffer.from(body)])),e=>e.status===400);
assert.deepEqual(await readJson(Readable.from([Buffer.from('{"ok":true}')])),{ok:true});
const cookies=parseCookies({headers:{cookie:'bad=%ZZ; good=a%20b; __proto__=test'}});assert.equal(cookies.good,'a b');assert.equal(cookies.bad,undefined);assert.equal(Object.getPrototypeOf(cookies),null);
const dir=await mkdtemp(path.join(tmpdir(),'nui-review-'));let store=new Store(dir);
try{
 await store.load();
 for(const id of ['c','a','e','b','d'])store.log({t:'memo.create',memo:{id,account:'123',createdAt:100,status:'ready',parts:[]}});
 const pages=()=>{let cursor,ids=[];for(let n=0;n<10;n++){const p=store.listMemos('123',{cursor,limit:2});ids.push(...p.items.map(m=>m.id));cursor=p.nextCursor;if(!cursor)return ids;}throw Error('pagination loop');};
 assert.deepEqual(pages(),['a','b','c','d','e']);store.rebuildIndex();assert.deepEqual(pages(),['a','b','c','d','e']);
 const ref={botId:'local',fileId:'stale',messageId:'stale'};
 store.log({t:'memo.create',memo:{id:'pending',account:'123',createdAt:1,status:'pending',parts:[ref]}});
 store.prunePendingMemos();assert(!store.state.memos.pending);assert.deepEqual(store.state.settings.storageCleanup,[ref]);
 await store.close();store=new Store(dir);await store.load();assert.deepEqual(pages(),['a','b','c','d','e']);assert.deepEqual(store.state.settings.storageCleanup,[ref]);
}finally{await store.close();await rm(dir,{recursive:true,force:true});}
const state={settings:{captcha:{enabled:true,version:1}}};const captcha=new Captcha({state},{});captcha.verify=async()=>{state.settings.captcha={enabled:true,version:2};};
await assert.rejects(captcha.check({captchaToken:'test'},'127.0.0.1'),e=>e.code==='CAPTCHA_CHANGED');
const manager=new DomainManager({dataDir:tmpdir()},{}),originalFetch=globalThis.fetch;let signal;
try{
 globalThis.fetch=async(u,opts)=>{signal=opts.signal;return new Response(JSON.stringify({success:true,result:{status:'active'}}));};
 assert.equal((await manager.verifyCfToken('secret')).ok,true);assert(signal.aborted);
 globalThis.fetch=async(u,opts)=>{signal=opts.signal;return new Response('x'.repeat(17000));};
 const bad=await manager.verifyCfToken('secret');assert.equal(bad.ok,false);assert(!bad.error.includes('secret'));assert(signal.aborted);
 manager.cfg.userHost='memo.example';manager.check=async()=>({addresses:[],error:null});
 for(const [status,body,expected] of [[403,'blocked',false],[200,'<html>challenge</html>',false],[200,JSON.stringify({ok:true,version:'test',uptime:1}),true]]){
  globalThis.fetch=async()=>new Response(body,{status});const p=await manager.probe({host:'memo.example',scheme:'http'});assert.equal(p.origin.ok,expected);assert.equal(p.http.ok,expected);
 }
}finally{globalThis.fetch=originalFetch;}
console.log('PASS review: object-only JSON, malformed cookies, stable restart pagination, durable pending cleanup, CAPTCHA configuration races, bounded CF response cleanup');
