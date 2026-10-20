// Router v3.1 档位标定（只在 dev 上用）：取每条进模型样本的模型首选（ranked[0] 与 modelConfidence），不论当时是否自动，
// 按"续接决策"与"NEW 决策"分别扫描阈值。
//   直接档：≥D 的续接决策项目错 0 且线程错 ≤5% 的最低 D；分叉档：[F, D) 内"项目对且线程对" ≥90% 的最低 F；
//   NEW：≥N 的 NEW 决策项目正确率 ≥90% 的最低 N。
// 用法：node scripts/route-eval/lab/calibrate.mjs <results.jsonl> [--set dev] [--out file.json]
import fs from 'node:fs';
import { loadSamples, poolFor } from './data.mjs';

const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const SET = arg('--set', 'dev');
const rows = fs.readFileSync(args[0], 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const samples = new Map(loadSamples(SET).map((s) => [s.id, s]));
const N_ALL = rows.length;

const pts = [];
for (const r of rows) {
  const d = r.decision;
  if (d.via !== 'model' || d.modelConfidence == null || !d.ranked?.length || d.ranked[0].p == null) continue;
  const s = samples.get(r.id);
  const top = d.ranked[0];
  const pool = await poolFor(s);
  const truth = r.targetProjectInPool ? r.targetCwd : null;
  const isNew = !!top.new;
  const proj = isNew ? (top.cwd ?? null) : (pool.find((c) => `${c.provider}:${c.sessionId}` === top.id)?.cwd ?? '?');
  const projOK = proj === truth;
  const threadOK = r.label === 'NEW' ? isNew : !isNew && top.id === r.label;
  pts.push({ id: r.id, conf: d.modelConfidence, isNew, projOK, threadOK, labelNew: r.label === 'NEW' });
}
const stat = (xs) => ({ n: xs.length, ok: xs.filter((p) => p.projOK && p.threadOK).length, threadWrong: xs.filter((p) => p.projOK && !p.threadOK).length, projWrong: xs.filter((p) => !p.projOK).length });
const cont = pts.filter((p) => !p.isNew), neu = pts.filter((p) => p.isNew);
const cands = [...new Set([0.7, 0.75, 0.8, 0.85, 0.88, 0.9, 0.92, 0.93, 0.95, ...cont.map((p) => p.conf), ...neu.map((p) => p.conf)].filter((c) => c >= 0.5))].sort((a, b) => a - b);

const contTable = cands.map((t) => ({ t, ...stat(cont.filter((p) => p.conf >= t)) }));
const direct = contTable.find((r) => r.n > 0 && r.projWrong === 0 && r.threadWrong / r.n <= 0.05) ?? null;
const D = direct?.t ?? Infinity;
const forkTable = cands.filter((t) => t < D).map((t) => ({ t, ...stat(cont.filter((p) => p.conf >= t && p.conf < D)) }));
const fork = forkTable.find((r) => r.n > 0 && r.ok / r.n >= 0.9) ?? null;
const newTable = cands.map((t) => { const xs = neu.filter((p) => p.conf >= t); return { t, n: xs.length, projOK: xs.filter((p) => p.projOK).length, projWrong: xs.filter((p) => !p.projOK).length, truthNotNew: xs.filter((p) => !p.labelNew).length }; });
const newPick = newTable.find((r) => r.n > 0 && r.projOK / r.n >= 0.9) ?? null;
const bucket = (lo, hi) => { const xs = neu.filter((p) => p.conf >= lo && p.conf < hi); return { range: `[${lo}, ${hi})`, n: xs.length, projOK: xs.filter((p) => p.projOK).length, projWrong: xs.filter((p) => !p.projOK).length, truthNotNew: xs.filter((p) => !p.labelNew).length, projOK_truthNew: xs.filter((p) => p.projOK && p.labelNew).length }; };
const newBuckets = [[0, 0.5], [0.5, 0.6], [0.6, 0.7], [0.7, 0.8], [0.8, 0.85], [0.85, 0.9], [0.9, 1.01]].map(([a, b]) => bucket(a, b));

// 选定阈值下的整体自动结果
const sim = (D, F, N) => {
  const auto = pts.filter((p) => (p.isNew ? p.conf >= N : p.conf >= F));
  const dir = cont.filter((p) => p.conf >= D), frk = cont.filter((p) => p.conf >= F && p.conf < D), nw = neu.filter((p) => p.conf >= N);
  return { auto: auto.length, autoRate: +(auto.length / N_ALL).toFixed(3), all: stat(auto), direct: stat(dir), fork: stat(frk), new: stat(nw) };
};
const out = { n: N_ALL, modelPoints: pts.length, cont: cont.length, new: neu.length, contTable, direct, forkTable, fork, newTable, newPick, newBuckets,
  chosen: { D: direct?.t ?? null, F: fork?.t ?? null, N: newPick?.t ?? null },
  simChosen: sim(direct?.t ?? Infinity, fork?.t ?? Infinity, newPick?.t ?? Infinity), simV31Default: sim(0.95, 0.85, 0.85) };
if (arg('--out')) fs.writeFileSync(arg('--out'), JSON.stringify(out, null, 2));
const pr = (rs) => rs.map((r) => Object.values(r).join('\t')).join('\n');
console.log(`points ${pts.length} (cont ${cont.length}, new ${neu.length}) of ${N_ALL}`);
console.log('continue ≥t: t n ok threadWrong projWrong\n' + pr(contTable));
console.log('direct', direct, '\nfork [F,D): t n ok tw pw\n' + pr(forkTable), '\nfork', fork);
console.log('NEW ≥t: t n projOK projWrong truthNotNew\n' + pr(newTable), '\nnewPick', newPick);
console.log('NEW buckets', newBuckets);
console.log('chosen', out.chosen, JSON.stringify(out.simChosen), '\nv3.1 default', JSON.stringify(out.simV31Default));
