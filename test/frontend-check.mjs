// 前端/后端 ESM 语法门禁：用 vm.SourceTextModule 真正按 ES 模块解析，
// 避免 `node --check` 对含 import 的 .js 误判。运行: node --experimental-vm-modules test/frontend-check.mjs
import { SourceTextModule } from 'node:vm';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const targets = ['web', 'server'];
const files = [];
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full);
    else if (/\.(js|mjs)$/.test(name)) files.push(full);
  }
}
for (const t of targets) walk(path.join(root, t));

let failed = 0;
for (const f of files) {
  const src = readFileSync(f, 'utf8');
  try {
    new SourceTextModule(src, { identifier: f });
    console.log('OK   ' + path.relative(root, f));
  } catch (e) {
    failed++;
    console.error('FAIL ' + path.relative(root, f) + ' -> ' + e.message);
  }
}
console.log(`\n${files.length - failed}/${files.length} 个模块语法通过`);
process.exit(failed ? 1 : 0);
