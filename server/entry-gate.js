import crypto from 'node:crypto';
import {parseCookies,setCookie,HttpError,readJson} from './util.js';
import {publicCaptcha} from './captcha.js';
const COOKIE='memo_entry',TTL=86400;
// In-memory signing key deliberately invalidates passes on a backend restart.
// No raw IP or signing key is stored in the browser or administrative settings.
export class EntryGate {
  constructor(store,{clock=()=>Math.floor(Date.now()/1000),key=crypto.randomBytes(32)}={}){this.store=store;this.clock=clock;this.key=key;}
  config(){return this.store.state.settings.captcha||{};}
  enabled(){const c=this.config();return c.enabled===true&&c.entryGate===true&&c.provider==='turnstile';}
  mac(value){return crypto.createHmac('sha256',this.key).update(value).digest('base64url');}
  issue(ip){const expires=this.clock()+TTL;const data=[expires,this.config().version||0,this.mac('ip:'+ip),crypto.randomBytes(16).toString('base64url')].join('.');return {admissionToken:data+'.'+this.mac(data),expires};}
  valid(token,ip){
    if(typeof token!=='string'||token.length>512||!/^\d+\.\d+\.[\w-]+\.[\w-]+\.[\w-]+$/.test(token))return false;
    const p=token.split('.'),exp=Number(p[0]),version=Number(p[1]);
    if(!Number.isSafeInteger(exp)||exp<=this.clock()||exp>this.clock()+TTL||version!==(this.config().version||0)||p[2]!==this.mac('ip:'+ip))return false;
    const expected=Buffer.from(this.mac(p.slice(0,4).join('.'))),actual=Buffer.from(p[4]);
    return expected.length===actual.length&&crypto.timingSafeEqual(expected,actual);
  }
  allowed(req,ip){return !this.enabled()||this.valid(req.headers['x-memo-entry']||parseCookies(req)[COOKIE],ip);}
  protects(path){return path.startsWith('/api/user/')||path.startsWith('/api/profiles/')||path.startsWith('/api/avatars/');}
}
export function registerEntryRoutes({route,cookieOpts},{limiter},captcha,gate){
  route('GET','/api/entry',async(req,res,p,ip)=>({ok:true,enabled:gate.enabled(),required:!gate.allowed(req,ip),captcha:publicCaptcha(gate.store.state.settings)}));
  route('POST','/api/entry',async(req,res,p,ip)=>{
    if(!gate.enabled())return {ok:true,required:false};
    if(!limiter.allow(`entry:${ip}`,30,300))throw new HttpError(429,'访问验证过于频繁，请稍后重试','RATE_LIMIT');
    const c=gate.config(),version=c.version||0,body=await readJson(req,12288);
    await captcha.verify(c,body.captchaToken,ip);
    if(!gate.enabled()||(gate.config().version||0)!==version)throw new HttpError(409,'验证配置已更新，请重新验证','CAPTCHA_CHANGED');
    const pass=gate.issue(ip);
    setCookie(res,COOKIE,pass.admissionToken,{...cookieOpts(req),maxAge:TTL});
    return {ok:true,required:false,...pass};
  });
}
