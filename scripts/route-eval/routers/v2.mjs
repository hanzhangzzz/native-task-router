// Router v2 的评测入口（TE-4b）：直接用生产的 createRouterV2（同一份召回、提示词、解析、闸门、claude -p 后端）。
import { createRouterV2, ROUTER_V2_VERSION, DEFAULT_POLICY } from '../../../src/layers/router/v2.ts';

export const version = ROUTER_V2_VERSION;
export const model = DEFAULT_POLICY.models.map((m) => m.model).join('+');
export const notes = 'production createRouterV2: recall recent20 ∪ lexical20 ∪ previous; Opus via local `claude -p`; auto iff confidence ≥0.9 and not content-free';
export async function create() { return createRouterV2(); }
