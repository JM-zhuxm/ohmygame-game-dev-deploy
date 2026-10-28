#!/usr/bin/env node
/**
 * 扫描 Phaser 工程里所有 setInteractive 调用，检查 hitArea 原点约定是否一致。
 *
 * 用法：
 *   node check-hitarea.mjs <projectDir>
 *   默认当前目录。
 *
 * 背景：Phaser 的 pointWithinHitArea 会把 displayOrigin(=width/2, height/2)
 * 加进局部坐标再交给 hitAreaCallback。对 Container 来说，用
 * Rectangle(-w/2, -h/2, w, h) 这种「以中心为原点」的 hitArea 会让可点区
 * 整体偏移一个身位——按钮正中点不中，鼠标因亚像素偏移偶尔能点中，
 * 触屏整数坐标则稳定失败。统一改成 Rectangle(0, 0, w, h)（左上为原点）。
 *
 * ⚠️ 但 Rectangle(0, 0, w, h) 仍有一个陷阱：它让可点区边界与图形边界
 * 压成同一条线（args = entry + (w/2,h/2)，entry 范围 ±w/2 → args 范围
 * [0,w]）。点在容器正中时 args 恰好等于 (w,h)，正好卡在边界上，任何浮点
 * 误差都会判定失败。实测 375×667 视口 args_y = 92.0000117 > 92 → 点不动。
 * 正确做法是给 hitArea 留 1px 余量，通常通过共享辅助函数
 * （如 kit.ts 的 makeHitArea）实现，因此本脚本也识别这种调用。
 *
 * 退出码：有「居中原点」写法时为 1（需人工确认后修改），否则 0。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.argv[2] ?? process.cwd();
const SRC_DIRS = ['src'];
const EXT = /\.(ts|tsx|js|jsx)$/;

function walk(dir, out = []) {
  let entries = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (e === 'node_modules' || e === 'dist' || e.startsWith('.')) continue;
      walk(p, out);
    } else if (EXT.test(e)) {
      out.push(p);
    }
  }
  return out;
}

const files = SRC_DIRS.flatMap((d) => walk(join(ROOT, d)));
const results = [];

for (const f of files) {
  const lines = readFileSync(f, 'utf8').split('\n');
  lines.forEach((line, i) => {
    if (!line.includes('setInteractive')) return;
    // 收集这一行往后 4 行的参数，判断 hitArea 原点约定
    const chunk = lines.slice(i, i + 5).join(' ');
    // 共享辅助函数（自带余量），如 makeHitArea(w, h)
    const helper = /makeHitArea\s*\(/.test(chunk);
    const centered = /new\s+Phaser\.Geom\.Rectangle\(\s*-/.test(chunk);
    const topLeft = /new\s+Phaser\.Geom\.Rectangle\(\s*0\s*,/.test(chunk);
    results.push({
      file: relative(ROOT, f),
      line: i + 1,
      kind: helper ? 'HELPER' : centered ? 'CENTERED' : topLeft ? 'TOP_LEFT' : 'UNKNOWN',
      text: line.trim(),
    });
  });
}

if (!results.length) {
  console.log('未发现 setInteractive 调用（可能全部用了 Phaser 默认 hitArea）。');
  process.exit(0);
}

const centered = results.filter((r) => r.kind === 'CENTERED');
for (const r of results) {
  const tag =
    r.kind === 'CENTERED' ? '❌ 居中原点'
    : r.kind === 'TOP_LEFT' ? '✅ 左上原点'
    : r.kind === 'HELPER' ? '✅ 共享辅助函数(带余量)'
    : '⚠️  需人工确认';
  console.log(`${tag}  ${r.file}:${r.line}  ${r.text}`);
}

console.log('');
if (centered.length) {
  console.log(`发现 ${centered.length} 处居中原点写法。`);
  console.log('Phaser 的命中判定会加上 displayOrigin(=width/2, height/2)，');
  console.log('居中原点会让可点区整体偏移半个身位——按钮正中点不中。');
  console.log('改为：new Phaser.Geom.Rectangle(0, 0, w, h)');
  process.exit(1);
}
if (results.some((r) => r.kind === 'UNKNOWN')) {
  console.log('有若干写法需人工确认（多行参数或自定义 hitArea）。');
}
console.log('hitArea 原点约定一致。');
process.exit(0);
