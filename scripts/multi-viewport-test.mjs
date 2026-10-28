/**
 * 多视口触屏/鼠标批量验收：真实 CDP 事件，逐视口跑「开始 → 答题 → 下一题」。
 *
 * 用法：
 *   node multi-viewport-test.mjs <url> [cdpPort] [mode]
 *     url     被测地址（本地 http://127.0.0.1:4189/ 或线上 https://...）
 *     cdpPort 已启动的 Chromium 调试端口（默认 9977）
 *     mode    touch | mouse（默认 touch）
 *
 * 视口覆盖：320×568 / 360×640 / 375×667 / 390×844 / 414×896 / 1280×800
 *
 * 前提：
 *   - 另开一个终端启动持久 Chromium：
 *     /snap/bin/chromium --headless=new --remote-debugging-port=9977 \
 *       --no-sandbox --user-data-dir=/tmp/cdp-mv about:blank
 *   - 页面暴露 window.__OHMYGAME_PLAYTEST__.snapshot()
 *
 * 为什么必须多视口：Phaser 的 Scale.FIT 在不同视口下缩放系数不同，
 * 同一点击会产生不同的浮点误差。hitArea 若把边界压在图形边界上，
 * 会表现为「390×844 能点、375×667 点不动」——单视口测试会漏掉。
 *
 * 退出码：全部视口通过为 0，否则为 1。
 */
import { setTimeout as delay } from 'node:timers/promises';

const URL_ = process.argv[2] ?? 'http://127.0.0.1:4189/';
const CDP_PORT = Number(process.argv[3] ?? 9977);
const MODE = process.argv[4] ?? 'touch';

const VIEWPORTS = [
  [320, 568], [360, 640], [375, 667], [390, 844], [414, 896], [1280, 800],
];

const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
const page = list.find(t => t.type === 'page');
if (!page) { console.error('找不到 page target，Chromium 是否已启动？'); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true });
  ws.addEventListener('error', reject, { once: true });
});
let id = 0; const pend = new Map();
const consoleIssues = [];
ws.onmessage = e => {
  const m = JSON.parse(e.data);
  if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) {
    consoleIssues.push(m.params.type + ': ' + m.params.args.map(a => a.value ?? a.description ?? '?').join(' ').slice(0, 160));
  }
  if (m.method === 'Runtime.exceptionThrown') {
    consoleIssues.push('EXCEPTION: ' + (m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text).slice(0, 200));
  }
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
};
const send = (method, params = {}) => new Promise(res => { id++; pend.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const evl = async expr => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value;

await send('Page.enable'); await send('Runtime.enable');
if (MODE === 'touch') await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });

const snap = async () => JSON.parse(await evl(`JSON.stringify(window.__OHMYGAME_PLAYTEST__.snapshot())`));

let failed = 0;
for (const [W, H] of VIEWPORTS) {
  await send('Emulation.setDeviceMetricsOverride', {
    width: W, height: H, deviceScaleFactor: 2, mobile: MODE === 'touch',
  });
  await send('Page.navigate', { url: URL_ });
  await delay(4500);

  const geo = JSON.parse(await evl(`JSON.stringify((function(){
    const c = document.querySelector('canvas'); const r = c.getBoundingClientRect();
    return { cw: c.width, ch: c.height, rw: r.width, rh: r.height, l: r.left, t: r.top };
  })())`));

  const tap = async (gx, gy) => {
    const cx = geo.l + (gx / geo.cw) * geo.rw;
    const cy = geo.t + (gy / geo.ch) * geo.rh;
    if (Number.isNaN(cx) || Number.isNaN(cy)) throw new Error('NaN 坐标');
    if (MODE === 'touch') {
      await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: cx, y: cy, id: 1 }] });
      await delay(90);
      await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } else {
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx, y: cy, button: 'left', clickCount: 1 });
    }
  };

  const steps = [];
  let s = await snap();
  if (s.scene !== 'Title') { steps.push(`初始场景=${s.scene}(非 Title)`); }

  if (s.startButton) {
    await tap(s.startButton.x, s.startButton.y); await delay(1400);
    s = await snap();
    steps.push(s.scene === 'Quiz' ? '开始✅' : `开始❌(${s.scene})`);
  }

  if (s.scene === 'Quiz' && s.options?.length) {
    const o = s.options[0];
    await tap(o.x + o.w / 2, o.y + o.h / 2); await delay(1400);
    s = await snap();
    steps.push(s.state === 'explaining' ? '答题✅' : `答题❌(state=${s.state})`);

    if (s.nextButton?.w > 0) {
      await tap(s.nextButton.x, s.nextButton.y); await delay(1400);
      s = await snap();
      const ok = s.scene === 'Quiz' && (s.index ?? 1) >= 1;
      steps.push(ok ? '下一题✅' : `下一题❌(scene=${s.scene},index=${s.index})`);
    } else {
      steps.push('下一题❌(无按钮)');
    }
  }

  const ok = steps.every(x => x.includes('✅'));
  if (!ok) failed++;
  console.log(`${ok ? '✅' : '❌'} ${W}×${H}  ${steps.join('  ')}`);
}

console.log('');
console.log('控制台问题:', consoleIssues.length ? consoleIssues : '（无）');
console.log(failed ? `❌ ${failed} 个视口未通过` : '✅ 全部视口通过');
process.exit(failed ? 1 : 0);
