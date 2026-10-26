// 手机远程服务的契约测试：起真实 HTTP 服务（临时目录做 NTR_HOME，桩 runCli 记录参数），用 fetch 走完整 HTTP 语义。
// 不碰真实会话、不碰网络隧道；隧道部分只测「未配置不启动」与状态/链接的生成。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createRemoteServer } = require('../entry/remote.cjs');

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}${extra ? ' | ' + extra : ''}`); }
};

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ntr-remote-'));
const calls = [];
let nextResult = { action: 'wrote', provider: 'claude', sessionId: 'X' };
const runCli = (args) => { calls.push(args); return Promise.resolve(nextResult); };

const srv = createRemoteServer({
  ntrHome: home,
  port: 0, // 让内核分配
  runCli,
  pageFile: path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'entry', 'remote.html'),
  trace: () => {},
  lockoutMs: 400,
});
// port=0：手动 listen 拿实际端口
await new Promise((r) => srv.srv.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${srv.srv.address().port}`;
const token = fs.readFileSync(path.join(home, 'remote', 'token'), 'utf8').trim();
const H = { authorization: `Bearer ${token}` };

// 1. 页面与 404
const page = await fetch(`${base}/`);
check('GET / 返回手机页（含令牌门）', page.status === 200 && (await page.text()).includes('ntr-token'));
check('未知路径 404', (await fetch(`${base}/nope`, { headers: H })).status === 404);

// 2. 认证：无令牌 401；错令牌 401；连续错 5 次锁 429（连对的也被拒），锁窗口过后恢复
check('无令牌 401', (await fetch(`${base}/api/tasks`)).status === 401);
for (let i = 0; i < 5; i++) await fetch(`${base}/api/tasks`, { headers: { authorization: 'Bearer deadbeef' } });
check('连错 5 次后锁 429', (await fetch(`${base}/api/tasks`, { headers: H })).status === 429);

// 3. /api/tasks 透传
await new Promise((r) => setTimeout(r, 500));
nextResult = { running: [{ provider: 'claude', sessionId: 'T1', state: 'busy' }], recent: [] };
const tasks = await (await fetch(`${base}/api/tasks`, { headers: H })).json();
check('GET /api/tasks 透传任务列表', tasks.running.length === 1 && tasks.running[0].sessionId === 'T1' && calls.at(-1)[0] === 'tasks');

// 4. /api/open 参数拼装：纯文本 / pick+answer / new+cwd / 空请求
const post = (body) => fetch(`${base}/api/open`, { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify(body) });
nextResult = { action: 'wrote', provider: 'claude', sessionId: 'X' };
let r = await (await post({ text: '把示例迁移脚本改成可重入' })).json();
check('纯文本 → open --json -- <text>', calls.at(-1).join(' ').includes('open --json -- 把示例迁移脚本改成可重入') && r.action === 'wrote');
await post({ target: { provider: 'claude', sessionId: 'S9', answer: 2 }, text: '' });
check('指定目标 + 代选选项 → --pick claude:S9 --answer 2（正文为空即只答题）', calls.at(-1).join(' ') === 'open --json --pick claude:S9 --answer 2');
await post({ target: { new: true, provider: 'codex', cwd: '/tmp/demo' }, text: '示例新任务' });
check('新建目标 → --new codex --cwd /tmp/demo -- <text>', calls.at(-1).join(' ').endsWith('--new codex --cwd /tmp/demo -- 示例新任务'));
check('空请求（无目标无正文）400', (await post({})).status === 400);
check('超长正文截到 8000 字', (await post({ text: 'a'.repeat(9000) })).status === 200 && calls.at(-1).at(-1).length === 8000);

// 5. 隧道：无配置 → unconfigured、mobileUrl 为空、不 spawn
check('无配置：status=unconfigured、mobileUrl=null', srv.status().tunnel === 'unconfigured' && srv.mobileUrl() === null);
check('未配置时 start 不抛错、隧道保持 unconfigured', await srv.start().then(() => srv.status().tunnel === 'unconfigured', () => false));
srv.stop();

// 6. 有配置：mobileUrl = url#token（令牌带在片段里，不发给服务器）
fs.mkdirSync(path.join(home, 'remote'), { recursive: true });
fs.writeFileSync(path.join(home, 'remote', 'config.json'), JSON.stringify({ host: 'demo.example.com', user: 'u', key: '/tmp/k', bind: '172.19.0.1', bindPort: 8765, url: 'https://ntr.example.com' }));
const srv2 = createRemoteServer({ ntrHome: home, port: 0, runCli, pageFile: path.join('/tmp'), trace: () => {} });
check('有配置：mobileUrl 含 #令牌', srv2.mobileUrl() === `https://ntr.example.com/#${token}`);

fs.rmSync(home, { recursive: true, force: true });
console.log(`remote contracts: ${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
