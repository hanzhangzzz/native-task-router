// 最小入口窗口（技术合同 §0.2 Entry 层）：全局快捷键 → 悬浮输入框 → 子进程调用 CLI `open --json`。
// 不碰原生会话、不加载旧 desktop/；所有业务都在 src/layers/cli.ts。
const { app, BrowserWindow, globalShortcut, ipcMain, screen, Tray, Menu, nativeImage, net, dialog, shell } = require('electron');
const { execFile } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const updater = require('./updater.cjs');

// 设置（快捷键、开机启动）存在 ~/.ntr/settings.json；环境变量 NTR_HOTKEY 优先（开发与测试用）
const NTR_HOME = process.env.NTR_HOME || path.join(os.homedir(), '.ntr');
// 0.2 以前数据目录叫 ~/.jev：第一次启动新版本时整体改名，设置和入口历史原样保留（与 src/layers/open.ts 的 ntrHome 同一规则）
if (!process.env.NTR_HOME && !fs.existsSync(NTR_HOME) && fs.existsSync(path.join(os.homedir(), '.jev'))) { try { fs.renameSync(path.join(os.homedir(), '.jev'), NTR_HOME); } catch { /* 改名失败就用新目录 */ } }
const SETTINGS = path.join(NTR_HOME, 'settings.json');
const DEFAULT_HOTKEY = 'Control+Alt+Space';
const loadSettings = () => { try { return JSON.parse(fs.readFileSync(SETTINGS, 'utf8')); } catch { return {}; } };
const saveSettings = (patch) => {
  const next = { ...loadSettings(), ...patch };
  fs.mkdirSync(NTR_HOME, { recursive: true });
  fs.writeFileSync(SETTINGS, JSON.stringify(next, null, 2) + '\n');
  return next;
};
let HOTKEY = process.env.NTR_HOTKEY || loadSettings().hotkey || DEFAULT_HOTKEY;
const prettyKey = (acc) => acc.replace(/Command\+|Cmd\+/g, '⌘').replace(/Control\+|Ctrl\+/g, '⌃').replace(/Alt\+|Option\+/g, '⌥').replace(/Shift\+/g, '⇧');
// NTR_ENTRY_CLI 只给界面验收用（换成返回固定结果的桩，不碰真实会话）
const CLI = process.env.NTR_ENTRY_CLI || path.join(__dirname, '..', 'src', 'layers', 'cli.ts');
const WIDTH = 640;
let win = null;
let focusedTty = null;
// 界面语言：NTR_LANG=zh|en 优先，否则跟随 macOS 首选语言（ready 之后才能读）
let LANG = 'zh';
const pickLang = () => {
  const l = (process.env.NTR_LANG || app.getPreferredSystemLanguages()[0] || app.getLocale() || '').toLowerCase();
  return l.startsWith('zh') ? 'zh' : 'en';
};
const T = {
  zh: {
    untitled: '(无标题)', noOutput: '无输出', wrote: (p, l) => `已送达 ${p}：${l}`, focused: (l, why) => `只聚焦 ${l}：${why}`,
    opened: (p, cwd) => `已新开 ${p}：${cwd}`, forked: (l, c) => `已分叉续接 ${l} · 置信度 ${c}`, failed: (why) => `失败：${why}`,
    trayShow: (k) => `唤起输入框（${k}）`, trayHotkey: '修改快捷键…', trayLogin: '开机自动启动', trayQuit: '退出', hotkeyTitle: '修改快捷键',
    upCheck: '检查更新…', upTo: (v) => `更新到 ${v} 并重启`, upBusy: (v) => `正在更新到 ${v}…`,
    upLatest: (v) => `已是最新版本（${v}）`, upFound: (v, cur) => `发现新版本 ${v}（当前 ${cur}）`, upNow: '更新并重启', upNotes: '查看更新说明', upLater: '稍后',
    upFailed: '更新失败', upCheckFailed: '检查更新失败', upManual: '打开下载页', ok: '好',
    voiceClarify: '拿不准送到哪，已放进输入框，回到电脑按快捷键确认', voiceClarifyBusy: '拿不准送到哪，输入框里还有没发出去的话，这句没放进去，回到电脑再说一次',
    hkEmpty: '快捷键为空', hkReserved: (k) => `${k} 是系统保留的快捷键（如 Spotlight、输入法切换），请换一个`, hkTaken: (k) => `${k} 注册失败（可能被别的应用占用）`,
  },
  en: {
    untitled: '(untitled)', noOutput: 'no output', wrote: (p, l) => `Sent to ${p}: ${l}`,
    focused: (l) => `Switched to ${l} but didn't type into it (busy, waiting for approval, or has a draft). Your text is on the clipboard.`,
    opened: (p, cwd) => `Opened ${p} in a new tab: ${cwd}`, forked: (l, c) => `Forked and continued ${l} · confidence ${c}`, failed: (why) => `Failed: ${why}`,
    trayShow: (k) => `Open input box (${k})`, trayHotkey: 'Change hotkey…', trayLogin: 'Open at login', trayQuit: 'Quit', hotkeyTitle: 'Change hotkey',
    upCheck: 'Check for updates…', upTo: (v) => `Update to ${v} and restart`, upBusy: (v) => `Updating to ${v}…`,
    upLatest: (v) => `You're on the latest version (${v})`, upFound: (v, cur) => `Version ${v} is available (you have ${cur})`, upNow: 'Update and restart', upNotes: 'Release notes', upLater: 'Later',
    upFailed: 'Update failed', upCheckFailed: "Couldn't check for updates", upManual: 'Open download page', ok: 'OK',
    voiceClarify: "Not sure where this goes. It's waiting in the input box; press the hotkey at your computer to pick.",
    voiceClarifyBusy: "Not sure where this goes, and the input box still has an unsent message, so this one wasn't kept. Say it again at your computer.",
    hkEmpty: 'Hotkey is empty', hkReserved: (k) => `${k} is reserved by macOS (Spotlight, input sources). Pick another one.`, hkTaken: (k) => `${k} could not be registered (another app may be using it).`,
  },
};
const t = () => T[LANG];
let hideTimer = null;

