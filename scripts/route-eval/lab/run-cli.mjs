// 用 claude -p 跑决策实验：node run-cli.mjs --name <run> --model sonnet [--subset stride:3] [--order recent-first] [--set dev]
import fs from 'node:fs';
import path from 'node:path';
import { loadSamples, poolFor, cardId } from './data.mjs';
import { LAB_DIR, pool as cpool } from './llm.mjs';
import { score } from './decide.mjs';
import * as V2 from '../../../src/layers/router/v2.ts';
import { claudeCli } from './claude-cli.mjs';
const args = process.argv.slice(2); const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const name = arg('--name'), model = arg('--model', 'sonnet'), order = arg('--order', 'recent-first'), SET = arg('--set', 'dev'), cand = arg('--cand', 'u20');
if (SET === 'heldout' && !process.env.NTR_HELDOUT_OK) { console.error('实验脚本不得读取留出集'); process.exit(1); }
let samples = loadSamples(SET); const sub = arg('--subset'); if (sub?.startsWith('stride:')) { const k = +sub.slice(7); samples = samples.filter((_, i) => i % k === 0); }
const rows = await cpool(samples, Number(arg('--conc', 4)), async (s) => {
  const cards = await poolFor(s); const c = cand === 'all' ? cards : V2.selectCandidates(s.text, { cards, live: [], previous: s.prev ?? null }, V2.DEFAULT_POLICY.recallRecent, V2.DEFAULT_POLICY.recallLexical);
  const labeled = V2.labelCards(c, order); const msgs = V2.buildMessages(s.text, labeled, s.prev, Date.parse(s.t));
  const r = await claudeCli({ model, system: msgs[0].content, user: msgs[1].content });
  const p = V2.parseOutput(r.text, labeled);
  return { id: s.id, order, model: `cli-${model}`, nCand: labeled.length, ...p, orderIds: labeled.map((x) => cardId(x.card)), promptChars: msgs[1].content.length, latencyMs: r.latencyMs, cached: r.cached, error: r.error, costUsd: 0 };
});
const file = path.join(LAB_DIR, 'runs', `${name}.jsonl`); fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
const lat = rows.filter((r) => !r.error && !r.cached).map((r) => r.latencyMs).sort((a, b) => a - b);
console.log(JSON.stringify({ name, n: samples.length, ...score(rows, samples), p50: lat[Math.floor(lat.length / 2)], p95: lat[Math.floor(lat.length * 0.95)] }));
