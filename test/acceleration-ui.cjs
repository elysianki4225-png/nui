// NUI_JSDOM_MODULE=/tmp/nui-ui-test/node_modules/jsdom node test/acceleration-ui.cjs
const {JSDOM}=require(process.env.NUI_JSDOM_MODULE||'jsdom');
const {build}=require('esbuild'); const path=require('node:path'),assert=require('node:assert/strict');
(async()=>{
 const bundle=await build({entryPoints:['web/admin/acceleration.js'],bundle:true,write:false,format:'iife',globalName:'Feature',plugins:[{name:'root',setup(b){b.onResolve({filter:/^\/assets\//},a=>({path:path.resolve('web'+a.path)}));}}]});
 const dom=new JSDOM('<main></main>',{url:'https://memo.example.com',runScripts:'outside-only'}),w=dom.window;
 let saved=0,checked=0,cancelled=0,hold=false;
 const guide={host:'memo.example.com',cdn:'cloudflare',sharedAdmin:true,records:[],notices:['仅手动配置 DNS']};
 w.fetch=async(url,opts)=>{
  if(hold)return new Promise((resolve,reject)=>opts.signal.addEventListener('abort',()=>{cancelled++;reject(new w.DOMException('aborted','AbortError'));}));
  let data={ok:true,plan:{enabled:false,kind:'ip',ips:[],cname:''},guide};
  if(opts.method==='PATCH'){saved++;const p=JSON.parse(opts.body);data={ok:true,plan:p,guide:{...guide,records:[{type:'A',name:guide.host,value:p.ips[0]}]}};}
  if(opts.method==='POST'){checked++;data={ok:true,host:guide.host,results:[{address:'104.16.0.1',ok:true,latencyMs:5,status:200}],note:'没有更改 DNS'};}
  return {ok:true,headers:{get:()=> 'application/json'},json:async()=>data};
 };
 w.eval(bundle.outputFiles[0].text);const page=w.document.querySelector('main'),dispose=w.Feature.renderAcceleration(page);const tick=()=>new Promise(r=>setTimeout(r,10));await tick();
 assert(!page.querySelector('details').open);assert(!page.querySelector('input[type=checkbox]').checked);assert(!page.textContent.includes('null'));
 assert(page.textContent.includes('共用域名'));const ips=page.querySelector('textarea'),kind=page.querySelector('select');ips.value='104.16.0.1';page.querySelector('input[type=checkbox]').checked=true;
 const button=t=>[...page.querySelectorAll('button')].find(b=>b.textContent.startsWith(t));
 button('保存方案').click();await tick();assert.equal(saved,1);assert(page.textContent.includes('完整记录名'));
 button('检测候选').click();await tick();assert.equal(checked,1);assert(page.textContent.includes('HTTPS 与健康接口通过'));
 kind.value='cname';kind.dispatchEvent(new w.Event('input'));assert(ips.closest('label').hidden);assert(!page.textContent.includes('HTTPS 与健康接口通过'));
 hold=true;button('检测候选').click();await tick();dispose();await tick();assert.equal(cancelled,1);
 assert.equal(page.querySelectorAll('.acceleration').length,1);dom.window.close();
 console.log('PASS acceleration UI: default off/collapsed, shared-host warning, explicit save, check rendering, stale result clearing, page cleanup cancels request');
})().catch(e=>{console.error(e);process.exitCode=1;});