// 从 Finder/Dock/登录项启动的 GUI 进程拿不到用户 shell 里的环境变量：PATH 很短找不到 claude/codex，
// 用户在 .zshrc 里设的 CLAUDE_CONFIG_DIR / CODEX_HOME（会话数据位置）、openrouter_api_key、NTR_* 也看不到。
// 启动时向登录 shell 要一次这些变量，只传给本 app 调用的 CLI 子进程；不写日志。
const LOGIN_ENV_KEY = (k) => k === 'PATH' || k === 'CLAUDE_CONFIG_DIR' || k === 'CODEX_HOME' || k === 'openrouter_api_key' || k.startsWith('NTR_');
let loginEnv = {};
function resolveLoginEnv() {
  return new Promise((resolve) => {
    execFile(process.env.SHELL || '/bin/zsh', ['-ilc', 'printf "__NTRENV__"; env -0'], { timeout: 8000, maxBuffer: 4 << 20 }, (_e, out) => {
      const s = String(out || '');
      const i = s.indexOf('__NTRENV__');
      const env = {};
      if (i >= 0) for (const kv of s.slice(i + 10).split('\0')) {
        const j = kv.indexOf('=');
        if (j > 0 && LOGIN_ENV_KEY(kv.slice(0, j))) env[kv.slice(0, j)] = kv.slice(j + 1);
      }
      resolve(env);
    });
  });
}
// 显式传给本进程的环境变量优先（终端里 npm run entry、测试）；登录 shell 的补上缺的
const childEnv = () => ({
  ...loginEnv,
  ...process.env,
  ELECTRON_RUN_AS_NODE: '1',
  PATH: [loginEnv.PATH, path.join(os.homedir(), '.local/bin'), path.join(os.homedir(), '.claude/local'), '/opt/homebrew/bin', '/usr/local/bin', process.env.PATH || '/usr/bin:/bin'].filter(Boolean).join(':'),
});

