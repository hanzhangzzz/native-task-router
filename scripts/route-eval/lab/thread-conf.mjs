// v3.2 诊断：自动决策里，线程置信度能否区分线程对错？（只读结果文件，不调模型）
// 用法：node scripts/route-eval/lab/thread-conf.mjs <results.jsonl> [--set dev]
import fs from 'node:fs';
import { loadSamples } from './data.mjs';
const args = process.argv.slice(2);
const SET = args.includes('--set') ? args[args.indexOf('--set') + 1] : 'dev';
const samples = new Map(loadSamples(SET).map((s) => [s.id, s]));
const rows = fs.readFileSync(args[0], 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const pts = [];
for (const r of rows) {
  const d = r.decision;
  if (d.kind === 'clarify' || d.error) continue;
  const s = samples.get(r.id);
  const truth = r.targetProjectInPool ? r.targetCwd : null;
  const projOK = (r.chosenCwd ?? null) === truth;
  const threadOK = s.label === 'NEW' ? d.kind === 'new' : d.kind === 'continue' && d.chosen === r.label;
  pts.push({ tc: d.threadConfidence, pc: d.modelConfidence, kind: d.kind, delivery: d.delivery, projOK, threadOK });
}
const band = (x) => (x == null ? 'null' : x >= 0.9 ? '>=0.90' : x >= 0.85 ? '0.85-0.90' : x >= 0.8 ? '0.80-0.85' : x >= 0.7 ? '0.70-0.80' : x >= 0.6 ? '0.60-0.70' : '<0.60');
const tab = {};
for (const p of pts) { const k = `${p.kind === 'new' ? 'new' : p.delivery} ${band(p.tc)}`; tab[k] ??= { n: 0, ok: 0, threadWrong: 0, projWrong: 0 }; tab[k].n++; if (!p.projOK) tab[k].projWrong++; else if (!p.threadOK) tab[k].threadWrong++; else tab[k].ok++; }
console.log(Object.entries(tab).sort().map(([k, v]) => `${k}\t${v.n}\t${v.ok}\t${v.threadWrong}\t${v.projWrong}`).join('\n'));
const N = rows.length;
for (const t of [0, 0.7, 0.8, 0.85, 0.9]) {
  const sel = pts.filter((p) => (p.tc ?? 0) >= t);
  const fork = sel.filter((p) => p.delivery === 'fork' && p.kind === 'continue');
  console.log(`若自动还要求线程置信度 ≥${t}: 自动 ${sel.length} (${(100 * sel.length / N).toFixed(1)}%) 全对 ${sel.filter((p) => p.projOK && p.threadOK).length} 线程错 ${sel.filter((p) => p.projOK && !p.threadOK).length} 项目错 ${sel.filter((p) => !p.projOK).length}; 分叉续接 ${fork.length} 全对 ${fork.filter((p) => p.projOK && p.threadOK).length}`);
}
