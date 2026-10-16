// 评测集 v2 挖掘（TE-4b）：生产卡片口径 + 按 provider 分层的时间切分 + "上一句"语境信号。
// 用法：node scripts/route-eval/mine2.mjs [--gap-min 30] [--heldout 0.4] [--until <iso>] [--out <dir>]
// 输出（默认 <主检出>/.runtime/route-eval/v2/，gitignore；v1 数据与账本保持不动）：
//   sessions.json  候选池里的全部会话（= 生产 listSessions 会返回的），含文件路径与首条相关行时间
//   dev.jsonl / heldout.jsonl / adversarial.jsonl / heldout.sha256 / mine-stats.json（聚合，不含原文）
// 与 v1 的差异：
//   1. 候选池 = TE-1 生产实现接受的会话（含 bg 任务；不含已归档 Codex，因为它们现在不能直接 resume）；
//      卡片 = 生产 cardFromClaudeLines/cardFromCodexLines（prod-cards.mjs，asOf 严格小于）；
//   2. 查询来源 = 池内、且按评测去噪规则含真人输入的会话（Jev 自己派发的 Codex 会话、探针夹具、Chrome 侧栏等只进候选池、不产生查询）；
//   3. 每个 provider 内按时间切分，早的约 60% 进 dev；
//   4. 每条样本带 prev：查询前 60 分钟内用户在任意会话里最近一条人工输入（存活/前台会话历史里没有，不伪造）。
// 留出集一旦存在就拒绝覆盖（冻结）。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseClaudeLines, claudeLineWanted } from '../../src/layers/providers/claude.ts';
import { parseCodexLines, codexLineWanted } from '../../src/layers/providers/codex.ts';
import { readRelevantLines, listJsonl } from '../../src/layers/providers/common.ts';
import { parseClaude, parseCodex, finalizeExclusion } from './parse.mjs';
import { buildSamples, attachPrev } from './dataset.mjs';
import { buildProdCard, describeSession, releaseLines } from './prod-cards.mjs';
import { DEFAULT_OUT, readJsonl, writeJsonl, sha256File } from './lib.mjs';

const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const GAP_MIN = Number(arg('--gap-min', 30));
const HELDOUT_FRAC = Number(arg('--heldout', 0.4));
const OUT = arg('--out', path.join(DEFAULT_OUT, 'v2'));
const PREV_WINDOW_MIN = 60;
const statsPath = path.join(OUT, 'mine-stats.json');
const priorUntil = fs.existsSync(statsPath) ? JSON.parse(fs.readFileSync(statsPath, 'utf8')).until : null;
const UNTIL = Date.parse(arg('--until', priorUntil ?? new Date().toISOString()));

const home = os.homedir();
async function listFiles() {
  const out = [];
  const root = path.join(home, '.claude/projects');
  for (const d of fs.readdirSync(root)) {
    const dir = path.join(root, d);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const f of await listJsonl(dir, false)) out.push({ provider: 'claude', file: f });
  }
  for (const f of await listJsonl(path.join(home, '.codex/sessions'), true)) out.push({ provider: 'codex', file: f });
  return out;
}

const files = await listFiles();
console.error(`扫描 ${files.length} 个原生会话文件…`);
const t0 = Date.now();
const stats = { files: { claude: 0, codex: 0 }, prodExcluded: {}, pool: { claude: 0, codex: 0 }, sourceExcluded: {}, sources: { claude: 0, codex: 0 } };
const accepted = [];
for (const f of files) {
  stats.files[f.provider]++;
  const lines = await readRelevantLines(f.file, f.provider === 'claude' ? claudeLineWanted : codexLineWanted);
  const r = f.provider === 'claude' ? parseClaudeLines(lines, { sessionId: path.basename(f.file, '.jsonl') }) : parseCodexLines(lines);
  if ('excluded' in r) { const k = `${f.provider}:${r.excluded}`; stats.prodExcluded[k] = (stats.prodExcluded[k] ?? 0) + 1; continue; }
  accepted.push({ ...f, card: r.card });
}
console.error(`生产实现接受 ${accepted.length} 个会话 (${((Date.now() - t0) / 1000).toFixed(0)}s)`);

// 同一 provider+sessionId 出现在多个文件里（resume/fork 复制）：生产按文件各出一张卡，这里先量出来
const idCount = new Map();
for (const a of accepted) { const k = `${a.provider}:${a.card.sessionId}`; idCount.set(k, (idCount.get(k) ?? 0) + 1); }
const dupIds = [...idCount.values()].filter((n) => n > 1).length;
if (dupIds) { console.error(`拒绝：${dupIds} 个 sessionId 对应多个文件，v2 尚未定义这种情形的归并口径`); process.exit(2); }

// 完整事件序列（查询文本、真人输入时间、间隔）：沿用 v1 解析器，其文本去噪已叠加生产的"斜杠命令不算人话"
const pool = [];
const logical = [];
for (const a of accepted) {
  stats.pool[a.provider]++;
  const s = a.provider === 'claude' ? await parseClaude(a.file) : await parseCodex(a.file);
  s.inputs = s.inputs.filter((i) => i.t < UNTIL);
  s.replies = s.replies.filter((r) => r.t < UNTIL);
  const why = finalizeExclusion(s);
  const isSource = (why === null || why === 'claude-bg') && s.inputs.length > 0 && s.cwd;
  const firstT = await describeSession(a.provider, a.file);
  pool.push({ key: `${a.provider}:${a.card.sessionId}`, provider: a.provider, sessionId: a.card.sessionId, files: [a.file], cwd: a.card.cwd, firstInputT: firstT, prod: true, source: !!isSource });
  if (!isSource) { const k = `${a.provider}:${why ?? 'no-human-input'}`; stats.sourceExcluded[k] = (stats.sourceExcluded[k] ?? 0) + 1; releaseLines(a.file); continue; }
  stats.sources[a.provider]++;
  logical.push({
    key: `${a.provider}:${a.card.sessionId}`, provider: a.provider, sessionId: a.card.sessionId, files: [a.file], cwd: a.card.cwd,
    firstInputT: s.inputs[0].t, inputs: s.inputs.map((i) => ({ ...i, viaResumeCopy: false })), replies: s.replies, titles: s.titles,
  });
}
logical.sort((a, b) => a.firstInputT - b.firstInputT);
pool.sort((a, b) => a.firstInputT - b.firstInputT);

