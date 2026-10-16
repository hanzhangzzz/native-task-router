// 召回候选排序器（TE-4b E1）：每个排序器 (query, cards, ctx) → cards 的排序（相关度从高到低）。
import { relevantCards } from '../baseline-recall.mjs';
import { cardId } from './data.mjs';
import { cosine } from './embed.mjs';

export const baseName = (cwd) => (cwd ?? '').split('/').filter(Boolean).slice(-2).join('/');

/** 现行 FTS12：直接用生产 relevantCards，同分按最近活动。 */
export function rankFts(query, cards) {
  const tc = cards.map((c) => ({ card: c, goal: (c.title ?? c.firstPrompt ?? '').slice(0, 240), last_input: c.recentPrompts.at(-1) ?? null, last_progress: c.lastReply, workspace_path: c.cwd, last_activity_at: c.updatedAt }));
  tc.sort((a, b) => b.last_activity_at.localeCompare(a.last_activity_at));
  return relevantCards(tc, query).map((x) => x.card);
}

export function rankRecency(cards) { return [...cards].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); }

// ---- 词面：Latin 词 + 路径片段 + 汉字 bigram（单字汉字 run 退为 unigram） ----
export function tokens(text, { unigrams = false } = {}) {
  const t = (text ?? '').toLowerCase();
  const out = [];
  for (const w of t.match(/[a-z0-9][a-z0-9_.-]*[a-z0-9]|[a-z0-9]/g) ?? []) {
    out.push(w);
    for (const p of w.split(/[._-]+/)) if (p.length >= 2 && p !== w) out.push(p);
  }
  for (const run of t.match(/[\p{Script=Han}]+/gu) ?? []) {
    if (run.length === 1) out.push(run);
    else for (let i = 0; i + 1 < run.length; i++) out.push(run.slice(i, i + 2));
    if (unigrams) for (const ch of run) out.push(ch);
  }
  return out;
}

const DEFAULT_W = { title: 3, first: 2, recent: 2, reply: 1, cwd: 2 };
function fieldsOf(c) {
  return { title: c.title ?? '', first: c.firstPrompt ?? '', recent: c.recentPrompts.join('\n'), reply: c.lastReply ?? '', cwd: baseName(c.cwd) };
}
/** BM25F：字段加权词频 + 池内 IDF。 */
export function rankBm25(query, cards, { w = DEFAULT_W, k1 = 1.2, b = 0.5, unigrams = false } = {}) {
  const qs = [...new Set(tokens(query, { unigrams }))];
  if (!qs.length) return rankRecency(cards);
  const docs = cards.map((c) => { const f = fieldsOf(c); const tf = new Map(); let len = 0; for (const [k, v] of Object.entries(f)) for (const tk of tokens(v, { unigrams })) { tf.set(tk, (tf.get(tk) ?? 0) + (w[k] ?? 1)); len += w[k] ?? 1; } return { tf, len }; });
  const avg = docs.reduce((a, d) => a + d.len, 0) / Math.max(1, docs.length) || 1;
  const df = new Map();
  for (const d of docs) for (const t of qs) if (d.tf.has(t)) df.set(t, (df.get(t) ?? 0) + 1);
  const N = docs.length;
  const scored = cards.map((c, i) => {
    const d = docs[i]; let s = 0;
    for (const t of qs) { const f = d.tf.get(t); if (!f) continue; const idf = Math.log(1 + (N - (df.get(t) ?? 0) + 0.5) / ((df.get(t) ?? 0) + 0.5)); s += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * d.len / avg)); }
    return { c, s };
  });
  scored.sort((a, b2) => b2.s - a.s || b2.c.updatedAt.localeCompare(a.c.updatedAt));
  return scored.map((x) => x.c);
}

/** 稠密：cosine(query, card)。vecs: Map<cardKey, Float32Array>，cardKey = cardId + updatedAt + turns。 */
export const cardKey = (c) => `${cardId(c)}|${c.updatedAt}|${c.turns}`;
export function rankDense(qvec, cards, vecs) {
  return cards.map((c) => ({ c, s: vecs.has(cardKey(c)) ? cosine(qvec, vecs.get(cardKey(c))) : -1 })).sort((a, b) => b.s - a.s).map((x) => x.c);
}

/** 倒数排名融合 */
export function rrf(lists, k = 60, weights = null) {
  const sc = new Map(); const byId = new Map();
  lists.forEach((l, li) => l.forEach((c, r) => { const id = cardId(c); byId.set(id, c); sc.set(id, (sc.get(id) ?? 0) + (weights?.[li] ?? 1) / (k + r + 1)); }));
  return [...sc.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => byId.get(id));
}
