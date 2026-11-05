import { h, clear, GET, PATCH, POST, copyText } from '/assets/js/core.js';

export function renderAcceleration(container) {
  const controller=new AbortController(); let alive=true, busy=false, guide;
  const details=h('details',{class:'panel domain-advanced acceleration'},h('summary',{},'访问加速 · 优选 IP / 优选域名（可选）'));
  const body=h('div'); details.append(body);container.append(details);
  const status=h('p',{role:'status',class:'md-body-s'});
  const field=(label,input)=>h('label',{class:'acceleration-field'},h('span',{},label),input);
  async function init() {
    const data=await GET('/api/admin/domain/acceleration',{signal:controller.signal});if(!alive)return;
    guide=data.guide;
    const enabled=h('input',{type:'checkbox',checked:data.plan.enabled});
    const kind=h('select',{class:'tf-input','aria-label':'优选类型'},h('option',{value:'ip',selected:data.plan.kind==='ip'},'优选 IP'),h('option',{value:'cname',selected:data.plan.kind==='cname'},'优选域名（CNAME）'));
    const ips=h('textarea',{class:'tf-input mono',rows:4,value:data.plan.ips.join('\n'),maxlength:512,'aria-label':'优选 IP 列表',placeholder:'每行一个公网 IP，最多 8 个'});
    const cname=h('input',{class:'tf-input mono',value:data.plan.cname,maxlength:253,'aria-label':'优选域名',placeholder:'优选服务提供的完整域名',spellcheck:'false'});
    const ipField=field('候选 IP（不含端口）',ips), cnameField=field('候选域名（不含协议/路径）',cname);
    const results=h('div',{class:'acceleration-results'}), records=h('div');
    const plan=()=>({enabled:enabled.checked,kind:kind.value,ips:kind.value==='ip'?ips.value.split(/[\n,;\s]+/).filter(Boolean):[],cname:kind.value==='cname'?cname.value.trim():''});
    const update=()=>{ipField.hidden=kind.value!=='ip';cnameField.hidden=kind.value!=='cname';clear(results);clear(records);status.textContent='修改尚未保存；诊断结果已清除。';};
    for(const el of [enabled,kind,ips,cname])el.addEventListener('input',update);
    const controls=[];
    const action=(label,fn)=>{const b=h('button',{class:'btn btn-tonal',onClick:async()=>{
      if(busy)return;busy=true;for(const el of [...controls,enabled,kind,ips,cname])el.disabled=true;status.textContent='处理中…';
      try{await fn();}catch(e){if(alive&&e.name!=='AbortError')status.textContent=e.message;}
      finally{busy=false;if(alive)for(const el of [...controls,enabled,kind,ips,cname])el.disabled=false;}
    }},label);controls.push(b);return b;};
    function showRecords(g) {
      clear(records);
      if(g.stale){records.append(h('p',{class:'auth-note'},'网站域名或 CDN 已改变，原方案仅供参考；请重新检测并保存，再生成 DNS 指引。'));return;}
      if(!g.records.length){records.append(h('p',{class:'muted'},'方案未启用。不会自动撤销之前手动修改的 DNS。'));return;}
      records.append(h('h4',{},'已保存方案的 DNS 指引（请自行核对后配置）'));
      for(const row of g.records)records.append(h('div',{class:'kv'},h('div',{class:'k'},`${row.type} · 完整记录名：${row.name}`),h('div',{class:'v mono'},row.value),h('button',{class:'btn btn-text btn-sm',onClick:async()=>{const ok=await copyText(row.value);if(alive)status.textContent=ok?'记录值已复制':'复制失败，请手动选择文本';}},'复制记录值')));
      records.append(h('p',{class:'muted md-body-s'},'DNS 服务商若要求主机记录前缀，请按所在 Zone 填写（如 m），不要重复填写整个根域名。先保留原记录截图；出现故障时恢复原 A/AAAA/CNAME。'));
    }
    body.append(h('div',{class:'acceleration-body'},h('p',{class:'auth-note'},'默认关闭。这是手动 DNS 接入助手，不是自动加速开关；保存和检测均不会修改正在使用的入口。'),
      h('p',{class:'mono'},`检测的网站：${guide.host} · 当前 CDN：${guide.cdn}`),
      h('p',{class:'muted'},'仅针对已经应用的网站域名；上方尚未保存的域名修改不会用于这里的检测。检测最多约 52 秒，离开页面会取消。'),
      guide.sharedAdmin?h('p',{class:'auth-note'},'当前管理端与用户端共用域名，手动修改该域名的 DNS 也会影响管理入口！操作前请确认 SSH 可用，最好先准备独立管理入口。'):null,
      field('启用并保存候选方案（仍需手动配置 DNS）',enabled),field('接入方式',kind),ipField,cnameField,
      h('div',{class:'row wrap gap-8'},
        action('保存方案 / 生成 DNS 指引',async()=>{const r=await PATCH('/api/admin/domain/acceleration',plan(),{signal:controller.signal});if(!alive)return;guide=r.guide;showRecords(guide);status.textContent='方案已保存；实际 DNS、Caddy 和证书没有更改。';}),
        action('检测候选兼容性（不保存）',async()=>{
          clear(results);const r=await POST('/api/admin/domain/acceleration/check',plan(),{signal:controller.signal});if(!alive)return;
          for(const result of r.results)results.append(h('div',{class:'kv'},h('div',{class:'k mono'},result.address),h('div',{class:'v'},result.ok?'HTTPS 与健康接口通过':`未通过：${result.error || 'HTTP '+result.status}`),h('div',{class:'muted md-body-s'},`VPS 探测耗时 ${result.latencyMs}ms${result.status?' · HTTP '+result.status:''}`)));
          status.textContent=`检测域名：${r.host}。${r.note}`;
        })),status,records,results,
      h('details',{},h('summary',{},'接入条件、风险与恢复方法'),h('ul',{},...guide.notices.map(text=>h('li',{},text)))),
      h('p',{class:'muted md-body-s'},'网址仍使用原域名；不要让用户访问裸 IP，也不要把备忘录密钥提供给优选服务。')));
    ipField.hidden=kind.value!=='ip';cnameField.hidden=kind.value!=='cname';showRecords(guide);
  }
  init().catch(e=>{if(alive){status.textContent='访问加速配置加载失败：'+e.message;body.append(status);}});
  return ()=>{alive=false;controller.abort();};
}
