// E4 闸门分析：读多个 run 的逐条结果，对信号组合算 A1 / 自动覆盖（只用 dev）。
import fs from 'node:fs';
import path from 'node:path';
import { LAB_DIR, } from './llm.mjs';
import { loadSamples, labelOf } from './data.mjs';
const rd = (n) => new Map(fs.readFileSync(path.join(LAB_DIR, 'runs', `${n}.jsonl`), 'utf8').split('\n').filter(Boolean).map((l) => { const r = JSON.parse(l); return [r.id, r]; }));
const samples = loadSamples('dev'); const byId = new Map(samples.map((s) => [s.id, s]));
export function auroc(pos, neg) { if (!pos.length || !neg.length) return null; let w = 0; for (const p of pos) for (const n of neg) w += p > n ? 1 : p === n ? 0.5 : 0; return +(w / (pos.length * neg.length)).toFixed(3); }
const names = process.argv.slice(2);
const runs = names.map(rd);
const ids = [...runs[0].keys()].filter((id) => runs.every((r) => r.get(id)?.ok));
const rows = ids.map((id) => {
  const s = byId.get(id), lab = labelOf(s), rs = runs.map((r) => r.get(id));
  const c = rs[0].choice; const agree = rs.every((r) => r.choice === c);
  const prevHit = s.prev && c === `${s.prev.provider}:${s.prev.sessionId}`;
  return { id, ok: c === lab, agree, conf: Math.min(...rs.map((r) => r.confidence ?? 0)), c, isNew: c === 'NEW', prevHit: !!prevHit, prevMin: s.prev?.minutesAgo ?? null, lab };
});
console.log('n', rows.length, 'acc', (rows.filter((r) => r.ok).length / rows.length).toFixed(3));
console.log('AUROC conf', auroc(rows.filter((r) => r.ok).map((r) => r.conf), rows.filter((r) => !r.ok).map((r) => r.conf)), 'agree', auroc(rows.filter((r) => r.ok).map((r) => +r.agree), rows.filter((r) => !r.ok).map((r) => +r.agree)));
for (const T of [0.5, 0.7, 0.8, 0.85, 0.9, 0.95, 0.98]) for (const need of [false, true]) {
  const sel = rows.filter((r) => r.conf >= T && (!need || r.agree));
  const bad = sel.filter((r) => !r.ok).length;
  console.log(`T=${T} agree=${need} auto=${sel.length} A1=${bad} (newPicked=${sel.filter((r) => r.isNew).length}, newBad=${sel.filter((r) => r.isNew && !r.ok).length})`);
}
