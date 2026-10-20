// Router v3.x 的离线评测入口（dev 与留出集）：去掉历史数据里的"上一句"。
// 原因：挖掘出的 prev 是"查询前 60 分钟内用户在任意会话里的最近一条输入"，在这份历史里几乎总是指向别的会话（续接样本的定义就是
// "隔了 ≥30 分钟回到这个会话"，之前通常在别处工作）；而产品入口的 previous 是"刚从入口发出的上一句"，两者语义不同。
// 快路径把 previous 当决定性信号，用历史 prev 评测会把这个口径差异算成送错。所以只评测"没有入口语境"时的行为：
// 短句一律 clarify，有内容的句子由模型选项目与线程。
// 版本史：v3.0-project-first-opus-t0.85/noprev-r3 为 v3.0 的留出集验收（r1 因 --max-cost 0 在 0 条处停止；r2 未传样本时刻，作废）。
import { createRouterV3, ROUTER_V3_VERSION, DEFAULT_POLICY_V3 } from '../../../src/layers/router/v3.ts';
import { claudeJsonComplete } from './claude-json.mjs';

export const version = `${ROUTER_V3_VERSION}/noprev`;
export const model = DEFAULT_POLICY_V3.model;
export const notes = 'production createRouterV3 with ctx.previous=null (historical prev is not the entry previous); live=[] as in all offline evals; claude -p json backend for cost';
export async function create() {
  const r = createRouterV3({ complete: claudeJsonComplete() });
  return { route: (text, ctx) => r.route(text, { ...ctx, previous: null }) };
}
