// 基线 Router（TE-3）：把当前生产路由（src/router/jev.ts 的 askJev + src/router/route.ts 的候选召回）包成 Router。
//
// 近似口径（与生产的差异在 TE-3 报告里逐条说明）：
//   - 召回：直接调用生产的 relevantCards（字面 token 重叠打分，取前 12）；生产的任务卡由
//     history-import 写入：goal=会话标题（无标题退首条输入）、last_input、last_progress=最后回复、workspace=cwd。
//   - 阈值与指令：askJev 原样（best ≥0.85 且领先 ≥0.20；INSTRUCTIONS 不改）。
//   - 无"上一句"语境（previousTurn=null）、无存活会话信号：评测数据里没有入口的上一句。
//   - 费用/时延取 askJev 返回值（OpenRouter usage.cost 与墙钟）。
// 外发给模型的只有 askJev 构造的有界字段（goal/last_input≤200/last_progress≤300），与生产同口径。

import { askJev } from '../../../src/router/jev.ts';
import { relevantCards } from '../baseline-recall.mjs';

export const version = 'jev-1.13+fts12-v1';
export const model = 'typesafe/jev-1.13';
export const notes = 'production askJev + relevantCards(top12); no previousTurn; cards built from eval cardBuilder';

const taskId = (c) => `${c.provider}:${c.sessionId}`;
const parseId = (id) => { const i = id.indexOf(':'); return { provider: id.slice(0, i), sessionId: id.slice(i + 1) }; };

function toTaskCard(c) {
  const last = c.recentPrompts.at(-1) ?? null;
  return {
    task_id: taskId(c), goal: (c.title ?? c.firstPrompt ?? '').slice(0, 240), executor: c.provider,
    workspace_path: c.cwd, last_input: last, last_progress: c.lastReply, turns: c.turns, last_activity_at: c.updatedAt,
  };
}

export async function create() {
  return {
    async route(text, ctx) {
      // 生产的 listTaskCards 无稳定的相关度顺序；这里按最近活动倒序作为同分时的顺序
      const cards = ctx.cards.map(toTaskCard).sort((a, b) => b.last_activity_at.localeCompare(a.last_activity_at));
      const ranked = relevantCards(cards, text).slice(0, 12);
      const candidates = ranked.map((c) => ({
        taskId: c.task_id, goal: c.goal, executor: c.executor, workspace: c.workspace_path, lastInput: c.last_input,
        lastProgress: c.last_progress, lastActivityAt: c.last_activity_at, turns: c.turns,
      }));
      const d = await askJev({ text, candidates, previousTurn: null });
      const meta = { latencyMs: d.latencyMs, costUsd: d.costUsd, model: d.model, candidates: candidates.map((c) => c.taskId), error: d.error };
      const optionsOf = (list) => (list ?? []).map((o) => ({ ...parseId(o.taskId), probability: o.probability }));
      // 阈值前的首选（风险-覆盖曲线用）
      const raw = d.topChoice
        ? { choice: d.topChoice === 'NEW' ? { kind: 'new' } : d.topChoice === 'CLARIFY' ? { kind: 'clarify' } : { kind: 'continue', ...parseId(d.topChoice) }, confidence: d.confidence }
        : null;
      if (d.kind === 'continue') return { kind: 'continue', ...parseId(d.taskId), confidence: d.confidence ?? 0, reason: d.reason, raw, ...meta };
      if (d.kind === 'new') return { kind: 'new', provider: 'claude', cwd: null, confidence: d.confidence, reason: d.reason, raw, ...meta };
      return { kind: 'clarify', options: optionsOf(d.options), reason: d.reason, raw, ...meta };
    },
  };
}
