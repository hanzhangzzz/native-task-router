// 最小入口窗口（技术合同 §0.2 Entry 层）：全局快捷键 → 悬浮输入框 → 子进程调用 CLI `open --json`。
// 不碰原生会话、不加载旧 desktop/；所有业务都在 src/layers/cli.ts。
const { app, BrowserWindow, globalShortcut, ipcMain, screen, Tray, Menu, nativeImage } = require('electron');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 设置（快捷键、开机启动）存在 ~/.jev/settings.json；环境变量 JEV_HOTKEY 优先（开发与测试用）
const JEV_HOME = process.env.JEV_HOME || path.join(os.homedir(), '.jev');
const SETTINGS = path.join(JEV_HOME, 'settings.json');
const DEFAULT_HOTKEY = 'Control+Alt+Space';
const loadSettings = () => { try { return JSON.parse(fs.readFileSync(SETTINGS, 'utf8')); } catch { return {}; } };
const saveSettings = (patch) => {
  const next = { ...loadSettings(), ...patch };
  fs.mkdirSync(JEV_HOME, { recursive: true });
  fs.writeFileSync(SETTINGS, JSON.stringify(next, null, 2) + '\n');
  return next;
};
let HOTKEY = process.env.JEV_HOTKEY || loadSettings().hotkey || DEFAULT_HOTKEY;
const prettyKey = (acc) => acc.replace(/Command\+|Cmd\+/g, '⌘').replace(/Control\+|Ctrl\+/g, '⌃').replace(/Alt\+|Option\+/g, '⌥').replace(/Shift\+/g, '⇧');
// JEV_ENTRY_CLI 只给界面验收用（换成返回固定结果的桩，不碰真实会话）
const CLI = process.env.JEV_ENTRY_CLI || path.join(__dirname, '..', 'src', 'layers', 'cli.ts');
const WIDTH = 640;
let win = null;
let focusedTty = null;
let hideTimer = null;

// 从 Finder/Dock/登录项启动的 GUI 进程 PATH 很短，找不到 claude/codex：启动时向用户的登录 shell 要一次 PATH
let loginPath = null;
function resolveLoginPath() {
  return new Promise((resolve) => {
    execFile(process.env.SHELL || '/bin/zsh', ['-ilc', 'printf "__JEVPATH__%s" "$PATH"'], { timeout: 8000 }, (_e, out) => {
      const m = String(out || '').match(/__JEVPATH__([^\n]*)/);
      resolve(m ? m[1].trim() : null);
    });
  });
}
const childEnv = () => ({
  ...process.env,
  ELECTRON_RUN_AS_NODE: '1',
  PATH: [loginPath, path.join(os.homedir(), '.local/bin'), path.join(os.homedir(), '.claude/local'), '/opt/homebrew/bin', '/usr/local/bin', process.env.PATH || '/usr/bin:/bin'].filter(Boolean).join(':'),
});

// 验收用：JEV_ENTRY_TRACE=<文件> 时追加事件行（只记事件名与动作，不记正文）
const trace = (ev) => process.env.JEV_ENTRY_TRACE && fs.appendFileSync(process.env.JEV_ENTRY_TRACE, JSON.stringify({ t: Date.now(), ...ev }) + '\n');

function osa(script) {
  return new Promise((resolve) => {
    execFile('osascript', ['-e', script], { timeout: 3000 }, (err, stdout) => resolve(err ? '' : stdout.trim()));
  });
}

/** 唤起前的前台 app 是 iTerm 时，读它当前 session 的 tty（给 Router 做"正在看哪个会话"的语境）。 */
async function frontIterm() {
  const front = await osa('tell application "System Events" to get bundle identifier of first application process whose frontmost is true');
  if (front !== 'com.googlecode.iterm2') return null;
  return (await osa('tell application "iTerm" to get tty of current session of current window')) || null;
}

function runCli(args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { env: childEnv(), timeout: 60_000, maxBuffer: 4 << 20 }, (err, stdout, stderr) => {
      const lines = stdout.trim().split('\n');
      try {
        const o = JSON.parse(lines[lines.length - 1]);
        resolve({ ...o, line: describe(o) });
      } catch {
        resolve({ action: 'failed', why: (stderr || String(err || '无输出')).trim(), line: `失败: ${(stderr || String(err || '无输出')).trim().slice(0, 300)}` });
      }
    });
  });
}

