import {GET,POST,h} from './core.js';
import {requestCaptcha} from './captcha.js';

// Blocks boot before any account/key recovery. Runtime failure locks private state;
// never replays a failed mutation automatically after verification.
export function startEntryGate(app,onBlocked=()=>{}) {
  let initial=true,checking=false,verifying=false,blocked=false,card=null,status,button,resolveBoot;
  const ready=new Promise(resolve=>{resolveBoot=resolve;});
  async function bounded(fn){
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);
    try{return await fn(controller.signal);}
    catch(e){if(controller.signal.aborted)throw new Error('访问权限检查超时，请检查网络后重试');throw e;}
    finally{clearTimeout(timer);}
  }
  const readState=()=>bounded(signal=>GET('/api/entry',{signal}));
  function show(message){
    if(!blocked){
      blocked=true;app.hidden=true;app.inert=true;
      if(!initial)onBlocked();
      status=h('p',{role:'status','aria-live':'polite',class:'auth-note'},message);
      button=h('button',{class:'btn btn-filled btn-block',onClick:()=>check(true)},'开始验证');
      card=h('div',{class:'auth-wrap entry-gate'},h('div',{class:'auth-card'},h('h1',{},'访问验证'),
        h('p',{},'通过 Cloudflare Turnstile 验证后进入备忘录。通行有效期为 24 小时，IP 变化后需重新验证。'),status,button));
      document.body.append(card);
    }else status.textContent=message;
  }
  function allow(){
    if(!initial&&blocked){location.reload();return;}
    card?.remove();card=null;blocked=false;app.hidden=false;app.inert=false;
    if(initial){initial=false;resolveBoot();}
  }
  async function verify(config){
    if(verifying)return;
    verifying=true;button.disabled=true;
    try{
      const captchaToken=await requestCaptcha(config);
      await bounded(signal=>POST('/api/entry',{captchaToken},{signal}));
      // Confirm the cookie/header was accepted and the IP did not change mid-challenge.
      const state=await readState();
      if(state.required)throw new Error('通行未生效或 IP 再次变化，请允许本站 Cookie/本地存储后重试');
      allow();
    }catch(e){if(status)status.textContent=(e.code?'['+e.code+'] ':'')+e.message;}
    finally{verifying=false;if(button)button.disabled=false;}
  }
  async function check(auto=false){
    if(checking||verifying)return;
    checking=true;
    try{
      const state=await readState();
      if(!state.required){allow();return;}
      const newlyBlocked=!blocked;
      show('首次访问、通行到期或 IP 已变化，请完成验证。');
      if(auto||newlyBlocked)await verify(state.captcha);
    }catch(e){show('无法检查访问权限，请重试。'+e.message);}
    finally{checking=false;}
  }
  window.addEventListener('memo-entry-required',()=>{
    show('访问通行已失效。已锁定界面，请重新验证；未完成的操作不会自动重发。');
    void check(true);
  });
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)void check();});
  window.addEventListener('online',()=>void check());
  window.addEventListener('pageshow',e=>{if(e.persisted)void check();});
  setInterval(()=>{if(!document.hidden)void check();},30000);
  // Also hide the shell during the first network check, including on failure.
  app.hidden=true;app.inert=true;
  void check(true);
  return ready;
}
