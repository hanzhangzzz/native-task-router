// 最小入口窗口（技术合同 §0.2 Entry 层）：全局快捷键 → 悬浮输入框 → 子进程调用 CLI `open --json`。
// 不碰原生会话、不加载旧 desktop/；所有业务都在 src/layers/cli.ts。
const { app, BrowserWindow, globalShortcut, ipcMain, screen } = require('electron');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const HOTKEY = process.env.JEV_HOTKEY || 'Control+Alt+Space';
// JEV_ENTRY_CLI 只给界面验收用（换成返回固定结果的桩，不碰真实会话）
const CLI = process.env.JEV_ENTRY_CLI || path.join(__dirname, '..', 'src', 'layers', 'cli.ts');
const WIDTH = 640;
let win = null;
let focusedTty = null;
let hideTimer = null;

// Finder/Dock 启动的 GUI 进程 PATH 很短，codex/claude/pbcopy 的子进程需要 Homebrew 路径
const childEnv = () => ({
  ...process.env,
  ELECTRON_RUN_AS_NODE: '1',
  PATH: ['/opt/homebrew/bin', '/usr/local/bin', process.env.PATH || '/usr/bin:/bin'].join(':'),
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
    width: WIDTH, height: 90, useContentSize: true, show: false, frame: false, transparent: true, resizable: false,
    alwaysOnTop: true, skipTaskbar: true, hasShadow: false,
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
  const hh = Math.max(60, Math.min(640, Math.round(Number(h) || 0)));
  if (win && win.getContentSize()[1] !== hh) win.setContentSize(WIDTH, hh);
});
ipcMain.handle('history', () => new Promise((resolve) => {
  execFile(process.execPath, [CLI, 'history'], { env: childEnv(), timeout: 30_000, maxBuffer: 4 << 20 }, (_err, stdout) => {
    try { const a = JSON.parse(stdout.trim().split('\n').pop()); resolve(Array.isArray(a) ? a : []); } catch { resolve([]); }
  });
}));

app.whenReady().then(() => {
  // 不 app.dock.hide()：accessory 激活策略下 macOS 不让它成为前台，输入框拿不到键盘焦点（2026-10-13 实测）
  createWindow();
  if (!globalShortcut.register(HOTKEY, () => void show())) {
    console.error(`全局快捷键 ${HOTKEY} 注册失败（被占用？可用 JEV_HOTKEY 更换）`);
    app.exit(1);
    return;
  }
  // 测试/排障：不经快捷键直接弹出
  if (process.env.JEV_ENTRY_SHOW === '1') void show();
  trace({ ev: 'registered', registered: globalShortcut.isRegistered(HOTKEY) });
  console.log(`jev 入口就绪：${HOTKEY}`);
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
    else if (m.cmd === 'probe') trace({ ev: 'probe', tag: m.tag ?? null, ...(await js('window.__jevProbe()')), window: win.getContentSize() });
    else if (m.cmd === 'shot') fs.writeFileSync(String(m.file), (await win.webContents.capturePage()).toPNG());
  });
}
app.on('window-all-closed', (e) => e.preventDefault());
app.on('will-quit', () => globalShortcut.unregisterAll());
