import { h, clear, icon, GET, POST, PATCH, PUT, DEL, toast, confirmDialog, formatBytes } from '/assets/js/core.js';
import { applyAppearance } from '/assets/js/appearance.js';

export function renderStorage(page) {
  let alive = true, running = false, state;
  const status = h('p', { role: 'status', class: 'auth-note' });
  const controls = h('div', { class: 'row wrap gap-8' });
  page.append(h('h2', {}, '存储管理'), h('div', { class: 'panel' },
    h('p', {}, '由管理员统一选择。迁移包含全部备忘录分块、缩略图、头像和主题素材；仍然保持备忘录端到端加密。'),
    h('p', { class: 'muted' }, '迁移逐文件复制 → SHA-256 校验 → 持久化索引 → 删除原文件。迁移期间全站只读。关闭此页会在当前文件完成后暂停，再打开可继续；取消后已迁移文件仍可读取。'),
    h('p', { class: 'muted' }, '账号、索引、配置与解密公开素材所需的服务端密钥始终保留在服务器，请备份数据目录。Telegram 旧消息可能因平台限制无法删除，会列为待清理，不影响新副本。'), status, controls));
  function draw() {
    if (!alive) return;
    status.textContent = `当前：${state.mode === 'local' ? '服务器磁盘' : 'Telegram'} · 本地 ${state.local} 个对象 · TG ${state.telegram} 个对象 · 待清理 ${state.cleanupPending}` + (state.migration ? ` · 已迁移 ${state.migration.moved} 个，${running ? '进行中' : '已暂停 / 可继续'}` : '');
    clear(controls);
    const button = (title, fn) => h('button', { class: 'btn btn-tonal', disabled: running, onClick: async () => { try { await fn(); } catch (e) { toast(e.message, { type: 'error' }); } } }, title);
    if (state.migration) controls.append(button('继续迁移', resume), button('取消迁移并恢复写入', async () => { state = await POST('/api/admin/storage/cancel'); draw(); }));
    else for (const [target, title] of [['local', '迁移到服务器磁盘'], ['telegram', '迁移到 Telegram']]) controls.append(button(title, async () => {
      if (!await confirmDialog({ title, message: '校验成功后默认删除原文件，迁移期间暂停全站写入。建议先备份数据目录。确定继续？', confirmLabel: '开始迁移' })) return;
      state = await POST('/api/admin/storage/start', { target }); await resume();
    }));
    if (state.cleanupPending) controls.append(button('重试清理原文件（逐个）', async () => {
      state = await POST('/api/admin/storage/cleanup'); draw();
      if (!state.removed) toast('原存储未确认删除，请检查机器人权限或平台限制；原文件仍保留', { type: 'info' });
    }));
  }
  async function resume() {
    if (running) return; running = true; draw();
    try {
      while (alive && state.migration) { state = await POST('/api/admin/storage/step'); draw(); }
      if (alive && !state.migration) toast(state.cleanupPending ? '迁移完成，部分原文件待清理' : '迁移完成，原文件已清理', { type: 'success' });
    } finally { running = false; draw(); }
  }
  GET('/api/admin/storage').then(r => { state = r; draw(); }).catch(e => { if (alive) status.textContent = e.message; });
  return () => { alive = false; };
}

