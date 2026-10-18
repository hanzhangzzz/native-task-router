// open() 编排离线契约（TE-5）：假 Router / Provider / Surface，不碰 iTerm、原生 CLI 和模型。
// 重点断言三条不变量：核对不通过绝不 write；存活会话绝不二开；没送达的输入不丢。
// 用法：node scripts/layers-open.contracts.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-open-'));
process.env.JEV_HOME = path.join(root, 'jev');
const { open, approvalPrompt, pendingDraft, shortName, readPrevious, readHistory } = await import('../src/layers/open.ts');
const { interimRouter, recall, MAX_CANDIDATES } = await import('../src/layers/router/interim.ts');

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) pass += 1;
  else fail += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : '  ' + detail}`);
};

// ---- 真实 TUI 观察到的屏幕（2026-10-13，Claude Code 2.1.288 / codex-cli 0.162.1）----
const CLAUDE_IDLE = `
❯ 上一条已经完成的输入
⏺ 好的。

────────────────────────────────────────────────────────────────────────────────
❯
────────────────────────────────────────────────────────────────────────────────
  [Haiku 4.5] | 0/200.0k | 0s[api:0m] | cache:0%
  ~/x/obs-claude
  ⏸ manual mode on`;
const CLAUDE_DRAFT = CLAUDE_IDLE.replace('\n❯\n', '\n❯ my draft line\n');
const CLAUDE_APPROVAL = `
⏺ Creating approval-probe.txt file
  ⎿  $ touch approval-probe.txt

────────────────────────────────────────────────────────────────────────────────
 Bash command
 touch approval-probe.txt
 Do you want to proceed?
 ❯ 1. Yes
   2. Yes, and always allow access to /x from this project
   3. No

 Esc to cancel · Tab to amend`;
const CODEX_IDLE = `
• PONG

  Worked for 2s • 10:02

› Ask Codex to do anything

  GPT-6.1-Sol medium fast · task/mvp-te5-open · Context 97% left
  ? for shortcuts                                     ⚠ 3 warnings · f2 to view`;
const CODEX_DRAFT = CODEX_IDLE.replace('Ask Codex to do anything', 'my draft line');
const CODEX_APPROVAL = `
• Running touch approval-probe.txt

  Would you like to run the following command?

  $ touch approval-probe.txt

