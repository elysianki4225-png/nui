export async function compressPetAudio(
  file,
  { signal, onProgress = () => {} } = {},
) {
  const check = () => {
    if (signal?.aborted) throw new DOMException("处理已取消", "AbortError");
  };
  if (!file.size || file.size > 30 * 1024 * 1024)
    throw Error("音频原文件需小于 30MB");
  check();
  const url = URL.createObjectURL(file),
    media = new Audio();
  let context;
  try {
    onProgress(null);
    await new Promise((resolve, reject) => {
      const finish = (e) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        media.onloadedmetadata = media.onerror = null;
        e ? reject(e) : resolve();
      };
      const abort = () => finish(new DOMException("处理已取消", "AbortError"));
      const timer = setTimeout(() => finish(Error("读取音频超时")), 15000);
      media.onloadedmetadata = () =>
        Number.isFinite(media.duration) &&
        media.duration > 0 &&
        media.duration <= 60
          ? finish()
          : finish(Error("桌宠音乐 / 音效最长 60 秒，请先裁剪"));
      media.onerror = () =>
        finish(Error("浏览器不支持此音频，请转换为 MP3 或 WAV"));
      signal?.addEventListener("abort", abort, { once: true });
      media.preload = "metadata";
      media.src = url;
    });
    check();
    context = new (window.AudioContext || window.webkitAudioContext)();
    const decoded = await context.decodeAudioData(await file.arrayBuffer());
    check();
    if (decoded.duration > 60 || decoded.duration <= 0)
      throw Error("桌宠音频最长 60 秒");
    const offline = new OfflineAudioContext(
        1,
        Math.ceil(decoded.duration * 16000),
        16000,
      ),
      source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start();
    const rendered = await offline.startRendering();
    check();
    const pcm = rendered.getChannelData(0),
      bytes = new ArrayBuffer(44 + pcm.length * 2),
      v = new DataView(bytes);
    const str = (i, s) => {
      for (let k = 0; k < s.length; k++) v.setUint8(i + k, s.charCodeAt(k));
    };
    str(0, "RIFF");
    v.setUint32(4, bytes.byteLength - 8, true);
    str(8, "WAVE");
    str(12, "fmt ");
    v.setUint32(16, 16, true);
    v.setUint16(20, 1, true);
    v.setUint16(22, 1, true);
    v.setUint32(24, 16000, true);
    v.setUint32(28, 32000, true);
    v.setUint16(32, 2, true);
    v.setUint16(34, 16, true);
    str(36, "data");
    v.setUint32(40, pcm.length * 2, true);
    for (let i = 0; i < pcm.length; i += 16384) {
      check();
      for (let j = i; j < Math.min(i + 16384, pcm.length); j++) {
        const n = Math.max(-1, Math.min(1, pcm[j]));
        v.setInt16(44 + j * 2, Math.round(n * (n < 0 ? 32768 : 32767)), true);
      }
      onProgress(Math.min(1, (i + 16384) / pcm.length));
      await new Promise((r) => setTimeout(r, 0));
    }
    check();
    return new Blob([bytes], { type: "audio/wav" });
  } finally {
    media.pause();
    media.removeAttribute("src");
    media.load();
    URL.revokeObjectURL(url);
    await context?.close().catch(() => {});
  }
}