// 验收用：NTR_ENTRY_TRACE=<文件> 时追加事件行（只记事件名与动作，不记正文）
const trace = (ev) => process.env.NTR_ENTRY_TRACE && fs.appendFileSync(process.env.NTR_ENTRY_TRACE, JSON.stringify({ t: Date.now(), ...ev }) + '\n');

function osa(script) {
  return new Promise((resolve) => {
    execFile('osascript', ['-e', script], { timeout: 3000 }, (err, stdout) => resolve(err ? '' : stdout.trim()));
  });
}

/** 唤起前的前台 app 是 iTerm 或 Terminal 时，读它当前会话的 tty（给 Router 做"正在看哪个会话"的语境，也决定新会话开在哪个终端）。 */
async function frontTerminalTty() {
  const front = await osa('tell application "System Events" to get bundle identifier of first application process whose frontmost is true');
  if (front === 'com.googlecode.iterm2') return (await osa('tell application "iTerm" to get tty of current session of current window')) || null;
  if (front === 'com.apple.Terminal') return (await osa('tell application "Terminal" to get tty of selected tab of front window')) || null;
  return null;
}

function runCli(args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { env: childEnv(), timeout: 60_000, maxBuffer: 4 << 20 }, (err, stdout, stderr) => {
      const lines = stdout.trim().split('\n');
      try {
        const o = JSON.parse(lines[lines.length - 1]);
        resolve({ ...o, line: describe(o) });
      } catch {
        const why = (stderr || String(err || t().noOutput)).trim();
        resolve({ action: 'failed', why, line: t().failed(why.slice(0, 300)) });
      }
    });
  });
}

// ---- 语音入口：satellite/ 收音端把听到的一句话 POST 过来，走与输入框相同的路由 ----
// 只听 127.0.0.1，且必须带 ~/.ntr/voice-token 里的口令：网页也能向 localhost 发请求，没有口令就能往会话里注入文字。
const VOICE_PORT = Number(process.env.NTR_VOICE_PORT) || 47615;
function voiceToken() {
  const file = path.join(NTR_HOME, 'voice-token');
  try { const tok = fs.readFileSync(file, 'utf8').trim(); if (tok) return tok; } catch { /* 第一次：生成 */ }
  const tok = crypto.randomBytes(24).toString('hex');
  fs.mkdirSync(NTR_HOME, { recursive: true });
  fs.writeFileSync(file, tok + '\n', { mode: 0o600 });
  return tok;
}
function startVoiceServer() {
  const token = Buffer.from(voiceToken());
  const authorized = (h) => { const b = Buffer.from(String(h || '').replace(/^Bearer /, '')); return b.length === token.length && crypto.timingSafeEqual(b, token); };
  const srv = http.createServer((req, res) => {
    const reply = (code, o) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(o)); };
    if (req.method !== 'POST' || req.url !== '/utterance') return reply(404, { error: 'not found' });
    if (!authorized(req.headers.authorization)) return reply(401, { error: 'bad token' });
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { body += c; if (body.length > 65536) req.destroy(); });
    req.on('end', async () => {
      let text = '';
      try { text = String(JSON.parse(body).text || '').trim(); } catch { /* 下面按空处理 */ }
      if (!text) return reply(400, { error: 'empty text' });
      // 人多半不在屏幕前：不带"正在看的终端"语境
      const r = await runCli(['open', '--json', '--', text]);
      trace({ ev: 'voice', action: r.action });
      // 拿不准时不弹窗抢焦点：这句话放进输入框，回到电脑按快捷键确认去处
      if (r.action !== 'clarify') return reply(200, { action: r.action, line: r.line });
      const placed = await win.webContents.executeJavaScript(`window.__ntrPrefill(${JSON.stringify(text)})`).catch(() => false);
      reply(200, { action: r.action, placed, line: placed ? t().voiceClarify : t().voiceClarifyBusy });
    });
  });
  srv.on('error', (e) => { console.error(`语音入口没有启动（127.0.0.1:${VOICE_PORT}）：${e.message}`); trace({ ev: 'voice-server', error: e.code }); });
  srv.listen(VOICE_PORT, '127.0.0.1', () => trace({ ev: 'voice-server', port: VOICE_PORT }));
}

