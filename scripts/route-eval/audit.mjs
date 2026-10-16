// 真实数据泄漏审计（TE-3）：对 dev / heldout 全部样本重建该时刻候选池，核对每张卡片的时间与内容。
// 只输出聚合计数，不输出原文。node scripts/route-eval/audit.mjs [--data <dir>]
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_OUT, readJsonl } from './lib.mjs';
import { loadSessions, poolCardsAt } from './runner.mjs';

const args = process.argv.slice(2);
const DATA = args.includes('--data') ? args[args.indexOf('--data') + 1] : DEFAULT_OUT;
const sessions = loadSessions(JSON.parse(fs.readFileSync(path.join(DATA, 'sessions.json'), 'utf8')));
const samples = [...readJsonl(path.join(DATA, 'dev.jsonl')), ...readJsonl(path.join(DATA, 'heldout.jsonl'))];
let cards = 0, tsViolations = 0, futureSessionInPool = 0, queryInTarget = 0, queryInTargetLong = 0, queryInOtherCard = 0, targetMissing = 0;
for (const s of samples) {
  const t = Date.parse(s.t);
  const pool = await poolCardsAt(sessions, s.t);
  for (const c of pool) {
    cards++;
    if (!(Date.parse(c.startedAt) < t && Date.parse(c.updatedAt) < t)) tsViolations++;
  }
  for (const L of sessions) if (L.firstInputT >= t && pool.some((c) => c.sessionId === L.sessionId && c.provider === L.provider)) futureSessionInPool++;
  const blob = (c) => JSON.stringify(c);
  if (s.label !== 'NEW') {
    const target = pool.find((c) => c.provider === s.label.provider && c.sessionId === s.label.sessionId);
    if (!target) { targetMissing++; continue; }
    if (blob(target).includes(JSON.stringify(s.text).slice(1, -1))) { queryInTarget++; if ([...s.text].length >= 12) queryInTargetLong++; }
  }
  for (const c of pool) if (s.label === 'NEW' || c.sessionId !== s.label.sessionId) if ([...s.text].length >= 12 && blob(c).includes(JSON.stringify(s.text).slice(1, -1))) queryInOtherCard++;
}
const out = { samples: samples.length, cardsChecked: cards, timestampViolations: tsViolations, futureSessionsInPool: futureSessionInPool, targetMissingFromPool: targetMissing,
  queryVerbatimInTargetCard: { all: queryInTarget, textLen12plus: queryInTargetLong, note: '同一句话在此前已说过（如重复"继续"），属自然重复而非泄漏；长文本重复多为重发/粘贴' }, longQueryVerbatimInOtherCards: queryInOtherCard };
console.log(JSON.stringify(out, null, 2));
process.exit(tsViolations || futureSessionInPool || targetMissing ? 1 : 0);
