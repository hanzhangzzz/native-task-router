// open() 真实 iTerm 验收（TE-5，场景 S1–S8 + 真实 interim 路由冒烟 + 入口窗口端到端）。
// 隔离：只在本脚本新建的 iTerm 专用窗口里开 tab；会话 cwd 都在 .runtime/te5/work/ 下；
// 所有写入/聚焦/排队/resume 都过 JEV_GUARD_FILE 名单闸门（只允许本脚本创建的视图与会话）。
// 结束时关窗口、杀本脚本启动的进程、删本脚本创建的会话，并核对用户原有视图前后一致。
// 用法: JEV_LIVE_ITERM=1 node scripts/layers-open.live.mjs [--no-entry]（不设则不运行：会在你正在用的 iTerm 里建测试窗口）    日志: .runtime/te5/live.log
import { execFile, execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { requireLiveOptIn, openTestWindow } from './lib-iterm-live.mjs';

requireLiveOptIn('layers-open.live');

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const D = path.join(ROOT, '.runtime/te5');
const WORK = path.join(D, 'work');
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });
process.env.JEV_HOME = path.join(D, 'jev-home');
fs.rmSync(path.join(process.env.JEV_HOME, 'entry-log.jsonl'), { force: true });
const GUARD = path.join(D, 'guard.json');
process.env.JEV_GUARD_FILE = GUARD;
const LOG = path.join(D, 'live.log');
fs.writeFileSync(LOG, '');

const { claude } = await import('../src/layers/providers/claude.ts');
const { codex } = await import('../src/layers/providers/codex.ts');
const { codexQueue } = await import('../src/layers/providers/codex-queue.ts');
const { iterm, osa } = await import('../src/layers/surfaces/iterm.ts');
const { interimRouter } = await import('../src/layers/router/interim.ts');
const { open, approvalPrompt, pendingDraft } = await import('../src/layers/open.ts');
const { guarded } = await import('../src/layers/guard.ts');