const label = (o, card = o.card, id = o.sessionId) => (card ? `${card.title ?? t().untitled} · ${card.project}` : id);
function describe(o) {
  switch (o.action) {
    case 'wrote': return t().wrote(o.provider, label(o));
    case 'focused-only': return t().focused(label(o), o.why);
    case 'opened':
      // 分叉送达：显示原会话的名字（新会话在新标签页里，原会话未改动）
      if (o.forkedFrom) return t().forked(label(o, o.forkedFromCard ?? null, o.forkedFrom), typeof o.confidence === 'number' ? o.confidence.toFixed(2) : '?');
      return t().opened(o.provider, o.cwd);
    case 'failed': return t().failed(o.why);
    default: return '';
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: WIDTH, height: 64, useContentSize: true, show: false, frame: false, resizable: false,
    alwaysOnTop: true, skipTaskbar: true, hasShadow: true, roundedCorners: true,
    // macOS 原生毛玻璃：系统合成，开销最低，随深浅色模式变化；页面背景全透明
    vibrancy: 'popover', visualEffectState: 'active', backgroundColor: '#00000000',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true },
  });
  win.setAlwaysOnTop(true, 'floating');
  win.loadFile(path.join(__dirname, 'index.html'));
  win.on('blur', () => win?.isVisible() && hide());
}

function hide() {
  clearTimeout(hideTimer);
  win?.hide();
  if (process.platform === 'darwin') app.hide(); // 把焦点还给之前的 app
}

async function show() {
  focusedTty = await frontTerminalTty();
  clearTimeout(hideTimer);
  const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  win.setPosition(Math.round(workArea.x + (workArea.width - WIDTH) / 2), Math.round(workArea.y + workArea.height * 0.18));
  if (process.platform === 'darwin') app.show();
  win.show();
  app.focus({ steal: true });
  win.focus();
  win.webContents.send('show');
  trace({ ev: 'shown', focusedTty });
  setTimeout(() => trace({ ev: 'focus-after', focused: win.isFocused(), appActive: app.isHidden() === false }), 800);
}

const finishLater = (r) => {
  trace({ ev: 'result', action: r.action });
  if (r.action !== 'clarify') hideTimer = setTimeout(hide, r.action === 'failed' ? 6000 : 1800);
  return r;
};

ipcMain.handle('submit', async (_e, text) => {
  const args = ['open', '--json'];
  if (focusedTty) args.push('--focused-tty', focusedTty);
  return finishLater(await runCli([...args, '--', String(text)]));
});
ipcMain.handle('pick', async (_e, c) => {
  const prov = c.provider === 'codex' || (!c.provider && process.env.NTR_DEFAULT_PROVIDER === 'codex') ? 'codex' : 'claude';
  const args = ['open', '--json', ...(c.new ? ['--new', prov, ...(c.cwd ? ['--cwd', String(c.cwd)] : [])] : ['--pick', `${c.provider}:${c.sessionId}`])];
  return finishLater(await runCli([...args, '--', String(c.text)]));
});
ipcMain.on('cancel', hide);
// 窗口高度跟随内容（多行输入、候选/历史列表），向下长，不超过 640
ipcMain.on('resize', (_e, h) => {
  const hh = Math.max(48, Math.min(640, Math.round(Number(h) || 0)));
  if (win && win.getContentSize()[1] !== hh) win.setContentSize(WIDTH, hh);
});
ipcMain.handle('history', () => new Promise((resolve) => {
  execFile(process.execPath, [CLI, 'history'], { env: childEnv(), timeout: 30_000, maxBuffer: 4 << 20 }, (_err, stdout) => {
    try { const a = JSON.parse(stdout.trim().split('\n').pop()); resolve(Array.isArray(a) ? a : []); } catch { resolve([]); }
  });
}));

