import { build } from 'esbuild';
import fs from 'node:fs';
await build({ entryPoints: ['scripts/theme-image-worker.js'], bundle: true, minify: true, format: 'iife', target: 'es2020', outfile: 'web/assets/js/theme-image-worker.js', legalComments: 'eof' });
fs.copyFileSync('THIRD_PARTY.md', 'web/assets/theme-libraries.txt');
