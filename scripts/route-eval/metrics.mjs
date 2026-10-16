// 评测打分与指标（TE-3）：纯函数，无 IO，可被契约测试直接喂合成数据。
// 失败分级见技术合同 §0.5：A1 自动送错（含"标签 NEW 却续进旧会话"）为不可接受；B1/B2/B3 计量。

const idOf = (provider, sessionId) => `${provider}:${sessionId}`;

/**
 * 给一条决策打分。
 * sample.label: 'NEW' | { provider, sessionId }；decision 为 Router 的输出（可带 candidates/raw 扩展）。
 * pool: 该时刻的卡片（用于诊断同项目/跨工具），可选。
 * 返回 { outcome, a1Type, top1, top3, diag }，其中 outcome ∈
 *   'ok-continue' | 'ok-new' | 'A1' | 'B1' | 'clarify' | 'error'
 */
export function scoreDecision(sample, decision, pool = []) {
  const isNew = sample.label === 'NEW';
  const target = isNew ? null : idOf(sample.label.provider, sample.label.sessionId);
  const cards = new Map(pool.map((c) => [idOf(c.provider, c.sessionId), c]));
  const targetCard = target ? cards.get(target) : null;
  const diag = {
    shortText: [...sample.text].length <= 8 || (sample.tags ?? []).includes('short-followup'),
    targetInCandidates: null,
    sameCwd: null,
    crossProvider: null,
  };
  if (decision.candidates && target) diag.targetInCandidates = decision.candidates.includes(target);
  if (decision.error) return { outcome: 'error', a1Type: null, top1: null, top3: null, diag };

  if (decision.kind === 'continue') {
    const chosen = idOf(decision.provider, decision.sessionId);
    const chosenCard = cards.get(chosen);
    if (!isNew && chosen === target) return { outcome: 'ok-continue', a1Type: null, top1: true, top3: true, diag };
    const refCwd = isNew ? sample.cwd : targetCard?.cwd;
    diag.sameCwd = chosenCard && refCwd ? chosenCard.cwd === refCwd : null;
    diag.crossProvider = !isNew && chosenCard ? chosenCard.provider !== sample.label.provider : null;
    const a1Type = isNew
      ? (diag.sameCwd ? 'new-labelled-continued-old/same-project' : 'new-labelled-continued-old/other-project')
      : (diag.sameCwd ? 'wrong-session/same-project' : 'wrong-session/other-project');
    return { outcome: 'A1', a1Type, top1: false, top3: false, diag };
  }
  if (decision.kind === 'new') {
    if (isNew) return { outcome: 'ok-new', a1Type: null, top1: true, top3: true, diag };
    return { outcome: 'B1', a1Type: null, top1: false, top3: false, diag };
  }
  // clarify
  const opts = (decision.options ?? []).map((o) => idOf(o.provider, o.sessionId));
  const top1 = !isNew && opts[0] === target;
  const top3 = !isNew && opts.slice(0, 3).includes(target);
  return { outcome: 'clarify', a1Type: null, top1, top3, diag };
}

// ---- 统计工具 ---------------------------------------------------------------

export function quantile(xs, q) {
  const a = xs.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((x, y) => x - y);
  if (!a.length) return null;
  const i = Math.min(a.length - 1, Math.max(0, Math.ceil(q * a.length) - 1));
  return a[i];
}

/** 95% 上界：零事件用 rule of three（3/n），否则 Wilson 上界。 */
export function upper95(events, n) {
  if (n === 0) return null;
  if (events === 0) return 3 / n;
  const z = 1.96, p = events / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const w = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return (c + w) / d;
}

const pct = (a, b) => (b === 0 ? null : a / b);

/**
 * 风险-覆盖：按置信度阈值扫描。points 为 { conf, correct, kind }（对每条样本取路由 top1 的置信度，
 * 不论最终是否自动）。返回每个阈值的覆盖率与错误数；"零错误最大覆盖"是开发集定阈值的依据（D7）。
 */
export function riskCoverage(points, thresholds = [0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.95, 0.98, 0.99]) {
  const valid = points.filter((p) => typeof p.conf === 'number');
  const table = thresholds.map((th) => {
    const sel = valid.filter((p) => p.conf >= th);
    const errors = sel.filter((p) => !p.correct).length;
    return { threshold: th, covered: sel.length, coverage: pct(sel.length, points.length), errors, errorRate: pct(errors, sel.length) };
  });
  // 零错误最大覆盖：按置信度降序，遇到第一个错误之前能覆盖多少
  const sorted = [...valid].sort((a, b) => b.conf - a.conf);
  let zeroErr = 0;
  for (const p of sorted) { if (!p.correct) break; zeroErr++; }
  // 并列置信度下不能拆开：回退到第一个错误所在置信度之上的严格更高部分
  const firstWrong = sorted.find((p) => !p.correct);
  const strict = firstWrong ? sorted.filter((p) => p.conf > firstWrong.conf).length : sorted.length;
  return { table, zeroErrorMaxCoverage: pct(strict, points.length), zeroErrorCovered: strict, zeroErrorOrdered: zeroErr, points: valid.length };
}

/**
 * rows: [{ sample, decision, scored, latencyMs, costUsd, conf, top1Correct, candidates }]
 * 汇总指标。error 行不计入分母，单独报告。
 */
