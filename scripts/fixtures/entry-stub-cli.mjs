// 入口界面验收用的桩 CLI（JEV_ENTRY_CLI）：不碰真实会话，按输入返回固定结果，并把收到的参数追加到 JEV_STUB_LOG。
import fs from 'node:fs';
const args = process.argv.slice(2);
fs.appendFileSync(process.env.JEV_STUB_LOG, JSON.stringify(args) + '\n');
const card = (title, project, last) => ({ title, project, cwd: `/tmp/${project}`, last });
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
