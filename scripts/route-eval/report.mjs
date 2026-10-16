// 把一次运行的 results.jsonl 汇总成 Markdown 表（只含聚合数字，可进报告）。
// 用法：node scripts/route-eval/report.mjs <runDir> [--adv]   （--adv：只统计对抗标签子集）
import fs from 'node:fs';
import path from 'node:path';
import { readJsonl } from './lib.mjs';
import { summarize } from './metrics.mjs';

const runDir = process.argv[2];
const advOnly = process.argv.includes('--adv');
const ADV = ['short-followup', 'same-project-multi', 'cross-tool-same-project', 'new-in-existing-project', 'exact-repeat-of-earlier'];
const rows = readJsonl(path.join(runDir, 'results.jsonl')).map((r) => ({
  sample: { kind: r.kind, provider: r.provider, tags: r.tags, label: r.label === 'NEW' ? 'NEW' : { provider: r.label.split(':')[0], sessionId: r.label.slice(r.label.indexOf(':') + 1) } },
  decision: { kind: r.decision.kind, candidates: r.candidates, raw: null },
  scored: { outcome: r.outcome, a1Type: r.a1Type, top1: r.top1, top3: r.top3, diag: r.diag },
  latencyMs: r.latencyMs, costUsd: r.costUsd, conf: r.conf, top1Correct: r.top1Correct,
}));
const sel = advOnly ? rows.filter((r) => r.sample.tags.some((t) => ADV.includes(t))) : rows;
const f = (x, d = 1) => (x === null || x === undefined ? '–' : `${(x * 100).toFixed(d)}%`);
const slices = {
  all: sel, 'continue(软标签外)': sel.filter((r) => r.sample.kind === 'continue'), 'new(软标签)': sel.filter((r) => r.sample.kind === 'new'),
  'provider=claude': sel.filter((r) => r.sample.provider === 'claude'), 'provider=codex': sel.filter((r) => r.sample.provider === 'codex'),
};
for (const t of ADV) slices[`tag=${t}`] = sel.filter((r) => r.sample.tags.includes(t));
console.log('| 切片 | n | 自动决策 | 自动送达率 | A1(续接标签) | A1(NEW标签) | A1 95%上界 | B1(续接→自动新建) | 澄清前3命中 | 续接可达* |');
console.log('|---|---|---|---|---|---|---|---|---|---|');
for (const [name, rs] of Object.entries(slices)) {
  if (!rs.length) continue;
  const s = summarize(rs);
  console.log(`| ${name} | ${s.n} | ${s.autoDecisions} | ${f(s.autoDeliveryRate)} | ${s.A1.fromContinueLabel} | ${s.A1.fromNewLabel} | ${f(s.A1.upper95)} | ${s.B1.count}/${s.B1.ofContinueLabel} (${f(s.B1.rate)}) | ${s.clarifyTop3.hit}/${s.clarifyTop3.of} (${f(s.clarifyTop3.rate)}) | ${f(s.contReachable)} |`);
}
const all = summarize(sel);
console.log('\nA1 类型分布:', JSON.stringify(all.A1.types), '\nA1 侧面:', JSON.stringify(all.A1.facets));
console.log('召回 recall@k(续接样本):', JSON.stringify(Object.fromEntries(Object.entries(all.recallAtK).map(([k, v]) => [k, f(v)]))));
console.log(`时延 p50=${all.latencyMs.p50}ms p95=${all.latencyMs.p95}ms；费用 $${all.cost.totalUsd.toFixed(4)}（${all.cost.calls} 次，均 $${all.cost.perCallUsd?.toFixed(5)}）；错误 ${all.errors}`);
console.log('风险-覆盖(top1置信度阈值 → 覆盖/错误):', all.riskCoverage.table.map((r) => `${r.threshold}:${f(r.coverage)}/${r.errors}`).join('  '), `；零错误最大覆盖 ${f(all.riskCoverage.zeroErrorMaxCoverage)}`);
