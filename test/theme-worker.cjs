// npm install --prefix /tmp/nui-ui-test @napi-rs/canvas@0.1.80
// NUI_CANVAS_MODULE=/tmp/nui-ui-test/node_modules/@napi-rs/canvas node test/theme-worker.cjs
const vm = require('node:vm'), assert = require('node:assert/strict');
const { buildSync } = require('esbuild');
const canvas = require(process.env.NUI_CANVAS_MODULE || '@napi-rs/canvas');
const { GIFEncoder } = require('gifenc');
const { parseGIF, decompressFrames } = require('gifuct-js');
const bundle = buildSync({ entryPoints: ['scripts/theme-image-worker.js'], bundle: true, write: false, format: 'iife', globalName: 'WorkerCode' }).outputFiles[0].text;
const messages = [];
class OffscreenCanvas { constructor(w, h) { const c = canvas.createCanvas(w,h); c.convertToBlob = async ({type,quality}) => new Blob([await c.encode(type === 'image/webp' ? 'webp' : 'png', Math.round(quality*100))], {type}); return c; } }
const ctx = { Uint8Array, Uint8ClampedArray, Uint32Array, ArrayBuffer, self: {postMessage: x => messages.push(x)}, OffscreenCanvas, ImageData: canvas.ImageData, Blob, TextDecoder, console,
  createImageBitmap: async b => {const image = await canvas.loadImage(Buffer.from(await b.arrayBuffer())); image.close = () => {}; return image;} };
vm.createContext(ctx); vm.runInContext(bundle, ctx);
async function run(bytes, options={}) { messages.length=0; await ctx.self.onmessage({ data: {bytes: Uint8Array.from(bytes).buffer, type:'image/gif', slot:'pet', cutout:true, color:'#ffffff', tolerance:10, ...options} }); return messages.at(-1); }
(async()=>{
  const gif=GIFEncoder(); const palette=[[255,255,255],[255,0,0]];
  gif.writeFrame(new Uint8Array([0,0,0,0,1,0,0,0,0]),3,3,{palette,delay:100,dispose:2});
  gif.writeFrame(new Uint8Array([0,0,0,0,1,1,0,0,0]),3,3,{palette,delay:200,dispose:2}); gif.finish();
  const result=await run(gif.bytes()); assert(!result.error,result.error); assert.equal(result.frames,2);
  const frames=decompressFrames(parseGIF(result.bytes),true);
  assert.deepEqual(frames.map(f=>f.delay),[100,200]); assert.equal(frames[0].patch[3],0); assert.equal(frames[0].patch[19],255);
  const image=canvas.createCanvas(1200,600); image.getContext('2d').fillRect(0,0,1200,600);
  const still=await run(await image.encode('png'),{type:'image/png',cutout:false}); assert(!still.error,still.error); assert.equal(still.width,512); assert.equal(still.height,256); assert.equal(still.type,'image/webp');
  const huge=GIFEncoder(); for(let i=0;i<241;i++) huge.writeFrame(new Uint8Array([0]),1,1,{palette,delay:100}); huge.finish();
  assert((await run(huge.bytes())).error.includes('240'));
  assert((await run(new Uint8Array(12*1024*1024+1))).error.includes('12MB'));
  console.log('PASS: animated GIF frame count/delays, transparency matting, static resize/WebP, frame/byte limits');
})().catch(e=>{console.error(e); process.exitCode=1;});
