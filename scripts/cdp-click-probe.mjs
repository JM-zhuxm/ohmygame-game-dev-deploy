/**
 * CDP 真实点击探针：复现 Phaser 网页游戏「按钮没反应」类问题。
 *
 * 用法：
 *   node cdp-click-probe.mjs [mouse|touch] [projectDir]
 *   默认 mouse。touch 模式开 Emulation.setTouchEmulationEnabled +
 *   Input.dispatchTouchEvent —— 手机端 bug 必须两种模式都测，
 *   鼠标正常不代表触屏正常（已验证的真实分歧）。
 *
 * 每步截图到 /tmp/probe-<mode>-*.png，并打印游戏 snapshot 状态。
 * 事件到达日志在页面里 window.__EVTS（区分「事件没到 canvas」和「Phaser 没命中」）。
 *
 * 前提：
 *   - 项目能 vite preview 跑起来；本机有无头 Chromium。
 *   - 游戏暴露 window.__OHMYGAME_PLAYTEST__（snapshot/reset/layout）。
 *     snapshot 返回 {scene, state, index, score, nextButton:{x,y,w,h}, options:[...]}。
 *     读状态用它，不要用截图像素对比——像素只能告诉你「画面变了没」，归因靠猜。
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

const MODE = process.argv[2] ?? 'mouse';
const PROJECT = process.argv[3] ?? process.cwd();
const CHROME = process.env.CHROME_BIN ?? '/snap/bin/chromium';
const APP_PORT = 4200 + Math.floor(Math.random() * 80);
const CDP_PORT = APP_PORT + 1000;

spawn('npx', ['vite', 'preview', '--port', String(APP_PORT), '--strictPort'], { cwd: PROJECT, stdio: 'ignore', detached: true });
spawn('sh', ['-c', `sleep 1 && ${CHROME} --headless=new --remote-debugging-port=${CDP_PORT} --no-sandbox --window-size=760,1400 --user-data-dir=/tmp/cdp-probe-${APP_PORT} about:blank`], { stdio: 'ignore', detached: true });
await delay(3200);

const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
const page = list.find(t => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true });
  ws.addEventListener('error', reject, { once: true });
});
let id = 0; const pend = new Map();
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
const send = (method, params = {}) => new Promise(res => { id++; pend.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const evl = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value;

await send('Page.enable'); await send('Runtime.enable');
if (MODE === 'touch') {
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
}
await send('Page.navigate', { url: `http://127.0.0.1:${APP_PORT}/` });
await delay(3500);

// 事件监听：确认输入事件是否到达 canvas、坐标是否正确
await evl(`(function(){
  window.__EVTS=[];
  const c=document.querySelector('canvas');
  ['pointerdown','pointerup','touchstart','mousedown'].forEach(t=>
    c.addEventListener(t, e=>window.__EVTS.push(t+':'+Math.round(e.clientX||0)+','+Math.round(e.clientY||0))));
})()`);

// 坐标映射（Phaser Scale.FIT）——字段名错一个就是 NaN → 点击落 (0,0) 假阳性。
// 分母用 canvas.width（绘制分辨率），换算用 clientWidth（CSS 尺寸）。
const info = await evl(`(()=>{const c=document.querySelector('canvas');const r=c.getBoundingClientRect();
  return {w:c.width,h:c.height,cw:c.clientWidth,ch:c.clientHeight,l:r.left,t:r.top};})()`);
console.log(`canvas: ${JSON.stringify(info)} (mode=${MODE})`);

async function tap(gx, gy) {
  const cx = info.l + (gx / info.w) * info.cw;
  const cy = info.t + (gy / info.h) * info.ch;
  if (Number.isNaN(cx) || Number.isNaN(cy)) throw new Error(`NaN 坐标 (${gx},${gy})——info 字段缺失`);
  if (MODE === 'touch') {
    await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: cx, y: cy, id: 1 }] });
    await delay(120);
    await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } else {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx, y: cy, button: 'left', clickCount: 1 });
  }
}
const snap = async () => JSON.parse(await evl(`JSON.stringify(window.__OHMYGAME_PLAYTEST__.snapshot())`));
async function shot(name) {
  const d = (await send('Page.captureScreenshot', { format: 'png' })).result || {};
  writeFileSync(`/tmp/probe-${MODE}-${name}.png`, Buffer.from(d.data ?? '', 'base64'));
}

// ---- 示例流程：坐标一律从 snapshot 拿真实按钮中心，不要硬编码猜坐标 ----
const s0 = await snap();
console.log('S0:', JSON.stringify(s0));
await shot('0-title');

if (s0.startButton) {
  await tap(s0.startButton.x, s0.startButton.y); await delay(1500);
  const s1 = await snap();
  console.log('S1 点开始后:', JSON.stringify(s1));
  await shot('1-quiz');

  if (s1.scene === 'Quiz' && s1.options?.length) {
    const o = s1.options[0];
    await tap(o.x + o.w / 2, o.y + o.h / 2); await delay(1500);
    const s2 = await snap();
    console.log('S2 答题后:', JSON.stringify(s2));
    await shot('2-explain');

    if (s2.nextButton?.w > 0) {
      await tap(s2.nextButton.x, s2.nextButton.y); await delay(1500);
      console.log('S3 点下一题后:', JSON.stringify(await snap()));
      await shot('3-next');
    }
  }
}

console.log('\n事件到达日志:', await evl(`JSON.stringify(window.__EVTS)`));
process.exit(0);
