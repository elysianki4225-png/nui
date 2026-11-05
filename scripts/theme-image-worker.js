import { parseGIF, decompressFrame } from 'gifuct-js';
import { GIFEncoder, quantize, applyPalette } from 'gifenc';

// Remove only edge-connected, near-solid background. Never claim semantic/AI matting.
export function removeBackground(image, color, tolerance) {
  const { data, width: w, height: h } = image;
  const target = color ? color.match(/[a-f0-9]{2}/gi).map(x => parseInt(x, 16)) : Array.from(data.slice(0, 3));
  const seen = new Uint8Array(w * h), queue = new Uint32Array(w * h); let head = 0, tail = 0;
  const add = n => {
    if (seen[n]) return; seen[n] = 1;
    const i = n * 4;
    if (data[i + 3] && Math.max(...target.map((v, c) => Math.abs(data[i + c] - v))) > tolerance) return;
    queue[tail++] = n;
  };
  for (let x = 0; x < w; x++) { add(x); add((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { add(y * w); add(y * w + w - 1); }
  while (head < tail) {
    const n = queue[head++]; data[n * 4 + 3] = 0;
    if (n % w) add(n - 1); if (n % w < w - 1) add(n + 1);
    if (n >= w) add(n - w); if (n + w < w * h) add(n + w);
  }
}
const scaled = (w, h, max) => { const ratio = Math.min(1, max / Math.max(w, h)); return [Math.max(1, Math.round(w * ratio)), Math.max(1, Math.round(h * ratio))]; };
async function processImage({ bytes, type, slot, cutout, color, tolerance }) {
  if (bytes.byteLength > 12 * 1024 * 1024) throw new Error('原图不能超过 12MB');
  if (typeof OffscreenCanvas === 'undefined') throw new Error('此浏览器不支持离屏画布，请升级浏览器后再处理图片');
  const isGif = new TextDecoder().decode(bytes.slice(0, 6)).startsWith('GIF8');
  const limit = slot === 'pet' ? 2 * 1024 * 1024 : 1536 * 1024;
  if (isGif) {
    const gif = parseGIF(bytes), frames = gif.frames.filter(f => f.image);
    const { width: w, height: h } = gif.lsd;
    if (!w || !h || w * h > 4000000 || !frames.length || frames.length > 240 || w * h * frames.length > 64000000) throw new Error('GIF 处理量超限：最多 240 帧、单帧 400 万像素、总计 6400 万像素，请先缩小原图');
    for (const f of frames) { const d = f.image.descriptor; if (!d.width || !d.height || d.width * d.height > 4000000 || d.left + d.width > w || d.top + d.height > h) throw new Error('GIF 帧尺寸无效'); }
    for (const max of [slot === 'pet' ? 320 : 512, 192, 128]) {
      const [width, height] = scaled(w, h, max), output = new OffscreenCanvas(width, height), out = output.getContext('2d', { willReadFrequently: true });
      const composition = new OffscreenCanvas(w, h), ctx = composition.getContext('2d', { willReadFrequently: true });
      const patchCanvas = new OffscreenCanvas(w, h), patchCtx = patchCanvas.getContext('2d');
      const encoder = GIFEncoder(); let previous = null, restored = null;
      let background = color;
      for (let i = 0; i < frames.length; i++) {
        if (previous?.disposalType === 2) {
          const d = previous.dims; ctx.clearRect(d.left, d.top, d.width, d.height);
          if (previous.transparentIndex === undefined && gif.gct?.[gif.lsd.backgroundColorIndex]) { ctx.fillStyle = `rgb(${gif.gct[gif.lsd.backgroundColorIndex].join(',')})`; ctx.fillRect(d.left, d.top, d.width, d.height); }
        }
        if (previous?.disposalType === 3 && restored) ctx.putImageData(restored, 0, 0);
        const frame = decompressFrame(frames[i], gif.gct, true);
        if (i === 0 && frame.transparentIndex === undefined && gif.gct?.[gif.lsd.backgroundColorIndex]) { ctx.fillStyle = `rgb(${gif.gct[gif.lsd.backgroundColorIndex].join(',')})`; ctx.fillRect(0, 0, w, h); }
        restored = frame.disposalType === 3 ? ctx.getImageData(0, 0, w, h) : null;
        patchCanvas.width = frame.dims.width; patchCanvas.height = frame.dims.height;
        patchCtx.putImageData(new ImageData(frame.patch, frame.dims.width, frame.dims.height), 0, 0);
        ctx.drawImage(patchCanvas, frame.dims.left, frame.dims.top);
        out.clearRect(0, 0, width, height); out.drawImage(composition, 0, 0, width, height);
        const image = out.getImageData(0, 0, width, height);
        if (cutout) {
          if (!background) background = '#' + Array.from(image.data.slice(0, 3)).map(x => x.toString(16).padStart(2, '0')).join('');
          removeBackground(image, background, tolerance);
        }
        // Keep transparent RGB consistent with quantizer clearAlpha, otherwise
        // palette mapping can choose an opaque colour for transparent white.
        for (let p = 0; p < image.data.length; p += 4) if (image.data[p + 3] < 128) image.data.fill(0, p, p + 4);
        const palette = quantize(image.data, 128, { format: 'rgba4444', oneBitAlpha: true });
        // A transparent palette entry on every frame makes disposal-to-background
        // reliable even when an individual frame is completely opaque.
        if (!palette.some(c => c[3] === 0)) palette.unshift([0, 0, 0, 0]);
        const index = applyPalette(image.data, palette, 'rgba4444');
        const transparentIndex = palette.findIndex(c => c[3] === 0);
        encoder.writeFrame(index, width, height, { palette, delay: frame.delay || 100, repeat: 0, transparent: transparentIndex >= 0, transparentIndex: Math.max(0, transparentIndex), dispose: 2 });
        previous = { dims: frame.dims, disposalType: frame.disposalType, transparentIndex: frame.transparentIndex };
        self.postMessage({ progress: Math.round((i + 1) / frames.length * 100), stage: `GIF ${width}×${height}` });
      }
      encoder.finish(); const encoded = encoder.bytes();
      if (encoded.length <= limit) return { bytes: encoded.buffer, type: 'image/gif', width, height, frames: frames.length };
    }
    throw new Error('压缩后 GIF 仍然过大，请缩短动画后重试（不会自动丢弃动画）');
  }
  const bitmap = await createImageBitmap(new Blob([bytes], { type }));
  try {
    if (bitmap.width * bitmap.height > 32000000) throw new Error('原图超过 3200 万像素，请先缩小');
    const max = slot === 'pet' ? 512 : slot === 'mobile' ? 960 : slot === 'tablet' ? 1440 : 1920;
    let [width, height] = scaled(bitmap.width, bitmap.height, max);
    for (let attempt = 0; attempt < 5; attempt++) {
      const canvas = new OffscreenCanvas(width, height), ctx = canvas.getContext('2d');
      ctx.drawImage(bitmap, 0, 0, width, height);
      if (cutout) { const image = ctx.getImageData(0, 0, width, height); removeBackground(image, color, tolerance); ctx.putImageData(image, 0, 0); }
      const blob = await canvas.convertToBlob({ type: 'image/webp', quality: .84 - attempt * .08 });
      if (blob.size <= limit) return { bytes: await blob.arrayBuffer(), type: blob.type, width, height, frames: 1 };
      width = Math.max(1, Math.round(width * .75)); height = Math.max(1, Math.round(height * .75));
    }
    throw new Error('图片压缩后仍超限，请选择更小图片');
  } finally { bitmap.close(); }
}
self.onmessage = async event => {
  try { const result = await processImage(event.data); self.postMessage(result, [result.bytes]); }
  catch (error) { self.postMessage({ error: error.message || '图片处理失败' }); }
};
