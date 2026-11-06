import {h,GET,PATCH,toast} from '/assets/js/core.js';
import {requestCaptcha} from '/assets/js/captcha.js';
export async function renderCaptcha(page){
 if(!page.isConnected)return;
 const panel=h('div',{class:'panel'},h('h2',{},'人机验证'));page.append(panel);
 try{
  const c=await GET('/api/admin/captcha');if(!panel.isConnected)return;
  const enabled=h('input',{type:'checkbox',checked:c.enabled});
  const entry=h('input',{type:'checkbox',checked:c.entryGate});
  const provider=h('select',{class:'tf-input','aria-label':'验证服务商'},...Object.entries({turnstile:'Cloudflare Turnstile',recaptcha:'Google reCAPTCHA v2',hcaptcha:'hCaptcha'}).map(([v,l])=>h('option',{value:v,selected:c.provider===v},l)));
  const site=h('input',{class:'tf-input',value:c.siteKey,'aria-label':'Site Key',autocomplete:'off',placeholder:'填写服务商提供的 Site Key',maxLength:256,spellcheck:'false',autocapitalize:'none'});
  const secret=h('input',{class:'tf-input',type:'password','aria-label':'Secret Key',autocomplete:'new-password',maxLength:2048,spellcheck:'false',autocapitalize:'none',placeholder:c.hasSecret?'已保存，留空沿用（同一服务商及 Site Key）':'填写 Secret Key'});
  const hosts=h('textarea',{class:'tf-input',value:c.hostnames.join('\n'),'aria-label':'允许验证的域名',rows:3,spellcheck:'false',autocapitalize:'none',placeholder:'memo.example.com\nadmin.example.com'});
  const field=(label,input)=>h('label',{class:'tf editor-field'},h('span',{class:'tf-field-label'},label),input);
  const status=h('p',{class:'auth-note',role:'status','aria-live':'polite',hidden:true});
  const save=h('button',{class:'btn btn-filled',onClick:async()=>{save.disabled=true;status.hidden=false;status.textContent='正在验证并保存…';try{
    const candidate={enabled:enabled.checked,entryGate:entry.checked,provider:provider.value,siteKey:site.value.trim(),secret:secret.value.trim(),hostnames:hosts.value.split(/\s+/).filter(Boolean),version:c.version};
    if(candidate.enabled&&candidate.entryGate&&candidate.provider!=='turnstile')throw new Error('进入前验证只支持 Cloudflare Turnstile，请切换服务商或关闭进入前验证');
    if(candidate.enabled)candidate.testToken=await requestCaptcha(candidate);
    if(!panel.isConnected)return;
    await PATCH('/api/admin/captcha',candidate);secret.value='';toast('人机验证设置已保存');panel.remove();renderCaptcha(page);
  }catch(e){status.textContent=(e.code?'['+e.code+'] ':'')+e.message;toast(e.message,{type:'error'});}finally{save.disabled=false;}}},'验证配置并保存');
  const updateSave=()=>{save.textContent=enabled.checked?'验证配置并保存':'保存（关闭验证）';};
  enabled.addEventListener('change',updateSave);updateSave();
  const updateSecret=()=>{secret.placeholder=c.hasSecret&&provider.value===c.provider&&site.value.trim()===c.siteKey?'已保存，留空沿用':'填写对应服务商的 Secret Key';};
  provider.addEventListener('change',updateSecret);site.addEventListener('input',updateSecret);updateSecret();
  panel.append(h('label',{class:'row gap-8'},enabled,h('span',{},'启用注册和两端登录的人机验证')),h('label',{class:'row gap-8'},entry,h('span',{},'用户端进入前验证（Turnstile，24 小时，IP 变化重新验证）')),h('p',{class:'muted md-body-s'},'需同时启用上方人机验证。默认关闭；已登录用户也需取得通行。开启后每次用户 API 请求检查 IP，页面每 30 秒及返回前台时检查。管理员恢复入口不受影响。'),field('服务商',provider),field('Site Key（公开）',site),field('Secret Key（仅服务端）',secret),field('允许验证的域名（每行一个，不含协议/端口）',hosts),h('p',{class:'auth-note'},'关闭时只停用验证，不保存未验证的新密钥。开启前需在当前管理域名完成一次验证。'),save,status,h('details',{},h('summary',{},'配置说明、隐私与恢复方式'),h('p',{class:'auth-note'},'默认关闭，独立于自动封锁。关闭时只停用验证，不保存未验证的新密钥。开启后保护用户注册、用户登录及管理员登录，包括记住凭据后的新登录。请在服务商控制台添加用户/管理域名和导出前端域名；Google 选择 v2 复选框。启用或更换配置前必须在当前管理域名完成一次真实验证。网络不通时不会放行；已登录管理员可关闭，SSH 重置管理员凭据也会关闭验证。第三方组件会处理浏览器/IP 等信息，请确认其隐私条款。')));
 }catch(e){panel.append(h('p',{},e.message));}
}
