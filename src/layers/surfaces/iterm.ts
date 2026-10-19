// iTerm Surface（技术合同 §0.4）。所有 AppleScript 都是固定源码，变量一律走 `on run argv`
// 传参（execFile 不经 shell），文本/路径/命令不会拼进脚本源码，所以不存在 AppleScript 注入。
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Surface, SurfaceView } from '../types.ts';

const run = promisify(execFile);

const FS = String.fromCharCode(31); // 字段分隔
const RS = String.fromCharCode(30); // 记录分隔

export class ItermNotRunningError extends Error {
  constructor() {
    super('iTerm 未运行');
    this.name = 'ItermNotRunningError';
  }
}

/** POSIX shell 单引号转义：任意字节（含换行、$、反引号、引号）都按字面量传递。 */
export function shellQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

/** `cd <cwd> && <argv...>`，每个词都做 POSIX 转义。 */
export function buildCommand(cwd: string, argv: string[]): string {
  if (argv.length === 0) throw new Error('argv 不能为空');
  return `cd ${shellQuote(cwd)} && ${argv.map(shellQuote).join(' ')}`;
}

/** bracketed paste 包裹的正文。正文里的 ESC 会提前结束粘贴并把后续字节当按键，必须剔除。 */
export function pasteBody(text: string): string {
  return `\u001b[200~${text.replaceAll('\u001b', '')}\u001b[201~`;
}

// `--` 之后的参数一律是脚本参数：否则以 `-` 开头的值（如 "-n"）会被 osascript 当成选项。
export async function osa(script: string, args: string[] = []): Promise<string> {
  const { stdout } = await run('osascript', ['-e', script, '--', ...args], { maxBuffer: 16 * 1024 * 1024 });
  return stdout.replace(/\n$/, '');
}

export async function itermRunning(): Promise<boolean> {
  const out = await osa('tell application "System Events" to return (count of (every application process whose bundle identifier is "com.googlecode.iterm2"))');
  return Number(out) >= 1;
}

