// Router v3（项目优先）的评测入口：直接用生产 createRouterV3（同一份分组、提示词、解析、闸门、claude -p 后端）。
import { createRouterV3, ROUTER_V3_VERSION, DEFAULT_POLICY_V3 } from '../../../src/layers/router/v3.ts';

export const version = ROUTER_V3_VERSION;
export const model = DEFAULT_POLICY_V3.model;
export const notes = 'production createRouterV3: project-first; Opus via local `claude -p`; auto iff project confidence ≥0.85; in-project pick open → recent(≤24h) → new';
export async function create() { return createRouterV3(); }