› 1. Yes, proceed (y)
  2. Yes, and don't ask again for commands that start with \`touch approval-probe.txt\` (p)
  3. No, and tell Codex what to do differently (esc)

  Press enter to confirm or esc to cancel`;

check('屏幕: Claude 空闲无拦截', approvalPrompt(CLAUDE_IDLE) === null && pendingDraft(CLAUDE_IDLE) === null);
check('屏幕: Codex 空闲(占位提示)无拦截', approvalPrompt(CODEX_IDLE) === null && pendingDraft(CODEX_IDLE) === null);
check('屏幕: Claude 审批框被识别', approvalPrompt(CLAUDE_APPROVAL) !== null);
check('屏幕: Codex 审批框被识别', approvalPrompt(CODEX_APPROVAL) !== null);
check('屏幕: Claude 草稿被识别', pendingDraft(CLAUDE_DRAFT) !== null);
check('屏幕: Codex 草稿被识别', pendingDraft(CODEX_DRAFT) !== null);
check('屏幕: 仅编号选项也被拦(无关键词的菜单)', approvalPrompt('Select model\n❯ 1. Opus\n  2. Haiku') !== null);
check('shortName', shortName('帮我 看看 "foo/bar" 的 CI!!') === '帮我-看看-foo-bar-的-CI' && shortName('???') === 'task');

// ---- 假实现 ----
const card = (provider, sessionId, cwd, extra = {}) => ({
  provider, sessionId, cwd, title: null, firstPrompt: `first ${sessionId}`, recentPrompts: [`recent ${sessionId}`], lastReply: null,
  startedAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-10T00:00:00Z', turns: 3, ...extra,
});

/** liveSeq: 每次 liveSessions 调用依次返回的列表（最后一个重复使用），用于模拟"路由之后映射变了" */
function world({ cards = [], liveSeq = [[]], views = [], tails = {}, queueFails = false, writeFails = false, clipFails = false } = {}) {
  const calls = { write: [], focus: [], openView: [], queue: [], clip: [], liveCalls: 0, viewsCalls: 0 };
  const mkProvider = (id) => ({
    id,
    listSessions: async () => cards.filter((c) => c.provider === id),
    liveSessions: async () => {
      if (id === 'claude') calls.liveCalls += 1;
      const l = liveSeq[Math.min(calls.liveCalls - 1, liveSeq.length - 1)];
      return l.filter((x) => x.provider === id);
    },
    resumeArgv: (s, p) => (id === 'claude' ? ['claude', '-r', s, p] : ['codex', 'resume', s, p]),
    newArgv: (p) => [id, p],
  });
  const surface = {
    id: 'iterm',
    listViews: async () => ((calls.viewsCalls += 1), views),
    focus: async (v) => void calls.focus.push(v),
    openView: async (cwd, argv, o) => {
      calls.openView.push({ cwd, argv, o });
      return { surface: 'iterm', viewId: 'NEWVIEW', tty: null, title: '' };
    },
    write: async (v, t) => {
      if (writeFails) throw new Error('boom');
      calls.write.push({ v, t });
    },
    screenTail: async (v) => tails[v] ?? CLAUDE_IDLE,
  };
  const opts = {
    providers: [mkProvider('claude'), mkProvider('codex')],
    surface,
    logPath: path.join(root, `log-${Math.random().toString(36).slice(2)}.jsonl`),
    tasksRoot: path.join(root, 'JevTasks'),
    settleMs: 0,
    clipboard: async (t) => {
      if (clipFails) throw new Error('nopbcopy');
      calls.clip.push(t);
    },
    queue: {
      codex: async (s, t) => {
        if (queueFails) throw new Error('queue-boom');
        calls.queue.push({ s, t });
      },
    },
  };
  return { calls, opts };
}
const route = (decision) => ({ route: async () => ({ ...decision, latencyMs: 1, costUsd: null, model: 'fake' }) });
const cont = (provider, sessionId) => route({ kind: 'continue', provider, sessionId, confidence: 0.95, reason: 'x' });
const live = (provider, sessionId, tty, state = 'idle', pid = 100) => ({ provider, sessionId, pid, tty, state });
const view = (viewId, tty) => ({ surface: 'iterm', viewId, tty, title: '' });
const TEXT = '修一下 "引号" $HOME\n第二行 😀';

// ---- 1. 存活 + 空闲 + 干净 → write 一次再 focus ----
{
  const w = world({ cards: [card('claude', 'S1', root)], liveSeq: [[live('claude', 'S1', '/dev/ttys1')]], views: [view('V1', '/dev/ttys1')] });
  const r = await open(TEXT, { ...w.opts, router: cont('claude', 'S1') });
  check('S1 存活空闲 → wrote', r.action === 'wrote' && r.viewId === 'V1' && r.sessionId === 'S1', JSON.stringify(r));
  check('S1 write 恰一次且正文原样、随后 focus', w.calls.write.length === 1 && w.calls.write[0].t === TEXT && w.calls.focus.join() === 'V1');
  check('S1 不二开', w.calls.openView.length === 0);
  check('S1 写入前重新取了存活映射(≥2 次)与视图列表(≥2 次)', w.calls.liveCalls >= 3 && w.calls.viewsCalls >= 2, `${w.calls.liveCalls}/${w.calls.viewsCalls}`);
}

// ---- 2. 核对不通过绝不 write ----
const refusal = async (name, wopts, expectAction = 'focused-only', pickId = 'S1') => {
  const w = world(wopts);
  const r = await open(TEXT, { ...w.opts, router: cont('claude', pickId) });
  check(`${name} → ${expectAction}`, r.action === expectAction, JSON.stringify(r));
  check(`${name}: 绝不 write、绝不二开`, w.calls.write.length === 0 && w.calls.openView.length === 0 && w.calls.queue.length === 0);
  check(`${name}: 正文在剪贴板`, w.calls.clip.length === 1 && w.calls.clip[0] === TEXT);
  return { r, w };
};
const base = { cards: [card('claude', 'S1', root)], views: [view('V1', '/dev/ttys1')] };
{
  const { w } = await refusal('S7 状态 busy', { ...base, liveSeq: [[live('claude', 'S1', '/dev/ttys1', 'busy')]] });
  check('S7 busy 仍聚焦', w.calls.focus.join() === 'V1');
}
await refusal('S7 状态 waiting', { ...base, liveSeq: [[live('claude', 'S1', '/dev/ttys1', 'waiting')]] });
await refusal('S7 状态 unknown', { ...base, liveSeq: [[live('claude', 'S1', '/dev/ttys1', 'unknown')]] });
await refusal('S7 状态 idle 但屏幕是 Claude 审批框', { ...base, liveSeq: [[live('claude', 'S1', '/dev/ttys1')]], tails: { V1: CLAUDE_APPROVAL } });
await refusal('草稿', { ...base, liveSeq: [[live('claude', 'S1', '/dev/ttys1')]], tails: { V1: CLAUDE_DRAFT } });
await refusal('写入前映射变化(同 tty 换了会话)', { ...base, liveSeq: [[live('claude', 'S1', '/dev/ttys1')], [live('claude', 'S1', '/dev/ttys1')], [live('claude', 'OTHER', '/dev/ttys1')]] });
await refusal('同 tty 上另有一个存活会话', { ...base, liveSeq: [[live('claude', 'S1', '/dev/ttys1', 'idle', 100), live('codex', 'C9', '/dev/ttys1', 'idle', 101)]] });
{
  // 视图在核对期间消失/变化：第二次 listViews 返回另一个 viewId
  const w = world({ ...base, liveSeq: [[live('claude', 'S1', '/dev/ttys1')]] });
  let n = 0;
  w.opts.surface.listViews = async () => (++n === 1 ? [view('V1', '/dev/ttys1')] : [view('V2', '/dev/ttys1')]);
  const r = await open(TEXT, { ...w.opts, router: cont('claude', 'S1') });
  check('写入前视图变化 → 不 write', w.calls.write.length === 0 && r.action === 'focused-only', JSON.stringify(r));
}

// ---- 3. 存活但不在 iTerm / 无终端 / 多进程：失败 + 剪贴板，绝不二开 ----
await refusal('存活但不在任何 iTerm 视图', { cards: [card('claude', 'S1', root)], liveSeq: [[live('claude', 'S1', '/dev/ttys9')]], views: [view('V1', '/dev/ttys1')] }, 'failed');
await refusal('存活但无终端(后台)', { ...base, liveSeq: [[live('claude', 'S1', null)]] }, 'failed');
await refusal('两个进程持有同一会话', { ...base, liveSeq: [[live('claude', 'S1', '/dev/ttys1', 'idle', 1), live('claude', 'S1', '/dev/ttys2', 'idle', 2)]] }, 'failed');
await refusal('一个 tty 对应两个视图', { ...base, views: [view('V1', '/dev/ttys1'), view('V1b', '/dev/ttys1')], liveSeq: [[live('claude', 'S1', '/dev/ttys1')]] }, 'failed');

// ---- 4. 冷会话：新 tab 里 resumeArgv，恰一次，不 write ----
{
  const cwd = fs.mkdtempSync(path.join(root, 'proj-'));
  const w = world({ cards: [card('claude', 'S2', cwd), card('codex', 'C2', cwd)] });
  const r = await open(TEXT, { ...w.opts, windowId: 77, router: cont('claude', 'S2') });
  check('S2 冷 Claude → opened', r.action === 'opened' && r.cwd === cwd && r.sessionId === 'S2', JSON.stringify(r));
  check('S2 openView(cwd, resumeArgv(id,正文), windowId) 恰一次且无 write',
    w.calls.openView.length === 1 && w.calls.openView[0].cwd === cwd && JSON.stringify(w.calls.openView[0].argv) === JSON.stringify(['claude', '-r', 'S2', TEXT]) && w.calls.openView[0].o.windowId === 77 && w.calls.write.length === 0);
  const w2 = world({ cards: [card('codex', 'C2', cwd)] });
  const r2 = await open(TEXT, { ...w2.opts, router: cont('codex', 'C2') });
  check('S3 冷 Codex → codex resume', r2.action === 'opened' && JSON.stringify(w2.calls.openView[0].argv) === JSON.stringify(['codex', 'resume', 'C2', TEXT]));
  const w3 = world({ cards: [card('claude', 'S3', path.join(root, 'gone'))] });
  const r3 = await open(TEXT, { ...w3.opts, router: cont('claude', 'S3') });
  // 不预先 stat 目录（避免 macOS 文件夹授权）：照常开视图，`cd <目录> && …` 失败时 claude 不启动，正文在命令里
  check('会话目录不预检 → 照常 openView(原 cwd)，不碰文件系统', r3.action === 'opened' && w3.calls.openView.length === 1 && w3.calls.openView[0].cwd === path.join(root, 'gone'));
  const w4 = world({});
  const r4 = await open(TEXT, { ...w4.opts, router: cont('claude', 'NOPE') });
  check('找不到会话 → failed + 剪贴板', r4.action === 'failed' && w4.calls.openView.length === 0 && w4.calls.clip[0] === TEXT);
}

// ---- 5. new ----
{
  const w = world({});
  const r = await open('帮我整理发票', { ...w.opts, router: route({ kind: 'new', provider: 'claude', cwd: null, confidence: null, reason: 'x' }) });
  check('S5 new 无 cwd → 建 JevTasks/<短名>-<4位>', r.action === 'opened' && new RegExp(`^${path.join(root, 'JevTasks').replaceAll('/', '\\/')}\\/帮我整理发票-\\d{4}$`).test(r.cwd) && fs.statSync(r.cwd).isDirectory(), JSON.stringify(r));
  check('S5 argv=newArgv(正文)', JSON.stringify(w.calls.openView[0].argv) === JSON.stringify(['claude', '帮我整理发票']));
  const proj = fs.mkdtempSync(path.join(root, 'proj-'));
  const w2 = world({});
  const r2 = await open('x', { ...w2.opts, router: route({ kind: 'new', provider: 'codex', cwd: proj, confidence: null, reason: 'x' }) });
  check('S4 new 给定 cwd → 原样使用', r2.action === 'opened' && r2.cwd === proj && w2.calls.openView[0].cwd === proj && w2.calls.openView[0].argv[0] === 'codex');
  const w3 = world({});
  const r3 = await open('x', { ...w3.opts, router: { route: async () => { throw new Error('不应路由'); } }, forceNew: { provider: 'codex' } });
  check('forceNew 跳过路由', r3.action === 'opened' && r3.cwd.startsWith(path.join(root, 'JevTasks')));
}

// ---- 入口历史（← 展开） ----
{
  const f = path.join(root, 'hist.jsonl');
  const L = (ts, input, outcome) => JSON.stringify({ ts, input, decision: {}, outcome });
  fs.writeFileSync(f, [
    L(1, 'a1', { action: 'wrote', viewId: 'V', provider: 'claude', sessionId: 'A' }),
    L(2, 'b1', { action: 'opened', viewId: 'V', provider: 'codex', sessionId: 'B', cwd: '/x' }),
    L(3, 'new-no-id', { action: 'opened', viewId: 'V', provider: 'claude', sessionId: null, cwd: '/y' }),
    L(4, 'clar', { action: 'clarify', options: [{ provider: 'claude', sessionId: 'C', probability: 0.5 }] }),
    '{broken',
    L(5, 'a2', { action: 'focused-only', viewId: 'V', provider: 'claude', sessionId: 'A', why: 'busy' }),
    L(6, 'fail', { action: 'failed', why: 'x' }),
  ].join('\n') + '\n');
  const h = readHistory(f);
  check('历史：按会话去重、新的在前、带最近一句', JSON.stringify(h.map((x) => [x.sessionId, x.lastInput])) === JSON.stringify([['A', 'a2'], ['B', 'b1']]), JSON.stringify(h));
  check('历史：跳过无会话 id / clarify / failed / 坏行', !h.some((x) => x.sessionId === 'C' || x.lastInput === 'new-no-id'));
  check('历史：limit 生效', readHistory(f, 1).length === 1);
  check('历史：文件不存在 → 空', readHistory(path.join(root, 'nope.jsonl')).length === 0);
}

// ---- 6. clarify / pick ----
{
  const opts = [{ provider: 'claude', sessionId: 'A', probability: 0.5 }, { provider: 'codex', sessionId: 'B', probability: 0.4 }];
  const w = world({ liveSeq: [[live('claude', 'A', '/dev/ttys1')]], views: [view('V1', '/dev/ttys1')] });
  const r = await open(TEXT, { ...w.opts, router: route({ kind: 'clarify', options: opts, reason: 'x' }) });
  check('S6 clarify 原样返回候选且无副作用', r.action === 'clarify' && JSON.stringify(r.options) === JSON.stringify(opts) && w.calls.write.length + w.calls.openView.length + w.calls.focus.length + w.calls.queue.length === 0);
  const rs = await open(TEXT, { ...w.opts, router: route({ kind: 'clarify', options: opts, reason: '置信度低于阈值', ranked: [{ kind: 'new', provider: 'codex', cwd: root, probability: 0.7 }, { kind: 'session', ...opts[0] }] }) });
  check('clarify 透传原因；Router 首选新建时给出 suggestNew（入口预选新建）', rs.action === 'clarify' && rs.reason === '置信度低于阈值' && rs.suggestNew?.provider === 'codex' && rs.suggestNew?.cwd === root);
  const rt = await open(TEXT, { ...w.opts, router: route({ kind: 'clarify', options: opts, reason: 'x', ranked: [{ kind: 'session', ...opts[0] }] }) });
  check('Router 首选是会话时 suggestNew 为 null（入口预选第 1 个会话）', rt.action === 'clarify' && rt.suggestNew === null);
  const w2 = world({ cards: [card('claude', 'A', root)], liveSeq: [[live('claude', 'A', '/dev/ttys1')]], views: [view('V1', '/dev/ttys1')] });
  const r2 = await open(TEXT, { ...w2.opts, router: { route: async () => { throw new Error('不应路由'); } }, pick: { provider: 'claude', sessionId: 'A' } });
  check('S6 pick 跳过路由并送达所选', r2.action === 'wrote' && w2.calls.write[0].v === 'V1');
}

// ---- 7. Codex queue 通道 ----
{
  const c = world({ cards: [card('codex', 'C1', root)], liveSeq: [[live('codex', 'C1', '/dev/ttys5')]], views: [view('VC', '/dev/ttys5')], tails: { VC: CODEX_DRAFT } });
  const r = await open(TEXT, { ...c.opts, router: route({ kind: 'continue', provider: 'codex', sessionId: 'C1', confidence: 1, reason: 'x' }) });
  check('Codex 空闲 → queue(线程,正文)，不按键，草稿不影响', r.action === 'wrote' && c.calls.queue.length === 1 && c.calls.queue[0].s === 'C1' && c.calls.queue[0].t === TEXT && c.calls.write.length === 0);
  const b = world({ cards: [card('codex', 'C1', root)], liveSeq: [[live('codex', 'C1', '/dev/ttys5', 'busy')]], views: [view('VC', '/dev/ttys5')], tails: { VC: CODEX_APPROVAL } });
  const rb = await open(TEXT, { ...b.opts, router: route({ kind: 'continue', provider: 'codex', sessionId: 'C1', confidence: 1, reason: 'x' }) });
  check('Codex 忙/审批 → 不 queue(排队消息会随取消丢失)、不 write，只聚焦', rb.action === 'focused-only' && b.calls.queue.length + b.calls.write.length === 0 && b.calls.clip[0] === TEXT);
  const f = world({ cards: [card('codex', 'C1', root)], liveSeq: [[live('codex', 'C1', '/dev/ttys5')]], views: [view('VC', '/dev/ttys5')], queueFails: true });
  const rf = await open(TEXT, { ...f.opts, router: route({ kind: 'continue', provider: 'codex', sessionId: 'C1', confidence: 1, reason: 'x' }) });
  check('queue 失败 → failed + 剪贴板，不退回按键', rf.action === 'failed' && f.calls.write.length === 0 && f.calls.clip[0] === TEXT);
}

// ---- 8. 失败不丢输入 ----
{
  const w = world({ ...base, liveSeq: [[live('claude', 'S1', '/dev/ttys1')]], writeFails: true });
  const r = await open(TEXT, { ...w.opts, router: cont('claude', 'S1') });
  check('write 抛错 → failed + 剪贴板', r.action === 'failed' && w.calls.clip[0] === TEXT);
  const w2 = world({ ...base, liveSeq: [[live('claude', 'S1', '/dev/ttys1', 'busy')]], clipFails: true });
  const r2 = await open(TEXT, { ...w2.opts, router: cont('claude', 'S1') });
  check('剪贴板也失败 → 原因明说，仍不 write', r2.action === 'focused-only' && /剪贴板失败/.test(r2.why) && w2.calls.write.length === 0);
  const w3 = world({});
  const r3 = await open(TEXT, { ...w3.opts, router: { route: async () => { throw new Error('router down'); } } });
  check('Router 抛错 → failed + 剪贴板', r3.action === 'failed' && w3.calls.clip[0] === TEXT);
}

// ---- 9. 入口记录与"上一句"语境 ----
{
  const w = world({ cards: [card('claude', 'S1', root)], liveSeq: [[live('claude', 'S1', '/dev/ttys1')]], views: [view('V1', '/dev/ttys1')] });
  let seen = null;
  const spy = { route: async (_t, ctx) => ((seen = ctx), { kind: 'continue', provider: 'claude', sessionId: 'S1', confidence: 1, reason: 'x', latencyMs: 1, costUsd: null, model: null }) };
  await open('第一句', { ...w.opts, router: spy });
  check('首次 open 无 previous', seen.previous === null);
  await open('第二句', { ...w.opts, router: spy, focusedTty: '/dev/ttys1' });
  check('第二次 open 带上一句及去处', seen.previous?.utterance === '第一句' && seen.previous.sessionId === 'S1' && seen.previous.provider === 'claude');
  check('focusedTty → focusedSessionId', seen.focusedSessionId === 'S1');
  const lines = fs.readFileSync(w.opts.logPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  check('记录: 每次 open 一行，含输入/决策/动作', lines.length === 2 && lines[0].input === '第一句' && lines[0].decision.kind === 'continue' && lines[0].outcome.action === 'wrote');
  check('readPrevious 容忍缺失文件', readPrevious(path.join(root, 'nope'), Date.now()) === null);
}

// ---- 10. 过渡 Router ----
{
  const mk = (n) => card('claude', `S${n}`, `/p/proj${n}`, { updatedAt: `2026-10-${String(10 + (n % 15)).padStart(2, '0')}T00:00:00Z`, firstPrompt: n === 7 ? '分析发票税率问题' : `topic ${n}` });
  const cards = Array.from({ length: 40 }, (_, i) => mk(i));
  const liveForced = [live('claude', 'S3', '/dev/ttys1'), live('claude', 'S30', '/dev/ttys2')];
  const got = recall('税率发票', { cards, live: liveForced, previous: { utterance: 'x', provider: 'claude', sessionId: 'S31', minutesAgo: 1 } });
  const ids = got.map((c) => c.sessionId);
  check('recall: ≤12，含词面命中、存活会话与上一句去处', got.length <= MAX_CANDIDATES && ids.includes('S7') && ids.includes('S3') && ids.includes('S30') && ids.includes('S31'), ids.join());

  const realFetch = globalThis.fetch;
  let fetched = 0;
  delete process.env.openrouter_api_key;
  delete process.env.JEV_ROUTER_API_KEY;
  globalThis.fetch = async () => { fetched += 1; throw new Error('不应发请求'); };
  const ctx = { cards, live: [], previous: null };
  const noKey = await interimRouter.route('税率发票', ctx);
  check('无 key → clarify，不发请求，原因点明缺 key，不含 key 字样值', noKey.kind === 'clarify' && fetched === 0 && /openrouter_api_key/.test(noKey.reason) && noKey.options.length <= 3);

  process.env.openrouter_api_key = 'sk-test-SECRET-123';
  const answer = (probabilities, choice) => async () => new Response(JSON.stringify({ answers: { destination: { choice, probabilities, reason: 'r' } }, model: 'fake', usage: { cost: 0.001 } }), { status: 200 });
  globalThis.fetch = answer({ 'claude:S7': 0.95, 'claude:S1': 0.03, NEW: 0.01, CLARIFY: 0.01 }, 'claude:S7');
  const hi = await interimRouter.route('税率发票', ctx);
  check('高置信 → continue 且映射回 provider/sessionId', hi.kind === 'continue' && hi.provider === 'claude' && hi.sessionId === 'S7' && hi.costUsd === 0.001, JSON.stringify(hi));
  const rc = recall('税率发票', ctx).map((c) => `claude:${c.sessionId}`).filter((x) => x !== 'claude:S7');
  globalThis.fetch = answer({ 'claude:S7': 0.6, [rc[0]]: 0.25, [rc[1]]: 0.1, NEW: 0.03, CLARIFY: 0.02 }, 'claude:S7');
  const mid = await interimRouter.route('税率发票', ctx);
  check('低置信 → clarify 前 3', mid.kind === 'clarify' && mid.options.length === 3 && mid.options[0].sessionId === 'S7');
  globalThis.fetch = answer({ 'claude:S7': 0.9, 'claude:S1': 0.8, NEW: 0.01 }, 'claude:S7');
  const bad = await interimRouter.route('税率发票', ctx);
  check('分布不合法(和>1.1) → clarify', bad.kind === 'clarify');
  globalThis.fetch = answer({ NEW: 0.95, 'claude:S1': 0.03, CLARIFY: 0.02 }, 'NEW');
  const nw = await interimRouter.route('一件全新的事', ctx);
  check('NEW → new(默认 claude, cwd null)', nw.kind === 'new' && nw.provider === 'claude' && nw.cwd === null);
  globalThis.fetch = async () => { throw new Error(`network down with key ${process.env.openrouter_api_key}`); };
  const down = await interimRouter.route('税率发票', ctx);
  check('出错 → clarify，且不泄露 key', down.kind === 'clarify' && !JSON.stringify(down).includes('SECRET-123'), JSON.stringify(down));
  globalThis.fetch = answer({ 'claude:GHOST': 0.95, NEW: 0.03, CLARIFY: 0.02 }, 'claude:GHOST');
  const ghost = await interimRouter.route('税率发票', ctx);
  check('模型选了候选之外的 id → clarify(不送)', ghost.kind === 'clarify');
  globalThis.fetch = realFetch;
  delete process.env.openrouter_api_key;
}

console.log(`\n${pass} PASS / ${fail} FAIL`);
fs.rmSync(root, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
