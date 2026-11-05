const vm=require('node:vm'),assert=require('node:assert/strict'),{buildSync}=require('esbuild');
const code=buildSync({entryPoints:['web/assets/js/media.js'],bundle:true,write:false,format:'iife',globalName:'Media'}).outputFiles[0].text;
let created=0,revoked=0,resolveDecrypt;
const text='你好 world';const bytes=Buffer.from(text);let parts=[bytes.subarray(0,2),bytes.subarray(2)];
const ctx={Blob,AbortController,AbortSignal,URL:{createObjectURL:()=>`blob:${++created}`,revokeObjectURL:()=>revoked++},
 fetch:async url=>({ok:true,arrayBuffer:async()=>Uint8Array.from(parts[Number(new URL(url,'https://test').searchParams.get('part')||0)]).buffer})};
vm.createContext(ctx);vm.runInContext(code,ctx);
(async()=>{
 const old=new ctx.Media.MediaManager({decryptBytes:async()=>new Promise(resolve=>resolveDecrypt=resolve)});
 const pending=old.thumbUrl({id:'old'});await new Promise(r=>setImmediate(r));old.clear();resolveDecrypt({buffer:new ArrayBuffer(8)});
 await assert.rejects(pending,{name:'AbortError'});assert.equal(created,0);assert.equal(old.thumbs.size,0);
 const media=new ctx.Media.MediaManager({decryptBytes:async buffer=>({buffer})});
 assert.equal(await media.text({id:'text',parts:2}),text);assert.equal(created,1);media.clear();assert.equal(revoked,1);
 await assert.rejects(media.content({id:'text',parts:2}),{name:'AbortError'});
 console.log('PASS: late thumbnail completion cannot recreate URLs after lock; multipart UTF-8 text is complete; disposed managers reject new work');
})().catch(e=>{console.error(e);process.exitCode=1;});