// ---- 快捷键（可在菜单栏修改，被占用时退回原来的） ----
function registerHotkey(acc) {
  const prev = HOTKEY;
  if (globalShortcut.isRegistered(prev)) globalShortcut.unregister(prev);
  let ok = false;
  try { ok = globalShortcut.register(acc, () => void show()); } catch { ok = false; }
  if (!ok) {
    if (prev !== acc) { try { globalShortcut.register(prev, () => void show()); } catch { /* 原快捷键也注册不上 */ } }
    return false;
  }
  HOTKEY = acc;
  refreshTray();
  return true;
}

let hotkeyWin = null;
function openHotkeyWindow() {
  if (hotkeyWin && !hotkeyWin.isDestroyed()) return hotkeyWin.focus();
  hotkeyWin = new BrowserWindow({
    width: 420, height: 220, resizable: false, minimizable: false, maximizable: false, title: t().hotkeyTitle,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true },
  });
  hotkeyWin.loadFile(path.join(__dirname, 'hotkey.html'));
  if (process.platform === 'darwin') app.show();
  hotkeyWin.on('closed', () => { hotkeyWin = null; });
}
ipcMain.handle('get-hotkey', () => ({ hotkey: HOTKEY, pretty: prettyKey(HOTKEY), fromEnv: !!process.env.NTR_HOTKEY, lang: LANG }));
ipcMain.handle('lang', () => LANG);
// macOS 系统保留的组合：Electron 注册它们不会报错，而是直接把 Spotlight / 输入法切换等抢走（2026-10-17 实测 ⌘Space）
const SYSTEM_RESERVED = new Set([
  'Command+Space', 'Control+Space', 'Command+Alt+Space', 'Control+Alt+Command+Space', 'Command+Tab', 'Command+Shift+Tab',
  'Command+Q', 'Command+W', 'Command+H', 'Command+M', 'Command+Alt+Escape', 'Command+Shift+3', 'Command+Shift+4', 'Command+Shift+5',
  'Control+Up', 'Control+Down', 'Control+Left', 'Control+Right', 'Control+Command+Q', 'Control+Command+Space',
]);
const normKey = (a) => a.split('+').map((p) => ({ Cmd: 'Command', Ctrl: 'Control', Option: 'Alt' }[p] || p)).join('+');
ipcMain.handle('set-hotkey', (_e, acc) => {
  const a = normKey(String(acc || '').trim());
  if (!a) return { ok: false, error: t().hkEmpty };
  if (SYSTEM_RESERVED.has(a)) return { ok: false, error: t().hkReserved(prettyKey(a)) };
  if (!registerHotkey(a)) return { ok: false, error: t().hkTaken(prettyKey(a)) };
  saveSettings({ hotkey: a });
  trace({ ev: 'hotkey-set', hotkey: a });
  return { ok: true, hotkey: a, pretty: prettyKey(a) };
});