const built = buildSamples(logical, { gapMin: GAP_MIN, heldoutFrac: HELDOUT_FRAC, splitBy: 'provider' });
let raw = built.samples;

// 生产口径核对：NEW 的前提是此时池里还没有这个会话的卡片（会话先有非真人输入、后有真人输入的，不算"新建"）；
// 续接的前提是目标会话此时在池里有卡片（生产卡片不认为此前有人话的，对生产来说就是新会话，标签不成立）
const poolByKey = new Map(pool.map((p) => [p.key, p]));
const droppedNew = [];
const droppedContinue = [];
raw = (await Promise.all(raw.map(async (s) => {
  const key = s.kind === 'new' ? s.sessionKey : `${s.label.provider}:${s.label.sessionId}`;
  const p = poolByKey.get(key);
  const card = await buildProdCard(p.provider, p.files[0], s.t);
  if (s.kind === 'new' && card) { droppedNew.push(s.id); return null; }
  if (s.kind === 'continue' && !card) { droppedContinue.push(s.id); return null; }
  return s;
}))).filter(Boolean);

// 上一句：查询前 PREV_WINDOW_MIN 分钟内、用户在任意会话里最近一条人工输入
const allInputs = logical.flatMap((L) => L.inputs.map((i) => ({ t: i.t, text: i.text, provider: L.provider, sessionId: L.sessionId, key: L.key }))).sort((a, b) => a.t - b.t);
const nPrev = attachPrev(raw, allInputs, PREV_WINDOW_MIN);
// id 在丢弃 NEW 后重排，保持稳定可复现
raw.forEach((s, i) => { s.id = `${s.split[0]}${String(i).padStart(5, '0')}-${s.kind[0]}`; delete s.sessionKey; });

fs.mkdirSync(OUT, { recursive: true });
const heldPath = path.join(OUT, 'heldout.jsonl');
const dev = raw.filter((s) => s.split === 'dev');
const held = raw.filter((s) => s.split === 'heldout');
if (fs.existsSync(heldPath)) {
  const tmp = path.join(OUT, 'heldout.candidate.jsonl');
  writeJsonl(tmp, held);
  const same = sha256File(tmp) === sha256File(heldPath);
  fs.rmSync(tmp);
  if (!same) { console.error('拒绝：v2 留出集已冻结且新挖掘结果与之不同。'); process.exit(2); }
} else {
  writeJsonl(heldPath, held);
  fs.writeFileSync(path.join(OUT, 'heldout.sha256'), `${sha256File(heldPath)}  heldout.jsonl\n`);
}
writeJsonl(path.join(OUT, 'dev.jsonl'), dev);
const ADV_TAGS = ['short-followup', 'same-project-multi', 'cross-tool-same-project', 'new-in-existing-project', 'exact-repeat-of-earlier'];
writeJsonl(path.join(OUT, 'adversarial.jsonl'), dev.filter((s) => s.tags.some((t) => ADV_TAGS.includes(t))));
fs.writeFileSync(path.join(OUT, 'sessions.json'), JSON.stringify(pool));

const count = (arr, f) => arr.reduce((m, x) => { const k = f(x); m[k] = (m[k] ?? 0) + 1; return m; }, {});
const summarize = (arr) => ({
  total: arr.length, byKind: count(arr, (s) => s.kind), byProvider: count(arr, (s) => `${s.kind}/${s.provider}`),
  withPrev: arr.filter((s) => s.prev).length, prevIsTarget: arr.filter((s) => s.prevSameAsTarget).length,
  tags: count(arr.flatMap((s) => s.tags.map((t) => ({ t }))), (x) => x.t),
  distinctTargetSessions: new Set(arr.filter((s) => s.kind === 'continue').map((s) => `${s.label.provider}:${s.label.sessionId}`)).size,
});
const out = {
  minedAt: new Date().toISOString(), until: new Date(UNTIL).toISOString(), gapMin: GAP_MIN, heldoutFrac: HELDOUT_FRAC, prevWindowMin: PREV_WINDOW_MIN,
  splitBy: 'provider', cutoffByProvider: Object.fromEntries(Object.entries(built.cutoffByProvider).map(([k, v]) => [k, new Date(v).toISOString()])),
  files: stats.files, pool: stats.pool, prodExcluded: stats.prodExcluded, sources: stats.sources, sourceExcluded: stats.sourceExcluded,
  droppedNewBecausePoolAlreadyHadCard: droppedNew.length, droppedContinueBecauseTargetHadNoCard: droppedContinue.length, withPrev: nPrev,
  dev: summarize(dev), heldout: summarize(held), adversarialDev: summarize(dev.filter((s) => s.tags.some((t) => ADV_TAGS.includes(t)))),
  heldoutSha256: sha256File(heldPath),
};
fs.writeFileSync(statsPath, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