export function renderAppearance(page) {
  let alive = true, cancelWork = () => {}, previewURL = '', processed = null, theme, busy = false, generation = 0;
  const disposeURL = () => { if (previewURL) URL.revokeObjectURL(previewURL); previewURL = ''; };
  const heading = h('h2', {}, '主题'); const body = h('div', { class: 'theme-editor' }); page.append(heading, body);
  const check = (label, input) => h('label', { class: 'row gap-8 wrap' }, input, h('span', {}, label));
  async function init() {
    const r = await GET('/api/admin/appearance'); if (!alive) return; theme = r.appearance;
    const gallery = h('div', { class: 'theme-current' });
    const drawGallery = () => {
      clear(gallery);
      for (const [key, src] of Object.entries(theme.assets)) gallery.append(h('figure', {}, h('figcaption', {}, ({ logo: '备忘录 Logo', pet: '桌宠', mobile: '手机背景', tablet: '平板背景', desktop: '电脑背景' })[key]), h('img', { class: 'theme-preview', src, alt: key, loading: 'lazy' })));
    };
    drawGallery();
    const userColor = h('input', { type: 'color', value: theme.userColor || '#6750a4', 'aria-label': '用户界面主色' });
    const adminColor = h('input', { type: 'color', value: theme.adminColor || '#6750a4', 'aria-label': '管理界面主色' });
    const enabled = h('input', { type: 'checkbox', checked: theme.petEnabled });
    const onAdmin = h('input', { type: 'checkbox', checked: theme.petOnAdmin });
    const size = h('input', { type: 'range', min: 48, max: 240, value: theme.petSize, 'aria-label': '桌宠尺寸' });
    const sizeText = h('span', {}, `${theme.petSize}px`); size.oninput = () => { sizeText.textContent = `${size.value}px（窄屏自动缩小）`; };
    const save = h('button', { class: 'btn btn-filled', onClick: async () => {
      save.disabled = true;
      try { const result = await PATCH('/api/admin/appearance', { userColor: userColor.value, adminColor: adminColor.value, petEnabled: enabled.checked, petOnAdmin: onAdmin.checked, petSize: +size.value }); theme = result.appearance; applyAppearance(theme, true); toast('主题已保存，用户端重新打开后生效', { type: 'success' }); }
      catch (e) { toast(e.message, { type: 'error' }); } finally { save.disabled = false; }
    } }, '保存主题设置');
    body.append(h('div', { class: 'panel theme-options' }, h('h3', {}, '配色与桌宠'),
      check('用户界面主色', userColor), check('管理员界面主色', adminColor), check('开启桌宠', enabled), check('管理端也显示桌宠', onAdmin),
      check('桌宠尺寸', size), sizeText,
      h('p', { class: 'muted md-body-s' }, '桌宠仅作装饰，不拦截点击。自动适配屏幕、安全区和横屏；页面隐藏或系统减少动画时停止显示。关闭后仍保留素材，需删除素材请使用下方按钮。'),
      h('div', { class: 'row wrap gap-8' }, save, h('button', { class: 'btn btn-outlined', onClick: async () => {
        try { const result = await PATCH('/api/admin/appearance', { userColor: '', adminColor: '' }); theme = result.appearance; userColor.value = adminColor.value = '#6750a4'; applyAppearance(theme, true); toast('已恢复默认配色'); } catch (e) { toast(e.message, { type: 'error' }); }
      } }, '恢复默认配色'))));
    const slot = h('select', { class: 'tf-input', 'aria-label': '素材用途' }, ...[['logo', '备忘录 Logo'], ['pet', '桌宠'], ['mobile', '手机背景（小于 600px）'], ['tablet', '平板背景（600–1023px）'], ['desktop', '电脑背景（1024px 起）']].map(([value, label]) => h('option', { value }, label)));
    const file = h('input', { type: 'file', accept: 'image/gif,image/png,image/jpeg,image/webp', 'aria-label': '选择素材' });
    const cutout = h('input', { type: 'checkbox' });
    const autoColor = h('input', { type: 'checkbox', checked: true });
    const color = h('input', { type: 'color', value: '#ffffff', 'aria-label': '背景色' });
    const tolerance = h('input', { type: 'range', min: 0, max: 120, value: 35, 'aria-label': '抠图容差' });
    const preview = h('img', { class: 'theme-preview', hidden: true, alt: '处理结果预览' });
    const message = h('p', { role: 'status', class: 'muted' });
    const upload = h('button', { class: 'btn btn-filled', disabled: true, onClick: async () => {
      if (!processed || busy) return; busy = true; upload.disabled = true;
      try { const result = await PUT(`/api/admin/appearance/assets/${processed.slot}`, processed.blob); theme = result.appearance; applyAppearance(theme, true); drawGallery(); message.textContent = '素材已上传。桌宠需开启上方开关；背景按设备自动显示。'; }
      catch (e) { message.textContent = e.message; } finally { busy = false; if (alive) upload.disabled = !processed; }
    } }, '确认预览并上传');
    const reset = () => { cancelWork(); generation++; processed = null; upload.disabled = true; disposeURL(); preview.removeAttribute('src'); preview.hidden = true; };
    for (const el of [slot, file, cutout, autoColor, color, tolerance]) el.addEventListener('change', reset);
    const process = h('button', { class: 'btn btn-tonal', onClick: async () => {
      if (busy) return; reset(); const selected = file.files[0]; if (!selected) { message.textContent = '请先选择图片'; return; }
      if (selected.size > 12 * 1024 * 1024 || !['image/gif', 'image/png', 'image/jpeg', 'image/webp'].includes(selected.type)) { message.textContent = '请选择 12MB 以内的 GIF、PNG、JPEG 或 WebP'; return; }
      const target = slot.value, ticket = generation; process.disabled = true; message.textContent = '正在本机处理，原图不会上传…';
      let worker = null, timer = null;
      const finish = () => { clearTimeout(timer); worker?.terminate(); worker = null; if (ticket === generation) { if (alive) process.disabled = false; cancelWork = () => {}; } };
      cancelWork = () => { finish(); if (alive) message.textContent = '已取消处理'; };
      try {
        const bytes = await selected.arrayBuffer(); if (!alive || ticket !== generation) return;
        worker = new Worker('/assets/js/theme-image-worker.js');
        timer = setTimeout(() => { finish(); if (alive) message.textContent = '处理超过 90 秒已停止，请缩小素材'; }, 90000);
        worker.onmessage = ({ data }) => {
          if (!alive || ticket !== generation) { finish(); return; }
          if ('progress' in data) { message.textContent = `${data.stage} · ${data.progress}%`; return; }
          finish();
          if (data.error) { message.textContent = data.error; return; }
          processed = { slot: target, blob: new Blob([data.bytes], { type: data.type }) };
          previewURL = URL.createObjectURL(processed.blob); preview.src = previewURL; preview.hidden = false; upload.disabled = false;
          message.textContent = `${formatBytes(selected.size)} → ${formatBytes(processed.blob.size)} · ${data.width}×${data.height} · ${data.frames} 帧 · ${data.type}。请检查预览，再确认上传。`;
        };
        worker.onerror = () => { finish(); if (alive) message.textContent = '处理失败或浏览器不兼容，请更新浏览器或缩小图片'; };
        worker.postMessage({ bytes, type: selected.type, slot: target, cutout: cutout.checked, color: autoColor.checked ? null : color.value, tolerance: +tolerance.value }, [bytes]);
      } catch (e) { finish(); if (alive && ticket === generation) message.textContent = e.message; }
    } }, '本机压缩 / 抠图并预览');
    body.append(h('div', { class: 'panel theme-options' }, h('h3', {}, 'Logo、桌宠与分设备背景'),
      h('p', { class: 'muted' }, `素材跟随全站存储（当前 ${r.storageMode === 'local' ? '服务器磁盘' : 'Telegram'}），可在“存储”页迁移。背景未设置时回退到较大设备背景。`),
      slot, file, check('去除纯色背景（边缘连通抠图）', cutout), check('自动取左上角色，否则使用下方颜色', autoColor), check('背景颜色', color), check('颜色容差', tolerance),
      h('p', { class: 'muted md-body-s' }, '支持纯色 / 近似纯色背景，不是 AI 人物分割，复杂背景请预先处理。静态图片自动缩放并转 WebP；GIF 保留动画和透明度，逐帧压缩，最多 240 帧 / 总计 6400 万像素。桌宠输出 ≤2MB，背景 ≤1.5MB；超限会缩小重试，不会悄悄丢弃动画。'),
      h('div', { class: 'row wrap gap-8' }, process, h('button', { class: 'btn btn-outlined', onClick: reset }, '取消处理'), upload,
        h('button', { class: 'btn btn-outlined', onClick: async () => {
          if (busy || !await confirmDialog({ title: '删除此位置的素材？', message: '会移除此位置的素材并尝试删除原存储文件；Logo 将恢复默认。', confirmLabel: '删除' })) return;
          try { const result = await DEL(`/api/admin/appearance/assets/${slot.value}`); theme = result.appearance; applyAppearance(theme, true); drawGallery(); reset(); message.textContent = '素材已移除'; } catch (e) { message.textContent = e.message; }
        } }, '删除此位置素材')), message, preview,
      gallery));
  }
  init().catch(e => { if (alive) body.append(h('p', {}, e.message)); });
  return () => { alive = false; cancelWork(); disposeURL(); processed = null; };
}