// ---- 一键升级（只在打包版：源码运行时 execPath 是 node_modules 里的 Electron，不能替换） ----
// 运行中的 .app：<X>.app/Contents/MacOS/<可执行文件>
const APP_PATH = path.resolve(process.execPath, '..', '..', '..');
let update = { state: 'idle', rel: null }; // idle | available | installing
async function checkUpdate(manual) {
  if (update.state === 'installing') return;
  let rel;
  try { rel = await updater.latest(net.fetch, app.getVersion()); } catch (e) {
    trace({ ev: 'update-check', error: String(e.message || e) });
    if (manual) dialog.showMessageBox({ type: 'error', message: t().upCheckFailed, detail: String(e.message || e) });
    return;
  }
  trace({ ev: 'update-check', latest: rel.version, newer: rel.newer });
  if (rel.newer) { update = { state: 'available', rel }; refreshTray(); }
  if (!manual) return;
  if (!rel.newer) return void dialog.showMessageBox({ message: t().upLatest(app.getVersion()) });
  const { response } = await dialog.showMessageBox({ message: t().upFound(rel.version, app.getVersion()), buttons: [t().upNow, t().upNotes, t().upLater], defaultId: 0, cancelId: 2 });
  if (response === 0) void installUpdate();
  else if (response === 1) void shell.openExternal(rel.page);
}
async function installUpdate() {
  const rel = update.rel;
  if (!rel || update.state === 'installing') return;
  update = { state: 'installing', rel };
  refreshTray();
  try {
    const staged = await updater.stage(rel, APP_PATH, net.fetch);
    trace({ ev: 'update-staged', version: rel.version });
    updater.swapAfterExit(process.pid, APP_PATH, staged, process.env.NTR_UPDATE_NO_RELAUNCH !== '1');
    app.quit();
  } catch (e) {
    trace({ ev: 'update-failed', error: String(e.message || e) });
    update = { state: 'available', rel };
    refreshTray();
    const { response } = await dialog.showMessageBox({ type: 'error', message: t().upFailed, detail: String(e.message || e), buttons: [t().upManual, t().ok], defaultId: 0, cancelId: 1 });
    if (response === 0) void shell.openExternal(rel.page);
  }
}
const updateItems = () => {
  if (!app.isPackaged) return [];
  if (update.state === 'installing') return [{ label: t().upBusy(update.rel.version), enabled: false }];
  if (update.state === 'available') return [{ label: t().upTo(update.rel.version), click: () => void installUpdate() }];
  return [{ label: t().upCheck, click: () => void checkUpdate(true) }];
};

// ---- 菜单栏 ----
let tray = null;
function refreshTray() {
  if (!tray) return;
  const login = app.isPackaged ? app.getLoginItemSettings().openAtLogin : null;
  // 有新版本时菜单栏图标旁显示 ↑
  tray.setTitle(update.state === 'available' ? '↑' : '');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: t().trayShow(prettyKey(HOTKEY)), click: () => void show() },
    { label: t().trayHotkey, click: openHotkeyWindow },
    ...(app.isPackaged ? [{ label: t().trayLogin, type: 'checkbox', checked: !!login, click: (i) => { app.setLoginItemSettings({ openAtLogin: i.checked }); saveSettings({ openAtLogin: i.checked }); } }] : []),
    { type: 'separator' },
    { label: `Native Task Router ${app.getVersion()}`, enabled: false },
    ...updateItems(),
    { label: t().trayQuit, role: 'quit' },
  ]));
}

// 源码运行（npm run entry、测试）与已安装的 app 同名，会共用用户数据目录和单实例锁：源码版一启动就把唤起转给已安装的 app 后退出。分开目录。
if (!app.isPackaged) app.setPath('userData', path.join(app.getPath('appData'), 'native-task-router-dev'));
// 验收用：打包版与用户正在用的 app 并存时，换一个数据目录避开单实例锁
if (process.env.NTR_USER_DATA) app.setPath('userData', process.env.NTR_USER_DATA);
// 同一时间只允许一个入口（开机自启与手动打开会抢同一个快捷键）
if (!app.requestSingleInstanceLock()) app.quit();
else app.on('second-instance', () => void show());

