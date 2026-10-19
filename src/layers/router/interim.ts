// 过渡 Router：词面召回 + 沿用旧 Jev 决策（src/router/jev.ts）。TE-4b 的 v2 会整体替换它。
// 阈值（≥0.85 且领先 ≥0.20 才 continue）、"无 key / 超时 / 出错一律 clarify" 都由 askJev 保证；
// 这里只负责：卡片 → 候选（≤12，存活会话与上一句去处强制并入）、决策 → RouteDecision。
import { askJev, type RouteCandidate } from '../../router/jev.ts';
import type { ProviderId, RouteContext, RouteDecision, RouteOption, Router, SessionCard } from '../types.ts';

export const MAX_CANDIDATES = 12;
const LEXICAL = 8;
const OPTIONS = 3;

const idOf = (p: ProviderId, s: string) => `${p}:${s}`;

/** 英文词 + CJK 单字/二元组，足够做粗召回。 */
export function terms(text: string): Set<string> {
  const out = new Set<string>();
  const t = text.toLowerCase();
  for (const w of t.match(/[a-z0-9_]{2,}/g) ?? []) out.add(w);
  for (const run of t.match(/\p{Script=Han}+/gu) ?? []) {
    for (let i = 0; i < run.length; i++) {
      out.add(run[i]!);
      if (i + 1 < run.length) out.add(run.slice(i, i + 2));
    }
  }
  return out;
}

function haystack(c: SessionCard): string {
  return [c.title, c.firstPrompt, ...c.recentPrompts, c.lastReply, c.cwd.split('/').pop()].filter(Boolean).join('\n');
}

/** 候选召回：存活 + 上一句去处（强制并入）+ 词面得分前 8 + 最近活跃补足，总数 ≤12（强制项可超出）；按相关度排序（词面得分，其次最近活跃）。 */
export function recall(text: string, ctx: RouteContext): SessionCard[] {
  const key = (c: SessionCard) => idOf(c.provider, c.sessionId);
  const byRecency = [...ctx.cards].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const q = terms(text);
  const score = new Map<string, number>();
  for (const c of ctx.cards) {
    const h = terms(haystack(c));
    let n = 0;
    for (const w of q) if (h.has(w)) n += w.length > 1 ? 2 : 1;
    score.set(key(c), n);
  }
  const forced = new Set([...ctx.live.map((l) => idOf(l.provider, l.sessionId)), ...(ctx.previous ? [idOf(ctx.previous.provider, ctx.previous.sessionId)] : [])]);
  const chosen = new Map<string, SessionCard>();
  for (const c of byRecency) if (forced.has(key(c))) chosen.set(key(c), c);
  const lexical = byRecency.filter((c) => score.get(key(c))! > 0).sort((a, b) => score.get(key(b))! - score.get(key(a))!);
  for (const c of lexical.slice(0, LEXICAL)) if (chosen.size < MAX_CANDIDATES) chosen.set(key(c), c);
  for (const c of byRecency) if (chosen.size < MAX_CANDIDATES) chosen.set(key(c), c);
  // 稳定排序：词面得分高者在前，同分保持最近活跃优先（chosen 的插入顺序已是强制项→词面→最近）
  return [...chosen.values()].sort((a, b) => score.get(key(b))! - score.get(key(a))!);
}

function toCandidate(c: SessionCard): RouteCandidate {
  return {
    taskId: idOf(c.provider, c.sessionId),
    goal: [c.title, c.firstPrompt].filter(Boolean).join(' | ') || c.cwd,
    executor: c.provider,
    workspace: c.cwd,
    lastInput: c.recentPrompts.at(-1) ?? null,
    lastProgress: c.lastReply,
    lastActivityAt: c.updatedAt,
    turns: c.turns,
  };
}

function parseId(taskId: string): { provider: ProviderId; sessionId: string } | null {
  const m = taskId.match(/^(claude|codex):(.+)$/);
  return m ? { provider: m[1] as ProviderId, sessionId: m[2]! } : null;
}

const NO_KEY = '未设置 openrouter_api_key（从 Finder/Dock 启动的 GUI 进程拿不到 shell 环境变量；请从终端启动，或用 CLI）';

export const interimRouter: Router = {
  async route(text, ctx) {
    const started = Date.now();
    const fallback = (reason: string): RouteDecision & { latencyMs: number; costUsd: number | null; model: string | null } => ({
      kind: 'clarify',
      options: recall(text, ctx).slice(0, OPTIONS).map((c): RouteOption => ({ provider: c.provider, sessionId: c.sessionId, probability: null })),
      reason,
      latencyMs: Date.now() - started,
      costUsd: null,
      model: null,
    });
    if (!(process.env.NTR_ROUTER_API_KEY ?? process.env.openrouter_api_key)) return fallback(NO_KEY);

    const candidates = recall(text, ctx).map(toCandidate);
    const prev = ctx.previous;
    const d = await askJev({
      text,
      candidates,
      timeoutMs: 12_000,
      previousTurn: prev ? { utterance: prev.utterance, taskId: idOf(prev.provider, prev.sessionId), minutesAgo: prev.minutesAgo, replyExcerpt: null } : null,
    });
    const meta = { latencyMs: d.latencyMs, costUsd: d.costUsd, model: d.model };
    if (d.kind === 'continue' && d.taskId) {
      const t = parseId(d.taskId);
      if (t) return { kind: 'continue', ...t, confidence: d.confidence ?? 0, reason: d.reason, ...meta };
    }
    if (d.kind === 'new') return { kind: 'new', provider: defaultProvider(), cwd: null, confidence: d.confidence, reason: d.reason, ...meta };
    const options: RouteOption[] = [];
    for (const o of d.options ?? []) {
      const t = parseId(o.taskId);
      if (t) options.push({ ...t, probability: o.probability });
    }
    return { kind: 'clarify', options: options.slice(0, OPTIONS), reason: d.error ?? d.reason, ...meta };
  },
};

function defaultProvider(): ProviderId {
  return process.env.NTR_DEFAULT_PROVIDER === 'codex' ? 'codex' : 'claude';
}
