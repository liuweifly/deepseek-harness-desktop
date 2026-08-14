'use strict';

// 后处理脚本:electron-builder 的依赖收集器会在 dsh 的深层依赖树上漏包,
// 这里在打包完成后,把项目里完整的生产依赖树(不含 devDependencies)
// 复制进 .app 的 Resources/app/node_modules,保证 Harness 可独立运行。

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const root = path.join(__dirname, '..');
const dest = path.join(
  root,
  'dist',
  'mac-arm64',
  'DeepSeek.app',
  'Contents',
  'Resources',
  'app',
  'node_modules'
);

if (!fs.existsSync(path.join(dest, '..'))) {
  console.error('未找到打包产物,请先运行 electron-builder');
  process.exit(1);
}

const lines = execSync('npm ls --omit=dev --all --parseable', {
  cwd: root,
  encoding: 'utf8',
})
  .split('\n')
  .filter(Boolean);

let copied = 0;
for (const line of lines) {
  if (!line.startsWith(root + path.sep)) continue; // 跳过项目根
  const rel = line.slice(root.length + 1); // 如 node_modules/@deepseek-ai/dsh
  if (!rel.startsWith('node_modules/')) continue;
  const srcPath = path.join(root, rel);
  const destPath = path.join(dest, rel.slice('node_modules/'.length));
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.cpSync(srcPath, destPath, { recursive: true, force: true });
  copied++;
}

console.log(`已复制 ${copied} 个生产依赖包到 app bundle`);