app.whenReady().then(async () => {
  // 不 app.dock.hide()：accessory 激活策略下 macOS 不让它成为前台，输入框拿不到键盘焦点（2026-10-13 实测）
  LANG = pickLang();
  loginEnv = await resolveLoginEnv();
  createWindow();
  startVoiceServer();
  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'assets', 'trayTemplate.png')));
  tray.setToolTip('Native Task Router');
  // 打包版第一次运行：默认开机自动启动（菜单栏可关）
  if (app.isPackaged && loadSettings().openAtLogin === undefined) {
    app.setLoginItemSettings({ openAtLogin: true });
    saveSettings({ openAtLogin: true });
  }
  refreshTray();
  // 启动 10 秒后查一次新版本，之后每 6 小时一次；只点亮菜单，不打扰
  if (app.isPackaged) { setTimeout(() => void checkUpdate(false), 10_000); setInterval(() => void checkUpdate(false), 6 * 3600_000); }
  if (!registerHotkey(HOTKEY)) {
    console.error(`全局快捷键 ${HOTKEY} 注册失败（被占用？在菜单栏「修改快捷键…」里换一个）`);
    trace({ ev: 'registered', registered: false });
    openHotkeyWindow();
    return;
  }
  // 测试/排障：不经快捷键直接弹出
  if (process.env.NTR_ENTRY_SHOW === '1') void show();
  trace({ ev: 'registered', registered: globalShortcut.isRegistered(HOTKEY) });
  console.log(`ntr 入口就绪：${HOTKEY}`);
  trace({ ev: 'path', hasClaude: (childEnv().PATH || '').split(':').some((d) => fs.existsSync(path.join(d, 'claude'))) });
  if (process.env.NTR_ENTRY_CONTROL === 'stdin') controlFromStdin();
});
/**
 * 验收用控制通道(NTR_ENTRY_CONTROL=stdin)：每行一条 JSON，走与真实按键相同的渲染进程路径，
 * 不需要辅助功能授权，也不会把按键敲进用户的其它 app。
 *   {"cmd":"show"}            等同全局快捷键
 *   {"cmd":"type","text":..}  把文字放进输入框
 *   {"cmd":"enter"}           在输入框按回车
 *   {"cmd":"key","key":"1"}   在窗口上按一个键(clarify 选择)
 *   {"cmd":"update"}          查新版本，有就走与菜单"更新到 x 并重启"相同的路径
 */
function controlFromStdin() {
  const rl = require('node:readline').createInterface({ input: process.stdin });
  const js = (code) => win.webContents.executeJavaScript(code);
  rl.on('line', async (line) => {
    let m;
    try { m = JSON.parse(line); } catch { return; }
    if (m.cmd === 'show') await show();
    else if (m.cmd === 'hide') hide();
    else if (m.cmd === 'type') await js(`(()=>{const i=document.getElementById('in');i.value=${JSON.stringify(String(m.text))};i.setSelectionRange(i.value.length,i.value.length);i.dispatchEvent(new Event('input'));})()`);
    else if (m.cmd === 'enter') await js(`document.getElementById('in').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))`);
    else if (m.cmd === 'key') await js(`window.dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(String(m.key))},shiftKey:${!!m.shift}}))`);
    else if (m.cmd === 'caret') await js(`(()=>{const i=document.getElementById('in');i.setSelectionRange(${Number(m.at) || 0},${Number(m.at) || 0});})()`);
    else if (m.cmd === 'js') trace({ ev: 'js', tag: m.tag ?? null, result: await js(String(m.code)) });
    else if (m.cmd === 'probe') trace({ ev: 'probe', tag: m.tag ?? null, ...(await js('window.__ntrProbe()')), window: win.getContentSize() });
    else if (m.cmd === 'update') { await checkUpdate(false); trace({ ev: 'update-state', state: update.state, version: update.rel?.version ?? null }); if (update.state === 'available') await installUpdate(); }
    else if (m.cmd === 'shot') fs.writeFileSync(String(m.file), (await win.webContents.capturePage()).toPNG());
  });
}
app.on('window-all-closed', () => { /* 常驻：没有窗口也不退出 */ });
app.on('will-quit', () => globalShortcut.unregisterAll());
