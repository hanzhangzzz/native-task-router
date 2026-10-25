// 入口界面验收用的桩 CLI（NTR_ENTRY_CLI）：不碰真实会话，按输入返回固定结果，并把收到的参数追加到 NTR_STUB_LOG。
import fs from 'node:fs';
const args = process.argv.slice(2);
fs.appendFileSync(process.env.NTR_STUB_LOG, JSON.stringify(args) + '\n');
const card = (title, project, last, reply = null) => ({ title, project, cwd: `/tmp/${project}`, last, reply, updatedAt: '2026-10-20T00:00:00Z' });
if (args[0] === 'tasks') {
  console.log(JSON.stringify({
    running: [
      { provider: 'claude', sessionId: 'H1', state: 'idle', viewId: 'V1', order: 0, card: card('数据库迁移', 'billing', '迁移要能重跑', '迁移脚本已改成可重入，测试全过。') },
      { provider: 'codex', sessionId: 'H3', state: 'busy', viewId: 'V3', order: 2, card: card('前端打包优化', 'web', '把首屏包拆小', '正在分析 bundle 体积…') },
    ],
    recent: [
      { provider: 'codex', sessionId: 'H2', card: card('API 限流改造', 'shop-api', '按用户维度限流') },
      { provider: 'claude', sessionId: 'H4', card: card('支付回调排查', 'billing', '回调偶尔重复') },
    ],
  }));
  process.exit(0);
}
if (args[0] === 'history') {
  console.log(JSON.stringify([
    { provider: 'claude', sessionId: 'H1', lastInput: '把迁移脚本改成可重入', ts: 2, card: card('数据库迁移', 'billing', '迁移要能重跑') },
    { provider: 'codex', sessionId: 'H2', lastInput: '登录接口加上限流', ts: 1, card: card('API 限流改造', 'shop-api', '按用户维度限流') },
  ]));
  process.exit(0);
}
const text = args[args.indexOf('--') + 1] ?? '';
const pick = args.indexOf('--pick') >= 0 ? args[args.indexOf('--pick') + 1] : null;
const nw = args.indexOf('--new') >= 0 ? args[args.indexOf('--new') + 1] : null;
if (text.includes('SLOW')) await new Promise((r) => setTimeout(r, 2500));
if (text.includes('FAIL')) console.log(JSON.stringify({ action: 'failed', why: '桩：模拟失败' }));
else if (pick) { const [provider, sessionId] = pick.split(':'); console.log(JSON.stringify({ action: 'wrote', viewId: 'V', provider, sessionId })); }
else if (nw) console.log(JSON.stringify({ action: 'opened', viewId: 'V', provider: nw, sessionId: null, cwd: '/tmp/new' }));
else if (text.includes('CLARIFY')) console.log(JSON.stringify({ action: 'clarify', reason: '置信度低于阈值', suggestNew: null, options: [
  { provider: 'claude', sessionId: 'C1', probability: 0.8, card: card('候选一', 'p1', 'x') },
  { provider: 'codex', sessionId: 'C2', probability: null, card: card('候选二', 'p2', 'y') },
] }));
else console.log(JSON.stringify({ action: 'wrote', viewId: 'V', provider: 'claude', sessionId: 'AUTO' }));
