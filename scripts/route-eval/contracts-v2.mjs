// 评测集 v2 契约测试（TE-4b）：全部合成夹具。node scripts/route-eval/contracts-v2.mjs
// 覆盖：生产卡片接入与防泄漏（含 Codex 同一输入两条记录的 1ms 时间戳偏差）、Codex 标题按 updated_at 防泄漏、
// 按 provider 分层切分、"上一句"信号、斜杠命令不算人话、bg 任务入库。变异检查：边距设为 0 时泄漏测试必须失败。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseClaude, parseCodex, cleanUserText } from './parse.mjs';
import { buildSamples, attachPrev } from './dataset.mjs';
import { buildProdCard, CUT_MARGIN_MS } from './prod-cards.mjs';
import { parseClaudeLines } from '../../src/layers/providers/claude.ts';

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name} ${detail}`); }
};
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'route-eval-contracts2-'));
const iso = (ms) => new Date(ms).toISOString();
const T0 = Date.parse('2026-09-01T00:00:00Z');
const MIN = 60000;
const cwdA = '/Users/fixture/projA', cwdB = '/Users/fixture/projB';
const wr = (name, lines) => { const f = path.join(tmp, name); fs.writeFileSync(f, lines.join('\n') + '\n'); return f; };

// ---- 夹具：Codex rollout 与真实结构一致——同一条用户输入有 response_item（先）和 event_msg（后 1ms） ----
const CX_ID = '01a12a10-f2b6-7ec2-859f-de99d4f522c7';
const cxFile = `rollout-2026-09-01T00-00-00-${CX_ID}.jsonl`;
const cxMeta = JSON.stringify({ timestamp: iso(T0), type: 'session_meta', payload: { id: CX_ID, cwd: cwdB, originator: 'codex-tui', source: 'cli', timestamp: iso(T0) } });
const cxResp = (t, role, text) => JSON.stringify({ timestamp: iso(t), type: 'response_item', payload: { type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }], ...(role === 'assistant' ? { phase: 'final_answer' } : {}) } });
const cxEvt = (t, text) => JSON.stringify({ timestamp: iso(t), type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'text', text }] } } });
const cxTask = (t) => JSON.stringify({ timestamp: iso(t), type: 'event_msg', payload: { type: 'task_started' } });
const q1 = 'CODEX-Q1 首句内容', q2 = 'CODEX-Q2 隔很久之后的第二句', q3 = 'CODEX-Q3 更晚的第三句';
const tq2 = T0 + 100 * MIN, tq3 = T0 + 300 * MIN;
const cxPath = path.join(tmp, cxFile);
fs.writeFileSync(cxPath, [
  cxMeta,
  cxTask(T0), cxResp(T0 + 5, 'user', q1), cxEvt(T0 + 6, q1), cxResp(T0 + MIN, 'assistant', 'CXREPLY1'),
  cxTask(tq2), cxResp(tq2 - 1, 'user', q2), cxEvt(tq2, q2), cxResp(tq2 + MIN, 'assistant', 'CXREPLY2'),
  cxTask(tq3), cxResp(tq3 - 1, 'user', q3), cxEvt(tq3, q3),
].join('\n') + '\n');

// ==== 1. Codex 防泄漏：事件时间戳比 response_item 晚 1ms，查询本身仍不得进自己的卡片 ====
const px = await parseCodex(cxPath);
check('codex fixture: events parsed with event_msg timestamps', px.inputs.length === 3 && px.inputs[1].t === tq2, JSON.stringify(px.inputs.map((i) => i.t - T0)));
const cardQ2 = await buildProdCard('codex', cxPath, iso(tq2), { titles: false });
check('leak: Codex query text not in its own session card (1ms record skew)', cardQ2 && !JSON.stringify(cardQ2).includes('CODEX-Q2'), JSON.stringify(cardQ2)?.slice(0, 200));
check('leak: Codex card keeps earlier turns (turns = 1, first prompt Q1)', cardQ2.turns === 1 && cardQ2.firstPrompt.includes('CODEX-Q1'));
const cardQ3 = await buildProdCard('codex', cxPath, iso(tq3), { titles: false });
check('leak: Codex card at Q3 has Q1+Q2 but not Q3 and not future', cardQ3.turns === 2 && !JSON.stringify(cardQ3).includes('CODEX-Q3'));
check('leak: no card before the first input', (await buildProdCard('codex', cxPath, iso(T0 + 3), { titles: false })) === null);
// 变异检查：把边距降到 0（只防 1ms 都不到）→ 泄漏测试必须能抓到。这里直接用生产 asOf=tq2-1 复现旧行为。
const { cardFromCodexLines, codexLineWanted } = await import('../../src/layers/providers/codex.ts');
const { readRelevantLines } = await import('../../src/layers/providers/common.ts');
const rawLines = await readRelevantLines(cxPath, codexLineWanted);
const naive = cardFromCodexLines(rawLines, { asOf: iso(tq2 - 1) });
check('mutation: naive asOf = t-1ms leaks the query (so the margin is load-bearing)', JSON.stringify(naive).includes('CODEX-Q2'));
check('card margin constant is >= 1s', CUT_MARGIN_MS >= 1000);

// ==== 2. Codex 标题：updated_at 早于查询时刻才用 ====
const titles = new Map([[CX_ID, { name: 'CODEX-TITLE', updatedMs: tq2 + 10 * MIN }]]);
const cEarly = await buildProdCard('codex', cxPath, iso(tq2), { titleIndex: titles });
const cLate = await buildProdCard('codex', cxPath, iso(tq3), { titleIndex: titles });
check('title: updated_at after query -> title not used', cEarly.title === null, String(cEarly.title));
check('title: updated_at before query -> title used', cLate.title === 'CODEX-TITLE', String(cLate.title));

// ==== 3. Claude：生产卡片 + 斜杠命令 + bg ====
const cu = (sid, t, text, extra = {}) => JSON.stringify({ type: 'user', uuid: `${sid}-${t}`, sessionId: sid, timestamp: iso(t), cwd: cwdA, entrypoint: 'cli', isSidechain: false, message: { role: 'user', content: text }, ...extra });
const ca = (sid, t, text) => JSON.stringify({ type: 'assistant', sessionId: sid, timestamp: iso(t), isSidechain: false, message: { role: 'assistant', content: [{ type: 'text', text }] } });
const CL = '11111111-1111-4111-8111-111111111111';
const clPath = wr(`${CL}.jsonl`, [
  cu(CL, T0, 'CLAUDE-Q1 首句'), ca(CL, T0 + MIN, 'CLREPLY1'),
  cu(CL, T0 + 2 * MIN, '<command-name>/model</command-name><command-args>sonnet</command-args>'),
  cu(CL, T0 + 90 * MIN, 'CLAUDE-Q2 隔很久'),
  JSON.stringify({ type: 'ai-title', aiTitle: 'CL-TITLE', sessionId: CL }),
  ca(CL, T0 + 91 * MIN, 'CLREPLY2'),
]);
const cl1 = await buildProdCard('claude', clPath, iso(T0 + 90 * MIN));
check('claude prod card: query not in card, earlier turn kept, builtin slash not counted', cl1.turns === 1 && !JSON.stringify(cl1).includes('CLAUDE-Q2') && cl1.firstPrompt.includes('CLAUDE-Q1'), JSON.stringify(cl1));
check('claude prod card: title that appears later in file is not used early', cl1.title === null);
const cl2 = await buildProdCard('claude', clPath, iso(T0 + 200 * MIN));
check('claude prod card: title used once present', cl2.title === 'CL-TITLE' && cl2.turns === 2);
const pcl = await parseClaude(clPath);
check('events: builtin slash command (/model sonnet) is not a human input', pcl.inputs.length === 2, JSON.stringify(pcl.inputs.map((i) => i.text)));
check('clean: bare skill-like slash with args still kept', cleanUserText('<command-name>/loop</command-name><command-args>检查部署</command-args>').text === '检查部署');
const BG = '22222222-2222-4222-8222-222222222222';
const bgLines = [cu(BG, T0, 'BG 任务', { entrypoint: 'sdk-cli', sessionKind: 'bg' }), ca(BG, T0 + MIN, 'ok')];
check('production parser admits a bg sdk-cli task (pool) ', 'card' in parseClaudeLines(bgLines, { sessionId: BG }));
const sdkLines = [cu(BG, T0, 'SDK', { entrypoint: 'sdk-cli' })];
check('production parser rejects plain sdk-cli', 'excluded' in parseClaudeLines(sdkLines, { sessionId: BG }));

// ==== 4. 按 provider 分层切分 ====
const mkL = (provider, id, baseT, n) => {
  const inputs = [];
  for (let k = 0; k < n; k++) inputs.push({ t: baseT + k * 60 * MIN, text: `${id}-input-${k}`, id: `${id}-${k}`, gapMs: k === 0 ? null : 60 * MIN, viaResumeCopy: false });
  return { key: `${provider}:${id}`, provider, sessionId: id, files: [], cwd: provider === 'claude' ? cwdA : cwdB, firstInputT: inputs[0].t, inputs, replies: [], titles: [] };
};
// codex 在 9 月上半月活跃，claude 在 9 月下半月才开始
const lg = [mkL('codex', 'cx1', T0, 11), mkL('codex', 'cx2', T0 + 20 * 60 * MIN, 11), mkL('claude', 'cl1', T0 + 15 * 24 * 60 * MIN, 11), mkL('claude', 'cl2', T0 + 16 * 24 * 60 * MIN, 11)];
const S = buildSamples(lg, { gapMin: 30, heldoutFrac: 0.4, splitBy: 'provider' });
for (const p of ['codex', 'claude']) {
  const mine = S.samples.filter((s) => s.provider === p);
  const devMax = Math.max(...mine.filter((s) => s.split === 'dev').map((s) => Date.parse(s.t)));
  const heldMin = Math.min(...mine.filter((s) => s.split === 'heldout').map((s) => Date.parse(s.t)));
  check(`split: ${p} has both dev and held-out, dev strictly earlier within provider`, Number.isFinite(devMax) && Number.isFinite(heldMin) && devMax < heldMin);
  const conts = mine.filter((s) => s.kind === 'continue');
  const heldFrac = conts.filter((s) => s.split === 'heldout').length / conts.length;
  check(`split: ${p} held-out fraction about 40% of continuations`, Math.abs(heldFrac - 0.4) <= 0.1, String(heldFrac));
}
const G = buildSamples(lg, { gapMin: 30, heldoutFrac: 0.4 });
const gc = G.samples.filter((s) => s.provider === 'claude' && s.kind === 'continue');
check('split: global split starves claude of dev samples (why stratification is needed)', gc.filter((s) => s.split === 'dev').length / gc.length < 0.3);

// ==== 5. 上一句信号 ====
const all = [
  { t: T0, text: '很久以前', provider: 'claude', sessionId: 'old' },
  { t: T0 + 100 * MIN, text: '十分钟前说的话', provider: 'codex', sessionId: 'cx' },
  { t: T0 + 105 * MIN, text: '同一时刻的另一条', provider: 'claude', sessionId: 'cl' },
];
const smp = (min, label) => ({ t: iso(T0 + min * MIN), kind: label === 'NEW' ? 'new' : 'continue', label });
const ss = [smp(110, { provider: 'claude', sessionId: 'cl' }), smp(105, 'NEW'), smp(300, 'NEW'), smp(70, 'NEW')];
const n = attachPrev(ss, all, 60);
check('prev: picks the latest earlier input within 60 min', ss[0].prev.utterance === '同一时刻的另一条' && ss[0].prev.minutesAgo === 5);
check('prev: input at exactly query time is not "previous" (strict <)', ss[1].prev.utterance === '十分钟前说的话');
check('prev: nothing within the window -> null (no fabrication)', ss[2].prev === null && ss[3].prev === null && n === 2);
check('prev: flags when previous input was in the target session itself', ss[0].prevSameAsTarget === true && ss[1].prevSameAsTarget === false);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} PASS, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
