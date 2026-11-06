import crypto from 'node:crypto';
import {HttpError,readJson} from './util.js';
export const CAPTCHA_PROVIDERS={turnstile:'https://challenges.cloudflare.com/turnstile/v0/siteverify',recaptcha:'https://www.google.com/recaptcha/api/siteverify',hcaptcha:'https://api.hcaptcha.com/siteverify'};
export function publicCaptcha(s) {const c=s.captcha||{};return {enabled:!!c.enabled,provider:c.provider||'turnstile',siteKey:c.siteKey||''};}
// Only authenticated configuration tests may receive these fixed diagnostic messages.
// Never echo upstream error text, hostnames, secrets or response tokens.
const verificationErrors={
  'missing-input-secret':['CAPTCHA_SECRET_INVALID','服务商未收到 Secret Key，请重新填写'],
  'invalid-input-secret':['CAPTCHA_SECRET_INVALID','服务商拒绝了 Secret Key，请检查是否复制完整且属于对应账户'],
  'sitekey-secret-mismatch':['CAPTCHA_KEY_MISMATCH','服务商确认 Site Key 与 Secret Key 不匹配，请使用同一账户下适用的密钥'],
  'invalid-sitekey':['CAPTCHA_SITEKEY_INVALID','服务商拒绝了 Site Key，请检查所选服务商及完整 Site Key'],
  'sitekey-mismatch':['CAPTCHA_SITEKEY_MISMATCH','验证令牌与提交的 Site Key 不匹配，请刷新页面后重新验证'],
  'missing-input-response':['CAPTCHA_TOKEN_INVALID','服务商未收到验证令牌，请重新完成验证'],
  'invalid-input-response':['CAPTCHA_TOKEN_INVALID','服务商拒绝了验证令牌，请重新验证并核对 Site Key 与 Secret Key'],
  'invalid-or-already-seen-response':['CAPTCHA_TOKEN_INVALID','验证令牌无效或已使用，请重新完成验证'],
  'expired-input-response':['CAPTCHA_TOKEN_EXPIRED','服务商判定验证令牌已过期，请重新完成验证'],
  'timeout-or-duplicate':['CAPTCHA_TOKEN_EXPIRED','验证令牌已过期或已使用，请重新完成验证'],
  'invalid-remoteip':['CAPTCHA_IP_INVALID','服务商拒绝了客户端 IP 参数，请检查反向代理的真实 IP 配置'],
  'bad-request':['CAPTCHA_PROVIDER_REQUEST','服务商拒绝了校验请求，请检查验证配置'],
  'internal-error':['CAPTCHA_PROVIDER_ERROR','服务商内部错误，请稍后重新验证'],
};
export class Captcha {
  constructor(store,cfg,fetcher=fetch){this.store=store;this.cfg=cfg;this.fetcher=fetcher;this.used=new Map();this.pending=0;}
  async verify(c,token,ip,{diagnostics=false}={}) {
    if(typeof token!=='string'||!token||token.length>8192)throw new HttpError(400,'请先完成人机验证','CAPTCHA_REQUIRED');
    if(!Object.hasOwn(CAPTCHA_PROVIDERS,c.provider)||!c.secret)throw new HttpError(503,'人机验证尚未正确配置','CAPTCHA_UNAVAILABLE');
    const now=Date.now();for(const [key,until] of this.used)if(until<now)this.used.delete(key);
    const digest=crypto.createHash('sha256').update(token).digest('hex');
    if(this.used.has(digest))throw new HttpError(400,'验证已使用，请重新验证','CAPTCHA_REPLAY');
    if(this.pending>=16||this.used.size>=10000)throw new HttpError(503,'验证繁忙，请稍后重试','CAPTCHA_BUSY');
    this.used.set(digest,now+300000);this.pending++;
    const ctrl=new AbortController(),timer=setTimeout(()=>ctrl.abort(),8000);
    try {
      const body=new URLSearchParams({secret:c.secret,response:token,remoteip:ip});if(c.provider==='hcaptcha')body.set('sitekey',c.siteKey);
      const response=await this.fetcher(CAPTCHA_PROVIDERS[c.provider],{method:'POST',body,redirect:'error',signal:ctrl.signal});
      let bytes=0;const chunks=[];
      for await(const chunk of response.body){bytes+=chunk.length;if(bytes>16384)throw new Error('oversize');chunks.push(Buffer.from(chunk));}
      const result=JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if(!result||typeof result!=='object'||Array.isArray(result))throw new Error('malformed');
      if(!response.ok && response.status!==400)throw new Error('upstream');
      if(result.success!==true){
        if(diagnostics){
          const codes=Array.isArray(result['error-codes'])?result['error-codes']:[];
          const known=codes.find(code=>typeof code==='string'&&Object.hasOwn(verificationErrors,code));
          const [code,message]=known?verificationErrors[known]:['CAPTCHA_PROVIDER_REJECTED','服务商未通过此验证，但未返回可识别的原因；请核对密钥配置后重新验证'];
          throw new HttpError(400,message,code);
        }
        throw new HttpError(400,'人机验证未通过，请重新验证','CAPTCHA_FAILED');
      }
      if(!response.ok)throw new Error('upstream');
      const hostname=typeof result.hostname==='string'?result.hostname.toLowerCase():'';
      if(!(c.hostnames||[]).includes(hostname))throw new HttpError(400,diagnostics?'服务商已通过验证，但返回域名不在本程序允许列表中（或未返回域名）；请核对当前访问域名、服务商站点及本程序域名列表':'人机验证未通过，请重新验证',diagnostics?'CAPTCHA_HOSTNAME_MISMATCH':'CAPTCHA_FAILED');
      if(c.provider==='turnstile'&&result.action!=='auth')throw new HttpError(400,diagnostics?'服务商已通过验证，但验证动作不匹配，请刷新前端后重试':'人机验证未通过，请重新验证',diagnostics?'CAPTCHA_ACTION_MISMATCH':'CAPTCHA_FAILED');
      const ts=Date.parse(result.challenge_ts);if(!Number.isFinite(ts)||Date.now()-ts>300000||ts>Date.now()+60000)throw new HttpError(400,'验证已过期，请重试','CAPTCHA_EXPIRED');
    }catch(e){if(e instanceof HttpError)throw e;throw new HttpError(503,diagnostics?(ctrl.signal.aborted?'服务器向验证服务发起的校验超时，请检查 VPS 出站网络后重试':'服务器无法取得有效校验响应，请检查 VPS 到验证服务的网络；浏览器完成验证不代表服务端校验成功'):'验证服务暂不可用，请稍后重试',diagnostics&&ctrl.signal.aborted?'CAPTCHA_UPSTREAM_TIMEOUT':'CAPTCHA_UNAVAILABLE');}
    finally{clearTimeout(timer);ctrl.abort();this.pending--;}
  }
  async check(body,ip){const c=this.store.state.settings.captcha;if(c?.enabled){await this.verify(c,body.captchaToken,ip);const current=this.store.state.settings.captcha;if(current?.enabled && (current.version||0)!==(c.version||0))throw new HttpError(409,'验证配置已更新，请重新验证','CAPTCHA_CHANGED');}}
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
      await captcha.verify(c,b.testToken,ip,{diagnostics:true});
    }
    if((store.state.settings.captcha?.version||0)!==(old.version||0))throw new HttpError(409,'配置已变化，请刷新后重试');
    store.log({t:'settings.set',settings:{captcha:c}});await pool.durable();store.audit(store.state.admin?.username||'admin','captcha.settings',c.enabled?'启用 '+c.provider:'关闭');return {ok:true};
  });
}
