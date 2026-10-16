// 基线在评测集 v2 上的对照（TE-4b）：路由逻辑与 jev-baseline.mjs 完全相同（生产 askJev + relevantCards 前 12，不使用上一句），
// 只换策略版本号：v1→v2 的差异只来自评测集（生产卡片、交互判定、按 provider 切分）。
export { create, model, notes } from './jev-baseline.mjs';
export const version = 'jev-1.13+fts12-v1@evalset-v2';
