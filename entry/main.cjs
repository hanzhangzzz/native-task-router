// 最小入口窗口（技术合同 §0.2 Entry 层）：全局快捷键 → 悬浮输入框 → 子进程调用 CLI `open --json`。
// 不碰原生会话、不加载旧 desktop/；所有业务都在 src/layers/cli.ts。
const { app, BrowserWindow, globalShortcut, ipcMain, screen, Tray, Menu, nativeImage } = require('electron');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

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
    opened: (p, cwd) => `已新开 ${p}：${cwd}`, failed: (why) => `失败：${why}`,
    trayShow: (k) => `唤起输入框（${k}）`, trayHotkey: '修改快捷键…', trayLogin: '开机自动启动', trayQuit: '退出', hotkeyTitle: '修改快捷键',
    hkEmpty: '快捷键为空', hkReserved: (k) => `${k} 是系统保留的快捷键（如 Spotlight、输入法切换），请换一个`, hkTaken: (k) => `${k} 注册失败（可能被别的应用占用）`,
  },
  en: {
    untitled: '(untitled)', noOutput: 'no output', wrote: (p, l) => `Sent to ${p}: ${l}`,
    focused: (l) => `Switched to ${l} but didn't type into it (busy, waiting for approval, or has a draft). Your text is on the clipboard.`,
    opened: (p, cwd) => `Opened ${p} in a new tab: ${cwd}`, failed: (why) => `Failed: ${why}`,
    trayShow: (k) => `Open input box (${k})`, trayHotkey: 'Change hotkey…', trayLogin: 'Open at login', trayQuit: 'Quit', hotkeyTitle: 'Change hotkey',
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

const label = (o) => (o.card ? `${o.card.title ?? t().untitled} · ${o.card.project}` : o.sessionId);
function describe(o) {
  switch (o.action) {
    case 'wrote': return t().wrote(o.provider, label(o));
    case 'focused-only': return t().focused(label(o), o.why);
    case 'opened': return t().opened(o.provider, o.cwd);
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

// ---- 菜单栏 ----
let tray = null;
function refreshTray() {
  if (!tray) return;
  const login = app.isPackaged ? app.getLoginItemSettings().openAtLogin : null;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: t().trayShow(prettyKey(HOTKEY)), click: () => void show() },
    { label: t().trayHotkey, click: openHotkeyWindow },
    ...(app.isPackaged ? [{ label: t().trayLogin, type: 'checkbox', checked: !!login, click: (i) => { app.setLoginItemSettings({ openAtLogin: i.checked }); saveSettings({ openAtLogin: i.checked }); } }] : []),
    { type: 'separator' },
    { label: `Native Task Router ${app.getVersion()}`, enabled: false },
    { label: t().trayQuit, role: 'quit' },
  ]));
}

// 源码运行（npm run entry、测试）与已安装的 app 同名，会共用用户数据目录和单实例锁：源码版一启动就把唤起转给已安装的 app 后退出。分开目录。
if (!app.isPackaged) app.setPath('userData', path.join(app.getPath('appData'), 'native-task-router-dev'));
// 同一时间只允许一个入口（开机自启与手动打开会抢同一个快捷键）
if (!app.requestSingleInstanceLock()) app.quit();
else app.on('second-instance', () => void show());

app.whenReady().then(async () => {
  // 不 app.dock.hide()：accessory 激活策略下 macOS 不让它成为前台，输入框拿不到键盘焦点（2026-10-13 实测）
  LANG = pickLang();
  loginEnv = await resolveLoginEnv();
  createWindow();
  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'assets', 'trayTemplate.png')));
  tray.setToolTip('Native Task Router');
  // 打包版第一次运行：默认开机自动启动（菜单栏可关）
  if (app.isPackaged && loadSettings().openAtLogin === undefined) {
    app.setLoginItemSettings({ openAtLogin: true });
    saveSettings({ openAtLogin: true });
  }
  refreshTray();
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
    else if (m.cmd === 'shot') fs.writeFileSync(String(m.file), (await win.webContents.capturePage()).toPNG());
  });
}
app.on('window-all-closed', () => { /* 常驻：没有窗口也不退出 */ });
app.on('will-quit', () => globalShortcut.unregisterAll());
