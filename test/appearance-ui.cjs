// NUI_JSDOM_MODULE=/tmp/nui-ui-test/node_modules/jsdom node test/appearance-ui.cjs
const { JSDOM } = require(process.env.NUI_JSDOM_MODULE || 'jsdom');
const { buildSync } = require('esbuild'); const assert = require('node:assert/strict');
const bundle = entry => buildSync({entryPoints:[entry],bundle:true,write:false,format:'iife',globalName:'Test',plugins:[]});
(async()=>{
  // esbuild's CLI-like synchronous API cannot use a resolver plugin; absolute imports
  // are rewritten in an in-memory entry via a small temporary bundle with async API.
  const {build}=require('esbuild'); const path=require('node:path');
  const output=await build({entryPoints:['web/admin/customize.js'],bundle:true,write:false,format:'iife',globalName:'Customize',plugins:[{name:'root',setup(b){b.onResolve({filter:/^\/assets\//},a=>({path:path.resolve('web'+a.path)}));}}]});
  const app=await build({entryPoints:['web/assets/js/appearance.js'],bundle:true,write:false,format:'iife',globalName:'Appearance'});
  let terminations=0, revokes=0, created=0;
  const dom=new JSDOM('<main></main>', {url:'https://memo.test',runScripts:'outside-only',pretendToBeVisual:true}); const w=dom.window;
  w.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}});
  w.fetch=async()=>({ok:true,headers:{get:()=> 'application/json'},json:async()=>({ok:true,appearance:{assets:{},petSize:120},storageMode:'local'})});
  w.Worker=class{constructor(){created++;}postMessage(){this.onmessage({data:{bytes:new Uint8Array([1]).buffer,type:'image/gif',width:1,height:1,frames:1}});}terminate(){terminations++;}};
  w.URL.createObjectURL=()=> 'blob:test'; w.URL.revokeObjectURL=()=>{revokes++;};
  w.eval(app.outputFiles[0].text);
  for(let i=0;i<30;i++)w.Appearance.applyAppearance({userColor:'#123456',assets:{pet:'/api/theme-assets/pet',desktop:'/api/theme-assets/desktop'},petEnabled:true,petSize:240});
  assert.equal(w.document.querySelectorAll('.site-pet').length,1); assert.equal(w.document.querySelectorAll('#site-appearance').length,1);
  assert(w.document.querySelector('#site-appearance').textContent.includes('max-width:599px'));
  w.Appearance.applyAppearance({assets:{},petEnabled:false}); assert.equal(w.document.querySelectorAll('.site-pet').length,0);
  w.eval(output.outputFiles[0].text); const page=w.document.querySelector('main'); const cleanup=w.Customize.renderAppearance(page);
  await new Promise(r=>setTimeout(r,20));
  const input=page.querySelector('input[type=file]'); assert(input);
  Object.defineProperty(input,'files',{value:[{size:10,type:'image/gif',arrayBuffer:async()=>new ArrayBuffer(10)}]});
  [...page.querySelectorAll('button')].find(b=>b.textContent==='本机压缩 / 抠图并预览').click();
  await new Promise(r=>setTimeout(r,20)); assert.equal(created,1); assert.equal(terminations,1);
  cleanup(); assert.equal(revokes,1);
  console.log('PASS: singleton pet/styles, responsive background rules, worker termination, preview URL cleanup');
  dom.window.close();
})().catch(e=>{console.error(e);process.exitCode=1;});
