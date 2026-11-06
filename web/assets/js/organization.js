import {GET,PUT} from './core.js';
export class Organization {
  constructor(crypto) {this.crypto=crypto;this.data={folders:[],locations:{},order:[]};this.revision=0;this.ready=false;this.busy=false;this.closed=false;}
  async load() {
    const r=await GET('/api/user/organization');const data=r.cipher?(await this.crypto.decryptMeta(r.cipher)).obj:{folders:[],locations:{},order:[]};
    if(this.closed)return;
    if(!data||!Array.isArray(data.folders)||!data.locations||typeof data.locations!=='object'||Array.isArray(data.locations)||!Array.isArray(data.order)||data.folders.length>200||data.folders.some(f=>!f||typeof f.id!=='string'||!f.id||typeof f.name!=='string'||!f.name.trim()||f.name.length>80)||data.order.some(k=>typeof k!=='string'||! /^(m|f):[a-zA-Z0-9_-]+$/.test(k)))throw new Error('文件夹数据无法解密，请勿覆盖');
    this.data=data;this.revision=r.revision;this.ready=true;
  }
  async change(fn) {
    if(this.closed||!this.ready)throw new Error('文件夹尚未加载，请刷新后重试');
    if(this.busy)throw new Error('正在保存整理结果，请稍候');
    this.busy=true;
    try {
      const next=JSON.parse(JSON.stringify(this.data));fn(next);
      if(next.folders.length>200)throw new Error('最多创建 200 个文件夹');
      if(new TextEncoder().encode(JSON.stringify(next)).length>240*1024)throw new Error('整理数据过大，请减少文件夹或排序条目');
      const {meta}=await this.crypto.encryptMeta(next);
      if(this.closed)return;
      const r=await PUT('/api/user/organization',JSON.stringify({revision:this.revision,cipher:meta}));
      if(this.closed)return;
      this.data=next;this.revision=r.revision;
    } catch(e) {if(e.status===409)this.ready=false;throw e;} finally {this.busy=false;}
  }
  close(){this.closed=true;this.ready=false;this.data={folders:[],locations:{},order:[]};}
}

// Delegated pointer handling survives virtual row recycling; at most one ghost and RAF.
export function installOrganizationDrag(container, drop) {
  let state=null,timer=0,raf=0,ghost=null,target=null,suppress=false,suppressTimer=0;
  const cleanup=()=>{const pointer=state?.id;state=null;if(pointer!=null){try{container.releasePointerCapture(pointer);}catch{}}clearTimeout(timer);cancelAnimationFrame(raf);ghost?.remove();ghost=null;target?.classList.remove('org-target');target=null;state=null;};
  const frame=()=>{
    if(!state||!ghost)return;
    ghost.style.transform=`translate3d(${state.x+12}px,${state.y+12}px,0)`;
    const hit=document.elementFromPoint(state.x,state.y)?.closest('[data-order-key]');
    if(hit!==target){target?.classList.remove('org-target');target=hit&&container.contains(hit)?hit:null;target?.classList.add('org-target');}
    const r=container.getBoundingClientRect();
    if(state.y<r.top+48)container.scrollTop-=10;else if(state.y>r.bottom-48)container.scrollTop+=10;
    raf=requestAnimationFrame(frame);
  };
  const down=e=>{
    const handle=e.target.closest('.org-drag');if(!handle||e.button!==0)return;
    cleanup();suppress=false;clearTimeout(suppressTimer);const row=handle.closest('[data-order-key]');if(!row)return;
    state={id:e.pointerId,key:row.dataset.orderKey,x:e.clientX,y:e.clientY};
    try{container.setPointerCapture(e.pointerId);}catch{cleanup();return;}
    timer=setTimeout(()=>{if(!state)return;ghost=row.cloneNode(true);ghost.classList.add('org-ghost');ghost.style.width=Math.min(row.getBoundingClientRect().width,260)+'px';ghost.setAttribute('aria-hidden','true');document.body.append(ghost);suppress=true;frame();},180);
  };
  const move=e=>{if(state&&e.pointerId===state.id){state.x=e.clientX;state.y=e.clientY;e.preventDefault();}};
  const up=e=>{if(!state||e.pointerId!==state.id)return;const from=state.key,to=target?.dataset.orderKey,active=!!ghost;cleanup();suppressTimer=setTimeout(()=>{suppress=false;},0);if(active&&to&&from!==to)drop(from,to);};
  const cancel=()=>{cleanup();suppress=false;clearTimeout(suppressTimer);};
  const click=e=>{if(suppress){e.preventDefault();e.stopPropagation();suppress=false;}};
  container.addEventListener('pointerdown',down);container.addEventListener('pointermove',move,{passive:false});container.addEventListener('pointerup',up);container.addEventListener('pointercancel',cancel);container.addEventListener('lostpointercapture',cancel);container.addEventListener('click',click,true);
  return ()=>{cancel();container.removeEventListener('pointerdown',down);container.removeEventListener('pointermove',move);container.removeEventListener('pointerup',up);container.removeEventListener('pointercancel',cancel);container.removeEventListener('lostpointercapture',cancel);container.removeEventListener('click',click,true);};
}
