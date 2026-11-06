import assert from 'node:assert/strict';
export async function checkDragPreview(page){
 for(const width of [320,360,768,1440])for(const grid of [false,true]){
  await page.setViewportSize({width,height:780});
  await page.evaluate(async grid=>{
   window.disposeDragFixture?.();document.querySelector('#drag-fixture')?.remove();
   const {installOrganizationDrag}=await import('/assets/js/organization.js');
   const c=document.createElement('div');c.id='drag-fixture';Object.assign(c.style,{position:'fixed',inset:'0',zIndex:'500',overflow:'auto',padding:'16px',background:'white'});
   const layout=document.createElement('div');if(grid){layout.style.display='grid';layout.style.gridTemplateColumns='1fr 1fr';layout.style.gap='8px';}
   for(let i=0;i<2;i++){
    const row=document.createElement('div');row.className=grid?'memo-cell':'memo-item';row.dataset.orderKey='m:'+i;row.style.height=grid?'180px':'84px';
    const media=document.createElement('div');media.className=grid?'cell-media':'memo-type';
    const img=document.createElement('img');img.src='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aGYQAAAAASUVORK5CYII=';media.append(img);
    const body=document.createElement('div');body.className=grid?'cell-info':'memo-body';
    const title=document.createElement('div');title.className=grid?'cell-title':'memo-title';title.textContent='Screenshot_20261106_140450_很长的图片文件名.jpg';
    const sub=document.createElement('div');sub.className=grid?'cell-sub':'memo-sub';sub.textContent='1 分钟前 · 305 KB · 图片';body.append(title,sub);
    const controls=document.createElement('div');controls.className='org-controls';const handle=document.createElement('button');handle.className='icon-btn org-drag';handle.textContent='拖动';controls.append(handle);
    row.append(media,body,controls);layout.append(row);
   }
   c.append(layout);document.body.append(c);window.fixtureDrops=[];window.disposeDragFixture=installOrganizationDrag(c,(...args)=>window.fixtureDrops.push(args));
  },grid);
  const source=page.locator('#drag-fixture [data-order-key="m:0"] .org-drag'),target=page.locator('#drag-fixture [data-order-key="m:1"]');
  const a=await source.boundingBox(),b=await target.boundingBox();const x=a.x+a.width/2,y=a.y+a.height/2,tx=b.x+b.width/2,ty=b.y+b.height/2;
  const touch=width<600;let cdp;
  if(touch){cdp=await page.context().newCDPSession(page);await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});}
  else{await page.mouse.move(x,y);await page.mouse.down();}
  await page.waitForTimeout(240);
  const verify=async()=>{
   const r=await page.locator('.org-ghost').boundingBox();assert(r&&r.height===72&&r.width<=280&&r.width>=200,JSON.stringify(r));assert(r.x>=0&&r.y>=0&&r.x+r.width<=width+1&&r.y+r.height<=780);
   assert.equal(await page.locator('.org-ghost button,.org-ghost input,.org-ghost [data-order-key]').count(),0);
   assert.equal(await page.locator('.org-ghost img').count(),1);
   assert(await page.locator('.org-ghost-sub').evaluate(e=>e.clientHeight<=20&&getComputedStyle(e).whiteSpace==='nowrap'));
  };
  await verify();
  if(touch)await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:tx,y:ty}]});else await page.mouse.move(tx,ty,{steps:8});
  await page.waitForTimeout(80);await verify();
  if(touch){await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await cdp.detach();}else await page.mouse.up();
  assert.deepEqual(await page.evaluate(()=>window.fixtureDrops),[['m:0','m:1',true]],'drag forward inserts after target, not a no-op');
  assert.equal(await page.locator('.org-ghost').count(),0);assert.equal(await page.locator('.org-target').count(),0);
  await page.evaluate(()=>{window.disposeDragFixture();document.querySelector('#drag-fixture').remove();});
 }
 console.log('PASS drag preview: image/list/grid, 320/360/768/1440px, bounded 72px card, no controls/wrapped metadata, touch/mouse forward insertion and cleanup');
}