export function summarize(rows) {
  const ok = rows.filter((r) => r.scored.outcome !== 'error');
  const n = ok.length;
  const by = (o) => ok.filter((r) => r.scored.outcome === o);
  const A1 = by('A1');
  const B1 = by('B1');
  const clar = by('clarify');
  const okC = by('ok-continue');
  const okN = by('ok-new');
  const autos = n - clar.length; // continue + new 的决策数
  const contRows = ok.filter((r) => r.sample.label !== 'NEW');
  const newRows = ok.filter((r) => r.sample.label === 'NEW');
  const contClar = clar.filter((r) => r.sample.label !== 'NEW');

  const a1Types = {};
  for (const r of A1) a1Types[r.scored.a1Type] = (a1Types[r.scored.a1Type] ?? 0) + 1;
  const a1Facets = { shortText: 0, targetOutsideCandidates: 0, crossProvider: 0, exactRepeatOfEarlier: 0 };
  for (const r of A1) {
    if (r.scored.diag.shortText) a1Facets.shortText++;
    if (r.scored.diag.targetInCandidates === false) a1Facets.targetOutsideCandidates++;
    if (r.scored.diag.crossProvider) a1Facets.crossProvider++;
    if ((r.sample.tags ?? []).includes('exact-repeat-of-earlier')) a1Facets.exactRepeatOfEarlier++;
  }
  const a1ByLabel = { fromContinueLabel: A1.filter((r) => r.sample.label !== 'NEW').length, fromNewLabel: A1.filter((r) => r.sample.label === 'NEW').length };

  // recall@k：Router 暴露候选（有序 id 列表）时才有
  const recallK = {};
  const withCands = contRows.filter((r) => r.decision.candidates);
  if (withCands.length) {
    const target = (r) => idOf(r.sample.label.provider, r.sample.label.sessionId);
    for (const k of [1, 3, 5, 12, 100]) recallK[k] = pct(withCands.filter((r) => r.decision.candidates.slice(0, k).includes(target(r))).length, withCands.length);
  }

  const lat = rows.map((r) => r.latencyMs);
  const costs = rows.map((r) => r.costUsd).filter((c) => typeof c === 'number');
  return {
    n: rows.length, scored: n, errors: rows.length - n,
    byKind: { continue: contRows.length, new: newRows.length },
    decisions: { 'ok-continue': okC.length, 'ok-new': okN.length, A1: A1.length, B1: B1.length, clarify: clar.length },
    A1: {
      count: A1.length, ...a1ByLabel, ofAuto: autos, upper95: upper95(A1.length, autos),
      upper95Zero: A1.length === 0 ? 3 / autos : null, types: a1Types, facets: a1Facets,
    },
    autoDeliveryRate: pct(autos, n),
    autoDecisions: autos,
    autoContinueDecisions: okC.length + A1.filter((r) => r.decision.kind === 'continue').length,
    autoCorrectRate: pct(okC.length + okN.length, autos),
    B1: { count: B1.length, ofContinueLabel: contRows.length, rate: pct(B1.length, contRows.length) },
    clarifyTop3: { hit: contClar.filter((r) => r.scored.top3).length, of: contClar.length, rate: pct(contClar.filter((r) => r.scored.top3).length, contClar.length) },
    // 上线口径：续接样本里，"自动送对 或 转澄清且前 3 命中" 的比例
    contReachable: pct(okC.length + contClar.filter((r) => r.scored.top3).length, contRows.length),
    recallAtK: recallK,
    latencyMs: { p50: quantile(lat, 0.5), p95: quantile(lat, 0.95) },
    cost: { totalUsd: costs.reduce((a, b) => a + b, 0), calls: costs.length, perCallUsd: costs.length ? costs.reduce((a, b) => a + b, 0) / costs.length : null },
    riskCoverage: riskCoverage(ok.map((r) => ({ conf: r.conf, correct: r.top1Correct, kind: r.sample.kind }))),
  };
}

/** 按维度切片汇总（kind/provider/tag/split），小样本如实给 n。 */
export function summarizeSlices(rows) {
  const slices = {};
  const add = (name, pred) => { const sub = rows.filter(pred); if (sub.length) slices[name] = summarize(sub); };
  add('all', () => true);
  add('continue', (r) => r.sample.kind === 'continue');
  add('new', (r) => r.sample.kind === 'new');
  for (const p of ['claude', 'codex']) add(`provider=${p}`, (r) => r.sample.provider === p);
  const tags = new Set(rows.flatMap((r) => r.sample.tags ?? []));
  for (const t of tags) add(`tag=${t}`, (r) => (r.sample.tags ?? []).includes(t));
  return slices;
}

/** 单条样本的 top1 置信与对错（风险-覆盖用）：优先 Router 暴露的 raw（阈值前的首选），否则用决策本身。 */
export function top1Of(sample, decision) {
  const isNew = sample.label === 'NEW';
  const raw = decision.raw;
  if (raw) {
    const correct = raw.choice.kind === 'new' ? isNew : !isNew && raw.choice.kind === 'continue' && raw.choice.provider === sample.label.provider && raw.choice.sessionId === sample.label.sessionId;
    return { conf: raw.confidence, correct };
  }
  if (decision.kind === 'continue') {
    return { conf: decision.confidence, correct: !isNew && decision.provider === sample.label.provider && decision.sessionId === sample.label.sessionId };
  }
  if (decision.kind === 'new') return { conf: decision.confidence, correct: isNew };
  const o = decision.options?.[0];
  return { conf: o?.probability ?? null, correct: !isNew && !!o && o.provider === sample.label.provider && o.sessionId === sample.label.sessionId };
}
