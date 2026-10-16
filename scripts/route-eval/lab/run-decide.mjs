// 通用决策实验运行器（TE-4b）。用法：
//   node run-decide.mjs --name <run> --model ds --order recent-first --cand u20 --set dev [--limit 40] [--no-prev] [--render '{"first":0}']
// 结果逐条写入 <v2>/lab/runs/<name>.jsonl（仅 id、选择、置信度、时延、费用，不含原文）并打印聚合。
import fs from 'node:fs';
import path from 'node:path';
import { loadSamples, poolFor, cardId } from './data.mjs';
import { LAB_DIR, pool as cpool, totalSpent } from './llm.mjs';
import { decideOnce, score, DEFAULT_RENDER } from './decide.mjs';
import { rankRecency, rankBm25 } from './recall.mjs';
import { quantile } from '../metrics.mjs';

const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const name = arg('--name'); const modelKey = arg('--model', 'ds'); const order = arg('--order', 'recent-first');
const candPolicy = arg('--cand', 'u20'); const SET = arg('--set', 'dev'); const limit = arg('--limit') ? Number(arg('--limit')) : null;
const usePrev = !args.includes('--no-prev'); const conc = Number(arg('--conc', 8));
const render = { ...DEFAULT_RENDER, ...(arg('--render') ? JSON.parse(arg('--render')) : {}) };
const subset = arg('--subset'); // 'stride:3' 取每 3 条一个，保证覆盖
if (SET === 'heldout') { console.error('实验脚本不得读取留出集'); process.exit(1); }
if (!name) { console.error('需要 --name'); process.exit(1); }

let samples = loadSamples(SET);
if (subset?.startsWith('stride:')) { const k = Number(subset.slice(7)); samples = samples.filter((_, i) => i % k === 0); }
if (limit) samples = samples.slice(0, limit);

export function candidatesFor(policy, s, cards) {
  if (policy === 'all') return cards;
  const m = policy.match(/^u(\d+)(?:-(\d+))?$/); // uR 或 uR-L
  const R = Number(m[1]), L = Number(m[2] ?? m[1]);
  if (cards.length <= R + L) return cards;
  const u = new Map();
  for (const c of rankRecency(cards).slice(0, R)) u.set(cardId(c), c);
  for (const c of rankBm25(s.text, cards).slice(0, L)) u.set(cardId(c), c);
  if (s.prev && usePrev) { const c = cards.find((x) => x.provider === s.prev.provider && x.sessionId === s.prev.sessionId); if (c) u.set(cardId(c), c); }
  return [...u.values()];
}

const file = path.join(LAB_DIR, 'runs', `${name}.jsonl`);
fs.mkdirSync(path.dirname(file), { recursive: true });
const before = totalSpent();
const t0 = Date.now();
const rows = await cpool(samples, conc, async (s) => {
  const cards = await poolFor(s);
  const cand = candidatesFor(candPolicy, s, cards);
  return decideOnce({ sample: s, cards, candidates: cand, modelKey, order, render, tag: name, usePrev });
});
fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
const sc = score(rows, samples);
const lat = rows.filter((r) => !r.error).map((r) => r.latencyMs);
console.log(JSON.stringify({ name, model: modelKey, order, cand: candPolicy, set: SET, usePrev, n: samples.length, ...sc, p50: quantile(lat, 0.5), p95: quantile(lat, 0.95), cost: +(totalSpent() - before).toFixed(4), avgCand: +(rows.reduce((a, r) => a + r.nCand, 0) / rows.length).toFixed(1), avgPromptTok: Math.round(rows.reduce((a, r) => a + (r.promptTokens ?? 0), 0) / rows.length), wallS: Math.round((Date.now() - t0) / 1000), cumSpend: +totalSpent().toFixed(3) }));
