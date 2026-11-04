// 本地 Telegram Bot API 模拟器（仅用于测试 / 演示，生产连接真实 api.telegram.org）
import http from 'node:http';
import crypto from 'node:crypto';

const files = new Map(); // file_id -> {bytes, name}
const messages = new Map(); // message_id -> file_id
let msgSeq = 1000;

function parseMultipart(buf, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!m) return { fields: {}, file: null };
  const boundary = Buffer.from('--' + (m[1] || m[2]).trim());
  const fields = {};
  let file = null;
  const sep = Buffer.from('\r\n\r\n');
  let idx = buf.indexOf(boundary);
  while (idx >= 0) {
    const start = idx + boundary.length;
    const next = buf.indexOf(boundary, start);
    if (next < 0) break;
    let part = buf.slice(start, next);
    // 去掉开头的 \r\n 与结尾的 \r\n
    if (part.slice(0, 2).toString() === '\r\n') part = part.slice(2);
    if (part.slice(-2).toString() === '\r\n') part = part.slice(0, -2);
    const headerEnd = part.indexOf(sep);
    if (headerEnd >= 0) {
      const headers = part.slice(0, headerEnd).toString('utf8');
      const body = part.slice(headerEnd + 4);
      const nameM = /name="([^"]+)"/.exec(headers);
      const fileM = /filename="([^"]*)"/.exec(headers);
      if (nameM) {
        if (fileM) file = { name: fileM[1], bytes: Buffer.from(body) };
        else fields[nameM[1]] = body.toString('utf8');
      }
    }
    idx = next;
  }
  return { fields, file };
}

export function startMockTelegram(port = 9099) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const json = (obj) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const buf = Buffer.concat(chunks);
      const path = url.pathname;
      const send = (result) => json({ ok: true, result });
      if (path.endsWith('/getMe')) return send({ id: 123456, is_bot: true, first_name: 'Mock', username: 'mock_memo_bot' });
      if (path.endsWith('/getChat')) {
        let chatId = '';
        try { chatId = String(JSON.parse(buf.toString()).chat_id); } catch {}
        return send({ id: chatId || -100123, type: 'private', title: 'Mock Chat', first_name: 'Admin' });
      }
      if (path.endsWith('/getUpdates')) return send([
        { update_id: 1, message: { message_id: 1, chat: { id: 100200300, type: 'private', first_name: 'Demo', username: 'demo_admin' }, date: 0, text: '/start' } },
      ]);
      if (path.endsWith('/deleteMessage')) {
        try { const b = JSON.parse(buf.toString()); messages.delete(b.message_id); } catch {}
        return send(true);
      }
      if (path.endsWith('/getFile')) {
        let fileId = '';
        try { fileId = JSON.parse(buf.toString()).file_id; } catch {}
        if (!files.has(fileId)) return json({ ok: false, error_code: 400, description: 'file not found' });
        return send({ file_id: fileId, file_path: `documents/${fileId}.bin` });
      }
      if (path.endsWith('/sendDocument')) {
        const { file } = parseMultipart(buf, req.headers['content-type']);
        if (!file) return json({ ok: false, error_code: 400, description: 'no document' });
        const fileId = 'F' + crypto.randomBytes(12).toString('hex');
        const messageId = ++msgSeq;
        files.set(fileId, { bytes: file.bytes, name: file.name });
        messages.set(messageId, fileId);
        return send({ message_id: messageId, document: { file_id: fileId, file_unique_id: fileId, file_name: file.name, file_size: file.bytes.length } });
      }
      if (path.startsWith('/file/')) {
        const fileId = path.split('/').pop().replace('.bin', '');
        const f = files.get(fileId);
        if (!f) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': f.bytes.length });
        res.end(f.bytes);
        return;
      }
      json({ ok: false, error_code: 404, description: 'unknown method ' + path });
    });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ server, port, files, messages })));
}

if (process.argv[1] && process.argv[1].endsWith('mock-telegram.mjs')) {
  const port = parseInt(process.argv[2] || '9099', 10);
  startMockTelegram(port).then(() => console.log(`Mock Telegram on http://127.0.0.1:${port}`));
}
