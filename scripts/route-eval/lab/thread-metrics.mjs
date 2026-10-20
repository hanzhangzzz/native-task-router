// Router v3.1 会话层指标：自动路由里"项目对且线程对 / 项目对线程错 / 项目错"，按三档（≥0.95 direct、0.85–0.95 fork）拆分。
// 项目真值：续接 = 目标会话的目录；新建 = 样本目录（该目录当时不在候选池里 → 真值为 NEW_PROJECT）。
// 线程真值：续接 → 同一会话 id；新建 → 决策为 NEW（项目内新开或新目录）。
// 用法：node scripts/route-eval/lab/thread-metrics.mjs <results.jsonl> --set dev|heldout [--out <file.json>]
//   旧格式（v3.0 r3，行里没有 chosenCwd）按候选池与 reason 里的项目名还原决策目录。
import fs from 'node:fs';
import { loadSamples, poolFor } from './data.mjs';

const args = process.argv.slice(2);
const file = args[0];
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const SET = arg('--set', 'dev');
const OUT = arg('--out', null);
const rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const samples = new Map(loadSamples(SET).map((s) => [s.id, s]));
const base2 = (cwd) => (cwd ?? '').split('/').filter(Boolean).slice(-2).join('/');
const q = (xs, p) => { const a = xs.filter((x) => typeof x === 'number').sort((x, y) => x - y); return a.length ? a[Math.min(a.length - 1, Math.ceil(p * a.length) - 1)] : null; };

const out = { file, set: SET, n: rows.length, errors: 0, auto: 0, tiers: {}, all: { ok: 0, threadWrong: 0, projWrong: 0 }, threadWrongTypes: {}, projWrongTypes: {}, clarify: { n: 0, contN: 0, top1: 0, top3: 0, newFirst: 0, newN: 0 }, latency: {}, cost: {} };
const tier = (c) => (c >= 0.95 ? 'direct' : 'fork');
const lat = [], costs = [];
const details = [];
for (const r of rows) {
  const s = samples.get(r.id);
  const d = r.decision;
  if (d.error) { out.errors++; continue; }
  const modelCalled = d.via ? d.via === 'model' : r.latencyMs > 100;
  if (modelCalled) { lat.push(r.latencyMs); if (typeof r.costUsd === 'number') costs.push(r.costUsd); }
  if (d.kind === 'clarify') {
    out.clarify.n++;
    if (s.label !== 'NEW') { out.clarify.contN++; if (r.top1) out.clarify.top1++; if (r.top3) out.clarify.top3++; }
    continue;
  }
  out.auto++;
  let chosenCwd = r.chosenCwd, targetCwd = r.targetCwd, inPool = r.targetProjectInPool;
  if (chosenCwd === undefined) {
    const pool = await poolFor(s);
    const cwds = [...new Set(pool.map((c) => c.cwd))];
    targetCwd = s.label === 'NEW' ? s.cwd : pool.find((c) => `${c.provider}:${c.sessionId}` === r.label)?.cwd ?? null;
    inPool = cwds.includes(targetCwd);
    if (d.kind === 'continue') chosenCwd = pool.find((c) => `${c.provider}:${c.sessionId}` === d.chosen)?.cwd ?? null;
    else { const m = (d.reason ?? '').match(/属于项目 (\S+?)，/); chosenCwd = m ? cwds.find((c) => base2(c) === m[1]) ?? `?${m[1]}` : null; }
  }
  const truthProject = inPool ? targetCwd : 'NEW_PROJECT';
  const decProject = chosenCwd ?? 'NEW_PROJECT';
  const projOK = decProject === truthProject;
  const threadOK = s.label === 'NEW' ? d.kind === 'new' : d.kind === 'continue' && d.chosen === r.label;
  const cls = projOK && threadOK ? 'ok' : projOK ? 'threadWrong' : 'projWrong';
  const tr = tier(d.confidence);
  out.tiers[tr] ??= { auto: 0, ok: 0, threadWrong: 0, projWrong: 0, continueDecisions: 0, newDecisions: 0, conf: [] };
  const T = out.tiers[tr];
  T.auto++; T[cls]++; T[d.kind === 'continue' ? 'continueDecisions' : 'newDecisions']++; T.conf.push(d.confidence);
  out.all[cls]++;
  const typ = `${s.label === 'NEW' ? 'label-new' : 'label-continue'}→${d.kind === 'continue' ? 'continue' : decProject === 'NEW_PROJECT' ? 'new-project' : 'new-in-project'}`;
  if (cls === 'threadWrong') out.threadWrongTypes[typ] = (out.threadWrongTypes[typ] ?? 0) + 1;
  if (cls === 'projWrong') out.projWrongTypes[typ] = (out.projWrongTypes[typ] ?? 0) + 1;
  if (cls !== 'ok') details.push({ id: r.id, cls, tier: tr, conf: d.confidence, typ, tags: s.tags });
}
for (const T of Object.values(out.tiers)) { T.confRange = [Math.min(...T.conf), Math.max(...T.conf)]; delete T.conf; }
out.autoRate = +(out.auto / (out.n - out.errors)).toFixed(3);
out.latency = { modelCalls: lat.length, p50: q(lat, 0.5), p90: q(lat, 0.9) };
out.cost = { calls: costs.length, totalUsd: +costs.reduce((a, b) => a + b, 0).toFixed(4), perCallUsd: costs.length ? +(costs.reduce((a, b) => a + b, 0) / costs.length).toFixed(4) : null };
out.details = details;
if (OUT) fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
console.log(JSON.stringify({ ...out, details: undefined }, null, 1));
