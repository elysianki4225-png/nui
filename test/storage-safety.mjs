import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../server/store.js';
import { StoragePool } from '../server/storage.js';
const dir = await mkdtemp(path.join(tmpdir(), 'nui-storage-safety-'));
let store = new Store(dir); await store.load();
const cfg = { dataDir: dir, chunkSize: 1048576 };
let pool = new StoragePool(store, cfg);
const payload = Buffer.from('original-ciphertext');
const source = { botId:'mock', fileId:'source', messageId:'source', size:payload.length };
store.log({ t:'user.create', user:{ account:'1', avatar:source } });
store.log({ t:'settings.set', settings:{ storageMigration:{target:'local',moved:0} } });
let deleted = [];
const read = pool.read.bind(pool), del = pool.deleteMessage.bind(pool);
pool.read = async (ref, max) => ref.botId === 'mock' ? payload : read(ref, max);
pool.deleteMessage = async (id,msg) => { deleted.push([id,msg]); return id === 'mock' ? false : del(id,msg); };
try {
  // A failed verification must not publish the new reference or delete the source.
  pool.read = async ref => ref.botId === 'mock' ? payload : Buffer.from('corrupted');
  await assert.rejects(pool.step(), /校验失败/);
  assert.equal(store.state.users['1'].avatar.fileId, 'source'); assert(!deleted.some(x=>x[0]==='mock'));
  pool.read = async (ref,max) => ref.botId === 'mock' ? payload : read(ref,max);
  await pool.step();
  assert.equal(store.state.users['1'].avatar.botId, 'local'); assert.equal(pool.status().cleanupPending,1);
  assert((await pool.read(store.state.users['1'].avatar)).equals(payload));
  await pool.step(); assert.equal(pool.mode(),'local'); assert.equal(pool.status().migration,null);
  // Persisted cleanup and new reference survive restart; deletion failure isn't success.
  pool.stop(); await store.close(); store=new Store(dir); await store.load(); pool=new StoragePool(store,cfg);
  assert.equal(pool.status().cleanupPending,1); assert.equal(store.state.users['1'].avatar.botId,'local');
  const localRef=store.state.users['1'].avatar;
  // An interrupted journal entry referencing a live object must never delete it.
  store.log({t:'settings.set',settings:{storageCleanup:[localRef]}});
  await pool.cleanupOne(localRef); assert((await pool.read(localRef)).equals(payload));
  // Metadata I/O failure stops migration before deleting any source.
  store.log({t:'settings.set',settings:{storageMigration:{target:'telegram',moved:0}}});
  pool.upload=async()=>({...source,fileId:'destination',messageId:'destination'});
  const localRead=pool.read.bind(pool); pool.read=async(ref,max)=>ref.botId==='mock'?payload:localRead(ref,max);
  let removed=false; pool.deleteMessage=async()=>{removed=true;return true;};
  pool.durable=async()=>{throw new Error('disk failure');};
  await assert.rejects(pool.step(),/disk failure/); assert.equal(removed,false);
  // Snapshot truncation is serialized with subsequently appended events.
  for(let i=0;i<100;i++){store.log({t:'settings.set',settings:{testSequence:i}});if(i%7===0)store.compact();}
  await store.close(); pool.stop(); store=new Store(dir);await store.load();assert.equal(store.state.settings.testSequence,99);
  console.log('PASS: checksum failure, source-delete failure, restart journal, live-source guard, metadata I/O failure, serialized snapshots');
} finally { pool.stop(); await store.close(); await rm(dir,{recursive:true,force:true}); }
