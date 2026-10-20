// 评测运行核心（TE-3）：对每条样本构造"该时刻"的候选池 → 调用 Router → 打分。
// 防泄漏的结构保证：候选池只含 firstInputT < t 的会话；卡片经 buildCard(…, asOf=t) 严格 `<` 截断。

import { registerParsed } from './parse.mjs';
import { buildCard as defaultBuildCard, buildCardDefault, setCardBuilder } from './cards.mjs';
import { buildProdCard } from './prod-cards.mjs';
import { scoreDecision, summarizeSlices, top1Of } from './metrics.mjs';

/** 把 sessions.json 的逻辑会话预载进解析缓存，返回按首条输入时间排序的会话清单。 */
export function loadSessions(logical) {
  // v2 数据（mine2.mjs）：会话只带文件路径，卡片由生产实现按 asOf 现建
  if (logical.some((L) => L.prod)) {
    setCardBuilder(buildProdCard);
    return [...logical].sort((a, b) => a.firstInputT - b.firstInputT);
  }
  setCardBuilder(buildCardDefault);
  for (const L of logical) {
    registerParsed(L.files[0], {
      provider: L.provider, file: L.files[0], sessionId: L.sessionId, cwd: L.cwd, inputs: L.inputs, replies: L.replies,
      titles: L.titles, firstT: L.inputs[0]?.t ?? null, lastT: null,
    });
  }
  return [...logical].sort((a, b) => a.firstInputT - b.firstInputT);
}

/** 该时刻的候选池卡片（只含此前已存在的会话，卡片只用此前内容）。 */
export async function poolCardsAt(sessions, asOfIso, buildCard = defaultBuildCard) {
  const t = Date.parse(asOfIso);
  const cards = [];
  for (const L of sessions) {
    if (L.firstInputT >= t) break; // sessions 已按 firstInputT 升序
    const c = await buildCard(L.provider, L.files[0], asOfIso);
    if (c) cards.push(c);
  }
  return cards;
}

export async function evaluate({ router, samples, sessions, buildCard = defaultBuildCard, concurrency = 3, maxCostUsd = Infinity, onRow = () => {}, retries = 0 }) {
  const rows = new Array(samples.length);
  let next = 0;
  let spent = 0;
  let budgetStopped = false;
  const worker = async () => {
    while (true) {
      const i = next++;
      if (i >= samples.length) return;
      if (spent >= maxCostUsd) { budgetStopped = true; return; }
      const s = samples[i];
      const cards = await poolCardsAt(sessions, s.t, buildCard);
      const ctx = { cards, live: [], previous: s.prev ?? null, focusedSessionId: null, nowMs: Date.parse(s.t) };
      let decision;
      const started = Date.now();
      for (let attempt = 0; ; attempt++) {
        try {
          decision = await router.route(s.text, ctx);
        } catch (e) {
          decision = { kind: 'clarify', options: [], reason: 'router threw', error: e instanceof Error ? e.message : String(e), latencyMs: Date.now() - started, costUsd: null, model: null };
        }
        if (typeof decision.costUsd === 'number') spent += decision.costUsd;
        if (!decision.error || attempt >= retries) break;
      }
      const scored = scoreDecision(s, decision, cards);
      const top = top1Of(s, decision);
      // 项目层打分用：决策落在哪个目录（新建到新目录为 null）、真值项目（续接 = 目标会话的目录；新建 = 样本目录）
      const chosenCwd = decision.kind === 'continue' ? (cards.find((c) => c.provider === decision.provider && c.sessionId === decision.sessionId)?.cwd ?? null) : decision.kind === 'new' ? (decision.cwd ?? null) : undefined;
      const targetCwd = s.label === 'NEW' ? s.cwd : (cards.find((c) => c.provider === s.label.provider && c.sessionId === s.label.sessionId)?.cwd ?? null);
      const row = { sample: s, decision, scored, latencyMs: decision.latencyMs ?? null, costUsd: decision.costUsd ?? null, conf: top.conf, top1Correct: top.correct, poolCards: cards.length, chosenCwd, targetCwd, targetProjectInPool: cards.some((c) => c.cwd === targetCwd) };
      rows[i] = row;
      onRow(row, i);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  const done = rows.filter(Boolean);
  return { rows: done, budgetStopped, skipped: samples.length - done.length, spentUsd: spent, slices: summarizeSlices(done) };
}

/** 逐条结果落盘用的行（不含样本原文；原文只在数据集里）。 */
export function rowForDisk(r) {
  const d = r.decision;
  return {
    id: r.sample.id, kind: r.sample.kind, provider: r.sample.provider, split: r.sample.split, tags: r.sample.tags,
    label: r.sample.label === 'NEW' ? 'NEW' : `${r.sample.label.provider}:${r.sample.label.sessionId}`,
    decision: {
      kind: d.kind, chosen: d.kind === 'continue' ? `${d.provider}:${d.sessionId}` : null, confidence: d.confidence ?? null,
      options: d.options?.map((o) => ({ id: `${o.provider}:${o.sessionId}`, p: o.probability })) ?? null,
      reason: d.reason ?? null, error: d.error ?? null, model: d.model ?? null,
      delivery: d.delivery ?? null, via: d.via ?? null, thread: d.thread ?? null, modelReason: d.modelReason ?? null, modelConfidence: d.modelConfidence ?? null,
      ranked: d.ranked?.map((o) => (o.kind === 'new' ? { new: true, cwd: o.cwd ?? null, p: o.probability } : { id: `${o.provider}:${o.sessionId}`, p: o.probability })) ?? null,
    },
    chosenCwd: r.chosenCwd, targetCwd: r.targetCwd, targetProjectInPool: r.targetProjectInPool,
    candidates: d.candidates ?? null,
    outcome: r.scored.outcome, a1Type: r.scored.a1Type, top1: r.scored.top1, top3: r.scored.top3, diag: r.scored.diag,
    conf: r.conf, top1Correct: r.top1Correct, latencyMs: r.latencyMs, costUsd: r.costUsd, poolCards: r.poolCards,
  };
}
