import net from 'node:net';
import dns from 'node:dns';
import https from 'node:https';
import { isValidHost } from './domain.js';
import { isCloudflareIp } from './domain-manager.js';
import { HttpError, readJson } from './util.js';

const blocked = new net.BlockList();
for (const [ip, bits] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.88.99.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]]) blocked.addSubnet(ip,bits,'ipv4');
const global6 = new net.BlockList(); global6.addSubnet('2000::',3,'ipv6');
for (const [ip,bits] of [['2001::',23],['2001:db8::',32],['2002::',16],['3fff::',20]]) blocked.addSubnet(ip,bits,'ipv6');
export function publicIP(ip) {
  const family = net.isIP(ip);
  return family === 4 ? !blocked.check(ip,'ipv4') : family === 6 && global6.check(ip,'ipv6') && !blocked.check(ip,'ipv6');
}
function hostName(value) {
  const host = String(value || '').trim().toLowerCase().replace(/\.$/,'');
  if (!isValidHost(host) || net.isIP(host) || !host.includes('.') || /\.(local|localhost|internal|test|invalid|example|onion)$/.test(host)) throw new HttpError(400,'请填写真实完整域名，不含协议、端口或路径','BAD_HOST');
  return host;
}
export function normalizeAcceleration(body, cdn) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400,'无效方案','BAD_PLAN');
  if (typeof body.enabled !== 'boolean' || !['ip','cname'].includes(body.kind)) throw new HttpError(400,'无效方案开关或类型','BAD_PLAN');
  if (!Array.isArray(body.ips) || body.ips.length > 8 || body.ips.some(x=>typeof x !== 'string')) throw new HttpError(400,'优选 IP 最多 8 个','BAD_IPS');
  const ips = [...new Set(body.ips.map(x=>x.trim()).filter(Boolean))];
  if (ips.some(ip=>!publicIP(ip))) throw new HttpError(400,'仅允许公网 IP，不允许内网、保留地址或附带端口','BAD_IPS');
  const cname = body.cname ? hostName(body.cname) : '';
  if (body.enabled && cdn === 'none') throw new HttpError(400,'请先正确配置 CDN，直连源站不适用边缘优选','NO_CDN');
  if (body.enabled && (body.kind === 'ip' ? !ips.length : !cname)) throw new HttpError(400,'请填写所选类型的候选地址','EMPTY_PLAN');
  if (body.enabled && cdn === 'cloudflare' && body.kind === 'ip' && ips.some(ip=>!isCloudflareIp(ip))) throw new HttpError(400,'Cloudflare 模式仅接受其官方边缘网段 IP','NOT_CF');
  return { enabled:body.enabled, kind:body.kind, ips, cname };
}
export function planGuide(plan, current) {
  const stale = Boolean(plan.forHost && (plan.forHost !== current.settings.userHost || plan.forCdn !== current.settings.cdn));
  return { stale, host: current.settings.userHost, cdn: current.settings.cdn, urls: current.urls,
    sharedAdmin: current.settings.mode !== 'ip' || current.settings.adminHost === current.settings.userHost,
    records: !plan.enabled || stale ? [] : plan.kind === 'ip'
      ? plan.ips.map(value=>({type:net.isIP(value)===6?'AAAA':'A',name:current.settings.userHost,value}))
      : [{type:'CNAME',name:current.settings.userHost,value:plan.cname}],
    notices: [
      '此处仅保存候选方案并生成 DNS 指引，不会修改 DNS、Caddy、证书或正在使用的域名。关闭方案也不会撤销你已手动修改的 DNS。',
      '修改前请备份原 DNS 记录并保留独立管理入口或 SSH。同名 CNAME 与 A/AAAA 不能并存；不要误删其他业务记录。',
      'HTTPS 访问网址必须保持原网站域名。CDN 必须已接入该域名并签发有效证书；优选域名可能需要自定义主机名等套餐能力。',
      '代理状态及根域 CNAME/扁平化按 DNS/CDN 厂商规则设置；开启小黄云并不保证指定候选 IP 会成为实际接入节点。',
      '多个 IP 是 DNS 轮询，不是健康检查或自动故障切换。第三方优选域名可能更换解析；请只使用可信服务。',
      '检测是 VPS 到候选节点的可达性，不代表国内用户速度；521/回源故障仍需先修复源站。',
    ] };
}
export async function resolveCandidates(host, signal) {
  if (signal?.aborted) throw new HttpError(499,'检测已取消','CANCELLED');
  const resolver = new dns.promises.Resolver();
  const cancel = () => resolver.cancel();
  signal?.addEventListener('abort',cancel,{once:true});
  const timer = setTimeout(cancel,4000); timer.unref();
  try {
    const results = await Promise.allSettled([resolver.resolve4(host), resolver.resolve6(host)]);
    // Do not hide one family's timeout/SERVFAIL as a successful complete check.
    for (const r of results) if (r.status === 'rejected' && !['ENODATA','ENOTFOUND'].includes(r.reason?.code)) throw new Error('DNS 查询失败或超时，请稍后重试');
    const addresses = [...new Set(results.flatMap(r=>r.status==='fulfilled'?r.value:[]))];
    if (!addresses.length) throw new Error('域名没有可用 A/AAAA 记录');
    if (addresses.length > 16) throw new Error('候选域名返回过多地址，请选择更明确的接入域名');
    return addresses;
  } finally { clearTimeout(timer); signal?.removeEventListener('abort',cancel); }
}
export function probeAddress(host, address, signal) {
  if (signal?.aborted) return Promise.resolve({address,ok:false,latencyMs:0,error:'检测已取消'});
  if (!publicIP(address)) return Promise.reject(new Error('拒绝非公网目标'));
  return new Promise(resolve=>{
    const started = Date.now(); let req, timer, finished = false;
    const done = result => { if (finished) return; finished=true; clearTimeout(timer); signal?.removeEventListener('abort',cancel); req?.destroy(); resolve({address,latencyMs:Date.now()-started,...result}); };
    const cancel = () => done({ok:false,error:'检测已取消'});
    // Pin the validated IP, but retain the site's Host and TLS SNI. No proxy, cookies,
    // credentials, redirects, custom ports or second DNS resolution are involved.
    req = https.request({hostname:address,port:443,path:'/api/health',method:'GET',servername:host,
      headers:{Host:host,Accept:'application/json','User-Agent':'nui-edge-check'},agent:false,rejectUnauthorized:true},res=>{
      const status = res.statusCode; let size=0; const chunks=[];
      res.on('error',()=>done({ok:false,status,error:'响应中断'}));
      res.on('data',chunk=>{size+=chunk.length;if(size>16384){done({ok:false,status,error:'响应过大或不是备忘录接口'});res.destroy();}else chunks.push(chunk);});
      res.on('end',()=>{
        let health=false; try {const json=JSON.parse(Buffer.concat(chunks).toString());health=json.ok===true&&typeof json.version==='string'&&Number.isFinite(json.uptime);} catch {}
        done({ok:status===200&&health,status,tlsValid:true,error:status>=300&&status<400?'返回重定向，未跟随；请检查 CDN 接入':!health?'未返回预期健康接口；可能未绑定该域名或存在挑战页':undefined});
      });
    });
    req.on('error',e=>done({ok:false,error:`TLS/连接失败：${e.code || 'NETWORK_ERROR'}`}));
    timer=setTimeout(()=>done({ok:false,error:'连接或响应超时（6 秒）'}),6000); timer.unref(); signal?.addEventListener('abort',cancel,{once:true}); req.end();
  });
}
export async function inspectPlan(plan, current, dependencies = {}) {
  const resolve = dependencies.resolve || resolveCandidates, probe = dependencies.probe || probeAddress;
  const host = hostName(current.settings.userHost);
  if (!plan.enabled) throw new HttpError(400,'请先勾选启用方案再检测（不会修改解析）','PLAN_DISABLED');
  if (plan.kind === 'cname' && plan.cname === host) throw new HttpError(400,'优选域名不能等于网站域名，否则形成解析循环','CNAME_LOOP');
  const addresses = plan.kind === 'ip' ? plan.ips : await resolve(plan.cname,dependencies.signal);
  if (addresses.some(ip=>!publicIP(ip))) throw new HttpError(400,'候选域名包含非公网地址，已拒绝整个探测','UNSAFE_DNS');
  if (current.settings.cdn === 'cloudflare' && addresses.some(ip=>!isCloudflareIp(ip))) throw new HttpError(400,'候选解析包含非 Cloudflare 网段，不能用于当前 CF 方案','NOT_CF');
  const results=[]; let index=0;
  await Promise.all(Array.from({length:Math.min(2,addresses.length)},async()=>{while(index<addresses.length){if(dependencies.signal?.aborted)throw new HttpError(499,'检测已取消','CANCELLED');const i=index++;results[i]=await probe(host,addresses[i],dependencies.signal);}}));
  return {host,results,checkedAt:new Date().toISOString(),note:'仅为源站视角的兼容性检查，健康接口响应不能证明节点归属或安全性，也不保证用户端速度。没有更改 DNS 或现有入口。'};
}
export function registerAccelerationRoutes({route,requireAdmin}, {store,domain,pool,limiter}) {
  let checking=false;
  const current = () => domain.current();
  const saved = () => store.state.settings.acceleration || {enabled:false,kind:'ip',ips:[],cname:''};
  route('GET','/api/admin/domain/acceleration',async req=>{requireAdmin(req);return {ok:true,plan:saved(),guide:planGuide(saved(),current())};});
  route('PATCH','/api/admin/domain/acceleration',async req=>{
    requireAdmin(req); const body=await readJson(req,4096), c=current();
    const plan={...normalizeAcceleration(body,c.settings.cdn),forHost:c.settings.userHost,forCdn:c.settings.cdn};
    if(plan.enabled&&plan.kind==='cname'&&plan.cname===c.settings.userHost)throw new HttpError(400,'优选域名不能等于网站域名','CNAME_LOOP');
    store.log({t:'settings.set',settings:{acceleration:plan}});await pool.durable();
    store.audit(store.state.admin?.username || 'admin','acceleration.save','仅保存 DNS 候选方案，未修改实际解析');
    return {ok:true,plan,guide:planGuide(plan,c)};
  });
  route('POST','/api/admin/domain/acceleration/check',async(req,res,params,ip)=>{
    requireAdmin(req);
    if(checking)throw new HttpError(409,'已有优选检测正在运行，请稍后重试','BUSY');
    if(!limiter.allow(`edge-check:${ip}`,20,3600))throw new HttpError(429,'检测过于频繁，请稍后重试','RATE_LIMIT');
    checking=true; const controller=new AbortController(),cancel=()=>controller.abort(); res.on('close',cancel);
    try {const body=await readJson(req,4096),c=current(),plan=normalizeAcceleration(body,c.settings.cdn);return {ok:true,...await inspectPlan(plan,c,{signal:controller.signal})};}
    finally {res.off('close',cancel);checking=false;}
  });
}
