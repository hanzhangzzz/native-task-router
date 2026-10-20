// Router v3.1（项目 → 线程）的评测入口：直接用生产 createRouterV3（同一份分组、提示词、解析、闸门）；后端为本机 `claude -p`（json 输出，记费用）。
import { createRouterV3, ROUTER_V3_VERSION, DEFAULT_POLICY_V3 } from '../../../src/layers/router/v3.ts';
import { claudeJsonComplete } from './claude-json.mjs';

export const version = ROUTER_V3_VERSION;
export const model = DEFAULT_POLICY_V3.model;
export const notes = 'production createRouterV3: model picks project + thread (or NEW) in one call; Opus via local `claude -p --output-format json`; three tiers 0.95 direct / 0.85 fork';
export async function create() { return createRouterV3({ complete: claudeJsonComplete() }); }
