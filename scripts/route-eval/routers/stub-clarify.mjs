// 无模型的桩 Router（契约测试与评测器冒烟用）：永远转澄清，选项按最近活动倒序。
export const version = process.env.STUB_VERSION ?? 'stub-clarify-v1';
export const model = null;
export async function create() {
  return {
    async route(_text, ctx) {
      const sorted = [...ctx.cards].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      return {
        kind: 'clarify',
        options: sorted.slice(0, 3).map((c) => ({ provider: c.provider, sessionId: c.sessionId, probability: null })),
        reason: 'stub', latencyMs: 1, costUsd: null, model: null,
        candidates: sorted.map((c) => `${c.provider}:${c.sessionId}`),
      };
    },
  };
}