const run = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (s) => { console.log(s); fs.appendFileSync(LOG, s + '\n'); };
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { ok ? pass++ : fail++; say(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : '  ' + detail}`); };
const waitFor = async (fn, ms, step = 700) => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) return null; await sleep(step); } };

// ---- 测试用 Provider：只在测试里给 argv 加便宜模型 / 关更新菜单，生产 argv 不变 ----
const TEST_CLAUDE = { ...claude, resumeArgv: (id, p) => ['claude', '--model', 'haiku', '-r', id, p], newArgv: (p) => ['claude', '--model', 'haiku', p] };
const TEST_CODEX = { ...codex, resumeArgv: (id, p) => ['codex', '-c', 'check_for_update_on_startup=false', 'resume', id, p], newArgv: (p) => ['codex', '-c', 'check_for_update_on_startup=false', p] };
const providers = [TEST_CLAUDE, TEST_CODEX];

// ---- 窗口与名单 ----
const viewsBefore = await iterm.listViews();
const userViewIds = new Set(viewsBefore.map((v) => v.viewId));
say(`测试前用户视图 ${viewsBefore.length} 个`);
fs.writeFileSync(path.join(D, 'views-before.json'), JSON.stringify(viewsBefore.map((v) => ({ viewId: v.viewId, tty: v.tty }))));
const testWindow = await openTestWindow();
const wid = testWindow.wid;
const firstSession = await osa(`tell application "iTerm" to return id of current session of current tab of window id ${wid}`);
const own = { views: [firstSession], sessions: [] };
const saveGuard = () => fs.writeFileSync(GUARD, JSON.stringify(own));
saveGuard();
const ownView = (id) => { if (!own.views.includes(id)) throw new Error(`非本测试视图 ${id}`); return id; };
const G = guarded(iterm, codexQueue, GUARD);
const clip = [];
const baseOpts = (extra = {}) => ({ providers, surface: G.surface, queue: { codex: G.queue }, windowId: wid, clipboard: async (t) => void clip.push(t), settleMs: 8000, tasksRoot: path.join(D, 'JevTasks'), ...extra });
const noRoute = { route: async () => { throw new Error('不应路由'); } };

async function openTest(cwd, argv) {
  const v = await iterm.openView(cwd, argv, { windowId: wid });
  own.views.push(v.viewId); saveGuard();
  return v;
}
const rawTyped = (viewId, s) => osa('on run argv\ntell application "iTerm"\nrepeat with w in windows\nrepeat with t in tabs of w\nrepeat with s in sessions of t\nif (id of s) is (item 1 of argv) then tell s to write text (item 2 of argv) newline NO\nend repeat\nend repeat\nend repeat\nend tell\nend run', [ownView(viewId), s]);

// ---- 原生证据：transcript / rollout 里的人工输入 ----
const claudeFile = (id) => { const root = path.join(os.homedir(), '.claude/projects'); for (const d of fs.readdirSync(root)) { const f = path.join(root, d, `${id}.jsonl`); if (fs.existsSync(f)) return f; } return null; };
const codexFile = (id) => { try { return execFileSync('find', [path.join(os.homedir(), '.codex/sessions'), '-name', `rollout-*-${id}.jsonl`], { encoding: 'utf8' }).trim().split('\n').filter(Boolean)[0] ?? null; } catch { return null; } };
function humanInputs(provider, id) {
  const f = provider === 'claude' ? claudeFile(id) : codexFile(id);
  if (!f) return [];
  const out = [];
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (provider === 'claude') {
      if (o.type !== 'user' || o.isMeta || o.isSidechain) continue;
      const c = o.message?.content;
      const texts = typeof c === 'string' ? [c] : Array.isArray(c) && !c.some((b) => b.type === 'tool_result') ? c.filter((b) => b.type === 'text').map((b) => b.text) : [];
      out.push(...texts);
    } else if (o.type === 'response_item' && o.payload?.type === 'message' && o.payload.role === 'user') {
      for (const b of o.payload.content ?? []) if (b.type === 'input_text' && !b.text.startsWith('<')) out.push(b.text);
    }
  }
  return out;
}
const countText = (provider, id, text) => humanInputs(provider, id).filter((t) => t.trim() === text.trim()).length;

const liveAll = async () => (await Promise.all(providers.map((p) => p.liveSessions()))).flat();
const holdersOf = async (provider, id) => (await liveAll()).filter((l) => l.provider === provider && l.sessionId === id);
/** S8: 没有第二个进程持有同一会话——存活映射 ≤1，且进程列表里至多一个命令行带这个 id 的 resume */
async function noSecondProcess(name, provider, id) {
  const h = await holdersOf(provider, id);
  // codex 有 node 包装进程 + 原生二进制，两者同 tty、命令行都带 id，所以数"不同终端上的会话进程"
  const ps = execFileSync('ps', ['-axww', '-o', 'tty=,command='], { encoding: 'utf8' }).split('\n').filter((l) => l.includes(id) && /\b(claude|codex)\b/.test(l) && !l.includes('ps -axww')).map((l) => l.trim().split(/\s+/)[0]);
  check(`S8 ${name}: 无第二个进程持有 ${provider}:${id.slice(0, 8)}`, h.length <= 1 && new Set(ps).size <= 1, `holders=${h.length} ttys=${[...new Set(ps)]}`);
}

async function createSession(provider, name, prompt, { argvExtra = [], idle = true } = {}) {
  const cwd = path.join(WORK, name);
  fs.mkdirSync(cwd, { recursive: true });
  const base = provider === 'claude' ? TEST_CLAUDE.newArgv(prompt) : TEST_CODEX.newArgv(prompt);
  const argv = [...base.slice(0, provider === 'claude' ? 3 : 3), ...argvExtra, ...base.slice(3)];
  const v = await openTest(cwd, argv);
  const prov = provider === 'claude' ? claude : codex;
  const sess = await waitFor(async () => (await prov.liveSessions()).find((l) => l.tty === v.tty), 40000);
  if (!sess) throw new Error(`${name}: 会话没有起来`);
  own.sessions.push(sess.sessionId); saveGuard();
  if (idle) {
    const ok = await waitFor(async () => { const h = (await holdersOf(provider, sess.sessionId))[0]; return h?.state === 'idle' && humanInputs(provider, sess.sessionId).length >= 1; }, 90000);
    if (!ok) throw new Error(`${name}: 没有进入 idle`);
    await sleep(2500);
  }
  return { provider, id: sess.sessionId, view: v, cwd, name };
}
async function exitSession(s) {
  const prov = s.provider === 'claude' ? claude : codex;
  await iterm.write(ownView(s.view.viewId), '/exit');
  const gone = await waitFor(async () => (await holdersOf(s.provider, s.id)).length === 0, 30000);
  check(`${s.name}: 退出后无存活进程(变冷)`, !!gone);
  void prov;
}
async function deliveredOnce(s, text, ms = 40000) {
  const ok = await waitFor(() => countText(s.provider, s.id, text) >= 1, ms);
  if (ok) await sleep(4000);
  return ok && countText(s.provider, s.id, text) === 1;
}

const results = {};
try {
  // ================= S1: 存活且空闲的 Claude 标签 → 写入同一会话并聚焦 =================
  say('\n== S1 存活空闲 Claude ==');
  const A = await createSession('claude', 's1-claude', 'We are building kumquat-ledger, a small bookkeeping tool for invoices. Just acknowledge with exactly: READY-A');
  const t1 = 'S1 测试第一行 "引号" $HOME\n第二行 😀 请只回复 OK-S1';
  const r1 = await open(t1, { ...baseOpts(), router: noRoute, pick: { provider: 'claude', sessionId: A.id } });
  check('S1 open → wrote 到该标签', r1.action === 'wrote' && r1.viewId === A.view.viewId && r1.sessionId === A.id, JSON.stringify(r1));
  check('S1 transcript 恰好新增一条与正文一致的人工输入(多行/中文/emoji)', await deliveredOnce(A, t1), JSON.stringify(humanInputs('claude', A.id)));
  const hA = await holdersOf('claude', A.id);
  check('S1 sessionId 不变、仍由同一 pid 持有', hA.length === 1 && hA[0].tty === A.view.tty);
  await noSecondProcess('S1', 'claude', A.id);
  await waitFor(async () => (await holdersOf('claude', A.id))[0]?.state === 'idle', 60000);

  // ================= S7: 草稿 / 审批框 → 只聚焦不写入 =================
  say('\n== S7 草稿与审批框 ==');
  await rawTyped(A.view.viewId, 'half typed draft');
  await sleep(800);
  const tailA = await iterm.screenTail(A.view.viewId, 16);
  check('S7a 真实屏幕上草稿特征被识别', pendingDraft(tailA) !== null && approvalPrompt(tailA) === null, tailA.slice(-200));
  clip.length = 0;
  const t7a = 'S7a 不应写入的正文';
  const r7a = await open(t7a, { ...baseOpts(), router: noRoute, pick: { provider: 'claude', sessionId: A.id } });
  check('S7a 有草稿 → focused-only，正文进剪贴板', r7a.action === 'focused-only' && clip.at(-1) === t7a, JSON.stringify(r7a));
  check('S7a transcript 没有新输入、草稿仍在输入行', countText('claude', A.id, t7a) === 0 && (await iterm.screenTail(A.view.viewId, 16)).includes('half typed draft'));
  await rawTyped(A.view.viewId, '\u0015'); // Ctrl-U 清掉草稿
  await sleep(600);
  check('S7a 清草稿后输入行为空', pendingDraft(await iterm.screenTail(A.view.viewId, 16)) === null);

  const B = await createSession('claude', 's7-claude-approval', 'Run this exact bash command and nothing else: touch approval-probe.txt', { argvExtra: ['--permission-mode', 'default'], idle: false });
  const atBox = await waitFor(async () => approvalPrompt(await iterm.screenTail(B.view.viewId, 16)) !== null, 90000, 2000);
  check('S7b Claude 停在审批框，真实屏幕特征被识别', !!atBox);
  const stB = (await holdersOf('claude', B.id))[0];
  const t7b = 'S7b 审批框时的正文，不应写入';
  clip.length = 0;
  const r7b = await open(t7b, { ...baseOpts(), router: noRoute, pick: { provider: 'claude', sessionId: B.id } });
  check(`S7b Claude 审批框 → focused-only(原生状态=${stB?.state})，正文进剪贴板`, r7b.action === 'focused-only' && clip.at(-1) === t7b, JSON.stringify(r7b));
  await sleep(1500);
  check('S7b 审批框未被按下：探针文件不存在、审批框仍在、transcript 无新输入', !fs.existsSync(path.join(B.cwd, 'approval-probe.txt')) && approvalPrompt(await iterm.screenTail(B.view.viewId, 16)) !== null && countText('claude', B.id, t7b) === 0);
  // 屏幕层独立验证：假装原生状态是 idle(只改映射)，仅凭屏幕特征也必须拦住
  {
    const forcedIdle = { ...TEST_CLAUDE, liveSessions: async () => (await claude.liveSessions()).map((l) => (l.sessionId === B.id ? { ...l, state: 'idle' } : l)) };
    clip.length = 0;
    const r = await open('S7b2 屏幕层独立拦截', { ...baseOpts(), providers: [forcedIdle, TEST_CODEX], router: noRoute, pick: { provider: 'claude', sessionId: B.id } });
    check('S7b2 即使原生状态伪装成 idle，审批框屏幕特征单独也拦住(不写入)', r.action === 'focused-only' && countText('claude', B.id, 'S7b2 屏幕层独立拦截') === 0 && approvalPrompt(await iterm.screenTail(B.view.viewId, 16)) !== null, JSON.stringify(r));
  }
  await rawTyped(B.view.viewId, '\u001b'); // Esc 拒绝，让它回到输入框

  const C = await createSession('codex', 's7-codex-approval', 'Run this shell command now and nothing else, requesting escalated permission if needed: touch approval-probe.txt', { argvExtra: ['-a', 'on-request', '-s', 'read-only'], idle: false });
  const atBoxC = await waitFor(async () => approvalPrompt(await iterm.screenTail(C.view.viewId, 16)) !== null, 90000, 2000);
  check('S7c Codex 停在审批框，真实屏幕特征被识别', !!atBoxC);
  const t7c = 'S7c Codex 审批框时的正文，不应排队也不应写入';
  clip.length = 0;
  const r7c = await open(t7c, { ...baseOpts(), router: noRoute, pick: { provider: 'codex', sessionId: C.id } });
  check('S7c Codex 审批框 → focused-only，正文进剪贴板', r7c.action === 'focused-only' && clip.at(-1) === t7c, JSON.stringify(r7c));
  await sleep(1500);
  check('S7c 审批框未被按下、rollout 无新输入', !fs.existsSync(path.join(C.cwd, 'approval-probe.txt')) && approvalPrompt(await iterm.screenTail(C.view.viewId, 16)) !== null && countText('codex', C.id, t7c) === 0);
  await rawTyped(C.view.viewId, '\u001b');

  // ================= S3: 冷 Codex → 新 tab resume；再测存活 Codex 的 queue 通道 =================
  say('\n== S3 Codex ==');
  const Dx = await createSession('codex', 's3-codex', 'Reply with exactly: READY-D');
  await exitSession(Dx);
  const t3 = 'S3 冷 Codex 续接正文 "q" $x 请只回复 OK-S3';
  const r3 = await open(t3, { ...baseOpts(), router: noRoute, pick: { provider: 'codex', sessionId: Dx.id } });
  check('S3 open → opened(新 tab resume)', r3.action === 'opened' && r3.cwd === Dx.cwd, JSON.stringify(r3));
  if (r3.action === 'opened') own.views.push(r3.viewId), saveGuard();
  check('S3 rollout 恰好新增一条与正文一致的人工输入、同一 thread id', await deliveredOnce(Dx, t3, 90000), JSON.stringify(humanInputs('codex', Dx.id)));
  await noSecondProcess('S3', 'codex', Dx.id);
  await waitFor(async () => (await holdersOf('codex', Dx.id))[0]?.state === 'idle', 90000);
  await sleep(2000);
  const t3q = 'S3q 存活 Codex 经 queue 通道 请只回复 OK-S3Q';
  const r3q = await open(t3q, { ...baseOpts(), router: noRoute, pick: { provider: 'codex', sessionId: Dx.id } });
  check('S3q 存活空闲 Codex → wrote(queue，不按键)', r3q.action === 'wrote' && r3q.sessionId === Dx.id, JSON.stringify(r3q));
  check('S3q rollout 恰好新增一条、同一 thread', await deliveredOnce(Dx, t3q, 60000));
  await noSecondProcess('S3q', 'codex', Dx.id);

  // ================= S2: 冷 Claude → 新 tab resume =================
  say('\n== S2 冷 Claude ==');
  const E = await createSession('claude', 's2-claude', 'Reply with exactly: READY-E');
  await exitSession(E);
  const t2 = 'S2 冷 Claude 续接正文 `bt` "q" 请只回复 OK-S2';
  const r2 = await open(t2, { ...baseOpts(), router: noRoute, pick: { provider: 'claude', sessionId: E.id } });
  check('S2 open → opened(新 tab resume)', r2.action === 'opened' && r2.sessionId === E.id, JSON.stringify(r2));
  if (r2.action === 'opened') own.views.push(r2.viewId), saveGuard();
  check('S2 同一 sessionId 的 transcript 恰好新增一条一致输入', await deliveredOnce(E, t2, 90000), JSON.stringify(humanInputs('claude', E.id)));
  await noSecondProcess('S2', 'claude', E.id);

  // ================= S4 / S5: 新建 =================
  say('\n== S4 / S5 新建 ==');
  const newClaudeInCwd = async (cwd, text) => waitFor(async () => (await claude.listSessions()).find((c) => c.cwd === cwd && c.firstPrompt?.includes(text)), 60000, 2000);
  const t4 = 'S4 已有项目里新建会话 请只回复 OK-S4';
  const r4 = await open(t4, { ...baseOpts(), router: { route: async () => ({ kind: 'new', provider: 'claude', cwd: A.cwd, confidence: null, reason: 'inject', latencyMs: 0, costUsd: null, model: null }) } });
  check('S4 open → opened，cwd 为给定项目目录', r4.action === 'opened' && r4.cwd === A.cwd, JSON.stringify(r4));
  if (r4.action === 'opened') { own.views.push(r4.viewId); if (r4.sessionId) own.sessions.push(r4.sessionId); saveGuard(); }
  const c4 = await newClaudeInCwd(A.cwd, 'S4 已有项目');
  check('S4 原生侧出现新会话(cwd 正确、首条输入=正文、id≠旧会话)', !!c4 && c4.sessionId !== A.id && c4.firstPrompt.trim() === t4, JSON.stringify(c4?.firstPrompt));
  if (c4) { own.sessions.push(c4.sessionId); saveGuard(); }
  const t5 = 'S5 全新项目 请只回复 OK-S5';
  const r5 = await open(t5, { ...baseOpts(), router: { route: async () => ({ kind: 'new', provider: 'claude', cwd: null, confidence: null, reason: 'inject', latencyMs: 0, costUsd: null, model: null }) } });
  check('S5 open → opened，在 JevTasks 下建了新目录', r5.action === 'opened' && r5.cwd.startsWith(path.join(D, 'JevTasks') + '/') && fs.statSync(r5.cwd).isDirectory(), JSON.stringify(r5));
  if (r5.action === 'opened') { own.views.push(r5.viewId); if (r5.sessionId) own.sessions.push(r5.sessionId); saveGuard(); }
  const c5 = r5.action === 'opened' && (await newClaudeInCwd(r5.cwd, 'S5 全新项目'));
  check('S5 原生会话 cwd=新目录、首条输入=正文', !!c5 && c5.cwd === r5.cwd && c5.firstPrompt.trim() === t5);
  if (c5) { own.sessions.push(c5.sessionId); saveGuard(); }

  // ================= 真实 interim 路由冒烟（子进程 CLI，真实模型）=================
  say('\n== 真实路由冒烟（CLI 默认 Router v2：Opus 经 claude -p）==');
  await waitFor(async () => (await holdersOf('claude', A.id))[0]?.state === 'idle', 60000);
  const tSmoke = '接着做 kumquat-ledger 记账工具那个任务，请只回复 OK-SMOKE';
  const cliEnv = { ...process.env, JEV_WINDOW_ID: String(wid) };
  const cli = (extra, text) => run('node', [path.join(ROOT, 'src/layers/cli.ts'), 'open', '--json', ...extra, '--', text], { env: cliEnv, timeout: 90000 }).then((r) => JSON.parse(r.stdout.trim().split('\n').pop()), (e) => ({ action: 'cli-error', why: String(e.stderr || e.message).slice(0, 300) }));
  const smoke = await cli([], tSmoke);
  const logLines = fs.readFileSync(path.join(process.env.JEV_HOME, 'entry-log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const lastDec = logLines.at(-1)?.decision;
  say(`  决策: kind=${lastDec?.kind} model=${lastDec?.model} latency=${lastDec?.latencyMs}ms cost=${lastDec?.costUsd} 结果=${smoke.action} 候选=${(smoke.options ?? []).map((o) => `${o.sessionId?.slice(0, 8)}:${o.probability}`)}`);
  // 过渡路由拿不准时让人选(clarify)是安全行为；验收是"要么直接送到 A，要么 A 是首选候选(入口预选第 1 个)"
  const toA = smoke.action === 'wrote' && smoke.sessionId === A.id;
  const clarifyAFirst = smoke.action === 'clarify' && smoke.options?.[0]?.sessionId === A.id;
  check('真实路由: 明确指向 A 的一句话 → 直接送到 A，或 clarify 且 A 是第 1 候选', toA || clarifyAFirst, JSON.stringify(smoke).slice(0, 400));
  if (clarifyAFirst) {
    const picked = await cli(['--pick', `claude:${A.id}`], tSmoke);
    check('真实路由: clarify 后按首选候选送达(--pick)', picked.action === 'wrote' && picked.sessionId === A.id, JSON.stringify(picked));
  }
  check('真实路由: A 的 transcript 恰好新增该句', await deliveredOnce(A, tSmoke, 60000));
  results.smoke = { action: smoke.action, latencyMs: lastDec?.latencyMs, costUsd: lastDec?.costUsd, model: lastDec?.model };

  // ================= 入口窗口端到端（全局快捷键）+ S6 =================
  if (!process.argv.includes('--no-entry')) {
    say('\n== 入口窗口端到端 ==');
    await waitFor(async () => (await holdersOf('claude', A.id))[0]?.state === 'idle', 60000);
    const trace = path.join(D, 'entry-trace.jsonl');
    const startEntry = (env) => {
      fs.rmSync(trace, { force: true });
      fs.writeFileSync(path.join(D, 'entry.out'), '');
      const out = fs.openSync(path.join(D, 'entry.out'), 'a');
      return spawn(path.join(ROOT, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'), [path.join(ROOT, 'entry/main.cjs')], { env: { ...process.env, JEV_WINDOW_ID: String(wid), JEV_ENTRY_TRACE: trace, JEV_HOTKEY: 'Control+Alt+Space', JEV_ENTRY_CONTROL: 'stdin', ...env }, stdio: ['pipe', out, out], detached: false });
    };
    const traceEvents = () => (fs.existsSync(trace) ? fs.readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

    // 不模拟系统按键(需要辅助功能授权，且会敲进用户正在用的 app)：用入口进程的 stdin 控制通道，
    // 走与真实按键相同的渲染进程路径(show → 输入框 → keydown Enter/数字键 → IPC → CLI 子进程)。
    for (const mode of ['real-route', 'clarify']) {
      const env = mode === 'clarify' ? { openrouter_api_key: '', JEV_ROUTER_API_KEY: '', JEV_ROUTER_BACKEND: 'openrouter' } : {};
      const el = startEntry(env);
      const send = (o) => el.stdin.write(JSON.stringify(o) + '\n');
      try {
        const ready = await waitFor(() => fs.readFileSync(path.join(D, 'entry.out'), 'utf8').includes('jev 入口就绪'), 20000, 300);
        check(`入口[${mode}] Electron 启动并注册全局快捷键`, !!ready && traceEvents().some((e) => e.ev === 'registered' && e.registered));
        if (!ready) continue;
        send({ cmd: 'show' });
        const shown = await waitFor(() => traceEvents().find((e) => e.ev === 'shown'), 8000, 200);
        check(`入口[${mode}] 唤起输入框(与快捷键同一 show 路径)`, !!shown);
        if (!shown) continue;
        await sleep(600);
        const text = mode === 'clarify' ? 'kumquat-ledger entry clarify test reply OK-ENTRY2' : 'continue the kumquat-ledger bookkeeping tool task, reply OK-ENTRY1';
        const before = countText('claude', A.id, text);
        send({ cmd: 'type', text });
        send({ cmd: 'enter' });
        const results = () => traceEvents().filter((e) => e.ev === 'result');
        const first = await waitFor(() => results()[0], 60000, 500);
        if (mode === 'real-route') {
          // 过渡路由可能直接送达，也可能 clarify(此时 A 在首位，按 1 即送达)
          let res = first;
          if (first?.action === 'clarify') { await sleep(500); send({ cmd: 'key', key: '1' }); res = await waitFor(() => results()[1], 60000, 500); }
          check('入口[real-route] 回车(必要时再按 1)后送达', res?.action === 'wrote', JSON.stringify(res));
        } else {
          check('S6 无 key → 入口显示 clarify 候选', first?.action === 'clarify', JSON.stringify(first));
          await sleep(500);
          send({ cmd: 'key', key: '1' });
          const res = await waitFor(() => results()[1], 60000, 500);
          check('S6 clarify → 按键 1 → 送达所选(候选首位=词面最相关的 A)', res?.action === 'wrote', JSON.stringify(res));
        }
        check(`入口[${mode}] A 的 transcript 恰好新增该句`, before === 0 && (await deliveredOnce(A, text, 60000)));
        await waitFor(async () => (await holdersOf('claude', A.id))[0]?.state === 'idle', 60000);
      } finally {
        el.kill('SIGTERM');
        await sleep(800);
      }
    }
    say('入口[真实快捷键按下并获得键盘焦点]: BLOCKED —— 本环境无法保证前台激活(见 PR 说明)，需人工按一次 Control+Alt+Space 确认');
  } else say('入口窗口端到端: NOT_RUN (--no-entry)');

  // ================= S8 总核对 =================
  say('\n== S8 总核对 ==');
  for (const [p, id] of [['claude', A.id], ['claude', B.id], ['claude', E.id], ['codex', C.id], ['codex', Dx.id]]) await noSecondProcess('终态', p, id);
} catch (e) {
  check('脚本异常', false, e.stack ?? String(e));
} finally {
  say('\n== 清理 ==');
  const ownTtys = new Set();
  for (const v of await iterm.listViews()) if (own.views.includes(v.viewId) && v.tty) ownTtys.add(v.tty);
  for (const l of await liveAll()) if (own.sessions.includes(l.sessionId) || (l.tty && ownTtys.has(l.tty))) { try { process.kill(l.pid, 'SIGTERM'); } catch { /* 已退出 */ } }
  await sleep(1500);
  // 关闭测试窗口（不要往会话里输入 exit：那样会留下关不掉的 0 会话窗口对象，曾累积到让 iTerm 卡死）
  const closed = await testWindow.close();
  check('清理: 测试窗口已关闭，iTerm 窗口对象回到测试前', closed.ok, closed.detail);
  for (const id of own.sessions) {
    const f = claudeFile(id);
    if (f) { fs.rmSync(f, { force: true }); fs.rmSync(f.replace(/\.jsonl$/, ''), { recursive: true, force: true }); }
    if (codexFile(id)) { try { execFileSync('codex', ['delete', '--force', id], { stdio: 'ignore', timeout: 30000 }); } catch { /* 手动 */ } }
  }
  // 测试 cwd 对应的 Claude 项目目录(只含本测试会话)
  const cp = path.join(os.homedir(), '.claude/projects');
  for (const d of fs.readdirSync(cp)) if (d.includes('jev-task-router--mvp-te5-open--runtime-te5')) { try { fs.rmdirSync(path.join(cp, d)); } catch { /* 非空则保留，交给报告 */ } }
  await sleep(1000);
  const after = await iterm.listViews();
  const key = (v) => `${v.viewId}|${v.tty}`;
  const beforeKeys = viewsBefore.map(key).sort().join();
  const afterUser = after.filter((v) => userViewIds.has(v.viewId)).map(key).sort().join();
  const leaked = after.filter((v) => !userViewIds.has(v.viewId));
  check('清理: 用户原有 session(id+tty)前后完全一致，且无遗留测试 session', beforeKeys === afterUser && leaked.length === 0, `before=${beforeKeys} after=${afterUser} leaked=${leaked.map(key)}`);
  const leftover = (await liveAll()).filter((l) => own.sessions.includes(l.sessionId));
  check('清理: 本测试的原生进程全部退出', leftover.length === 0, JSON.stringify(leftover));
  say(`\n${pass} PASS / ${fail} FAIL`);
  fs.writeFileSync(path.join(D, 'results.json'), JSON.stringify({ pass, fail, ...results }, null, 1));
  process.exit(fail ? 1 : 0);
}