async function assertRunning(): Promise<void> {
  if (!(await itermRunning())) throw new ItermNotRunningError();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 冷启动 iTerm 并切到前台；等到窗口数连续约 1 秒不变（启动时自带的窗口已建好）才返回，最多等 15 秒。 */
async function coldStart(): Promise<void> {
  await osa('tell application "iTerm" to activate');
  let last = -1, stable = 0;
  for (const until = Date.now() + 15_000; Date.now() < until; await sleep(350)) {
    const n = Number(await osa('tell application "iTerm" to return count of windows').catch(() => '-1'));
    stable = n >= 0 && n === last ? stable + 1 : 0;
    last = n;
    if (stable >= 3) return;
  }
}

/** tty 停在 shell 提示符：前台进程组里只有 login/shell（后台辅助进程和已退出的僵尸不算）。iTerm 刚启动时自带的空白会话就是这样。 */
async function idleShell(tty: string): Promise<boolean> {
  const { stdout } = await run('ps', ['-t', tty.replace(/^\/dev\//, ''), '-o', 'stat=,comm=']);
  const fg = stdout.split('\n').map((l) => l.trim().split(/\s+/)).filter(([stat]) => stat && stat.includes('+') && !stat.includes('Z'));
  return fg.length > 0 && fg.every(([, comm = '']) => ['login', 'zsh', 'bash', 'sh', 'fish'].includes(comm.replace(/^-/, '').split('/').pop()!));
}

// 公共片段：在全部 window/tab/session 里按 id 找 session，找不到返回 missing value。
const FIND = `
on findSession(sid)
  tell application "iTerm"
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          if (id of s) is sid then return s
        end repeat
      end repeat
    end repeat
  end tell
  return missing value
end findSession
`;

const ROW = `
on describe(s)
  tell application "iTerm" to return (id of s) & (character id 31) & (tty of s) & (character id 31) & (name of s)
end describe
`;

function parseRow(row: string): SurfaceView {
  const [viewId = '', tty = '', ...name] = row.split(FS);
  return { surface: 'iterm', viewId, tty: tty || null, title: name.join(FS) };
}

// 比 Surface 多一个可选的 windowId（把新 tab 开进指定窗口，测试隔离用），仍可赋给 Surface。
export const iterm: Omit<Surface, 'openView'> & { openView(cwd: string, argv: string[], opts?: { windowId?: number }): Promise<SurfaceView> } = {
  id: 'iterm',

  /** iTerm 未运行时返回空数组（没有视图是事实，不是错误）；其他操作则抛 ItermNotRunningError。 */
  async listViews() {
    try {
      await assertRunning();
    } catch (e) {
      if (e instanceof ItermNotRunningError) return [];
      throw e;
    }
    const out = await osa(`
tell application "iTerm"
  set acc to ""
  repeat with w in windows
    repeat with t in tabs of w
      repeat with s in sessions of t
        set acc to acc & (id of s) & (character id 31) & (tty of s) & (character id 31) & (name of s) & (character id 30)
      end repeat
    end repeat
  end repeat
  return acc
end tell`);
    return out.split(RS).filter((r) => r.trim() !== '').map((r) => parseRow(r.replace(/^\n/, '')));
  },

  async focus(viewId) {
    await assertRunning();
    const r = await osa(`${FIND}
on run argv
  set sid to item 1 of argv
  tell application "iTerm"
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          if (id of s) is sid then
            select w
            select t
            select s
            activate
            return "ok"
          end if
        end repeat
      end repeat
    end repeat
  end tell
  return "missing"
end run`, [viewId]);
    if (r !== 'ok') throw new Error(`iTerm 视图不存在: ${viewId}`);
  },

  /**
   * 默认在当前窗口开 tab，没有可用窗口就新建（iTerm 关闭后会残留不可见的 0 session 窗口对象，所以不能用 count of windows 判断）；opts.windowId 指定窗口（测试和隔离用）。
   * iTerm 没在运行时先冷启动它；启动后若只有它自带的一个空白会话，就直接在那个会话里执行，不多留一个空标签页。
   */
  async openView(cwd, argv, opts) {
    const command = buildCommand(cwd, argv);
    if (!(await itermRunning())) {
      await coldStart();
      const views = await iterm.listViews();
      if (opts?.windowId === undefined && views.length === 1 && views[0]!.tty && (await idleShell(views[0]!.tty))) {
        const r = await osa(`${FIND}
on run argv
  set s to my findSession(item 1 of argv)
  if s is missing value then return "missing"
  tell application "iTerm" to tell s to write text (item 2 of argv)
  return "ok"
end run`, [views[0]!.viewId, command]);
        if (r === 'ok') return views[0]!;
      }
    }
    const row = await osa(`${ROW}
on run argv
  set cmd to item 1 of argv
  set wid to item 2 of argv
  tell application "iTerm"
    if wid is not "" then
      set w to window id (wid as integer)
      tell w to set t to (create tab with default profile)
    else if (current window) is missing value then
      set w to (create window with default profile)
      set t to current tab of w
    else
      tell current window to set t to (create tab with default profile)
    end if
    set s to current session of t
    tell s to write text cmd
  end tell
  return my describe(s)
end run`, [command, opts?.windowId === undefined ? '' : String(opts.windowId)]);
    return parseRow(row);
  },

  /**
   * bracketed paste 正文 + 单独一个 \r。AppleScript `write text ... newline NO` 原样发送字节
   * （含 ESC，正文里的 \n 也不转换，live 验收②逐字节核对过）；正文里的 ESC 由 pasteBody 剔除，
   * 防止提前结束粘贴。
   */
  async write(viewId, text) {
    await assertRunning();
    const r = await osa(`${FIND}
on run argv
  set s to my findSession(item 1 of argv)
  if s is missing value then return "missing"
  tell application "iTerm"
    tell s
      write text (item 2 of argv) newline NO
      write text (character id 13) newline NO
    end tell
  end tell
  return "ok"
end run`, [viewId, pasteBody(text)]);
    if (r !== 'ok') throw new Error(`iTerm 视图不存在: ${viewId}`);
  },

  async screenTail(viewId, lines) {
    await assertRunning();
    const out = await osa(`${FIND}
on run argv
  set s to my findSession(item 1 of argv)
  if s is missing value then return "missing:"
  tell application "iTerm" to return "ok:" & (contents of s)
end run`, [viewId]);
    if (out.startsWith('missing:')) throw new Error(`iTerm 视图不存在: ${viewId}`);
    const all = out.slice(3).split('\n');
    while (all.length && all[all.length - 1]!.trim() === '') all.pop();
    return all.slice(-lines).join('\n');
  },
};

const _assignable: Surface = iterm;
void _assignable;
