// 实验数据读取（TE-4b）：样本 + 每条样本"该时刻"的候选池（生产卡片，防泄漏由 prod-cards 保证）。
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_OUT, readJsonl } from '../lib.mjs';
import { loadSessions, poolCardsAt } from '../runner.mjs';

export const V2_DIR = process.env.ROUTE_EVAL_DATA ?? path.join(DEFAULT_OUT, 'v2');
export const cardId = (c) => `${c.provider}:${c.sessionId}`;

let sessions = null;
function sess() {
  if (!sessions) sessions = loadSessions(JSON.parse(fs.readFileSync(path.join(V2_DIR, 'sessions.json'), 'utf8')));
  return sessions;
}
/** set: dev | adversarial | heldout（heldout 只在最终验收脚本里碰）。 */
export function loadSamples(set) { return readJsonl(path.join(V2_DIR, `${set}.jsonl`)); }
export async function poolFor(sample) { return poolCardsAt(sess(), sample.t); }
/** 该样本的正确答案 id（NEW 为 'NEW'）。 */
export const labelOf = (s) => (s.label === 'NEW' ? 'NEW' : `${s.label.provider}:${s.label.sessionId}`);
