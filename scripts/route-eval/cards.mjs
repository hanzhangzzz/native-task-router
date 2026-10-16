// 可插拔的卡片构建接口（TE-3）：buildCard(provider, sessionFile, asOfIso) => SessionCard | null。
//
// 防泄漏的唯一执行点：卡片只用 `t < asOf`（严格小于）的内容。TE-1 的 Provider 导出带 asOf 截断的
// 生产实现后，TE-4b 把 `setCardBuilder` 换成它重跑；评测器只依赖这个接口。
//
// 本文件是评测用的**临时实现**：字段与截断口径对齐 src/layers/types.ts 的 SessionCard。

import { parseSessionFile, CARD_FIELD_MAX, RECENT_PROMPTS } from './parse.mjs';

const clip = (s, n = CARD_FIELD_MAX) => (s.length > n ? s.slice(0, n) : s);

/** 把同一逻辑会话的多个文件（resume/fork 复制了旧历史）合并去重。 */
async function loadMerged(provider, files) {
  const list = Array.isArray(files) ? files : [files];
  const parsed = await Promise.all(list.map((f) => parseSessionFile(provider, f)));
  if (parsed.length === 1) return parsed[0];
  const seen = new Set();
  const inputs = [];
  for (const p of parsed) for (const i of p.inputs) if (!seen.has(i.id)) { seen.add(i.id); inputs.push(i); }
  const rseen = new Set();
  const replies = [];
  for (const p of parsed) for (const r of p.replies) {
    const k = `${r.t}|${r.text}`;
    if (!rseen.has(k)) { rseen.add(k); replies.push(r); }
  }
  inputs.sort((a, b) => a.t - b.t);
  replies.sort((a, b) => a.t - b.t);
  return {
    ...parsed[0],
    inputs, replies, titles: parsed.flatMap((p) => p.titles),
    firstT: Math.min(...parsed.map((p) => p.firstT ?? Infinity)), lastT: Math.max(...parsed.map((p) => p.lastT ?? 0)),
  };
}

export async function buildCardDefault(provider, sessionFile, asOfIso) {
  const asOf = Date.parse(asOfIso);
  const s = await loadMerged(provider, sessionFile);
  const inputs = s.inputs.filter((i) => i.t < asOf);
  if (inputs.length === 0) return null;
  const replies = s.replies.filter((r) => r.t < asOf);
  const finals = replies.filter((r) => r.final !== false);
  const lastReply = (finals.length ? finals : replies).at(-1) ?? null;
  const titles = s.titles.filter((x) => x.t !== null && x.t < asOf);
  const title = titles.at(-1)?.title ?? null;
  const updated = Math.max(inputs.at(-1).t, lastReply?.t ?? 0);
  return {
    provider,
    sessionId: s.sessionId,
    cwd: s.cwd,
    title,
    firstPrompt: clip(inputs[0].text),
    recentPrompts: inputs.slice(-RECENT_PROMPTS).map((i) => clip(i.text)),
    lastReply: lastReply ? lastReply.text : null,
    startedAt: new Date(inputs[0].t).toISOString(),
    updatedAt: new Date(updated).toISOString(),
    turns: inputs.length,
  };
}

let builder = buildCardDefault;
/** TE-4b：换成 TE-1 的生产实现（签名相同）。 */
export function setCardBuilder(fn) { builder = fn; }
export function buildCard(provider, sessionFile, asOfIso) { return builder(provider, sessionFile, asOfIso); }
