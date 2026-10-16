// E1 召回（TE-4b）：dev v2 续接样本上，各排序器 recall@{1,3,10,30,全量}。只用 dev（--set adversarial 可看对抗子集）。
// 用法：node exp-e1.mjs [--set dev] [--dense] 结果追加到 <v2>/lab/e1-<set>.json（聚合数字，不含原文）
import fs from 'node:fs';
import path from 'node:path';
import { loadSamples, poolFor, cardId, labelOf } from './data.mjs';
import { LAB_DIR } from './llm.mjs';
import { embed } from './embed.mjs';
import { rankFts, rankRecency, rankBm25, rankDense, rrf, cardKey, baseName } from './recall.mjs';

const args = process.argv.slice(2);
const SET = args.includes('--set') ? args[args.indexOf('--set') + 1] : 'dev';
const DENSE = args.includes('--dense');
const samples = loadSamples(SET).filter((s) => s.kind === 'continue');
const pools = [];
for (const s of samples) pools.push(await poolFor(s));

export function embedText(c, variant = 'all') {
  const proj = baseName(c.cwd);
  const parts = [c.title ? `标题：${c.title}` : '', `项目：${proj}`, c.firstPrompt ? `首句：${c.firstPrompt.slice(0, 300)}` : '', ...(c.recentPrompts.slice(-3).map((p) => `最近：${p.slice(0, 200)}`))];
  if (variant === 'all' && c.lastReply) parts.push(`回复：${c.lastReply.slice(0, 300)}`);
  return parts.filter(Boolean).join('\n').slice(0, 1600);
}

const rankers = {
  recency: (s, cards) => rankRecency(cards),
  'fts12(prod)': (s, cards) => rankFts(s.text, cards),
  'bm25f-bigram': (s, cards) => rankBm25(s.text, cards),
  'bm25f+uni': (s, cards) => rankBm25(s.text, cards, { unigrams: true }),
  'bm25-title-first-only': (s, cards) => rankBm25(s.text, cards, { w: { title: 3, first: 2, recent: 0, reply: 0, cwd: 2 } }),
  'bm25-user-only': (s, cards) => rankBm25(s.text, cards, { w: { title: 3, first: 2, recent: 2, reply: 0, cwd: 2 } }),
};

const denseModels = DENSE ? ['qwen/qwen3-embedding-8b', 'baai/bge-m3'] : [];
const dense = {};
for (const m of denseModels) {
  const uniq = new Map();
  for (const p of pools) for (const c of p) uniq.set(cardKey(c), c);
  const keys = [...uniq.keys()];
  const qPrefix = m.includes('qwen3') ? 'Instruct: 给定用户刚说的一句话，找出它接着聊的那个编程助手会话\nQuery: ' : '';
  const [cv, qv] = await Promise.all([embed(m, keys.map((k) => embedText(uniq.get(k))), { tag: 'e1' }), embed(m, samples.map((s) => qPrefix + s.text), { tag: 'e1' })]);
  const vecs = new Map(keys.map((k, i) => [k, cv[i]]));
  dense[m] = { vecs, q: new Map(samples.map((s, i) => [s.id, qv[i]])) };
  rankers[`dense:${m.split('/')[1]}`] = (s, cards) => rankDense(dense[m].q.get(s.id), cards, dense[m].vecs);
}
if (DENSE) for (const m of denseModels) {
  const n = m.split('/')[1];
  rankers[`rrf(bm25f,dense:${n})`] = (s, cards) => rrf([rankBm25(s.text, cards), rankDense(dense[m].q.get(s.id), cards, dense[m].vecs)]);
  rankers[`rrf(bm25f,fts12,dense:${n})`] = (s, cards) => rrf([rankBm25(s.text, cards), rankFts(s.text, cards), rankDense(dense[m].q.get(s.id), cards, dense[m].vecs)]);
}
if (DENSE) rankers['rrf(bm25f,dense:both)'] = (s, cards) => rrf([rankBm25(s.text, cards), ...denseModels.map((m) => rankDense(dense[m].q.get(s.id), cards, dense[m].vecs))]);

