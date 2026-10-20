// 评测用的本机 `claude -p` 后端：参数与生产 claudeCliComplete（src/layers/router/v2.ts）相同，只多 --output-format json，
// 用来记下每次调用的等价 API 费用（total_cost_usd，订阅下不实际扣费）与 token 数。生产后端不变。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function claudeJsonComplete(bin = 'claude') {
  let cwd = null;
  return (req) => new Promise((resolve) => {
    cwd ??= fs.mkdtempSync(path.join(os.tmpdir(), 'ntr-router-eval-'));
    const system = req.messages.find((m) => m.role === 'system')?.content ?? '';
    const user = req.messages.filter((m) => m.role === 'user').map((m) => m.content).join('\n');
    let out = '', err = '';
    const p = spawn(bin, ['-p', '--model', req.model, '--no-session-persistence', '--safe-mode', '--tools', '', '--output-format', 'json', '--system-prompt', system], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    const timer = setTimeout(() => p.kill('SIGKILL'), req.timeoutMs);
    p.stdout.on('data', (b) => (out += b));
    p.stderr.on('data', (b) => (err += b));
    p.on('error', (e) => { clearTimeout(timer); resolve({ text: '', costUsd: null, error: e.message }); });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return resolve({ text: '', costUsd: null, error: `claude exit ${code}: ${err.trim().slice(0, 200)}` });
      try {
        const j = JSON.parse(out);
        if (j.is_error) return resolve({ text: '', costUsd: j.total_cost_usd ?? null, error: `claude error: ${String(j.result).slice(0, 200)}` });
        resolve({ text: String(j.result ?? '').trim(), costUsd: typeof j.total_cost_usd === 'number' ? j.total_cost_usd : null, usage: { in: j.usage?.input_tokens, cacheRead: j.usage?.cache_read_input_tokens, cacheWrite: j.usage?.cache_creation_input_tokens, out: j.usage?.output_tokens } });
      } catch { resolve({ text: '', costUsd: null, error: 'claude json parse failed' }); }
    });
    p.stdin.end(user);
  });
}
