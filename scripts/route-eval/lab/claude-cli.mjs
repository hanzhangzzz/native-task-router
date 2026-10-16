// 通过本机 Claude Code 订阅做路由决策（`claude -p`），不需要 OpenRouter key（TE-4b）。
// --safe-mode 关闭用户的 hooks/插件/记忆注入，--system-prompt 替换默认系统提示，--tools "" 禁用工具，
// --no-session-persistence 不落会话；在临时目录运行。结果按请求哈希缓存到 <数据目录>/lab/cli-cache/。
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LAB_DIR } from './llm.mjs';

const CACHE = path.join(LAB_DIR, 'cli-cache');
fs.mkdirSync(CACHE, { recursive: true });
const CWD = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-route-cli-'));

export function claudeCli({ model, system, user, timeoutMs = 60_000 }) {
  const key = crypto.createHash('sha256').update(JSON.stringify({ model, system, user })).digest('hex');
  const f = path.join(CACHE, `${key}.json`);
  if (fs.existsSync(f)) return Promise.resolve({ ...JSON.parse(fs.readFileSync(f, 'utf8')), cached: true });
  const t0 = Date.now();
  return new Promise((resolve) => {
    const p = spawn('claude', ['-p', '--model', model, '--no-session-persistence', '--safe-mode', '--tools', '', '--system-prompt', system], { cwd: CWD, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => { p.kill('SIGKILL'); }, timeoutMs);
    p.stdout.on('data', (b) => (out += b));
    p.stderr.on('data', (b) => (err += b));
    p.on('close', (code) => {
      clearTimeout(timer);
      const r = { text: out.trim(), latencyMs: Date.now() - t0, error: code === 0 ? null : `exit ${code}: ${err.trim().slice(0, 200)}` };
      if (!r.error) fs.writeFileSync(f, JSON.stringify(r));
      resolve({ ...r, cached: false });
    });
    p.stdin.end(user);
  });
}
