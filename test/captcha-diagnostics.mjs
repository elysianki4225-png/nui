import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {Captcha,registerCaptchaRoutes} from '../server/captcha.js';
const c={enabled:true,provider:'hcaptcha',siteKey:'public-test',secret:'private-secret-never-echo',hostnames:['admin.example.com'],version:0};
const store={state:{settings:{captcha:c}},log(){throw Error('failed configuration must not be saved');},audit(){}};
let result={},status=200,body,seen,requests=0;
const verifier=new Captcha(store,{},async(url,opts)=>{requests++;seen=new URLSearchParams(opts.body);assert.equal(opts.redirect,'error');return new Response(body??JSON.stringify(result),{status});});
let seq=0;
async function failure(code,diagnostics=true){
 await assert.rejects(()=>verifier.verify(c,'private-token-'+seq++,'1.2.3.4',{diagnostics}),e=>{
  assert.equal(e.code,code);assert(!e.message.includes(c.secret));assert(!e.message.includes('private-token'));assert(!e.message.includes('ATTACKER'));return true;
 });assert.equal(verifier.pending,0);
}
for(const [upstream,expected] of [
 ['missing-input-secret','CAPTCHA_SECRET_INVALID'],['invalid-input-secret','CAPTCHA_SECRET_INVALID'],
 ['sitekey-secret-mismatch','CAPTCHA_KEY_MISMATCH'],['invalid-sitekey','CAPTCHA_SITEKEY_INVALID'],['sitekey-mismatch','CAPTCHA_SITEKEY_MISMATCH'],
 ['missing-input-response','CAPTCHA_TOKEN_INVALID'],['invalid-input-response','CAPTCHA_TOKEN_INVALID'],['invalid-or-already-seen-response','CAPTCHA_TOKEN_INVALID'],
 ['expired-input-response','CAPTCHA_TOKEN_EXPIRED'],['timeout-or-duplicate','CAPTCHA_TOKEN_EXPIRED'],
 ['invalid-remoteip','CAPTCHA_IP_INVALID'],['bad-request','CAPTCHA_PROVIDER_REQUEST'],['internal-error','CAPTCHA_PROVIDER_ERROR'],
 ['ATTACKER '+c.secret,'CAPTCHA_PROVIDER_REJECTED'],['constructor','CAPTCHA_PROVIDER_REJECTED'],
]){
 result={success:false,'error-codes':[upstream]};await failure(expected);await failure('CAPTCHA_FAILED',false);
}
assert.equal(seen.get('secret'),c.secret);assert.equal(seen.get('sitekey'),c.siteKey);assert.equal(seen.get('remoteip'),'1.2.3.4');
status=400;result={success:false,'error-codes':['invalid-input-secret']};await failure('CAPTCHA_SECRET_INVALID');
status=503;await failure('CAPTCHA_UNAVAILABLE');status=200;
for(const malformed of ['<html>ATTACKER</html>','null','[]','x'.repeat(17000)]){body=malformed;await failure('CAPTCHA_UNAVAILABLE');}body=undefined;
result={success:true,hostname:'other.example.com',challenge_ts:new Date().toISOString()};await failure('CAPTCHA_HOSTNAME_MISMATCH');await failure('CAPTCHA_FAILED',false);
result.hostname='admin.example.com';await verifier.verify(c,'valid-hcaptcha','1.2.3.4',{diagnostics:true});
assert.equal(verifier.pending,0);
await assert.rejects(verifier.verify({...c,provider:'turnstile'},'action-test','1.2.3.4',{diagnostics:true}),e=>e.code==='CAPTCHA_ACTION_MISMATCH');
const routes=new Map();registerCaptchaRoutes({route:(m,p,h)=>routes.set(m+' '+p,h),requireAdmin:req=>{if(!req.admin)throw Error('unauthorized');}},{store,cfg:{},pool:{durable(){}}},verifier);
const patch=routes.get('PATCH /api/admin/captcha');
const req=admin=>Object.assign(Readable.from([Buffer.from(JSON.stringify({...c,testToken:'route-test'}))]),{admin});
const before=requests;await assert.rejects(patch(req(false),null,null,'1.2.3.4'),/unauthorized/);assert.equal(requests,before);
result={success:false,'error-codes':['sitekey-secret-mismatch']};
await assert.rejects(patch(req(true),null,null,'1.2.3.4'),e=>e.code==='CAPTCHA_KEY_MISMATCH');assert.equal(store.state.settings.captcha,c);
await assert.rejects(verifier.check({captchaToken:'guest',diagnostics:true},'1.2.3.4'),e=>e.code==='CAPTCHA_FAILED');
console.log('PASS CAPTCHA diagnostics: admin-only fixed messages, HTTP 400, no upstream/secret/token reflection, bounded malformed responses, hostname/action, fail-closed and no failed config writes');
