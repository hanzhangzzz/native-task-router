// 入口界面验收（多行自动长高、候选上下键选择、← 历史会话、语音入口、语音唤醒弹框）。用桩 CLI，不碰 iTerm 和任何真实会话；
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
// 语音入口的口令与端口用隔离目录，不碰 ~/.ntr 和正在用的 app
const HOME = path.join(D, 'home');
const VOICE_PORT = '47698';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : '  ' + detail}`); };
const lines = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const calls = () => lines(STUB_LOG).filter((a) => a[0] === 'open');

const el = spawn(path.join(ROOT, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'), [path.join(ROOT, 'entry/main.cjs')], {
  env: { ...process.env, NTR_ENTRY_CLI: path.join(ROOT, 'scripts/fixtures/entry-stub-cli.mjs'), NTR_STUB_LOG: STUB_LOG, NTR_ENTRY_TRACE: TRACE, NTR_ENTRY_CONTROL: 'stdin', NTR_HOTKEY: 'Control+Alt+Shift+F12', NTR_HOME: HOME, NTR_VOICE_PORT: VOICE_PORT, NTR_NO_SPEAK: '1' },
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

  // ---- 5. 语音入口：127.0.0.1 POST /utterance，口令不对不路由；拿不准时不弹窗，放进输入框 ----
  send({ cmd: 'hide' });
  await sleep(300);
  const token = fs.readFileSync(path.join(HOME, 'voice-token'), 'utf8').trim();
  const post = (body, tok = token, url = '/utterance') => fetch(`http://127.0.0.1:${VOICE_PORT}${url}`, { method: 'POST', headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const n0 = calls().length;
  check('口令不对 → 401，不路由', (await post({ text: '不该送出' }, 'x'.repeat(token.length))).status === 401 && calls().length === n0);
  check('不带口令 → 401', (await fetch(`http://127.0.0.1:${VOICE_PORT}/utterance`, { method: 'POST', body: '{"text":"不该送出"}' })).status === 401 && calls().length === n0);
  check('别的路径 → 404', (await post({ text: '不该送出' }, token, '/')).status === 404 && calls().length === n0);
  const vr = await (await post({ text: '语音说的一句' })).json();
  check('语音一句 → 走路由（不带聚焦终端），返回可播报的结果', vr.action === 'wrote' && !!vr.line && JSON.stringify(calls().at(-1)) === JSON.stringify(['open', '--json', '--', '语音说的一句']), JSON.stringify({ vr, call: calls().at(-1) }));
  const shown0 = lines(TRACE).filter((e) => e.ev === 'shown').length;
  // 此刻输入框停在上一句的候选列表（没发出去）：语音这句不能拼进去
  const vb = await (await post({ text: 'CLARIFY 语音第一句' })).json();
  pk = await probe();
  check('框里有没发出去的话 → 语音这句不放进去，提示重说', vb.action === 'clarify' && vb.placed === false && vb.line.includes('再说一次') && pk.value === 'SLOW CLARIFY 慢的一句', JSON.stringify({ vb, pk }));
  await show();
  send({ cmd: 'type', text: '' });
  await sleep(200);
  send({ cmd: 'hide' });
  await sleep(300);
  const vc = await (await post({ text: 'CLARIFY 语音拿不准的一句' })).json();
  pk = await probe();
  check('框是空的 → 原句放进输入框，提示回电脑确认', vc.action === 'clarify' && vc.placed === true && vc.line.includes('输入框') && pk.mode === 'input' && pk.value === 'CLARIFY 语音拿不准的一句', JSON.stringify({ vc, pk }));
  check('语音拿不准 → 不弹出窗口', lines(TRACE).filter((e) => e.ev === 'shown').length === shown0 + 1);
  await show();
  pk = await probe();
  check('回到电脑唤起 → 那句话还在输入框', pk.mode === 'input' && pk.value === 'CLARIFY 语音拿不准的一句', JSON.stringify(pk));

  // ---- 6. 语音唤醒：与快捷键同一个输入框（模拟收音子进程的事件，不用麦克风）----
  const vev = async (ev, ms = 300) => { send({ cmd: 'voiceEvent', ev }); await sleep(ms); };
  const speaks = () => lines(TRACE).filter((e) => e.ev === 'speak').length;
  const visible = async () => { send({ cmd: 'js', tag: 'vis' + probeN, code: 'document.visibilityState' }); await sleep(300); return lines(TRACE).filter((e) => e.ev === 'js').at(-1)?.result; };
  send({ cmd: 'type', text: '' });
  send({ cmd: 'hide' });
  await sleep(400);
  let shownN = lines(TRACE).filter((e) => e.ev === 'shown').length;
  await vev({ ev: 'wake' }, 900);
  pk = await probe();
  check('唤醒 → 弹出输入框，提示在听', lines(TRACE).filter((e) => e.ev === 'shown').length === shownN + 1 && pk.mode === 'input' && pk.msg.includes('在听') && pk.voice?.auto === true, JSON.stringify(pk));
  await vev({ ev: 'partial', text: '帮我看一下' });
  check('边说边出字', (await probe()).value === '帮我看一下');
  const nv = calls().length, sp = speaks();
  await vev({ ev: 'final', text: '帮我看一下登录页的报错' });
  pk = await probe();
  check('说完 → 倒计时', pk.value === '帮我看一下登录页的报错' && pk.msg.includes('3 秒后发送') && pk.voice?.counting === true, JSON.stringify(pk));
  await sleep(3800);
  const vc1 = calls();
  check('倒计时到 → 走输入框的发送（路由）', vc1.length === nv + 1 && vc1.at(-1).at(-1) === '帮我看一下登录页的报错' && !vc1.at(-1).includes('--pick'), JSON.stringify(vc1.at(-1)));
  check('语音发送的结果读出来', speaks() === sp + 1);

  await sleep(2000); // 等送达后自动收起
  await vev({ ev: 'wake' }, 900);
  await vev({ ev: 'final', text: '第二句先别发' });
  await key('a');
  pk = await probe();
  const nk = calls().length;
  await sleep(3800);
  check('倒计时中按键 → 停下，改成手动，不自动发送', pk.voice === null && pk.msg === '' && pk.value === '第二句先别发' && calls().length === nk, JSON.stringify(pk));

  send({ cmd: 'type', text: '手打的半句' });
  await sleep(200);
  const sd = speaks();
  await vev({ ev: 'wake' }, 900);
  await vev({ ev: 'final', text: '语音这句' });
  pk = await probe();
  const nd = calls().length;
  await sleep(3800);
  check('框里有没发的话 → 语音接在后面，不自动发送，并提示', pk.value === '手打的半句\n语音这句' && pk.msg.includes('不自动发送') && calls().length === nd && speaks() === sd + 1, JSON.stringify(pk));

  send({ cmd: 'type', text: '' });
  await vev({ ev: 'wake' }, 900);
  await vev({ ev: 'timeout' });
  check('唤醒后没开口 → 提示没听到', (await probe()).msg.includes('没听到'));
  await sleep(1800);
  check('没听到且框是空的 → 自动收起', (await visible()) === 'hidden');

  await vev({ ev: 'wake' }, 900);
  await vev({ ev: 'final', text: '按 Esc 取消的一句' });
  const ne = calls().length;
  await key('Escape');
  await sleep(3800);
  check('倒计时中 Esc → 关掉，不发送', calls().length === ne && (await visible()) === 'hidden');

  // ---- 7. 修改唤醒词窗口 ----
  let jsN = 0;
  const wjs = async (code) => {
    const tag = `w${++jsN}`;
    send({ cmd: 'js', win: 'wake', tag, code });
    for (let i = 0; i < 30; i++) { const e = lines(TRACE).find((x) => x.ev === 'js' && x.tag === tag); if (e) return e.result; await sleep(100); }
    return null;
  };
  const settings = () => { try { return JSON.parse(fs.readFileSync(path.join(HOME, 'settings.json'), 'utf8')); } catch { return {}; } };
  const trySave = (w) => wjs(`(async()=>{const i=document.getElementById('word');i.value=${JSON.stringify(w)};i.dispatchEvent(new Event('input'));document.getElementById('save').click();await new Promise(r=>setTimeout(r,300));return document.getElementById('msg').textContent;})()`);
  send({ cmd: 'openWake' });
  await sleep(1000);
  check('打开 → 显示当前唤醒词（默认小卡拉米）', (await wjs(`document.getElementById('word').value`)) === '小卡拉米');
  send({ cmd: 'shot', win: 'wake', file: path.join(D, '7-wake-word.png') });
  check('两个字 → 拒绝，不保存', (await trySave('小卡'))?.includes('3～6') && settings().wakeWord === undefined);
  check('英文 → 拒绝，不保存', (await trySave('hey siri'))?.includes('3～6') && settings().wakeWord === undefined);
  check('合格 → 保存', (await trySave('小爱同学'))?.includes('已改为') && settings().wakeWord === '小爱同学', JSON.stringify(settings()));
  await sleep(1200);
  send({ cmd: 'openWake' });
  await sleep(1000);
  check('再打开 → 显示新唤醒词', (await wjs(`document.getElementById('word').value`)) === '小爱同学');
  await wjs('window.close()');
} catch (e) {
  check('脚本异常', false, e.stack);
} finally {
  el.kill('SIGTERM');
  await sleep(500);
  console.log(`\n${pass} PASS / ${fail} FAIL   截图: ${D}`);
  process.exit(fail ? 1 : 0);
}
