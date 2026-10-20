// 步骤 0（Router v3.1，不调模型）：项目内给模型看几条线程、多长时间窗，才能覆盖续接目标？
// 对 dev+heldout 的续接样本，在样本时刻 t 的候选池里统计：目标线程在所属项目内按最近活跃的排名、目标距 t 多久、
// 项目内时间窗内活跃线程数；以及目标项目是否在最近活跃前 40 个项目里。
// 用法：node scripts/route-eval/lab/exp-thread-k.mjs  → stdout 汇总 + .runtime/route-eval/v2/lab-thread/step0.json
import fs from 'node:fs';
import path from 'node:path';
import { loadSamples, poolFor, labelOf, cardId, V2_DIR } from './data.mjs';

const OUT = path.join(V2_DIR, 'lab-thread');
fs.mkdirSync(OUT, { recursive: true });
const DAY = 86_400_000;
const rows = [];
for (const set of ['dev', 'heldout']) {
  for (const s of loadSamples(set)) {
    const t = Date.parse(s.t);
    const cards = await poolFor(s);
    const byCwd = new Map();
    for (const c of cards) (byCwd.get(c.cwd) ?? byCwd.set(c.cwd, []).get(c.cwd)).push(c);
    for (const v of byCwd.values()) v.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const projOrder = [...byCwd.entries()].sort((a, b) => b[1][0].updatedAt.localeCompare(a[1][0].updatedAt)).map(([cwd]) => cwd);
    if (s.kind === 'continue') {
      const want = labelOf(s);
      const tc = cards.find((c) => cardId(c) === want);
      if (!tc) { rows.push({ set, id: s.id, kind: s.kind, missing: true }); continue; }
      const cs = byCwd.get(tc.cwd);
      const rank = cs.findIndex((c) => cardId(c) === want) + 1;
      const age = (t - Date.parse(tc.updatedAt)) / DAY;
      const inW = (d) => cs.filter((c) => t - Date.parse(c.updatedAt) <= d * DAY).length;
      rows.push({ set, id: s.id, kind: s.kind, rank, ageDays: age, projThreads: cs.length, act7: inW(7), act14: inW(14), act30: inW(30), projRank: projOrder.indexOf(tc.cwd) + 1, short: (s.tags ?? []).includes('short-followup') });
    } else {
      const cs = byCwd.get(s.cwd) ?? [];
      rows.push({ set, id: s.id, kind: s.kind, projThreads: cs.length, act14: cs.filter((c) => t - Date.parse(c.updatedAt) <= 14 * DAY).length, projRank: cs.length ? projOrder.indexOf(s.cwd) + 1 : null });
    }
  }
}
fs.writeFileSync(path.join(OUT, 'step0-rows.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

const q = (xs, p) => { const a = [...xs].sort((x, y) => x - y); return a.length ? a[Math.min(a.length - 1, Math.ceil(p * a.length) - 1)] : null; };
const pct = (a, b) => (b ? +(100 * a / b).toFixed(1) : null);
const cont = rows.filter((r) => r.kind === 'continue' && !r.missing);
const out = { n: { continue: cont.length, missing: rows.filter((r) => r.missing).length, new: rows.filter((r) => r.kind === 'new').length } };
out.projInTop40 = pct(cont.filter((r) => r.projRank <= 40).length, cont.length);
out.rankDist = Object.fromEntries([1, 2, 3, 4, 5, 6, 8, 10].map((k) => [`<=${k}`, pct(cont.filter((r) => r.rank <= k).length, cont.length)]));
out.ageDist = Object.fromEntries([1, 3, 7, 14, 21, 30, 60].map((d) => [`<=${d}d`, pct(cont.filter((r) => r.ageDays <= d).length, cont.length)]));
// 覆盖率：列出项目内"时间窗内活跃"的前 K 条；minOne=true 时窗内为空也至少列最近一条
const cover = (K, W, minOne) => cont.filter((r) => r.rank <= K && (r.ageDays <= W || (minOne && r.rank === 1))).length;
out.coverage = {};
for (const W of [7, 14, 30, Infinity]) for (const K of [2, 3, 4, 5, 6, 8]) {
  out.coverage[`K${K}/W${W}`] = { strict: pct(cover(K, W, false), cont.length), minOne: pct(cover(K, W, true), cont.length) };
}
out.coverageDevHeldout = {};
for (const set of ['dev', 'heldout']) {
  const c = cont.filter((r) => r.set === set);
  out.coverageDevHeldout[set] = { n: c.length, 'K4/W14': pct(c.filter((r) => r.rank <= 4 && r.ageDays <= 14).length, c.length), rank1: pct(c.filter((r) => r.rank === 1).length, c.length) };
}
out.projThreadsAll = { p50: q(cont.map((r) => r.projThreads), 0.5), p90: q(cont.map((r) => r.projThreads), 0.9), max: Math.max(...cont.map((r) => r.projThreads)) };
out.act14 = { p50: q(cont.map((r) => r.act14), 0.5), p90: q(cont.map((r) => r.act14), 0.9), max: Math.max(...cont.map((r) => r.act14)), gt4: pct(cont.filter((r) => r.act14 > 4).length, cont.length) };
out.notCovered_K4W14 = cont.filter((r) => !(r.rank <= 4 && r.ageDays <= 14)).map((r) => ({ id: r.id, rank: r.rank, ageDays: +r.ageDays.toFixed(1), act14: r.act14 }));
fs.writeFileSync(path.join(OUT, 'step0.json'), JSON.stringify(out, null, 2));
console.log(JSON.stringify({ ...out, notCovered_K4W14: out.notCovered_K4W14.length }, null, 2));
