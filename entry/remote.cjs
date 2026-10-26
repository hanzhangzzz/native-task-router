// 手机远程入口（2026-10-26）：本机 127.0.0.1 起一个只带令牌认证的小 HTTP 服务，页面与 API 全部复用 CLI；
// 经一条受限 SSH 反向隧道（restricted,port-forwarding,permitlisten 的专用钥匙）挂到用户自己的服务器，
// 由服务器上的 Caddy 做 TLS 反代，手机在任何网络打开域名即可用。服务端配置在 ~/.ntr/remote/config.json，
// 不进仓库；没有配置文件时服务不启动（菜单里给出指引）。
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const DEFAULT_PORT = 8765;

function remoteDir(ntrHome) { return path.join(ntrHome, 'remote'); }

/** 手机访问令牌：~/.ntr/remote/token，第一次启用时生成（256 位），只在「复制手机链接」里出现。 */
function remoteToken(ntrHome) {
  const file = path.join(remoteDir(ntrHome), 'token');
  try { const tok = fs.readFileSync(file, 'utf8').trim(); if (tok) return tok; } catch { /* 第一次 */ }
  const tok = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(remoteDir(ntrHome), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, tok + '\n', { mode: 0o600 });
  return tok;
}

/** 服务器配置（host/user/密钥/绑定点/公网地址）；没有就是未配置，返回 null。 */
function loadConfig(ntrHome) {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(remoteDir(ntrHome), 'config.json'), 'utf8'));
    if (c && c.host && c.user && c.key && c.bind && c.bindPort && c.url) return { localPort: DEFAULT_PORT, ...c };
  } catch { /* 未配置 */ }
  return null;
}

function createRemoteServer({ ntrHome, port, runCli, pageFile, trace, onTunnelStatus, lockoutMs = 30_000 }) {
  const token = Buffer.from(remoteToken(ntrHome));
  let failures = 0;
  let lockedUntil = 0;
  let tunnel = null;          // ssh 子进程
  let tunnelWanted = false;
  let restartTimer = null;
  const config = loadConfig(ntrHome);
  let tunnelStatus = config ? 'off' : 'unconfigured';   // off | connecting | up | down | unconfigured

  const setStatus = (s) => { tunnelStatus = s; onTunnelStatus?.(s); };

  // ---- 隧道：ssh -N -R <bind>:<bindPort>:127.0.0.1:<port>，断了退避重连（只在想要时） ----
  function startTunnel() {
    if (!config) { setStatus('unconfigured'); return; }
    if (tunnel || !tunnelWanted) return;
    setStatus(tunnelStatus === 'up' ? 'up' : 'connecting');
    const child = tunnel = spawn('/usr/bin/ssh', [
      '-i', config.key, '-N',
      '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes',
      '-o', 'ServerAliveInterval=20', '-o', 'ServerAliveCountMax=3',
      '-o', 'ConnectTimeout=15',
      '-R', `${config.bind}:${config.bindPort}:127.0.0.1:${port}`,
      `${config.user}@${config.host}`,
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (b) => { stderr = (stderr + b).slice(-500); });
    // 隧道起来没有事件可听：连接建立 5 秒后视为 up（转发失败会立刻退出走 exit 分支）
    const upTimer = setTimeout(() => { if (tunnel === child) setStatus('up'); }, 5000);
    child.on('exit', (code) => {
      clearTimeout(upTimer);
      if (tunnel !== child) return;
      tunnel = null;
      if (!tunnelWanted) { setStatus('off'); return; }
      setStatus('down');
      trace?.({ ev: 'remote-tunnel-exit', code, stderr: stderr.slice(-200) });
      restartTimer = setTimeout(startTunnel, 15_000); // 断线重连退避
    });
  }
  function stopTunnel() {
    tunnelWanted = false;
    clearTimeout(restartTimer);
    if (tunnel) { const c = tunnel; tunnel = null; c.kill(); }
    setStatus('off');
  }

  // ---- HTTP：GET / 手机页；/api/* 全部要 Bearer 令牌 ----
  const authorized = (h) => {
    const b = Buffer.from(String(h || '').replace(/^Bearer /, ''));
    return b.length === token.length && crypto.timingSafeEqual(b, token);
  };
  const srv = http.createServer((req, res) => {
    const json = (code, o) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(o)); };
    if (req.url === '/' || req.url.startsWith('/?')) {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        // 单文件页面：无外部资源需求；script/style 内联（非源文件加载），connect 只许同源
        'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self'; form-action 'none'; base-uri 'none'",
      });
      return res.end(fs.readFileSync(pageFile));
    }
    if (!req.url.startsWith('/api/')) return json(404, { error: 'not found' });
    if (Date.now() < lockedUntil) return json(429, { error: 'locked' });
    if (!authorized(req.headers.authorization)) {
      failures += 1;
      if (failures >= 5) { lockedUntil = Date.now() + lockoutMs; failures = 0; }
      return json(401, { error: 'bad token' });
    }
    failures = 0;
    if (req.method === 'GET' && req.url === '/api/tasks') {
      return runCli(['tasks']).then((o) => json(200, { running: o.running || [], recent: o.recent || [] })).catch((e) => json(500, { error: String(e.message || e) }));
    }
    if (req.method === 'POST' && req.url === '/api/open') {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (c) => { body += c; if (body.length > 65536) req.destroy(); });
      return req.on('end', async () => {
        let m = {};
        try { m = JSON.parse(body); } catch { return json(400, { error: 'bad json' }); }
        const text = String(m.text ?? '').slice(0, 8000);
        const args = ['open', '--json'];
        if (m.target) {
          const tg = m.target;
          if (tg.new) args.push('--new', tg.provider === 'codex' ? 'codex' : 'claude', ...(tg.cwd ? ['--cwd', String(tg.cwd)] : []));
          else if (tg.provider && tg.sessionId) args.push('--pick', `${tg.provider}:${tg.sessionId}`);
          if (tg.answer) args.push('--answer', String(Math.max(1, Math.min(9, Number(tg.answer) || 1))));
        }
        if (text) args.push('--', text);
        if (!m.target && !text) return json(400, { error: 'empty' });
        try { return json(200, await runCli(args)); } catch (e) { return json(500, { error: String(e.message || e) }); }
      });
    }
    return json(404, { error: 'not found' });
  });

  return {
    srv,
    start: async () => {
      if (!srv.listening) await new Promise((resolve, reject) => { srv.once('error', reject); srv.listen(port, '127.0.0.1', resolve); });
      tunnelWanted = true;
      startTunnel();
      trace?.({ ev: 'remote-server', port: srv.address()?.port ?? port, configured: !!config });
    },
    stop: () => { stopTunnel(); srv.close(); },
    status: () => ({ tunnel: tunnelStatus, url: config?.url ?? null, configured: !!config }),
    mobileUrl: () => (config ? `${config.url}/#${remoteToken(ntrHome)}` : null),
    config,
  };
}

module.exports = { createRemoteServer, loadConfig, remoteToken, DEFAULT_PORT };
