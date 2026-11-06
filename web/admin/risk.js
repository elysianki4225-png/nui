import { renderCaptcha } from './captcha.js';
import {h,GET,PATCH,POST,toast} from '/assets/js/core.js';
export async function renderRisk(page) {
  if(!page.isConnected)return;
  const panel=h('div',{class:'panel'},h('h2',{},'风控'));
  let section=page.querySelector('[data-captcha-section]');
  if(!section){section=h('div',{'data-captcha-section':'true'});page.append(section);renderCaptcha(section);}
  page.insertBefore(panel,section);
  const refresh=()=>{if(panel.isConnected){panel.remove();renderRisk(page);}};
  try {
    const d=await GET('/api/admin/risk');if(!panel.isConnected)return;
    const enabled=h('input',{type:'checkbox',checked:d.settings.enabled});
    const auto=h('input',{type:'checkbox',checked:d.settings.autoBlock,disabled:!enabled.checked});
    enabled.onchange=()=>{auto.disabled=!enabled.checked;};
    panel.append(h('label',{class:'row gap-8'},enabled,h('span',{},'启用风控检测')),h('label',{class:'row gap-8'},auto,h('span',{},'自动临时封锁 IP')),
      h('p',{class:'auth-note'},'默认关闭。10 分钟内登录失败 20 次或触发限流 120 次，才记录风险；开启自动封锁时封锁 15 分钟。浏览器基础特征摘要仅辅助排查，不因 IP/指纹变化封锁，不采集 Canvas/字体指纹。共享网络仍可能被误伤。已登录管理员保留解封入口。关闭任一开关会清除自动封锁。记录最多保留 200 条，界面只展示近 24 小时。'),
      h('button',{class:'btn btn-filled',onClick:async e=>{const button=e.currentTarget;button.disabled=true;try{await PATCH('/api/admin/risk',{enabled:enabled.checked,autoBlock:auto.checked});toast('风控设置已保存');refresh();}catch(e){toast(e.message,{type:'error'});}finally{button.disabled=false;}}},'保存风控设置'),h('h3',{},'临时封锁'));
    for(const b of d.blocks)panel.append(h('div',{class:'row wrap gap-8'},h('span',{},`${b.ip} · ${b.reason} · ${new Date(b.until*1000).toLocaleString()} 到期`),h('button',{class:'btn btn-text',onClick:async e=>{const button=e.currentTarget;button.disabled=true;try{await POST('/api/admin/risk/unblock',{id:b.id});refresh();}catch(e){toast(e.message,{type:'error'});}finally{button.disabled=false;}}},'解封')));
    if(!d.blocks.length)panel.append(h('p',{},'暂无自动封锁'));
    panel.append(h('h3',{},'近期命中'));
    for(const e of d.events)panel.append(h('p',{style:{overflowWrap:'anywhere'}},`${new Date(e.at*1000).toLocaleString()} · ${e.ip} · ${e.reason} · 浏览器摘要 ${e.fingerprint} · ${e.blocked?'触发临时封锁':'仅记录'}`));
  }catch(e){panel.append(h('p',{},e.message));}
}
