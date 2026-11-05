// 构建「单文件用户前端」导出模板：web/export/template.html
// 内联 CSS / 图标 / 加密 Worker / 应用 bundle，并留出 __MEMO_CONFIG__ 注入点。
// 运行：npm i -D esbuild && npm run build:export
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const WEB = path.join(ROOT, 'web');
const read = (p) => fs.readFileSync(path.join(WEB, p), 'utf8');

// CSS：去掉 @font-face（改用系统字体），去掉指向 /assets 的 url()，保证单文件自包含
let css = read('assets/md3.css') + '\n' + read('assets/app.css');
css = css.replace(/@font-face\s*{[^}]*}/g, '');
css = css.replace(/url\((['"]?)\/assets\/[^)]*\)/g, 'none');

const icons = read('assets/icons.svg');
const worker = read('user/worker.js');
const themeBoot = read('assets/js/theme-boot.js');
const favicon = read('assets/favicon.svg');

const bundle = await build({
  entryPoints: [path.join(WEB, 'user', 'app.js')],
  bundle: true, write: false, format: 'iife', platform: 'browser',
  minify: true, legalComments: 'none',
  plugins: [{
    name: 'abs-web',
    setup(b) {
      b.onResolve({ filter: /^\/(assets|app|admin)\// }, (a) => ({ path: path.join(WEB, a.path) }));
    },
  }],
});
const js = bundle.outputFiles[0].text;

const html = `<!doctype html>
<html lang="zh-CN" data-theme="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#FEF7FF">
<meta name="robots" content="noindex">
<title>备忘录</title>
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(favicon)}">
<style>${css}</style>
<script>${themeBoot}</script>
</head>
<body>
<div style="display:none" aria-hidden="true">${icons}</div>
<div id="app"></div>
<noscript>请启用 JavaScript 以使用备忘录。</noscript>
<script>
window.__MEMO_CONFIG__ = /*__MEMO_CONFIG__*/null;
window.__MEMO_WORKER__ = ${JSON.stringify(worker)};
</script>
<script>${js}</script>
</body>
</html>
`;

const outDir = path.join(WEB, 'export');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'template.html'), html);
console.log(`[build-export] 模板已生成: web/export/template.html (${(html.length / 1024).toFixed(1)} KB)`);
