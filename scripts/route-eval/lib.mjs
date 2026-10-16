// 评测公共小工具（TE-3）。数据一律落在主检出的 .runtime/route-eval/（gitignore），多个 worktree 共用。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

// 默认写到主检出（git common dir 的上一级）下的 .runtime/route-eval，多个 worktree 共用；可用 ROUTE_EVAL_DIR 覆盖。
function defaultOut() {
  if (process.env.ROUTE_EVAL_DIR) return path.resolve(process.env.ROUTE_EVAL_DIR);
  const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim();
  return path.join(path.dirname(common), '.runtime', 'route-eval');
}
export const DEFAULT_OUT = defaultOut();

export function readJsonl(file) {
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}
export function writeJsonl(file, rows) {
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
}
export function appendJsonl(file, row) {
  fs.appendFileSync(file, JSON.stringify(row) + '\n');
}
export function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
