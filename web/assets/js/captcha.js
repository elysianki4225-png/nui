import {GET,h,openDialog} from './core.js';
const providers={turnstile:{url:'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit',global:'turnstile'},recaptcha:{url:'https://www.google.com/recaptcha/api.js?render=explicit',global:'grecaptcha'},hcaptcha:{url:'https://js.hcaptcha.com/1/api.js?render=explicit',global:'hcaptcha'}};
const loads=new Map();
function load(provider){
  if(loads.has(provider))return loads.get(provider);
  const p=Object.hasOwn(providers,provider)?providers[provider]:null;if(!p)return Promise.reject(new Error('不支持的验证服务'));
  const promise=new Promise((resolve,reject)=>{
    let done=false;
    const script=document.createElement('script');script.src=p.url;script.async=true;
    const error=(code,message)=>Object.assign(new Error(message),{code});
    const timer=setTimeout(()=>finish(error('CAPTCHA_SDK_TIMEOUT','浏览器加载验证组件超时，请检查浏览器网络或拦截设置（尚未进行服务器校验）')),15000);
    function finish(err){
      if(done)return;
      done=true;clearTimeout(timer);script.onload=script.onerror=null;
      if(err){script.remove();loads.delete(provider);reject(err);}else resolve(window[p.global]);
    }
    const ready=()=>{
      if(typeof window[p.global]?.render!=='function')return finish(error('CAPTCHA_SDK_INVALID','验证组件未正确初始化，请刷新页面后重试'));
      finish();
    };
    script.onerror=()=>finish(error('CAPTCHA_SDK_NETWORK','浏览器无法加载验证组件，请检查网络或内容拦截设置'));
    script.onload=()=>{
      try {
        const api=window[p.global];
        // Turnstile explicit rendering does not support turnstile.ready().
        // The script load event provides the exported render API; only Google's
        // SDK needs its ready callback to wait for the secondary library.
        if(provider==='recaptcha' && typeof api?.ready==='function')api.ready(ready);
        else ready();
      }catch{finish(error('CAPTCHA_SDK_INIT','验证组件初始化失败，请刷新页面后重试（不是服务器校验失败）'));}
    };
    document.head.append(script);
  });loads.set(provider,promise);return promise;
}
export async function requestCaptcha(candidate){
  const c=candidate||await GET('/api/captcha');if(!c.enabled)return '';
  return new Promise((resolve,reject)=>{
    let widget,api,finished=false,close,timer;
    const box=h('div',{style:{minHeight:'90px',display:'flex',justifyContent:'center'}}),message=h('p',{role:'status'},'正在加载验证组件…');
    const cleanup=()=>{clearTimeout(timer);try{if(widget!=null){if(c.provider==='recaptcha')api?.reset(widget);else api?.remove(widget);}}catch{}};
    const finish=(error,token)=>{if(finished)return;finished=true;cleanup();close?.();error?reject(error):resolve(token);};
    const dialog=openDialog({title:'人机验证',dismissable:false,content:h('div',{},h('p',{},'验证由所选第三方服务提供，会处理网络及浏览器信息。'),box,message),actions:[{label:'取消',variant:'text',onClick:()=>finish(new Error('已取消人机验证'))}],onClose:()=>finish(new Error('已取消人机验证'))});close=dialog.close;
    timer=setTimeout(()=>finish(new Error('验证超时，请重试')),120000);
    load(c.provider).then(loaded=>{if(finished)return;api=loaded;message.textContent='请完成下方验证';widget=api.render(box,{sitekey:c.siteKey,size:'compact',action:'auth',callback:token=>finish(null,token),'error-callback':()=>{message.textContent='验证失败，请取消后重试';},'expired-callback':()=>{message.textContent='验证已过期，请重新完成';}});}).catch(e=>finish(e));
  });
}
