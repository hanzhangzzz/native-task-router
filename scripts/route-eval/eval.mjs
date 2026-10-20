// 评测器 CLI（TE-3）。
// 用法：node scripts/route-eval/eval.mjs --router scripts/route-eval/routers/jev-baseline.mjs --set dev|heldout|adversarial
//         [--limit N] [--concurrency 3] [--max-cost 5] [--retries 2] [--data <dir>]
// 留出集纪律：每个策略版本只能跑一次。启动前先把 {版本, 时间} 写进账本 heldout-ledger.jsonl，
// 同一版本再次出现一律拒绝（即使上一次中途失败——看过部分结果同样算看过）；留出集文件哈希必须与冻结值一致。
// 逐条结果：<data>/runs/<版本>-<时间>/results.jsonl，汇总：summary.json（不含任何原文）。

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_OUT, readJsonl, writeJsonl, appendJsonl, sha256File } from './lib.mjs';
import { loadSessions, evaluate, rowForDisk } from './runner.mjs';

const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const DATA = arg('--data', DEFAULT_OUT);
const SET = arg('--set', 'dev');
const routerPath = arg('--router');
if (!routerPath) { console.error('缺少 --router <module>'); process.exit(1); }
const limit = arg('--limit') ? Number(arg('--limit')) : null;
const concurrency = Number(arg('--concurrency', 3));
const maxCost = Number(arg('--max-cost', 5));
const retries = Number(arg('--retries', 2));

const mod = await import(pathToFileURL(path.resolve(routerPath)).href);
const version = mod.version;
if (!version) { console.error('Router 模块必须导出 version（策略版本）'); process.exit(1); }
const router = await mod.create();

let samples = readJsonl(path.join(DATA, `${SET}.jsonl`));
const ledgerPath = path.join(DATA, 'heldout-ledger.jsonl');
const ts = new Date().toISOString();

if (SET === 'heldout') {
  if (limit) { console.error('留出集不允许 --limit（部分运行同样算看过结果）'); process.exit(1); }
  const frozen = fs.readFileSync(path.join(DATA, 'heldout.sha256'), 'utf8').split(/\s+/)[0];
  const actual = sha256File(path.join(DATA, 'heldout.jsonl'));
  if (frozen !== actual) { console.error(`拒绝：heldout.jsonl 哈希 ${actual} 与冻结值 ${frozen} 不一致`); process.exit(2); }
  const prior = fs.existsSync(ledgerPath) ? readJsonl(ledgerPath).filter((r) => r.version === version) : [];
  if (prior.length) { console.error(`拒绝：策略版本 ${version} 已在 ${prior[0].time} 跑过留出集（账本 ${ledgerPath}）。换新版本号再跑。`); process.exit(3); }
  appendJsonl(ledgerPath, { version, time: ts, status: 'started', heldoutSha256: actual, n: samples.length, notes: mod.notes ?? null, preregistered: mod.preregistered ?? null });
} else if (limit) samples = samples.slice(0, limit);

const logical = JSON.parse(fs.readFileSync(path.join(DATA, 'sessions.json'), 'utf8'));
const sessions = loadSessions(logical);

const runDir = path.join(DATA, 'runs', `${version}-${ts.replace(/[:.]/g, '-')}-${SET}`);
fs.mkdirSync(runDir, { recursive: true });
const resultsFile = path.join(runDir, 'results.jsonl');
fs.writeFileSync(resultsFile, '');
let done = 0;
let spentSoFar = 0;
const t0 = Date.now();
const out = await evaluate({
  router, samples, sessions, concurrency, maxCostUsd: maxCost, retries,
  onRow: (r) => {
    appendJsonl(resultsFile, rowForDisk(r));
    spentSoFar += r.costUsd ?? 0;
    if (++done % 25 === 0) console.error(`  ${done}/${samples.length} cost=$${spentSoFar.toFixed(3)}`);
  },
});

const summary = {
  version, set: SET, time: ts, wallSeconds: Math.round((Date.now() - t0) / 1000), model: mod.model ?? null,
  notes: mod.notes ?? null, n: samples.length, ran: out.rows.length, skippedForBudget: out.skipped, budgetStopped: out.budgetStopped,
  spentUsd: out.spentUsd, slices: out.slices,
};
fs.writeFileSync(path.join(runDir, 'summary.json'), JSON.stringify(summary, null, 2));
if (SET === 'heldout') appendJsonl(ledgerPath, { version, time: new Date().toISOString(), status: 'finished', runDir, ran: out.rows.length, all: { A1: out.slices.all.A1.count, autoDecisions: out.slices.all.autoDecisions, autoDeliveryRate: out.slices.all.autoDeliveryRate, B1: out.slices.all.B1.rate, top3: out.slices.all.clarifyTop3.rate, spentUsd: out.spentUsd } });
console.log(`run: ${runDir}`);
const a = out.slices.all;
console.log(JSON.stringify({ ran: out.rows.length, errors: a.errors, A1: a.A1.count, autoDecisions: a.autoDecisions, autoDeliveryRate: a.autoDeliveryRate, B1: a.B1.count, clarifyTop3: a.clarifyTop3, spentUsd: out.spentUsd, latencyMs: a.latencyMs, budgetStopped: out.budgetStopped }, null, 2));