const KS = [1, 3, 5, 10, 20, 30, 50];
const res = {};
function summarizeRank(name, fn, sel = () => true) {
  const hit = Object.fromEntries(KS.map((k) => [k, 0]));
  let n = 0, hitAll = 0, poolSum = 0;
  samples.forEach((s, i) => {
    if (!sel(s)) return;
    const ranked = fn(s, pools[i]).map(cardId);
    const r = ranked.indexOf(labelOf(s));
    n++; poolSum += ranked.length;
    if (r >= 0) hitAll++;
    for (const k of KS) if (r >= 0 && r < k) hit[k]++;
  });
  return { n, poolAvg: +(poolSum / n).toFixed(1), ...Object.fromEntries(KS.map((k) => [`@${k}`, +(hit[k] / n).toFixed(3)])), all: +(hitAll / n).toFixed(3) };
}
for (const [name, fn] of Object.entries(rankers)) {
  res[name] = {
    all: summarizeRank(name, fn),
    claude: summarizeRank(name, fn, (s) => s.provider === 'claude'),
    codex: summarizeRank(name, fn, (s) => s.provider === 'codex'),
    short: summarizeRank(name, fn, (s) => s.tags.includes('short-followup')),
    sameProject: summarizeRank(name, fn, (s) => s.tags.includes('same-project-multi')),
  };
}
// 语境通道并入：上一句去处 + 最近活跃 3 个（不参与竞争，只保证在场）
function withContext(base, extraRecent = 3) {
  return (s, cards) => {
    const ranked = base(s, cards);
    const forced = [];
    if (s.prev) { const c = cards.find((x) => x.provider === s.prev.provider && x.sessionId === s.prev.sessionId); if (c) forced.push(c); }
    for (const c of rankRecency(cards).slice(0, extraRecent)) if (!forced.includes(c)) forced.push(c);
    return [...forced, ...ranked.filter((c) => !forced.includes(c))];
  };
}
const ctxBase = DENSE ? rankers['rrf(bm25f,dense:both)'] : rankers['bm25f-bigram'];
res['ctx-first + ' + (DENSE ? 'rrf(bm25f,dense:both)' : 'bm25f-bigram')] = { all: summarizeRank('ctx', withContext(ctxBase)), claude: summarizeRank('ctx', withContext(ctxBase), (s) => s.provider === 'claude'), codex: summarizeRank('ctx', withContext(ctxBase), (s) => s.provider === 'codex'), short: summarizeRank('ctx', withContext(ctxBase), (s) => s.tags.includes('short-followup')), sameProject: summarizeRank('ctx', withContext(ctxBase), (s) => s.tags.includes('same-project-multi')) };
const out = { set: SET, continueSamples: samples.length, poolSizeAvg: +(pools.reduce((a, p) => a + p.length, 0) / pools.length).toFixed(1), ks: KS, results: res, time: new Date().toISOString() };
fs.writeFileSync(path.join(LAB_DIR, `e1-${SET}${DENSE ? '-dense' : ''}.json`), JSON.stringify(out, null, 2));
const f = (x) => (x * 100).toFixed(0).padStart(3) + '%';
console.log(`E1 ${SET}: ${samples.length} 续接样本，平均候选池 ${out.poolSizeAvg}`);
console.log('ranker'.padEnd(40), KS.map((k) => ('@' + k).padStart(5)).join(''), '  | claude@3/@10  codex@3/@10  short@3/@10  sameproj@3/@10');
for (const [name, r] of Object.entries(res)) console.log(name.padEnd(40), KS.map((k) => f(r.all['@' + k]).padStart(5)).join(''), '  |', [r.claude, r.codex, r.short, r.sameProject].map((x) => `${f(x['@3'])}/${f(x['@10'])}`).join('   '));
