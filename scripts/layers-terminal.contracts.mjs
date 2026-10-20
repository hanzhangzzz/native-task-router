// Terminal Surface 与组合 Surface 离线契约：不启动 Terminal/iTerm，只测纯函数与假 Surface 上的分发。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openTerminalView, parseRows, tailLines } from '../src/layers/surfaces/terminal.ts';
import { createMulti, decodeViewId, encodeViewId, pickTarget } from '../src/layers/surfaces/multi.ts';
import { guarded } from '../src/layers/guard.ts';
import { open } from '../src/layers/open.ts';

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ' ' + detail}`); };
const throws = async (fn) => { try { await fn(); return false; } catch { return true; } };
const FS = String.fromCharCode(31), RS = String.fromCharCode(30);

// ---- 1. viewId 编解码 ----
check('encode iterm', encodeViewId('iterm', 'ABC-123') === 'iterm:ABC-123');
check('encode terminal', encodeViewId('terminal', '/dev/ttys012') === 'terminal:/dev/ttys012');
for (const [s, id] of [['iterm', 'w0t0p0:5D1C-UUID'], ['terminal', '/dev/ttys012'], ['iterm', 'a:b:c']]) {
  const d = decodeViewId(encodeViewId(s, id));
  check(`decode 往返 ${s}:${id}（id 里的冒号原样保留）`, d.surface === s && d.id === id, JSON.stringify(d));
}
for (const bad of ['ABC-123', 'ghostty:/dev/ttys1', ':x', 'iterm:', '', 'Terminal:/dev/ttys1']) {
  check(`decode 拒绝 ${JSON.stringify(bad)}`, await throws(() => decodeViewId(bad)));
}

// ---- 2. openView 目标选择：全部分支 ----
const R = (iterm, terminal) => ({ iterm, terminal });
const cases = [
  ['NTR_TERMINAL=terminal 压过前台 iTerm', { env: 'terminal', focusedOwner: 'iterm', running: R(true, true), itermInstalled: true }, 'terminal'],
  ['NTR_TERMINAL=iterm 压过前台 Terminal', { env: 'iterm', focusedOwner: 'terminal', running: R(false, true), itermInstalled: true }, 'iterm'],
  ['NTR_TERMINAL 为空串视为未设置', { env: '', focusedOwner: 'terminal', running: R(true, true), itermInstalled: true }, 'terminal'],
  ['前台是 Terminal 会话 → Terminal（即使 iTerm 也在跑）', { focusedOwner: 'terminal', running: R(true, true), itermInstalled: true }, 'terminal'],
  ['前台是 iTerm 会话 → iTerm', { focusedOwner: 'iterm', running: R(true, true), itermInstalled: true }, 'iterm'],
  ['无前台、两个都在跑 → iTerm', { focusedOwner: null, running: R(true, true), itermInstalled: true }, 'iterm'],
  ['无前台、只有 Terminal 在跑 → Terminal', { focusedOwner: null, running: R(false, true), itermInstalled: true }, 'terminal'],
  ['无前台、只有 iTerm 在跑 → iTerm', { focusedOwner: null, running: R(true, false), itermInstalled: true }, 'iterm'],
  ['都没跑、装了 iTerm → iTerm', { focusedOwner: null, running: R(false, false), itermInstalled: true }, 'iterm'],
  ['都没跑、没装 iTerm → Terminal', { focusedOwner: null, running: R(false, false), itermInstalled: false }, 'terminal'],
];
for (const [name, f, want] of cases) check(`pickTarget: ${name}`, pickTarget(f) === want, pickTarget(f));
check('pickTarget: NTR_TERMINAL 非法值报错（不静默猜）', await throws(() => pickTarget({ env: 'ghostty', focusedOwner: null, running: R(true, true), itermInstalled: true })));

// ---- 3. Terminal 输出解析与截尾 ----
const rows = parseRows(`/dev/ttys010${FS}user@host${RS}\n/dev/ttys011${FS}a${FS}b${RS}${FS}no-tty${RS}`);
check('parseRows: 每个 tab 一行，viewId=tty', rows.length === 2 && rows[0].viewId === '/dev/ttys010' && rows[0].tty === '/dev/ttys010' && rows[0].surface === 'terminal', JSON.stringify(rows));
check('parseRows: 标题里含分隔符时原样拼回', rows[1].title === `a${FS}b`);
check('parseRows: 没有 tty 的 tab 不列出', rows.every((r) => r.tty));
check('parseRows: 空输出 → []', parseRows('').length === 0);
const screen = 'l1\nl2\nl3 marker\n   \n\n\n';
check('tailLines: 去掉尾部空行后取末尾 N 行', tailLines(screen, 2) === 'l2\nl3 marker', JSON.stringify(tailLines(screen, 2)));
check('tailLines: N 大于行数时返回全部', tailLines(screen, 99) === 'l1\nl2\nl3 marker');
check('tailLines: 全空屏 → 空串', tailLines('\n\n  \n', 5) === '');

// ---- 4. 静态：terminal.ts 的 AppleScript 只插入常量片段 FIND ----
const src = fs.readFileSync(new URL('../src/layers/surfaces/terminal.ts', import.meta.url), 'utf8');
const scripts = [...src.matchAll(/osa\(`([\s\S]*?)`/g)].map((m) => m[1]);
const interp = scripts.flatMap((s) => [...s.matchAll(/\$\{([^}]*)\}/g)].map((m) => m[1]));
check(`terminal.ts 脚本源码仅插入 FIND (${scripts.length} 个脚本, 插值 ${JSON.stringify(interp)})`, scripts.length >= 5 && interp.every((x) => x === 'FIND'));
const allScripts = [...scripts, ...[...src.matchAll(/osa\('([^']*)'/g)].map((m) => m[1])];
const activating = allScripts.filter((s) => /\bactivate\b/.test(s));
check('terminal.ts 只有两处脚本 activate：focus 末尾与 openView 冷启动分支', activating.length === 2 && activating.every((a) => a.trim() === 'tell application "Terminal" to activate') && /async focus\(viewId\) \{\n\s+await selectView\(viewId\);\n\s+await osa\('tell application "Terminal" to activate'\);/.test(src) && /if \(cold\) await deps\.osa\('tell application "Terminal" to activate'\);/.test(src), JSON.stringify(activating));

// ---- 4b. openView 冷/热两个分支的脚本序列（假 osa，不碰真实 Terminal）----
{
  const seq = async (running) => {
    const scripts = [];
    const v = await openTerminalView('/work/proj', ['claude', 'x'], { running: async () => running, osa: async (sc, args) => { scripts.push(sc.trim().startsWith('on run') ? 'do script' : sc); return sc.includes('do script') ? `/dev/ttys042${FS}t` : ''; } });
    return { v, scripts };
  };
  const cold = await seq(false);
  check('openView 冷启动：launch → do script → activate（与 iTerm 冷启动一致，切到前台）', JSON.stringify(cold.scripts) === JSON.stringify(['tell application "Terminal" to launch', 'do script', 'tell application "Terminal" to activate']) && cold.v.tty === '/dev/ttys042', JSON.stringify(cold.scripts));
  const warm = await seq(true);
  check('openView 已在运行：只 do script，不 launch、不 activate（不抢焦点）', JSON.stringify(warm.scripts) === JSON.stringify(['do script']), JSON.stringify(warm.scripts));
}

// ---- 5. 组合 Surface：合并、分发、目标选择、单边失败 ----
function fakeSurface(id, views, { failList = false } = {}) {
  const calls = { focus: [], write: [], tail: [], open: [] };
  return {
    calls,
    s: {
      listViews: async () => { if (failList) throw new Error(`${id} -1743`); return views.map((v) => ({ surface: id, title: '', ...v })); },
      focus: async (v) => void calls.focus.push(v),
      write: async (v, t) => void calls.write.push({ v, t }),
      screenTail: async (v, n) => (calls.tail.push({ v, n }), `${id}-tail`),
      openView: async (cwd, argv, o) => (calls.open.push({ cwd, argv, o }), { surface: id, viewId: id === 'iterm' ? 'NEW-SESSION' : '/dev/ttys099', tty: '/dev/ttys099', title: '' }),
    },
  };
}
function multi({ itermViews = [], termViews = [], running = R(true, true), installed = true, focusedTty = null, env, itermFails = false, termFails = false } = {}) {
  const it = fakeSurface('iterm', itermViews, { failList: itermFails });
  const te = fakeSurface('terminal', termViews, { failList: termFails });
  const m = createMulti({ surfaces: { iterm: it.s, terminal: te.s }, running: async (s) => running[s], itermInstalled: () => installed, focusedTty, env });
  return { m, it: it.calls, te: te.calls };
}
{
  const { m, it, te } = multi({ itermViews: [{ viewId: 'S1', tty: '/dev/ttys001' }], termViews: [{ viewId: '/dev/ttys002', tty: '/dev/ttys002' }] });
  const vs = await m.listViews();
  check('multi.listViews 合并两边并加前缀', JSON.stringify(vs.map((v) => [v.surface, v.viewId, v.tty])) === JSON.stringify([['iterm', 'iterm:S1', '/dev/ttys001'], ['terminal', 'terminal:/dev/ttys002', '/dev/ttys002']]), JSON.stringify(vs));
  await m.write('terminal:/dev/ttys002', 'hello');
  await m.focus('iterm:S1');
  const tail = await m.screenTail('terminal:/dev/ttys002', 7);
  check('multi.write 按前缀分发，去前缀后交给 Terminal', te.write.length === 1 && te.write[0].v === '/dev/ttys002' && te.write[0].t === 'hello' && it.write.length === 0);
  check('multi.focus 按前缀分发给 iTerm', it.focus.length === 1 && it.focus[0] === 'S1' && te.focus.length === 0);
  check('multi.screenTail 按前缀分发并透传行数', tail === 'terminal-tail' && te.tail[0].v === '/dev/ttys002' && te.tail[0].n === 7);
  check('multi.write 无前缀/未知前缀报错，不落到任何终端', (await throws(() => m.write('S1', 'x'))) && (await throws(() => m.write('kitty:1', 'x'))) && it.write.length === 0 && te.write.length === 1);
}
{
  const { m, it, te } = multi({ termViews: [{ viewId: '/dev/ttys002', tty: '/dev/ttys002' }], itermFails: true });
  const vs = await m.listViews();
  check('multi.listViews: 一边报错（如未授权）时另一边照常列出', vs.length === 1 && vs[0].viewId === 'terminal:/dev/ttys002', JSON.stringify(vs));
  void it; void te;
}
{
  const { m, it, te } = multi({ itermViews: [{ viewId: 'S1', tty: '/dev/ttys001' }], termViews: [{ viewId: '/dev/ttys002', tty: '/dev/ttys002' }], focusedTty: '/dev/ttys002' });
  const v = await m.openView('/tmp/p', ['claude', 'hi']);
  check('multi.openView: 前台 tty 属于 Terminal → 开在 Terminal，返回带前缀 viewId', te.open.length === 1 && it.open.length === 0 && v.viewId === 'terminal:/dev/ttys099' && te.open[0].cwd === '/tmp/p' && JSON.stringify(te.open[0].argv) === '["claude","hi"]', JSON.stringify(v));
}
{
  const { m, it, te } = multi({ termViews: [{ viewId: '/dev/ttys002', tty: '/dev/ttys002' }], focusedTty: '/dev/ttys002' });
  const v = await m.openView('/tmp/p', ['claude'], { windowId: 42 });
  check('multi.openView: 给了 windowId（测试隔离）→ 固定 iTerm 并透传 windowId', it.open.length === 1 && it.open[0].o.windowId === 42 && te.open.length === 0 && v.viewId === 'iterm:NEW-SESSION');
}
{
  const { m, it, te } = multi({ focusedTty: '/dev/ttys777', running: R(false, true) });
  await m.openView('/tmp/p', ['claude']);
  check('multi.openView: 前台 tty 不在任何终端 → 按运行状态（只有 Terminal 在跑）', te.open.length === 1 && it.open.length === 0);
}
{
  const { m, it, te } = multi({ env: 'terminal', running: R(true, false) });
  await m.openView('/tmp/p', ['claude']);
  check('multi.openView: NTR_TERMINAL=terminal 时即使 Terminal 没在跑也开在 Terminal', te.open.length === 1 && it.open.length === 0);
}
{
  const { m, it, te } = multi({ env: 'nope' });
  check('multi.openView: NTR_TERMINAL 非法 → 报错，不开任何视图', (await throws(() => m.openView('/tmp/p', ['claude']))) && it.open.length === 0 && te.open.length === 0);
}

// ---- 6. guard 名单：带前缀与裸 id 都认 ----
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ntr-term-guard-'));
  const file = path.join(dir, 'guard.json');
  fs.writeFileSync(file, JSON.stringify({ views: ['S1', 'terminal:/dev/ttys002'], sessions: [] }));
  const { m, it, te } = multi();
  const g = guarded(m, async () => {}, file);
  await g.surface.write('iterm:S1', 'a');
  await g.surface.write('terminal:/dev/ttys002', 'b');
  check('guard: 名单写裸 iTerm id 时放行 iterm:<id>', it.write.length === 1 && it.write[0].v === 'S1');
  check('guard: 名单写带前缀 id 时放行', te.write.length === 1 && te.write[0].v === '/dev/ttys002');
  check('guard: 名单外的视图被拒', (await throws(() => g.surface.write('iterm:S2', 'x'))) && (await throws(() => g.surface.write('terminal:/dev/ttys003', 'x'))) && it.write.length === 1 && te.write.length === 1);
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---- 7. 经 open()：存活在 Terminal 的会话被写进那个 Terminal tab ----
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ntr-term-open-'));
  const card = { provider: 'claude', sessionId: 'S1', cwd: dir, title: null, firstPrompt: 'x', recentPrompts: [], lastReply: null, startedAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', turns: 1 };
  const prov = (id) => ({ id, listSessions: async () => (id === 'claude' ? [card] : []), liveSessions: async () => (id === 'claude' ? [{ provider: 'claude', sessionId: 'S1', pid: 1, tty: '/dev/ttys002', state: 'idle' }] : []), resumeArgv: (s, p) => [id, '-r', s, p], newArgv: (p) => [id, p] });
  const { m, it, te } = multi({ itermViews: [{ viewId: 'S9', tty: '/dev/ttys001' }], termViews: [{ viewId: '/dev/ttys002', tty: '/dev/ttys002' }] });
  const text = '修一下 "引号" $HOME\n第二行 😀';
  const r = await open(text, { router: { route: async () => { throw new Error('不该路由'); } }, providers: [prov('claude'), prov('codex')], surface: m, pick: { provider: 'claude', sessionId: 'S1' }, logPath: path.join(dir, 'log.jsonl'), settleMs: 0, clipboard: async () => {} });
  check('open → wrote，viewId 为 terminal:<tty>', r.action === 'wrote' && r.viewId === 'terminal:/dev/ttys002', JSON.stringify(r));
  check('open: 正文原样写进 Terminal tab、iTerm 未被写', te.write.length === 1 && te.write[0].v === '/dev/ttys002' && te.write[0].t === text && it.write.length === 0);
  check('open: 写入前读了 Terminal 屏幕核对', te.tail.length >= 1 && te.tail[0].v === '/dev/ttys002');
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\nPASS ${pass} / FAIL ${fail}`);
process.exit(fail ? 1 : 0);
