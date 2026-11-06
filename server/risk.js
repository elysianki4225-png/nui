import crypto from 'node:crypto';
import { HttpError, readJson, nowSec } from './util.js';

// Signals are advisory, never a stable identity. No canvas/font fingerprint or raw headers persisted.
export class RiskControl {
  constructor(store, clock = nowSec) { this.store=store;this.clock=clock;this.windows=new Map();this.salt=crypto.randomBytes(32); }
  settings() { return {enabled:false,autoBlock:false,...this.store.state.settings.riskControl}; }
  blocked(ip) { const s=this.settings();return s.enabled && s.autoBlock && (this.store.state.settings.riskBlocks || []).some(b=>b.ip===ip && b.until>this.clock()); }
  success(ip) { this.windows.delete(ip); }
  signal(ip, req, reason) {
    const s=this.settings();if(!s.enabled)return;
    const now=this.clock();
    for(const [key,w] of this.windows)if(now-w.start>=600)this.windows.delete(key);
    if(!this.windows.has(ip) && this.windows.size>=5000)this.windows.delete(this.windows.keys().next().value);
    const w=this.windows.get(ip)||{start:now,failures:0,limits:0,reported:false};this.windows.set(ip,w);
    if(reason==='credentials')w.failures++;else w.limits++;
    if(w.reported || (w.failures<20 && w.limits<120))return;
    w.reported=true;
    const fingerprint=crypto.createHmac('sha256',this.salt).update(['user-agent','accept-language','sec-ch-ua','sec-ch-ua-platform'].map(k=>String(req.headers[k]||'').slice(0,512)).join('\n')).digest('hex').slice(0,24);
    const event={id:crypto.randomBytes(12).toString('hex'),ip,fingerprint,at:now,until:now+900,reason:w.failures>=20?'10 分钟内登录失败至少 20 次':'10 分钟内被限流至少 120 次',blocked:!!s.autoBlock};
    const events=[event,...(this.store.state.settings.riskEvents||[])].filter(e=>e.at>now-86400).slice(0,200);
    const blocks=(this.store.state.settings.riskBlocks||[]).filter(b=>b.until>now && b.ip!==ip);
    if(s.autoBlock)blocks.push(event);
    this.store.log({t:'settings.set',settings:{riskEvents:events,riskBlocks:blocks.slice(-500)}});
  }
}
export function registerRiskRoutes({route,requireAdmin},{store,pool},risk) {
  route('GET','/api/admin/risk',async req=>{requireAdmin(req);const now=risk.clock();return {ok:true,settings:risk.settings(),events:(store.state.settings.riskEvents||[]).filter(e=>e.at>now-86400),blocks:(store.state.settings.riskBlocks||[]).filter(b=>b.until>now)};});
  route('PATCH','/api/admin/risk',async req=>{requireAdmin(req);const b=await readJson(req,1024);const s=risk.settings();for(const k of ['enabled','autoBlock'])if(k in b){if(typeof b[k]!=='boolean')throw new HttpError(400,'无效风控开关');s[k]=b[k];}store.log({t:'settings.set',settings:{riskControl:s,...(!s.enabled||!s.autoBlock?{riskBlocks:[]}: {})}});risk.windows.clear();store.audit(store.state.admin?.username||'admin','risk.settings',`检测=${s.enabled} 自动封锁=${s.autoBlock}`);await pool.durable();return {ok:true};});
  route('POST','/api/admin/risk/unblock',async req=>{requireAdmin(req);const b=await readJson(req,1024);const blocked=(store.state.settings.riskBlocks||[]).find(x=>x.id===b.id);store.log({t:'settings.set',settings:{riskBlocks:(store.state.settings.riskBlocks||[]).filter(x=>x.id!==b.id)}});if(blocked)risk.success(blocked.ip);store.audit(store.state.admin?.username||'admin','risk.unblock',blocked?.ip||'已不存在');await pool.durable();return {ok:true};});
}
