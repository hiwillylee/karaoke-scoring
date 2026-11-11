// build.mjs — 把前端的 ES 模組打包成一支 js/app.bundle.js。
//
// 不打包也能跑（開發時就是直接載入各個模組），打包只是讓手機開頁時少
// 二十幾個請求。伺服器只在打包檔與目前的原始碼一致時才改送打包檔：
// 這裡把所有來源的雜湊寫進 js/app.bundle.meta.json，server.py 用同樣的
// 算法核對，改了任何一支 js 而沒重新打包，就自動退回逐支載入。
//
// 執行：npm run build
//
// worklet（pitchshift-worklet.js、mic-worklet.js）與 config/params.json 是用
// new URL(..., import.meta.url) 在執行時載入的，打包後仍從 js/ 底下讀，
// 所以打包檔一定要放在 js/ 裡。

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const JS = join(ROOT, 'js');
const BUNDLE = 'app.bundle.js';

/** 列出所有前端原始碼（不含打包產物）。順序固定，雜湊才穩定。 */
function sources(dir = JS) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sources(full));
    else if (entry.name.endsWith('.js') && !entry.name.startsWith('app.bundle')) out.push(full);
  }
  return out;
}

/** 與 server.py 的 bundle_source_hash() 相同的算法。 */
function sourceHash() {
  const h = createHash('sha256');
  const files = sources().map((f) => relative(ROOT, f).split('\\').join('/')).sort();
  for (const rel of files) {
    h.update(rel);
    h.update('\0');
    h.update(readFileSync(join(ROOT, rel)));
    h.update('\0');
  }
  return h.digest('hex');
}

await build({
  entryPoints: [join(JS, 'main.js')],
  outfile: join(JS, BUNDLE),
  bundle: true,
  format: 'esm',
  target: ['es2020', 'safari14'],
  minify: true,
  sourcemap: true,
  legalComments: 'none',
  logLevel: 'info',
});

writeFileSync(join(JS, 'app.bundle.meta.json'),
  `${JSON.stringify({ sourceHash: sourceHash(), builtAt: new Date().toISOString() }, null, 2)}\n`);
console.log('已寫入 js/app.bundle.js 與 js/app.bundle.meta.json');
