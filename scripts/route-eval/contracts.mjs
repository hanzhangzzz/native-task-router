// 路由评测契约测试（TE-3）：全部用合成夹具，不读真实历史。node scripts/route-eval/contracts.mjs
// 覆盖：用户输入去噪、交互会话判定、防泄漏（卡片内容时间 < 查询时间；查询文本不在目标卡片）、
// resume 复制文件的同会话归并、续接/新建标注与时间切分、打分/指标能推翻（坏路由必须被抓出）、
// 留出集账本与哈希冻结。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cleanUserText, parseClaude, parseCodex, finalizeExclusion } from './parse.mjs';
import { buildCard } from './cards.mjs';
import { groupLogical, buildSamples } from './dataset.mjs';
import { loadSessions, poolCardsAt, evaluate } from './runner.mjs';
import { scoreDecision, summarize, upper95, riskCoverage } from './metrics.mjs';
import { writeJsonl, sha256File } from './lib.mjs';

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name} ${detail}`); }
};
const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'route-eval-contracts-'));
// 注意：夹具 cwd 不能落在 /tmp 下，否则会被"临时目录探针"规则排除
const cwdA = '/Users/fixture/projA', cwdB = '/Users/fixture/projB';
const iso = (ms) => new Date(ms).toISOString();
const T0 = Date.parse('2026-09-01T00:00:00Z');
const MIN = 60000;

// ---- 夹具构造 --------------------------------------------------------------
const cUser = (sid, uuid, t, text, extra = {}) => JSON.stringify({ type: 'user', uuid, sessionId: sid, timestamp: iso(t), cwd: cwdA, entrypoint: 'cli', isSidechain: false, message: { role: 'user', content: text }, ...extra });
const cAsst = (sid, t, text) => JSON.stringify({ type: 'assistant', sessionId: sid, timestamp: iso(t), isSidechain: false, message: { role: 'assistant', content: [{ type: 'text', text }] } });
const cTool = (sid, uuid, t) => JSON.stringify({ type: 'user', uuid, sessionId: sid, timestamp: iso(t), cwd: cwdA, entrypoint: 'cli', isSidechain: false, message: { role: 'user', content: [{ type: 'tool_result', content: 'x' }] } });
const writeLines = (name, lines) => { const f = path.join(tmp, name); fs.writeFileSync(f, lines.join('\n') + '\n'); return f; };

// ==== 1. 去噪 ================================================================
check('clean: plain text kept', cleanUserText('帮我看看日志').text === '帮我看看日志');
check('clean: system-reminder stripped', cleanUserText('<system-reminder>注入</system-reminder>真正的话').text === '真正的话');
check('clean: reminder-only dropped as empty', cleanUserText('<system-reminder>x</system-reminder>').drop === 'empty');
check('clean: slash-only dropped', cleanUserText('<command-name>/compact</command-name><command-args></command-args>').drop === 'slash-only');
check('clean: bare /compact dropped', cleanUserText('/compact').drop === 'slash-only');
check('clean: slash with args keeps args', cleanUserText('<command-name>/loop</command-name><command-args>检查部署</command-args>').text === '检查部署');
check('clean: path-like input kept', cleanUserText('/Users/x/proj 里面的 bug').text === '/Users/x/proj 里面的 bug');
check('clean: Caveat dropped', cleanUserText('Caveat: The messages below were generated').drop === 'system-injection');
check('clean: local-command-stdout dropped', cleanUserText('<local-command-stdout>ok</local-command-stdout>').drop === 'system-injection');
check('clean: codex wrapper -> request', cleanUserText('# Files mentioned by the user:\n\n## a.png: /x\n\n## My request for Codex:\n改一下颜色').text === '改一下颜色');
check('clean: in-app-browser block with attributes stripped', cleanUserText('<in-app-browser-context source="x">\nstate\n</in-app-browser-context>\n\n## My request:\n再看看').text === '再看看');
check('clean: automation prompt dropped', cleanUserText('Automation: We Are Warriors\nrun').drop === 'system-injection');

// ==== 2. Claude 解析 / 交互判定 =================================================
const fa = writeLines('claude-a.jsonl', [
  cUser('A', 'a1', T0, 'ALPHA 首句'),
  cAsst('A', T0 + 1 * MIN, 'REPLY1'),
  cTool('A', 'a-tr', T0 + 2 * MIN),
  cUser('A', 'a-meta', T0 + 3 * MIN, '元消息', { isMeta: true }),
  cUser('A', 'a-cav', T0 + 4 * MIN, 'Caveat: injected'),
  cUser('A', 'a-slash', T0 + 5 * MIN, '<command-name>/clear</command-name><command-args></command-args>'),
  cUser('A', 'a2', T0 + 40 * MIN, 'ALPHA 第二句 隔了很久'),
  cAsst('A', T0 + 41 * MIN, 'REPLY2'),
  cUser('A', 'a3', T0 + 50 * MIN, 'ALPHA 第三句 紧接着'),
  cAsst('A', T0 + 51 * MIN, 'REPLY3'),
  JSON.stringify({ type: 'ai-title', aiTitle: 'ALPHA TITLE', sessionId: 'A' }),
  cUser('A', 'a4', T0 + 200 * MIN, 'ALPHA 第四句 很晚'),
]);
const pa = await parseClaude(fa);
check('claude: only human inputs kept (4)', pa.inputs.length === 4, JSON.stringify(pa.inputs.map((i) => i.id)));
check('claude: drops counted (slash-only/system-injection)', pa.drops['slash-only'] === 1 && pa.drops['system-injection'] === 1, JSON.stringify(pa.drops));
check('claude: gap measured from previous activity', Math.round(pa.inputs[1].gapMs / MIN) === 35 && Math.round(pa.inputs[2].gapMs / MIN) === 9, JSON.stringify(pa.inputs.map((i) => i.gapMs / MIN)));
check('claude: interactive session not excluded', finalizeExclusion(pa) === null);
const fsdk = writeLines('claude-sdk.jsonl', [cUser('S', 's1', T0, 'x', { entrypoint: 'sdk-cli' })]);
check('claude: sdk-cli excluded', finalizeExclusion(await parseClaude(fsdk)) === 'claude-sdk-cli');
const fbg = writeLines('claude-bg.jsonl', [cUser('G', 'g1', T0, 'x', { sessionKind: 'bg' })]);
check('claude: bg excluded', finalizeExclusion(await parseClaude(fbg)) === 'claude-bg');
const ftmp = writeLines('claude-tmp.jsonl', [cUser('T', 't1', T0, 'x', { cwd: '/private/tmp/probe' })]);
check('claude: temp cwd excluded', finalizeExclusion(await parseClaude(ftmp)) === 'temp-cwd');
const ffix = writeLines('claude-fix.jsonl', [cUser('F', 'f1', T0, 'x', { cwd: '/Users/x/repo/.runtime/te2/iso' })]);
check('claude: .runtime fixture cwd excluded', finalizeExclusion(await parseClaude(ffix)) === 'runtime-fixture-cwd');

// ==== 3. Codex 解析 ===========================================================
const cxMeta = (id, originator, source, cwd) => JSON.stringify({ timestamp: iso(T0), ordinal: 0, type: 'session_meta', payload: { id, cwd, originator, source } });
const cxTask = (t) => JSON.stringify({ timestamp: iso(t), type: 'event_msg', payload: { type: 'task_started' } });
const cxUser = (t, text) => JSON.stringify({ timestamp: iso(t), type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'text', text }] } } });
const cxAgent = (t, text) => JSON.stringify({ timestamp: iso(t), type: 'event_msg', payload: { type: 'item_completed', item: { type: 'AgentMessage', phase: 'final_answer', content: [{ type: 'Text', text }] } } });
const cxAct = (t) => JSON.stringify({ timestamp: iso(t), type: 'response_item', payload: { type: 'function_call' } });
const fx = writeLines('codex-x.jsonl', [
  cxMeta('X', 'Codex Desktop', 'vscode', cwdB),
  cxTask(T0), cxUser(T0, 'BETA 首句'), cxAct(T0 + MIN), cxAgent(T0 + 2 * MIN, 'CXREPLY1'),
  cxTask(T0 + 100 * MIN), cxUser(T0 + 100 * MIN, 'BETA 隔很久'), cxAgent(T0 + 101 * MIN, 'CXREPLY2'),
  cxTask(T0 + 105 * MIN), cxUser(T0 + 105 * MIN, '<heartbeat>auto</heartbeat>'),
]);
const px = await parseCodex(fx);
check('codex: human inputs (2), automation dropped', px.inputs.length === 2 && px.drops['system-injection'] === 1, JSON.stringify(px.drops));
check('codex: gap uses activity before the turn started', Math.round(px.inputs[1].gapMs / MIN) === 98, String(px.inputs[1].gapMs / MIN));
check('codex: not excluded', finalizeExclusion(px) === null);
const fsub = writeLines('codex-sub.jsonl', [JSON.stringify({ timestamp: iso(T0), type: 'session_meta', payload: { id: 'Z', cwd: cwdB, originator: 'Codex Desktop', source: { subagent: {} } } })]);
check('codex: subagent excluded', finalizeExclusion(await parseCodex(fsub)) === 'codex-subagent');
const fjev = writeLines('codex-jev.jsonl', [cxMeta('J', 'jev-task-router', 'vscode', cwdB)]);
check('codex: jev-originated excluded', finalizeExclusion(await parseCodex(fjev)).startsWith('codex-originator:'));
const fexec = writeLines('codex-exec.jsonl', [cxMeta('E', 'codex_exec', 'exec', cwdB)]);
check('codex: exec excluded', finalizeExclusion(await parseCodex(fexec)) === 'codex-exec');

// ==== 4. 防泄漏：卡片 ==========================================================
const asOfs = pa.inputs.map((i) => iso(i.t));
let cardOk = true, queryOk = true, futureOk = true, detail = '';
for (const [k, inp] of pa.inputs.entries()) {
  const card = await buildCard('claude', fa, iso(inp.t));
  if (k === 0) { if (card !== null) { cardOk = false; detail += 'first-input card should be null;'; } continue; }
  const blob = JSON.stringify(card);
  if (!(Date.parse(card.startedAt) < inp.t && Date.parse(card.updatedAt) < inp.t)) { cardOk = false; detail += `ts@${k};`; }
  // 查询文本里有唯一标记（"第N句"），目标卡片不得出现当前这句
  if (blob.includes(inp.text)) { queryOk = false; detail += `query@${k};`; }
  // 此后才出现的内容（后续输入/回复/标题）不得出现
  const future = pa.inputs.slice(k + 1).map((i) => i.text).concat(pa.replies.filter((r) => r.t >= inp.t).map((r) => r.text));
  if (future.some((f) => blob.includes(f))) { futureOk = false; detail += `future@${k};`; }
}
check('leak: card timestamps < query time', cardOk, detail);
check('leak: query text not in target card', queryOk, detail);
check('leak: no future input/reply content in card', futureOk, detail);
const cardAtSecond = await buildCard('claude', fa, asOfs[1]);
check('leak: asOf equal to input time excludes that input (strict <)', cardAtSecond.turns === 1 && !JSON.stringify(cardAtSecond).includes('第二句'));
const cardBeforeAll = await buildCard('claude', fa, iso(T0));
check('leak: asOf at first input -> no card', cardBeforeAll === null);
const cardTitleEarly = await buildCard('claude', fa, asOfs[2]); // 标题行在文件里出现在 a3 之后
check('leak: title appearing later in file is not used before it exists', cardTitleEarly.title === null, String(cardTitleEarly.title));
const cardTitleLate = await buildCard('claude', fa, iso(T0 + 300 * MIN));
check('leak: title used once it exists', cardTitleLate.title === 'ALPHA TITLE' && cardTitleLate.turns === 4);

// ==== 5. resume 复制文件 → 同一逻辑会话 =========================================
const fa2 = writeLines('claude-a-resume.jsonl', [
  cUser('A2', 'a1', T0, 'ALPHA 首句'), cAsst('A2', T0 + MIN, 'REPLY1'),
  cUser('A2', 'a2', T0 + 40 * MIN, 'ALPHA 第二句 隔了很久'),
  cUser('A2', 'a-resume', T0 + 400 * MIN, 'RESUME 之后的第一句'),
  cUser('A2', 'a-after', T0 + 402 * MIN, 'RESUME 之后的第二句'),
]);
const pa2 = await parseClaude(fa2);
const { logical: lg1, mergedGroups } = groupLogical([pa, pa2, px].filter((s) => finalizeExclusion(s) === null));
check('resume-copy: merged into one logical session', mergedGroups === 1 && lg1.filter((l) => l.provider === 'claude').length === 1, `groups=${mergedGroups}`);
const claudeL = lg1.find((l) => l.provider === 'claude');
check('resume-copy: inputs deduped (a1..a4 + 2 new = 6)', claudeL.inputs.length === 6, String(claudeL.inputs.length));
const S1 = buildSamples(lg1, { gapMin: 30, heldoutFrac: 0.4 });
const newClaude = S1.samples.filter((s) => s.kind === 'new' && s.provider === 'claude');
check('resume-copy: one NEW sample for the logical session (no double-count)', newClaude.length === 1);
const resumeSample = S1.samples.find((s) => s.text.startsWith('RESUME 之后的第一句'));
check('resume-copy: first novel input after resume labelled continue (reason resume-copy)', resumeSample?.kind === 'continue' && resumeSample.reason === 'resume-copy');
const afterSample = S1.samples.find((s) => s.text.startsWith('RESUME 之后的第二句'));
check('resume-copy: second input 2min later is not a continuation', afterSample === undefined);
check('samples: gap>=30min continues (35min yes, 9min no)', S1.samples.some((s) => s.text.startsWith('ALPHA 第二句')) && !S1.samples.some((s) => s.text.startsWith('ALPHA 第三句')));
check('samples: gap sensitivity monotone', S1.sens[10] >= S1.sens[30] && S1.sens[30] >= S1.sens[120]);
const devMax = Math.max(...S1.samples.filter((s) => s.split === 'dev').map((s) => Date.parse(s.t)));
const heldMin = Math.min(...S1.samples.filter((s) => s.split === 'heldout').map((s) => Date.parse(s.t)));
check('split: every dev sample is earlier than every held-out sample', devMax < heldMin, `${devMax} ${heldMin}`);

// ==== 6. 防泄漏：候选池 + 评测器 ================================================
const logicalForRun = lg1; // A(claude,合并) 与 X(codex)
const sessionsSorted = loadSessions(JSON.parse(JSON.stringify(logicalForRun)));
const lateT = iso(T0 + 3 * MIN);
const poolEarly = await poolCardsAt(sessionsSorted, lateT);
check('pool: only sessions that already existed (X starts at T0 too -> strict <)', poolEarly.every((c) => Date.parse(c.updatedAt) < Date.parse(lateT)));
const poolBefore = await poolCardsAt(sessionsSorted, iso(T0));
check('pool: nothing exists at the first input time', poolBefore.length === 0);

// 在 Router 内部断言每一次调用的候选池：卡片时间 < 查询时间、查询文本不在目标卡片
const textToT = new Map(S1.samples.map((s) => [s.text, s.t]));
let routerViolations = 0, routerCalls = 0;
const auditRouter = {
  async route(text, ctx) {
    routerCalls++;
    const qt = Date.parse(textToT.get(text));
    for (const c of ctx.cards) {
      if (!(Date.parse(c.startedAt) < qt && Date.parse(c.updatedAt) < qt)) routerViolations++;
      if (JSON.stringify(c).includes(text)) routerViolations++;
    }
    return { kind: 'clarify', options: [], reason: 'audit', latencyMs: 0, costUsd: null, model: null };
  },
};
await evaluate({ router: auditRouter, samples: S1.samples, sessions: sessionsSorted, concurrency: 2 });
check('evaluator: every router call saw a leak-free pool', routerViolations === 0 && routerCalls === S1.samples.length, `violations=${routerViolations} calls=${routerCalls}`);

// ==== 7. 打分 / 指标必须能推翻 ===================================================
const lbl = (p, id) => ({ provider: p, sessionId: id });
const cardsFx = [
  { provider: 'claude', sessionId: 'A', cwd: cwdA }, { provider: 'claude', sessionId: 'B', cwd: cwdA }, { provider: 'codex', sessionId: 'C', cwd: cwdB },
];
const mk = (label, text = '继续', extra = {}) => ({ id: 'x', kind: label === 'NEW' ? 'new' : 'continue', provider: 'claude', label, text, cwd: cwdA, tags: [], ...extra });
const cont = (p, id, conf = 0.9) => ({ kind: 'continue', provider: p, sessionId: id, confidence: conf, reason: '', latencyMs: 1, costUsd: 0.001 });
const sd = (s, d) => scoreDecision(s, d, cardsFx);
check('score: correct continue', sd(mk(lbl('claude', 'A')), cont('claude', 'A')).outcome === 'ok-continue');
const wrong = sd(mk(lbl('claude', 'A')), cont('claude', 'B'));
check('score: wrong session = A1 (same-project type)', wrong.outcome === 'A1' && wrong.a1Type === 'wrong-session/same-project', JSON.stringify(wrong));
check('score: wrong session cross project typed', sd(mk(lbl('claude', 'A')), cont('codex', 'C')).a1Type === 'wrong-session/other-project');
const n2o = sd(mk('NEW'), cont('claude', 'A'));
check('score: NEW label continued into old session = A1', n2o.outcome === 'A1' && n2o.a1Type.startsWith('new-labelled-continued-old'));
check('score: auto-new for continue label = B1 (not A1)', sd(mk(lbl('claude', 'A')), { kind: 'new', provider: 'claude', cwd: null, confidence: 0.9, latencyMs: 1 }).outcome === 'B1');
check('score: auto-new for NEW label ok', sd(mk('NEW'), { kind: 'new', provider: 'claude', cwd: null, confidence: 0.9, latencyMs: 1 }).outcome === 'ok-new');
const opts = (...ids) => ({ kind: 'clarify', options: ids.map(([p, i]) => ({ provider: p, sessionId: i, probability: 0.3 })), latencyMs: 1 });
const clar = sd(mk(lbl('claude', 'A')), opts(['claude', 'B'], ['codex', 'C'], ['claude', 'A']));
check('score: clarify top-3 hit but not top-1', clar.outcome === 'clarify' && clar.top3 && !clar.top1);
check('score: clarify top-3 miss', !sd(mk(lbl('claude', 'A')), opts(['claude', 'B'], ['codex', 'C'], ['codex', 'D'], ['claude', 'A'])).top3);
check('score: router error excluded from scoring', sd(mk(lbl('claude', 'A')), { kind: 'clarify', options: [], error: 'x' }).outcome === 'error');

// 坏路由必须被抓出：总是续进"最近"的会话 → A1 > 0；永远澄清 → A1 = 0 且自动送达率 0
const rowsOf = (decideFn, samples) => samples.map((s) => { const d = decideFn(s); return { sample: s, decision: d, scored: scoreDecision(s, d, cardsFx), latencyMs: d.latencyMs ?? 1, costUsd: d.costUsd ?? null, conf: d.confidence ?? null, top1Correct: false }; });
const synth = [mk(lbl('claude', 'A')), mk(lbl('claude', 'B')), mk(lbl('codex', 'C')), mk('NEW'), mk('NEW')];
const sumBad = summarize(rowsOf(() => cont('claude', 'A'), synth));
check('metrics: always-continue router is caught (A1 = 4 of 5)', sumBad.A1.count === 4 && sumBad.A1.fromNewLabel === 2, JSON.stringify(sumBad.A1));
const sumClar = summarize(rowsOf(() => opts(['claude', 'A']), synth));
check('metrics: always-clarify has A1 0 and auto-delivery 0', sumClar.A1.count === 0 && sumClar.autoDeliveryRate === 0);
const oracle = summarize(rowsOf((s) => (s.label === 'NEW' ? { kind: 'new', provider: 'claude', cwd: null, confidence: 0.99, latencyMs: 1 } : cont(s.label.provider, s.label.sessionId)), synth));
check('metrics: oracle has A1 0, B1 0, auto-delivery 1', oracle.A1.count === 0 && oracle.B1.count === 0 && oracle.autoDeliveryRate === 1);
check('metrics: zero-event upper bound = rule of three', Math.abs(upper95(0, 300) - 0.01) < 1e-12 && oracle.A1.upper95Zero === 3 / 5);
check('metrics: nonzero events use Wilson bound > point estimate', upper95(2, 100) > 0.02);
const rc = riskCoverage([{ conf: 0.99, correct: true }, { conf: 0.95, correct: true }, { conf: 0.9, correct: false }, { conf: 0.8, correct: true }]);
check('risk-coverage: zero-error coverage stops before first error', rc.zeroErrorCovered === 2 && rc.zeroErrorMaxCoverage === 0.5);
const rc2 = riskCoverage([{ conf: 0.9, correct: false }, { conf: 0.9, correct: true }]);
check('risk-coverage: tied confidence with an error does not count as zero-error', rc2.zeroErrorCovered === 0);

// ==== 8. 留出集账本 / 哈希冻结（真实运行 eval.mjs，桩 Router） ====================
const dataDir = path.join(tmp, 'data');
fs.mkdirSync(dataDir);
writeJsonl(path.join(dataDir, 'dev.jsonl'), S1.samples.filter((s) => s.split === 'dev'));
const heldFile = path.join(dataDir, 'heldout.jsonl');
writeJsonl(heldFile, S1.samples.filter((s) => s.split === 'heldout'));
fs.writeFileSync(path.join(dataDir, 'heldout.sha256'), `${sha256File(heldFile)}  heldout.jsonl\n`);
fs.writeFileSync(path.join(dataDir, 'sessions.json'), JSON.stringify(logicalForRun));
const runEval = (extra, env = {}) => spawnSync(process.execPath, [path.join(here, 'eval.mjs'), '--router', path.join(here, 'routers/stub-clarify.mjs'), '--data', dataDir, ...extra], { encoding: 'utf8', env: { ...process.env, ...env } });
const r1 = runEval(['--set', 'heldout']);
check('ledger: first held-out run for a version succeeds', r1.status === 0, r1.stderr.slice(0, 300));
const r2 = runEval(['--set', 'heldout']);
check('ledger: same version again is rejected', r2.status === 3, `status=${r2.status} ${r2.stderr.slice(0, 200)}`);
const r3 = runEval(['--set', 'heldout'], { STUB_VERSION: 'stub-clarify-v2' });
check('ledger: a new version may run once', r3.status === 0, r3.stderr.slice(0, 200));
const r4 = runEval(['--set', 'heldout', '--limit', '1'], { STUB_VERSION: 'stub-clarify-v3' });
check('ledger: --limit on held-out is rejected', r4.status === 1);
const ledger = fs.readFileSync(path.join(dataDir, 'heldout-ledger.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
check('ledger: started+finished recorded per run (2 runs -> 4 lines)', ledger.length === 4 && ledger.filter((l) => l.status === 'finished').length === 2, String(ledger.length));
fs.appendFileSync(heldFile, JSON.stringify({ id: 'tamper' }) + '\n');
const r5 = runEval(['--set', 'heldout'], { STUB_VERSION: 'stub-clarify-v4' });
check('freeze: tampered held-out file is rejected by hash', r5.status === 2);
const r6 = runEval(['--set', 'dev']);
check('dev runs are repeatable and do not touch the ledger', r6.status === 0 && fs.readFileSync(path.join(dataDir, 'heldout-ledger.jsonl'), 'utf8').trim().split('\n').length === 4, r6.stderr.slice(0, 200));

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} PASS, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
