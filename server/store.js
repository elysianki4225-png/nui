import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { nowSec } from './util.js';

const MB = 1024 * 1024;

function defaultState() {
  return {
    version: 1,
    admin: null,
    users: {},
    memos: {},
    sessions: {},
    ipBans: {},
    bots: [],
    settings: {
      siteName: '备忘录',
      registrationOpen: true,
      maxFileSizeMB: 128,
      userSessionDays: 30,
      adminSessionHours: 12,
      autoLockMinutes: 30,
      motd: '',
      // 跨域 / 前端部署
      corsMode: 'off',          // off | whitelist | open
      corsOrigins: [],          // 允许的前端 Origin 列表
      // 广告
      adsEnabled: false,
      adsMode: 'custom',        // custom | html
      adsHtml: '',              // 任意广告网络代码（AdSense 等）
      adsItems: [],             // 自有广告 [{id,title,image,url,enabled}]
    },
    audit: [],
    stats: { createdAt: nowSec() },
  };
}

/**
 * 零依赖持久化：内存索引 + 追加式事件日志 + 定期快照压缩。
 * 磁盘上只保存：账号元数据、封禁规则、会话哈希、机器人凭据，
 * 以及备忘录的「密文元数据」（标题/摘要的密文）。正文与媒体密文按管理员配置存于 Telegram 或本地对象目录。
 */
export class Store {
  constructor(dir) {
    this.dir = dir;
    this.snapshotFile = path.join(dir, 'snapshot.json');
    this.logFile = path.join(dir, 'events.jsonl');
    this.tmpFile = path.join(dir, 'snapshot.json.tmp');
    this.state = defaultState();
    this.writeChain = Promise.resolve();
    this.logLines = 0;
    this.dirty = false;
    this.lastCompact = Date.now();
    this.accountIndex = new Map(); // account -> Memo[]（按 createdAt 降序）
    this.closed = false;
    this.compactTimer = null;
    this.pruneTimer = null;
    this.onSessionPrune = null;
  }

