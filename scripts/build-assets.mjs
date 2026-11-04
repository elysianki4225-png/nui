#!/usr/bin/env node
/**
 * 开发期资源构建脚本（部署时不需要运行）。
 * 从 npm 包 @material-design-icons/svg 与 @fontsource/* 中提取所需图标 / 字体，
 * 生成 web/assets/icons.svg 雪碧图与 web/assets/fonts/*.woff2。
 *
 * 用法:
 *   npm pack @material-design-icons/svg @fontsource/roboto @fontsource/roboto-mono
 *   tar xzf ... 到 .asset-tmp/{icons,roboto,robotomono}
 *   node scripts/build-assets.mjs .asset-tmp
 */
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = process.argv[2] || join(root, '.asset-tmp');
const outAssets = join(root, 'web', 'assets');
mkdirSync(join(outAssets, 'fonts'), { recursive: true });

const ICONS = [
  // 通用
  'add','remove','close','check','check_circle','cancel','error','warning','info','help',
  'search','menu','more_vert','more_horiz','arrow_back','arrow_forward','chevron_left','chevron_right',
  'expand_more','expand_less','open_in_new','link','content_copy','download','upload','save','edit',
  'delete','delete_sweep','delete_forever','refresh','sync','autorenew','settings','tune','history','logout','login',
  'dark_mode','light_mode','visibility','visibility_off','filter_list','sort','swap_vert',
  'select_all','deselect','done_all','drag_indicator','checklist','playlist_add_check','task_alt',
  // 备忘录
  'sticky_note_2','notes','note_add','description','text_snippet','image','photo_library','movie',
  'video_library','attach_file','insert_drive_file','file_present','broken_image','push_pin','star',
  'star_border','folder','folder_open','cloud','cloud_done','cloud_off','cloud_upload','cloud_download',
  'play_arrow','pause','zoom_in','zoom_out','rotate_right','fullscreen','fullscreen_exit','grid_view',
  'view_list','view_module','table_rows','list_alt','calendar_today','schedule','access_time','today',
  'event','storage','sell','label','archive','flag','share','timer','bolt','speed',
  // 账号 / 安全
  'person','person_add','account_circle','group','manage_accounts','key','vpn_key','lock','lock_open',
  'lock_person','enhanced_encryption','no_encryption','shield','security','verified_user','policy',
  'privacy_tip','fingerprint','badge','block','gpp_bad','report','public','language','devices',
  // 管理
  'password','chat','forum','question_answer',
  'admin_panel_settings','dashboard','analytics','query_stats','bar_chart','timeline','monitor_heart',
  'lan','router','dns','hub','api','webhook','integration_instructions','smart_toy','send','telegram',
  'memory','developer_board','terminal','restart_alt','power_settings_new','update','construction',
  'engineering','build','home','apps','widgets','palette','contrast','wb_sunny','nights_stay',
  'format_list_bulleted','fact_check','rule','settings_suggest','data_object','folder_copy',
  'file_download','file_upload','drive_file_move','expand_circle_down','reorder','toc','segment',
  'north_east','south_east','my_location','pin_drop','translate','mail','flag_circle',
];

const iconDir = join(tmp, 'icons', 'package', 'round');
const outlinedDir = join(tmp, 'icons', 'package', 'outlined');
let symbols = '';
let used = 0;
for (const name of [...new Set(ICONS)]) {
  let file = join(iconDir, `${name}.svg`);
  if (!existsSync(file)) file = join(outlinedDir, `${name}.svg`);
  if (!existsSync(file)) { console.warn('skip missing icon:', name); continue; }
  let svg = readFileSync(file, 'utf8');
  const m = svg.match(/viewBox="([^"]+)"/);
  const viewBox = m ? m[1] : '0 0 24 24';
  let inner = svg.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '').trim();
  inner = inner.replace(/<path /g, '<path fill="currentColor" ');
  symbols += `<symbol id="i-${name}" viewBox="${viewBox}">${inner}</symbol>`;
  used++;
}
const sprite = `<svg xmlns="http://www.w3.org/2000/svg" style="display:none" aria-hidden="true">${symbols}</svg>`;
writeFileSync(join(outAssets, 'icons.svg'), sprite);
console.log(`icons.svg: ${used} icons, ${(sprite.length / 1024).toFixed(1)} KB`);

const fonts = [
  ['roboto', 'roboto-latin-400-normal.woff2'],
  ['roboto', 'roboto-latin-500-normal.woff2'],
  ['roboto', 'roboto-latin-700-normal.woff2'],
  ['robotomono', 'roboto-mono-latin-400-normal.woff2'],
  ['robotomono', 'roboto-mono-latin-500-normal.woff2'],
];
for (const [pkg, file] of fonts) {
  copyFileSync(join(tmp, pkg, 'package', 'files', file), join(outAssets, 'fonts', file));
}
console.log('fonts copied:', fonts.length);