const label = (o) => (o.card ? `${o.card.title ?? '(无标题)'} · ${o.card.project}` : o.sessionId);
function describe(o) {
  switch (o.action) {
    case 'wrote': return `已送达 ${o.provider}：${label(o)}`;
    case 'focused-only': return `只聚焦 ${label(o)}：${o.why}`;
    case 'opened': return `已新开 ${o.provider}：${o.cwd}`;
    case 'failed': return `失败：${o.why}`;
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
  focusedTty = await frontIterm();
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
  const prov = c.provider === 'codex' || (!c.provider && process.env.JEV_DEFAULT_PROVIDER === 'codex') ? 'codex' : 'claude';
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
    width: 420, height: 220, resizable: false, minimizable: false, maximizable: false, title: '修改快捷键',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true },
  });
  hotkeyWin.loadFile(path.join(__dirname, 'hotkey.html'));
  if (process.platform === 'darwin') app.show();
  hotkeyWin.on('closed', () => { hotkeyWin = null; });
}
ipcMain.handle('get-hotkey', () => ({ hotkey: HOTKEY, pretty: prettyKey(HOTKEY), fromEnv: !!process.env.JEV_HOTKEY }));
// macOS 系统保留的组合：Electron 注册它们不会报错，而是直接把 Spotlight / 输入法切换等抢走（2026-10-17 实测 ⌘Space）
const SYSTEM_RESERVED = new Set([
  'Command+Space', 'Control+Space', 'Command+Alt+Space', 'Control+Alt+Command+Space', 'Command+Tab', 'Command+Shift+Tab',
  'Command+Q', 'Command+W', 'Command+H', 'Command+M', 'Command+Alt+Escape', 'Command+Shift+3', 'Command+Shift+4', 'Command+Shift+5',
  'Control+Up', 'Control+Down', 'Control+Left', 'Control+Right', 'Control+Command+Q', 'Control+Command+Space',
]);
const normKey = (a) => a.split('+').map((p) => ({ Cmd: 'Command', Ctrl: 'Control', Option: 'Alt' }[p] || p)).join('+');
ipcMain.handle('set-hotkey', (_e, acc) => {
  const a = normKey(String(acc || '').trim());
  if (!a) return { ok: false, error: '快捷键为空' };
  if (SYSTEM_RESERVED.has(a)) return { ok: false, error: `${prettyKey(a)} 是系统保留的快捷键（如 Spotlight、输入法切换），请换一个` };
  if (!registerHotkey(a)) return { ok: false, error: `${prettyKey(a)} 注册失败（可能被别的应用占用）` };
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
    { label: `唤起输入框（${prettyKey(HOTKEY)}）`, click: () => void show() },
    { label: '修改快捷键…', click: openHotkeyWindow },
    ...(app.isPackaged ? [{ label: '开机自动启动', type: 'checkbox', checked: !!login, click: (i) => { app.setLoginItemSettings({ openAtLogin: i.checked }); saveSettings({ openAtLogin: i.checked }); } }] : []),
    { type: 'separator' },
    { label: `Native Task Router ${app.getVersion()}`, enabled: false },
    { label: '退出', role: 'quit' },
  ]));
}

// 同一时间只允许一个入口（开机自启与手动打开会抢同一个快捷键）
if (!app.requestSingleInstanceLock()) app.quit();
else app.on('second-instance', () => void show());

app.whenReady().then(async () => {
  // 不 app.dock.hide()：accessory 激活策略下 macOS 不让它成为前台，输入框拿不到键盘焦点（2026-10-13 实测）
  loginPath = await resolveLoginPath();
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
  if (process.env.JEV_ENTRY_SHOW === '1') void show();
  trace({ ev: 'registered', registered: globalShortcut.isRegistered(HOTKEY) });
  console.log(`jev 入口就绪：${HOTKEY}`);
  trace({ ev: 'path', hasClaude: (childEnv().PATH || '').split(':').some((d) => fs.existsSync(path.join(d, 'claude'))) });
  if (process.env.JEV_ENTRY_CONTROL === 'stdin') controlFromStdin();
});
/**
 * 验收用控制通道(JEV_ENTRY_CONTROL=stdin)：每行一条 JSON，走与真实按键相同的渲染进程路径，
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
    else if (m.cmd === 'probe') trace({ ev: 'probe', tag: m.tag ?? null, ...(await js('window.__jevProbe()')), window: win.getContentSize() });
    else if (m.cmd === 'shot') fs.writeFileSync(String(m.file), (await win.webContents.capturePage()).toPNG());
  });
}
app.on('window-all-closed', () => { /* 常驻：没有窗口也不退出 */ });
app.on('will-quit', () => globalShortcut.unregisterAll());
