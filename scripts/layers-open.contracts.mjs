// open() 编排离线契约（TE-5）：假 Router / Provider / Surface，不碰 iTerm、原生 CLI 和模型。
// 重点断言三条不变量：核对不通过绝不 write；存活会话绝不二开；没送达的输入不丢。
// 用法：node scripts/layers-open.contracts.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ntr-open-'));
process.env.NTR_HOME = path.join(root, 'ntr');
const { open, approvalPrompt, pendingDraft, shortName, readPrevious, readHistory } = await import('../src/layers/open.ts');
const { interimRouter, recall, MAX_CANDIDATES } = await import('../src/layers/router/interim.ts');
const { routingNote, routingNoteNew, stripRoutingNote } = await import('../src/layers/routing-note.ts');

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
function world({ cards = [], liveSeq = [[]], views = [], tails = {}, queueFails = false, writeFails = false, clipFails = false, newTty = null } = {}) {
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
    forkArgv: (s, p) => (id === 'claude' ? ['claude', '-r', s, '--fork-session', p] : ['codex', 'fork', s, p]),
  });
  const surface = {
    id: 'iterm',
    listViews: async () => ((calls.viewsCalls += 1), views),
    focus: async (v) => void calls.focus.push(v),
    openView: async (cwd, argv, o) => {
      calls.openView.push({ cwd, argv, o });
      return { surface: 'iterm', viewId: 'NEWVIEW', tty: newTty, title: '' };
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
    tasksRoot: path.join(root, 'ntr-tasks'),
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
  check('S5 new 无 cwd → 建 ntr-tasks/<短名>-<4位>', r.action === 'opened' && new RegExp(`^${path.join(root, 'ntr-tasks').replaceAll('/', '\\/')}\\/帮我整理发票-\\d{4}$`).test(r.cwd) && fs.statSync(r.cwd).isDirectory(), JSON.stringify(r));
  check('S5 argv=newArgv(正文)', JSON.stringify(w.calls.openView[0].argv) === JSON.stringify(['claude', '帮我整理发票']));
  const proj = fs.mkdtempSync(path.join(root, 'proj-'));
  const w2 = world({});
  const r2 = await open('x', { ...w2.opts, router: route({ kind: 'new', provider: 'codex', cwd: proj, confidence: null, reason: 'x' }) });
  check('S4 new 给定 cwd → 原样使用', r2.action === 'opened' && r2.cwd === proj && w2.calls.openView[0].cwd === proj && w2.calls.openView[0].argv[0] === 'codex');
  const w3 = world({});
  const r3 = await open('x', { ...w3.opts, router: { route: async () => { throw new Error('不应路由'); } }, forceNew: { provider: 'codex' } });
  check('forceNew 跳过路由', r3.action === 'opened' && r3.cwd.startsWith(path.join(root, 'ntr-tasks')));
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
  const proj2 = path.join(root, 'proj-x');
  const ru = await open(TEXT, { ...w.opts, router: route({ kind: 'clarify', options: opts, reason: 'x', ranked: [{ kind: 'session', ...opts[0] }, { kind: 'new', provider: 'codex', cwd: proj2, probability: null }, { kind: 'session', ...opts[1] }] }) });
  check('clarify 按 Router 顺序透传全部候选：排第二的项目内新建保留目录', ru.action === 'clarify' && JSON.stringify(ru.ranked) === JSON.stringify([{ kind: 'session', provider: 'claude', sessionId: 'A' }, { kind: 'new', provider: 'codex', cwd: proj2 }, { kind: 'session', provider: 'codex', sessionId: 'B' }]) && ru.suggestNew === null, JSON.stringify(ru.ranked));
  check('Router 没给 ranked 时 clarify 不带 ranked（入口退回 options + suggestNew）', r.ranked === undefined);
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
  delete process.env.NTR_ROUTER_API_KEY;
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

// ---- 11. 分叉送达（delivery: 'fork'）与路由说明头 ----
{
  const note = (t, c) => routingNote(t, c);
  check('说明头：含汉字 → 中文，置信度两位小数，正文在空行之后原样保留',
    note(TEXT, 0.876) === `[路由说明] 这句话由 Native Task Router 自动送达，对项目的置信度 0.88。如果它与这个项目或会话正在做的事无关，请说明原因并停下，不要修改任何文件。\n\n${TEXT}`, note(TEXT, 0.876));
  check('说明头：无汉字 → 英文', note('add pagination to the export API', 0.9) === '[Routing note] This message was delivered automatically by Native Task Router (project confidence 0.90). If it is unrelated to what this project or session is working on, say so and stop without changing any files.\n\nadd pagination to the export API');
  check('说明头：只有假名/韩文不算汉字 → 英文', note('テスト 한국어', 0.9).startsWith('[Routing note]'));
  check('说明头：不含本机路径', !/\/Users\/|\/home\/|~\//.test(note(TEXT, 0.9) + note('x', 0.9)));
  check('stripRoutingNote 往返还原用户原话（中/英）', stripRoutingNote(note(TEXT, 0.9)) === TEXT && stripRoutingNote(note('fix it', 0.86)) === 'fix it');
  check('stripRoutingNote 不动普通文本与正文中间出现的说明字样', stripRoutingNote(TEXT) === TEXT && stripRoutingNote(`前缀\n\n${note('x', 0.9)}`) === `前缀\n\n${note('x', 0.9)}`);

  const forkRoute = (provider, sessionId, confidence = 0.88) => route({ kind: 'continue', provider, sessionId, confidence, reason: 'x', delivery: 'fork' });
  const sameArgv = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  // 原会话存活、空闲、视图干净：direct 档会 write，fork 档必须新开分叉
  const w = world({ cards: [card('claude', 'S1', root)], liveSeq: [[live('claude', 'S1', '/dev/ttys1')]], views: [view('V1', '/dev/ttys1')] });
  const r = await open(TEXT, { ...w.opts, windowId: 5, router: forkRoute('claude', 'S1') });
  check('fork：原会话存活空闲也不 write、不 queue、不 focus 原视图', w.calls.write.length === 0 && w.calls.queue.length === 0 && w.calls.focus.length === 0, JSON.stringify(w.calls));
  check('fork：恰一次 openView(原 cwd, forkArgv(原 id, 说明头+正文), windowId)', w.calls.openView.length === 1 && w.calls.openView[0].cwd === root && w.calls.openView[0].o.windowId === 5
    && sameArgv(w.calls.openView[0].argv, ['claude', '-r', 'S1', '--fork-session', note(TEXT, 0.88)]), JSON.stringify(w.calls.openView));
  check('fork：argv 不是在原 id 上 resume（含 --fork-session）', w.calls.openView[0].argv.includes('--fork-session') && !sameArgv(w.calls.openView[0].argv, ['claude', '-r', 'S1', TEXT]));
  check('fork：说明头在正文前', w.calls.openView[0].argv.at(-1).startsWith('[路由说明]') && w.calls.openView[0].argv.at(-1).endsWith(TEXT));
  check('fork：outcome opened 记 forkedFrom 与置信度；新 id 取不到时为 null（不编造为原 id）', r.action === 'opened' && r.forkedFrom === 'S1' && r.confidence === 0.88 && r.sessionId === null && r.cwd === root, JSON.stringify(r));
  const log = fs.readFileSync(w.opts.logPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).at(-1);
  check('fork：入口日志 decision 记 delivery=fork 与置信度，input 是用户原话（不含说明头）', log.decision.delivery === 'fork' && log.decision.confidence === 0.88 && log.input === TEXT, JSON.stringify(log.decision));

  const c = world({ cards: [card('codex', 'C1', root)], liveSeq: [[live('codex', 'C1', '/dev/ttys5')]], views: [view('VC', '/dev/ttys5')] });
  const rc = await open('fix the flaky test', { ...c.opts, router: forkRoute('codex', 'C1', 0.9) });
  check('fork Codex：空闲也不走 queue，新开 codex fork <id> <英文说明头+正文>', rc.action === 'opened' && c.calls.queue.length === 0 && c.calls.write.length === 0
    && sameArgv(c.calls.openView[0].argv, ['codex', 'fork', 'C1', note('fix the flaky test', 0.9)]), JSON.stringify(c.calls.openView));

  const b = world({ cards: [card('claude', 'S1', root)], liveSeq: [[live('claude', 'S1', '/dev/ttys1', 'busy')]], views: [view('V1', '/dev/ttys1')], tails: { V1: CLAUDE_APPROVAL } });
  const rb = await open(TEXT, { ...b.opts, router: forkRoute('claude', 'S1') });
  check('fork：原会话忙/停在审批框也照样分叉（不是 focused-only）', rb.action === 'opened' && rb.forkedFrom === 'S1' && b.calls.openView.length === 1 && b.calls.clip.length === 0);
  const two = world({ cards: [card('claude', 'S1', root)], liveSeq: [[live('claude', 'S1', '/dev/ttys1', 'idle', 1), live('claude', 'S1', '/dev/ttys2', 'idle', 2)]] });
  const rt = await open(TEXT, { ...two.opts, router: forkRoute('claude', 'S1') });
  check('fork：原会话被两个进程持有也能分叉（新 id 不与任何进程冲突）', rt.action === 'opened' && two.calls.openView.length === 1);
  const cold = world({ cards: [card('claude', 'S2', root)] });
  await open(TEXT, { ...cold.opts, router: forkRoute('claude', 'S2') });
  check('fork：原会话未运行 → 仍是 forkArgv，不是 resumeArgv', cold.calls.openView[0].argv.includes('--fork-session'));
  const miss = world({});
  const rm = await open(TEXT, { ...miss.opts, router: forkRoute('claude', 'NOPE') });
  check('fork：找不到原会话 → failed + 剪贴板，不开视图', rm.action === 'failed' && miss.calls.openView.length === 0 && miss.calls.clip[0] === TEXT);

  // settle：新视图的 tty 上先报原 id（进程尚未换成分叉 id），再报新 id → 取新 id
  const st = world({ cards: [card('claude', 'S1', root)], newTty: '/dev/ttys9', liveSeq: [[], [live('claude', 'S1', '/dev/ttys9')], [live('claude', 'FORK1', '/dev/ttys9')]] });
  const rs = await open(TEXT, { ...st.opts, settleMs: 3000, router: forkRoute('claude', 'S1') });
  check('fork settle：不把原 id 当成分叉结果，等到新 id', rs.action === 'opened' && rs.sessionId === 'FORK1' && rs.forkedFrom === 'S1', JSON.stringify(rs));
  let seen = null;
  const spy = { route: async (_t, ctx) => ((seen = ctx), { kind: 'clarify', options: [], reason: 'x', latencyMs: 1, costUsd: null, model: null }) };
  await open('继续', { ...st.opts, router: spy });
  check('fork 之后下一句的"上一句"去处是分叉出的新会话，不是原会话', seen.previous?.sessionId === 'FORK1', JSON.stringify(seen.previous));
  check('fork 出的新会话进入 ← 历史', readHistory(st.opts.logPath).some((h) => h.sessionId === 'FORK1'));

  // 路由自动新建（有置信度，不论档位）：在项目目录新建，正文前加"自动新建在项目 X"的说明头；人工 --new（置信度 null）不加
  const n1 = world({});
  const proj = fs.mkdtempSync(path.join(root, 'proj-'));
  await open(TEXT, { ...n1.opts, router: route({ kind: 'new', provider: 'claude', cwd: proj, confidence: 0.86, reason: 'x', delivery: 'direct' }) });
  const nn = routingNoteNew(TEXT, 0.86, path.basename(proj));
  check('自动新建：在项目目录 newArgv(新建说明头+正文)', n1.calls.openView[0].cwd === proj && sameArgv(n1.calls.openView[0].argv, ['claude', nn]));
  check('新建说明头：点明项目目录名与置信度，不含本机路径', nn.startsWith(`[路由说明] 这句话由 Native Task Router 自动新建在项目 ${path.basename(proj)}，置信度 0.86。如果这句话不属于这个项目，请说明原因并停下`) && !nn.includes(root), nn.split('\n')[0]);
  check('新建说明头：英文', routingNoteNew('add a CSV import', 0.9, 'shop-api').startsWith('[Routing note] Native Task Router automatically started this session in project shop-api (confidence 0.90).'));
  check('新建说明头可被 stripRoutingNote 去掉（中英文）', stripRoutingNote(nn) === TEXT && stripRoutingNote(routingNoteNew('add a CSV import', 0.9, 'x')) === 'add a CSV import');
  const n2 = world({});
  await open(TEXT, { ...n2.opts, router: route({ kind: 'new', provider: 'claude', cwd: proj, confidence: 0.97, reason: 'x', delivery: 'direct' }) });
  check('direct 档自动新建同样加新建说明头', sameArgv(n2.calls.openView[0].argv, ['claude', routingNoteNew(TEXT, 0.97, path.basename(proj))]));
  const n3 = world({});
  await open(TEXT, { ...n3.opts, router: route({ kind: 'new', provider: 'claude', cwd: proj, confidence: null, reason: 'x' }) });
  check('置信度为 null 的新建（人工语义）不加说明头', sameArgv(n3.calls.openView[0].argv, ['claude', TEXT]));

  // direct 档与人工 pick：原样写入，不加说明头
  const d = world({ cards: [card('claude', 'S1', root)], liveSeq: [[live('claude', 'S1', '/dev/ttys1')]], views: [view('V1', '/dev/ttys1')] });
  const rd = await open(TEXT, { ...d.opts, router: route({ kind: 'continue', provider: 'claude', sessionId: 'S1', confidence: 0.97, reason: 'x', delivery: 'direct' }) });
  check('direct 档：写进原会话、正文原样', rd.action === 'wrote' && d.calls.write[0].t === TEXT && d.calls.openView.length === 0);
  const pk = world({ cards: [card('claude', 'S1', root)], liveSeq: [[live('claude', 'S1', '/dev/ttys1')]], views: [view('V1', '/dev/ttys1')] });
  const rp = await open(TEXT, { ...pk.opts, router: forkRoute('claude', 'S1'), pick: { provider: 'claude', sessionId: 'S1' } });
  check('人工 pick：始终 direct（即使 Router 会给 fork），不加说明头', rp.action === 'wrote' && pk.calls.write[0].t === TEXT && pk.calls.openView.length === 0);
  const pkc = world({ cards: [card('claude', 'S2', root)] });
  await open(TEXT, { ...pkc.opts, router: forkRoute('claude', 'S2'), pick: { provider: 'claude', sessionId: 'S2' } });
  check('人工 pick 冷会话：resumeArgv(原正文)，不分叉', sameArgv(pkc.calls.openView[0].argv, ['claude', '-r', 'S2', TEXT]));
  const fn = world({});
  await open(TEXT, { ...fn.opts, router: forkRoute('claude', 'S2'), forceNew: { provider: 'claude', cwd: proj } });
  check('人工 --new：不加说明头', sameArgv(fn.calls.openView[0].argv, ['claude', TEXT]));
}

console.log(`\n${pass} PASS / ${fail} FAIL`);
fs.rmSync(root, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
