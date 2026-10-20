// Router v3.2 线程阈值表：对同一次运行的逐条结果做事后过滤，给出 t=0 / 0.7 / 0.8 下的指标（不调模型）。
// 每条进模型样本的首选去处取 ranked[0]，置信度取 modelConfidence（项目）与 threadConfidence（线程），按生产闸门重放：
//   项目 ≥0.85 且线程 ≥t → 自动；NEW → 新建；续接且项目 ≥0.95、线程 ≥0.85 → 直接，否则分叉。
// 候选 t 值在 dev 上预先定（0 / 0.7 / 0.8）。用法：node scripts/route-eval/lab/thread-gate.mjs <results.jsonl> --set dev|heldout [--out f.json]
import fs from 'node:fs';
import { loadSamples, poolFor } from './data.mjs';

const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const SET = arg('--set', 'dev');
const rows = fs.readFileSync(args[0], 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const samples = new Map(loadSamples(SET).map((s) => [s.id, s]));
const N = rows.length;
const pts = [];
for (const r of rows) {
  const d = r.decision;
  if (d.via !== 'model' || d.error || d.modelConfidence == null || !d.ranked?.[0] || d.ranked[0].p == null) continue;
  const s = samples.get(r.id);
  const top = d.ranked[0];
  const pool = await poolFor(s);
  const truth = r.targetProjectInPool ? r.targetCwd : null;
  const isNew = !!top.new;
  const proj = isNew ? top.cwd ?? null : pool.find((c) => `${c.provider}:${c.sessionId}` === top.id)?.cwd ?? '?';
  const threadOK = s.label === 'NEW' ? isNew : !isNew && top.id === r.label;
  pts.push({ id: r.id, pc: d.modelConfidence, tc: d.threadConfidence, isNew, projOK: proj === truth, threadOK, actual: d.kind });
}
const cls = (p) => (!p.projOK ? 'projWrong' : !p.threadOK ? 'threadWrong' : 'ok');
const stat = (xs) => { const o = { n: xs.length, ok: 0, threadWrong: 0, projWrong: 0 }; for (const p of xs) o[cls(p)]++; return o; };
function table(t) {
  const auto = pts.filter((p) => p.pc >= 0.85 && (p.tc ?? -1) >= t);
  const tier = (p) => (p.isNew ? 'new' : p.pc >= 0.95 && p.tc >= 0.85 ? 'direct' : 'fork');
  const by = (k) => stat(auto.filter((p) => tier(p) === k));
  const all = stat(auto);
  return { t, auto: auto.length, autoRate: +(auto.length / N).toFixed(3), ...all, threadWrongRate: auto.length ? +(all.threadWrong / auto.length).toFixed(3) : null, direct: by('direct'), fork: { ...by('fork'), okRate: null }, new: by('new') };
}
const out = { file: args[0], set: SET, n: N, modelPoints: pts.length, tables: [0, 0.7, 0.8].map(table) };
for (const tb of out.tables) tb.fork.okRate = tb.fork.n ? +(tb.fork.ok / tb.fork.n).toFixed(3) : null;
if (arg('--out')) fs.writeFileSync(arg('--out'), JSON.stringify(out, null, 2));
for (const tb of out.tables) console.log(JSON.stringify(tb));
