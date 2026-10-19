// 入口界面验收（多行自动长高、候选上下键选择、← 历史会话）。用桩 CLI，不碰 iTerm 和任何真实会话；
// 会短暂弹出入口窗口。用法: node scripts/entry-ux.live.mjs    日志与截图: .runtime/entry-ux/
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const D = path.join(ROOT, '.runtime/entry-ux');
fs.rmSync(D, { recursive: true, force: true });
fs.mkdirSync(D, { recursive: true });
const TRACE = path.join(D, 'trace.jsonl');
const STUB_LOG = path.join(D, 'stub-calls.jsonl');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : '  ' + detail}`); };
const lines = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const calls = () => lines(STUB_LOG).filter((a) => a[0] === 'open');

const el = spawn(path.join(ROOT, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'), [path.join(ROOT, 'entry/main.cjs')], {
  env: { ...process.env, NTR_ENTRY_CLI: path.join(ROOT, 'scripts/fixtures/entry-stub-cli.mjs'), NTR_STUB_LOG: STUB_LOG, NTR_ENTRY_TRACE: TRACE, NTR_ENTRY_CONTROL: 'stdin', NTR_HOTKEY: 'Control+Alt+Shift+F12' },
  stdio: ['pipe', 'pipe', 'pipe'],
});
let out = '';
el.stdout.on('data', (b) => (out += b));
el.stderr.on('data', (b) => (out += b));
const send = (o) => el.stdin.write(JSON.stringify(o) + '\n');
let probeN = 0;
const probe = async () => {
  const tag = `p${++probeN}`;
  send({ cmd: 'probe', tag });
  for (let i = 0; i < 40; i++) { const p = lines(TRACE).find((e) => e.ev === 'probe' && e.tag === tag); if (p) return p; await sleep(100); }
  return null;
};
const key = async (k, shift = false) => { send({ cmd: 'key', key: k, shift }); await sleep(150); };
const waitCalls = async (n) => { for (let i = 0; i < 50; i++) { if (calls().length >= n) return calls(); await sleep(100); } return calls(); };
const show = async () => { send({ cmd: 'show' }); await sleep(700); };

try {
  for (let i = 0; i < 100 && !out.includes('ntr 入口就绪'); i++) await sleep(100);
  check('入口启动', out.includes('ntr 入口就绪'), out);

  // ---- 1. 多行：自动换行、输入框与窗口一起长高 ----
  await show();
  const p0 = await probe();
  send({ cmd: 'type', text: '这是一句很长的话，用来验证输入框会自动换行而不是横向滚动把前面的内容挤出去。'.repeat(4) });
  await sleep(300);
  const p1 = await probe();
  check('长文本自动换行：输入框高度 ≥ 3 行', p1.inputHeight >= p1.lineHeight * 3 - 1, JSON.stringify({ h: p1.inputHeight, lh: p1.lineHeight }));
  check('窗口随内容长高', p1.window[1] > p0.window[1], `${p0.window} → ${p1.window}`);
  send({ cmd: 'shot', file: path.join(D, '1-multiline.png') });
  await key('Enter', true);
  const p2 = await probe();
  check('Shift+回车不发送', p2.mode === 'input' && calls().length === 0, JSON.stringify(p2.mode));
  send({ cmd: 'type', text: '' });
  await sleep(300);
  const p3 = await probe();
  check('清空后输入框缩回一行、窗口缩回', p3.inputHeight <= p3.lineHeight + 2 && p3.window[1] < p1.window[1], JSON.stringify({ h: p3.inputHeight, w: p3.window }));

  // ---- 2. 拿不准时的候选：上下键选择、回车确认 ----
  send({ cmd: 'type', text: 'CLARIFY 帮我看一下那个任务' });
  send({ cmd: 'enter' });
  let pc = null;
  for (let i = 0; i < 30; i++) { await sleep(150); pc = await probe(); if (pc.mode === 'choose') break; }
  check('拿不准 → 列表，默认选中第 1 项', pc.mode === 'choose' && pc.sel === 0 && JSON.stringify(pc.items) === JSON.stringify(['claude:C1', 'codex:C2', 'NEW']), JSON.stringify(pc));
  await key('ArrowDown');
  check('↓ 移到第 2 项', (await probe()).sel === 1);
  await key('ArrowUp'); await key('ArrowUp');
  check('↑ 越过顶部回绕到最后一项', (await probe()).sel === 2);
  await key('ArrowDown'); await key('ArrowDown');
  send({ cmd: 'shot', file: path.join(D, '2-choose.png') });
  await sleep(200);
  await key('Enter');
  const c1 = await waitCalls(2);
  check('回车确认当前高亮项（第 2 项 → --pick codex:C2）', JSON.stringify(c1[1]?.slice(0, 4)) === JSON.stringify(['open', '--json', '--pick', 'codex:C2']), JSON.stringify(c1[1]));
  check('候选回车发送的正文是原句', c1[1]?.at(-1) === 'CLARIFY 帮我看一下那个任务');

  // ---- 3. ← 历史会话：空输入时选中 → 成为发送目标，之后打字直接发往它 ----
  await show();
  await key('ArrowLeft');
  let ph = null;
  for (let i = 0; i < 30; i++) { await sleep(150); ph = await probe(); if (ph.mode === 'history' && ph.items.length) break; }
  check('空输入按 ← 展开历史会话', ph.mode === 'history' && JSON.stringify(ph.items) === JSON.stringify(['claude:H1', 'codex:H2']), JSON.stringify(ph));
  await key('ArrowDown');
  send({ cmd: 'shot', file: path.join(D, '3-history.png') });
  await sleep(200);
  await key('Enter');
  const pt = await probe();
  check('选中历史会话 → 成为发送目标，回到输入', pt.mode === 'input' && pt.target === 'codex:H2', JSON.stringify(pt));
  send({ cmd: 'shot', file: path.join(D, '4-target.png') });
  send({ cmd: 'type', text: '周末的场次再确认一下' });
  send({ cmd: 'enter' });
  const c2 = await waitCalls(3);
  check('有目标时回车直接 --pick 该会话（不经 Jev 判断）', JSON.stringify(c2[2]) === JSON.stringify(['open', '--json', '--pick', 'codex:H2', '--', '周末的场次再确认一下']), JSON.stringify(c2[2]));

  // ---- 4. 已经打了字，再按 ← 选历史 → 直接发出 ----
  await show();
  send({ cmd: 'type', text: '接着复盘' });
  send({ cmd: 'caret', at: 0 });
  await sleep(150);
  await key('ArrowLeft');
  for (let i = 0; i < 30; i++) { await sleep(150); if ((await probe()).items.length) break; }
  await key('Enter');
  const c3 = await waitCalls(4);
  check('有正文时选历史会话 → 立即发往它', JSON.stringify(c3[3]) === JSON.stringify(['open', '--json', '--pick', 'claude:H1', '--', '接着复盘']), JSON.stringify(c3[3]));

  // ---- 5. ← 只在光标位于开头时触发；Esc 层层退出 ----
  await show();
  send({ cmd: 'type', text: 'abc' });
  await sleep(150);
  await key('ArrowLeft');
  check('光标不在开头时 ← 不展开历史', (await probe()).mode === 'input');
  send({ cmd: 'type', text: '' });
  await key('ArrowLeft');
  for (let i = 0; i < 30; i++) { await sleep(150); if ((await probe()).items.length) break; }
  await key('Escape');
  check('历史列表里 Esc → 回到输入', (await probe()).mode === 'input');
  await key('ArrowLeft');
  for (let i = 0; i < 30; i++) { await sleep(150); if ((await probe()).items.length) break; }
  await key('Enter');
  check('设好发送目标', (await probe()).target === 'claude:H1');
  await key('Escape');
  const pe = await probe();
  check('有目标时 Esc → 取消目标，改由 Jev 判断', pe.target === null && pe.mode === 'input');
  send({ cmd: 'type', text: '普通一句' });
  send({ cmd: 'enter' });
  const c4 = await waitCalls(5);
  check('取消目标后回车走路由（无 --pick）', JSON.stringify(c4[4]) === JSON.stringify(['open', '--json', '--', '普通一句']), JSON.stringify(c4[4]));

  // ---- 6. 关闭再打开：没送出去的话保留 ----
  const hideShow = async () => { send({ cmd: 'hide' }); await sleep(300); await show(); return probe(); };
  await show();
  send({ cmd: 'type', text: '输入到一半的话' });
  await sleep(150);
  let pk = await hideShow();
  check('输入到一半关掉 → 再打开文字还在', pk.mode === 'input' && pk.value === '输入到一半的话', JSON.stringify(pk));
  send({ cmd: 'type', text: '' });
  await key('ArrowLeft');
  for (let i = 0; i < 30; i++) { await sleep(150); if ((await probe()).items.length) break; }
  await key('Enter');
  send({ cmd: 'type', text: '带目标的半句' });
  await sleep(150);
  pk = await hideShow();
  check('已选发送目标 + 半句 → 再打开两者都在', pk.value === '带目标的半句' && pk.target === 'claude:H1', JSON.stringify(pk));
  await key('Escape');
  send({ cmd: 'type', text: 'CLARIFY 还没选去处' });
  send({ cmd: 'enter' });
  for (let i = 0; i < 30; i++) { await sleep(150); if ((await probe()).mode === 'choose') break; }
  pk = await hideShow();
  check('停在候选列表时关掉 → 再打开回到输入且原句还在', pk.mode === 'input' && pk.value === 'CLARIFY 还没选去处', JSON.stringify(pk));
  send({ cmd: 'type', text: 'FAIL 这句会失败' });
  send({ cmd: 'enter' });
  for (let i = 0; i < 30; i++) { await sleep(150); if ((await probe()).lastAction === 'failed') break; }
  pk = await hideShow();
  check('发送失败后再打开 → 原句放回输入框', pk.mode === 'input' && pk.value === 'FAIL 这句会失败', JSON.stringify(pk));
  send({ cmd: 'type', text: '成功送达的一句' });
  send({ cmd: 'enter' });
  for (let i = 0; i < 30; i++) { await sleep(150); if ((await probe()).lastAction === 'wrote') break; }
  pk = await hideShow();
  check('成功送达后再打开 → 清空', pk.mode === 'input' && pk.value === '' && pk.target === null, JSON.stringify(pk));
  send({ cmd: 'type', text: 'SLOW CLARIFY 慢的一句' });
  send({ cmd: 'enter' });
  await sleep(300);
  pk = await hideShow();
  check('请求还在路上时再打开 → 保持处理中，不重置', pk.inflight === true && pk.mode === 'busy', JSON.stringify(pk));
  for (let i = 0; i < 40; i++) { await sleep(150); pk = await probe(); if (pk.mode === 'choose') break; }
  check('在路上的结果回来后照常显示候选（没有丢）', pk.mode === 'choose' && pk.items.length === 3, JSON.stringify(pk));
} catch (e) {
  check('脚本异常', false, e.stack);
} finally {
  el.kill('SIGTERM');
  await sleep(500);
  console.log(`\n${pass} PASS / ${fail} FAIL   截图: ${D}`);
  process.exit(fail ? 1 : 0);
}