  async load() {
    await fsp.mkdir(this.dir, { recursive: true });
    if (fs.existsSync(this.snapshotFile)) {
      try {
        const raw = await fsp.readFile(this.snapshotFile, 'utf8');
        const snap = JSON.parse(raw);
        this.state = { ...defaultState(), ...snap, settings: { ...defaultState().settings, ...(snap.settings || {}) } };
      } catch (e) {
        console.error('[store] 快照损坏，尝试从事件日志恢复:', e.message);
        this.state = defaultState();
      }
    }
    if (fs.existsSync(this.logFile)) {
      const raw = await fsp.readFile(this.logFile, 'utf8');
      let applied = 0;
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try {
          this.apply(JSON.parse(line));
          applied++;
        } catch (e) {
          console.error('[store] 跳过损坏日志行:', e.message);
        }
      }
      this.logLines = applied;
    }
    this.rebuildIndex();
    this.pruneSessions();
    this.prunePendingMemos();
    this.compactTimer = setInterval(() => this.maybeCompact(), 60_000);
    this.compactTimer.unref();
    this.pruneTimer = setInterval(() => { this.pruneSessions(); this.prunePendingMemos(); }, 10 * 60_000);
    this.pruneTimer.unref();
    await this.compact();
  }

  rebuildIndex() {
    this.accountIndex.clear();
    for (const memo of Object.values(this.state.memos)) {
      this.indexAdd(memo);
    }
    for (const arr of this.accountIndex.values()) {
      arr.sort((a, b) => (b.createdAt - a.createdAt) || (a.id < b.id ? 1 : -1));
    }
  }

  indexAdd(memo) {
    let arr = this.accountIndex.get(memo.account);
    if (!arr) { arr = []; this.accountIndex.set(memo.account, arr); }
    // 二分插入保持降序
    let lo = 0, hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const m = arr[mid];
      if (m.createdAt > memo.createdAt || (m.createdAt === memo.createdAt && m.id < memo.id)) lo = mid + 1;
      else hi = mid;
    }
    arr.splice(lo, 0, memo);
  }

  indexRemove(memo) {
    const arr = this.accountIndex.get(memo.account);
    if (!arr) return;
    const i = arr.indexOf(memo);
    if (i >= 0) arr.splice(i, 1);
    if (!arr.length) this.accountIndex.delete(memo.account);
  }

  apply(ev) {
    const s = this.state;
    switch (ev.t) {
      case 'admin.set': s.admin = ev.admin; break;
      case 'user.create': s.users[ev.user.account] = ev.user; break;
      case 'user.update': {
        const u = s.users[ev.account];
        if (u) Object.assign(u, ev.patch);
        break;
      }
      case 'user.delete': delete s.users[ev.account]; break;
      case 'memo.create': s.memos[ev.memo.id] = ev.memo; this.indexAdd(ev.memo); break;
      case 'memo.update': {
        const m = s.memos[ev.id];
        if (m) Object.assign(m, ev.patch);
        break;
      }
      case 'memo.delete': {
        const m = s.memos[ev.id];
        if (m) { this.indexRemove(m); delete s.memos[ev.id]; }
        break;
      }
      case 'session.create': s.sessions[ev.session.tokenHash] = ev.session; break;
      case 'session.delete': delete s.sessions[ev.tokenHash]; break;
      case 'ban.add': s.ipBans[ev.ban.id] = ev.ban; break;
      case 'ban.update': {
        const b = s.ipBans[ev.id];
        if (b) Object.assign(b, ev.patch);
        break;
      }
      case 'ban.remove': delete s.ipBans[ev.id]; break;
      case 'bot.add': s.bots.push(ev.bot); break;
      case 'bot.update': {
        const b = s.bots.find((x) => x.id === ev.id);
        if (b) Object.assign(b, ev.patch);
        break;
      }
      case 'bot.remove': s.bots = s.bots.filter((x) => x.id !== ev.id); break;
      case 'settings.set': Object.assign(s.settings, ev.settings); break;
      case 'audit.add':
        s.audit.push(ev.entry);
        if (s.audit.length > 1000) s.audit.splice(0, s.audit.length - 1000);
        break;
      default: break;
    }
  }

  log(ev) {
    if (this.closed) return;
    this.apply(ev);
    this.dirty = true;
    this.logLines++;
    const line = JSON.stringify(ev) + '\n';
    this.writeChain = this.writeChain.then(() => fsp.appendFile(this.logFile, line)).catch((e) => {
      this.writeFailure = e;
      console.error('[store] 写入日志失败:', e.message);
    });
    if (this.logLines > 5000) this.maybeCompact(true);
  }

  touch() { this.dirty = true; }

  async maybeCompact(force = false) {
    if (this.closed) return;
    const age = Date.now() - this.lastCompact;
    if (!force && (!this.dirty || age < 5 * 60_000)) return;
    if (!this.dirty && !force) return;
    await this.compact();
  }

  compact() {
    if (this.closed) return Promise.resolve();
    // Capture state before later log() calls, serialize rename/truncate with log writes.
    const data = JSON.stringify(this.state);
    this.dirty = false;
    this.lastCompact = Date.now();
    const job = this.writeChain.then(async () => {
      const fh = await fsp.open(this.tmpFile, 'w', 0o600);
      try { await fh.writeFile(data); await fh.sync(); } finally { await fh.close(); }
      await fsp.rename(this.tmpFile, this.snapshotFile);
      const dir = await fsp.open(path.dirname(this.snapshotFile), 'r');
      try { await dir.sync(); } finally { await dir.close(); }
      const log = await fsp.open(this.logFile, 'w', 0o600);
      try { await log.sync(); } finally { await log.close(); }
      this.logLines = 0;
    });
    this.writeChain = job.catch(e => { this.writeFailure = e; this.dirty = true; console.error('[store] 快照写入失败:', e.message); });
    return this.writeChain;
  }

  async flushDurable() {
    await this.compact();
    if (this.writeFailure) throw new Error('元数据写入失败；为避免丢失数据，未删除原文件，请检查磁盘并重启');
  }

  async close() {
    clearInterval(this.compactTimer);
    clearInterval(this.pruneTimer);
    await this.writeChain.catch(() => {});
    await this.compact();   // 先落盘再标记关闭（compact 在 closed 时会直接返回）
    this.closed = true;
  }

  // ---- 会话 ----
  pruneSessions() {
    const now = nowSec();
    const expired = Object.entries(this.state.sessions).filter(([, s]) => s.expiresAt <= now);
    for (const [hash] of expired) this.log({ t: 'session.delete', tokenHash: hash });
    if (expired.length && this.onSessionPrune) this.onSessionPrune(expired.length);
  }

  // ---- 未完成上传清理 ----
  prunePendingMemos() {
    if (this.state.settings.storageMigration) return [];
    const cutoff = nowSec() - 3600;
    const stale = Object.values(this.state.memos).filter((m) => m.status === 'pending' && m.createdAt < cutoff);
    for (const m of stale) this.log({ t: 'memo.delete', id: m.id });
    return stale;
  }

  // ---- 查询 ----
  listMemos(account, { cursor, limit = 100, type, pinned, query } = {}) {
    const arr = this.accountIndex.get(account) || [];
    let start = 0;
    if (cursor) {
      const [ts, id] = cursor.split(':');
      const cts = parseInt(ts, 10);
      while (start < arr.length) {
        const m = arr[start];
        if (m.createdAt < cts || (m.createdAt === cts && m.id > id)) break;
        start++;
      }
    }
    const items = [];
    let i = start;
    for (; i < arr.length && items.length < limit; i++) {
      const m = arr[i];
      if (m.status !== 'ready') continue;
      if (type && type !== 'all' && m.type !== type) continue;
      if (pinned === true && !m.pinned) continue;
      items.push(m);
    }
    const nextCursor = i < arr.length && items.length ? `${arr[i - 1].createdAt}:${arr[i - 1].id}` : null;
    return { items, nextCursor, scanned: i };
  }

  userStats(account) {
    const arr = this.accountIndex.get(account) || [];
    let count = 0, bytes = 0, images = 0, videos = 0, texts = 0, files = 0, pinned = 0;
    for (const m of arr) {
      if (m.status !== 'ready') continue;
      count++;
      bytes += m.size || 0;
      if (m.type === 'image') images++;
      else if (m.type === 'video') videos++;
      else if (m.type === 'text') texts++;
      else files++;
      if (m.pinned) pinned++;
    }
    return { count, bytes, images, videos, texts, files, pinned };
  }

  totals() {
    let memos = 0, bytes = 0, pending = 0;
    for (const m of Object.values(this.state.memos)) {
      if (m.status === 'ready') { memos++; bytes += m.size || 0; }
      else pending++;
    }
    const users = Object.values(this.state.users);
    return {
      users: users.length,
      bannedUsers: users.filter((u) => u.banned).length,
      memos, bytes, pending,
      ipBans: Object.keys(this.state.ipBans).length,
      bots: this.state.bots.length,
      activeBots: this.state.bots.filter((b) => b.enabled).length,
    };
  }

  audit(actor, action, detail) {
    this.log({ t: 'audit.add', entry: { ts: nowSec(), actor, action, detail: String(detail || '').slice(0, 500) } });
  }
}
