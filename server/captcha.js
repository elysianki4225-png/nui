import crypto from 'node:crypto';
import {HttpError,readJson} from './util.js';
export const CAPTCHA_PROVIDERS={turnstile:'https://challenges.cloudflare.com/turnstile/v0/siteverify',recaptcha:'https://www.google.com/recaptcha/api/siteverify',hcaptcha:'https://api.hcaptcha.com/siteverify'};
export function publicCaptcha(s) {const c=s.captcha||{};return {enabled:!!c.enabled,provider:c.provider||'turnstile',siteKey:c.siteKey||''};}
export class Captcha {
  constructor(store,cfg,fetcher=fetch){this.store=store;this.cfg=cfg;this.fetcher=fetcher;this.used=new Map();this.pending=0;}
  async verify(c,token,ip) {
    if(typeof token!=='string'||!token||token.length>8192)throw new HttpError(400,'请先完成人机验证','CAPTCHA_REQUIRED');
    if(!CAPTCHA_PROVIDERS[c.provider]||!c.secret)throw new HttpError(503,'人机验证尚未正确配置','CAPTCHA_UNAVAILABLE');
    const now=Date.now();for(const [key,until] of this.used)if(until<now)this.used.delete(key);
    const digest=crypto.createHash('sha256').update(token).digest('hex');
    if(this.used.has(digest))throw new HttpError(400,'验证已使用，请重新验证','CAPTCHA_REPLAY');
    if(this.pending>=16||this.used.size>=10000)throw new HttpError(503,'验证繁忙，请稍后重试','CAPTCHA_BUSY');
    this.used.set(digest,now+300000);this.pending++;
    const ctrl=new AbortController(),timer=setTimeout(()=>ctrl.abort(),8000);
    try {
      const body=new URLSearchParams({secret:c.secret,response:token,remoteip:ip});if(c.provider==='hcaptcha')body.set('sitekey',c.siteKey);
      const response=await this.fetcher(CAPTCHA_PROVIDERS[c.provider],{method:'POST',body,redirect:'error',signal:ctrl.signal});
      if(!response.ok)throw new Error('upstream');let bytes=0,text='';
      for await(const chunk of response.body){bytes+=chunk.length;if(bytes>16384)throw new Error('oversize');text+=Buffer.from(chunk).toString('utf8');}
      const result=JSON.parse(text),hostname=String(result.hostname||'').toLowerCase();
      if(result.success!==true||!(c.hostnames||[]).includes(hostname)||(c.provider==='turnstile'&&result.action!=='auth'))throw new HttpError(400,'人机验证未通过，请重新验证并检查域名配置','CAPTCHA_FAILED');
      const ts=Date.parse(result.challenge_ts);if(!Number.isFinite(ts)||Date.now()-ts>300000||ts>Date.now()+60000)throw new HttpError(400,'验证已过期，请重试','CAPTCHA_EXPIRED');
    }catch(e){if(e instanceof HttpError)throw e;throw new HttpError(503,'验证服务暂不可用，请稍后重试','CAPTCHA_UNAVAILABLE');}
    finally{clearTimeout(timer);this.pending--;}
  }
  async check(body,ip){const c=this.store.state.settings.captcha;if(c?.enabled)await this.verify(c,body.captchaToken,ip);}
}
export function registerCaptchaRoutes({route,requireAdmin},{store,cfg,pool},captcha){
  const defaults=()=>[...new Set([cfg.userHost,cfg.adminHost].filter(Boolean).map(h=>h.split(':')[0]))];
  route('GET','/api/captcha',async()=>({ok:true,...publicCaptcha(store.state.settings)}));
  route('GET','/api/admin/captcha',async req=>{requireAdmin(req);const c=store.state.settings.captcha||{};return {ok:true,...publicCaptcha(store.state.settings),hostnames:c.hostnames||defaults(),hasSecret:!!c.secret,version:c.version||0};});
  route('PATCH','/api/admin/captcha',async(req,res,p,ip)=>{
    requireAdmin(req);const b=await readJson(req,16000),old=store.state.settings.captcha||{};
    if(typeof b.enabled!=='boolean'||b.version!==(old.version||0))throw new HttpError(409,'配置已变化，请刷新后重试');
    let c={...old,enabled:b.enabled,version:(old.version||0)+1};
    if(b.enabled){
      if(!Object.hasOwn(CAPTCHA_PROVIDERS,b.provider)||typeof b.siteKey!=='string'||!b.siteKey.trim()||b.siteKey.length>256)throw new HttpError(400,'请选择服务商并填写 Site Key');
      const secret=b.secret || (old.provider===b.provider&&old.siteKey===b.siteKey?old.secret:'');
      if(typeof secret!=='string'||!secret||secret.length>2048)throw new HttpError(400,'请填写对应 Secret Key');
      if(!Array.isArray(b.hostnames)||!b.hostnames.length||b.hostnames.length>20||b.hostnames.some(h=>typeof h!=='string'||! /^[a-z0-9.-]{1,253}$/i.test(h)))throw new HttpError(400,'填写允许验证的域名，不含协议和端口');
      c={...c,provider:b.provider,siteKey:b.siteKey.trim(),secret,hostnames:[...new Set(b.hostnames.map(h=>h.toLowerCase()))]};
      await captcha.verify(c,b.testToken,ip);
    }
    if((store.state.settings.captcha?.version||0)!==(old.version||0))throw new HttpError(409,'配置已变化，请刷新后重试');
    store.log({t:'settings.set',settings:{captcha:c}});await pool.durable();store.audit(store.state.admin?.username||'admin','captcha.settings',c.enabled?'启用 '+c.provider:'关闭');return {ok:true};
  });
}
