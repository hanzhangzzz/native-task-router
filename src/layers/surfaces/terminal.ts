// Terminal.app Surface。纪律同 iterm.ts：AppleScript 全是固定源码，变量一律走 `on run argv` 传参，
// 文本/路径/命令不拼进脚本源码。
//
// 视图标识：Terminal 的 tab 没有 id，window id 稳定但 tab 序号会在同窗口前面的 tab 关闭时漂移。
// tty 在 tab 存活期间唯一且不变，所以 viewId 直接用 tab 的 tty（如 /dev/ttys012），每次操作都按 tty
// 重新在全部窗口里查找。风险：tab 关闭后 tty 可能被之后新开的 tab 复用，此时同一 viewId 指向新 tab；
// open.ts 在写入前会按会话 tty 重新列视图并核对 tty→pid→会话，复用的 tty 上跑的不是目标会话就不会写。
// 没有 tty 的 tab（进程已退出且窗口未关）无法寻址，不列出。
import type { Surface, SurfaceView } from '../types.ts';
import { buildCommand, osa, pasteBody } from './iterm.ts';

const FS = String.fromCharCode(31);
const RS = String.fromCharCode(30);

export class TerminalNotRunningError extends Error {
  constructor() {
    super('Terminal 未运行');
    this.name = 'TerminalNotRunningError';
  }
}

export async function terminalRunning(): Promise<boolean> {
  const out = await osa('tell application "System Events" to return (count of (every application process whose bundle identifier is "com.apple.Terminal"))');
  return Number(out) >= 1;
}

async function assertRunning(): Promise<void> {
  if (!(await terminalRunning())) throw new TerminalNotRunningError();
}

// 公共片段：按 tty 找 tab，返回 {window id, tab 序号}，调用方用 `tab i of window id w` 定位。
// 不返回 `repeat with t in` 的序号引用（窗口重排后会指错），也不把引用放进列表再取
// （`contents of (item 1 of list)` 会被当成解引用，读不到 tab 的 contents 属性）。
const FIND = `
on findTab(tt)
  tell application "Terminal"
    repeat with w in windows
      set wid to id of w
      repeat with i from 1 to count of tabs of w
        if (tty of tab i of window id wid) is tt then return {wid, i}
      end repeat
    end repeat
  end tell
  return missing value
end findTab
`;

export function parseRows(out: string): SurfaceView[] {
  return out
    .split(RS)
    .map((r) => r.replace(/^\n/, ''))
    .filter((r) => r.trim() !== '')
    .map((r) => {
      const [tty = '', ...title] = r.split(FS);
      return { surface: 'terminal' as const, viewId: tty, tty: tty || null, title: title.join(FS) };
    })
    .filter((v) => v.tty);
}

/** contents 是当前可见内容，末尾常有大量空行；去掉尾部空行后取最后 lines 行。 */
export function tailLines(contents: string, lines: number): string {
  const all = contents.split('\n');
  while (all.length && all[all.length - 1]!.trim() === '') all.pop();
  return all.slice(-lines).join('\n');
}

/** 选中 tab 并把它的窗口放到 Terminal 最前，不激活 Terminal（focus 的前半段；真实验收单独测它）。 */
export async function selectView(viewId: string): Promise<void> {
  await assertRunning();
  const r = await osa(`${FIND}
on run argv
  set hit to my findTab(item 1 of argv)
  if hit is missing value then return "missing"
  tell application "Terminal"
    set selected of tab (item 2 of hit) of window id (item 1 of hit) to true
    set frontmost of window id (item 1 of hit) to true
  end tell
  return "ok"
end run`, [viewId]);
  if (r !== 'ok') throw new Error(`Terminal 视图不存在: ${viewId}`);
}

/**
 * 新开一个窗口执行命令。`do script` 不带 in 时总是新开窗口；要开成 tab 只能用 System Events
 * 模拟 ⌘T，会抢焦点且依赖键盘布局，所以不做。
 * Terminal 没在运行时（冷启动）：先 `launch`（不开默认窗口），再 `do script`，避免多出一个空白的启动窗口；
 * 窗口建好后 `activate` 把 Terminal 带到前台，与 iTerm 冷启动一致——否则用户看不到刚启动的 Terminal。
 * Terminal 已在运行时不激活（不抢焦点；用户在别的应用里也能继续做事）。
 * deps 只为契约测试注入（scripts/layers-terminal.contracts.mjs 用假 osa 断言两个分支的脚本序列）；
 * 冷启动分支的真实效果会抢前台，live 验收用先启动好的 Terminal 跑，不覆盖它。
 */
export async function openTerminalView(
  cwd: string,
  argv: string[],
  deps: { running: () => Promise<boolean>; osa: (script: string, args?: string[]) => Promise<string> } = { running: terminalRunning, osa },
): Promise<SurfaceView> {
  const command = buildCommand(cwd, argv);
  const cold = !(await deps.running());
  if (cold) await deps.osa('tell application "Terminal" to launch');
  const out = await deps.osa(`
on run argv
  tell application "Terminal"
    set t to do script (item 1 of argv)
    return (tty of t) & (character id 31) & (custom title of t)
  end tell
end run`, [command]);
  const v = parseRows(out)[0];
  if (!v) throw new Error('Terminal 新窗口没有返回 tty');
  if (cold) await deps.osa('tell application "Terminal" to activate');
  return v;
}

export const terminal: Surface = {
  id: 'terminal',

  /** Terminal 未运行时返回空数组，且不会因此启动它。 */
  async listViews() {
    if (!(await terminalRunning())) return [];
    const out = await osa(`
tell application "Terminal"
  set acc to ""
  repeat with w in windows
    repeat with t in tabs of w
      set acc to acc & (tty of t) & (character id 31) & (custom title of t) & (character id 30)
    end repeat
  end repeat
  return acc
end tell`);
    return parseRows(out);
  },

  /** 选中 tab、把它的窗口放到最前，再激活 Terminal（用户刚按下入口，切过去是预期行为）。 */
  async focus(viewId) {
    await selectView(viewId);
    await osa('tell application "Terminal" to activate');
  },

  openView: (cwd, argv) => openTerminalView(cwd, argv),

  /**
   * `do script <正文> in <tab>` 把正文原样写进 tab 的输入并追加一个回车，回车即提交。live 验收②
   * 逐字节核对过：ESC、\n、\r、中文、emoji 都不改写，末尾恰好一个 \r，与 iTerm 的
   * "bracketed paste 正文 + \r" 一致。正文里的 ESC 由 pasteBody 剔除。
   */
  async write(viewId, text) {
    await assertRunning();
    const r = await osa(`${FIND}
on run argv
  set hit to my findTab(item 1 of argv)
  if hit is missing value then return "missing"
  tell application "Terminal" to do script (item 2 of argv) in tab (item 2 of hit) of window id (item 1 of hit)
  return "ok"
end run`, [viewId, pasteBody(text)]);
    if (r !== 'ok') throw new Error(`Terminal 视图不存在: ${viewId}`);
  },

  /**
   * 选项框的按键（↑↓↵Esc）。`do script` 末尾必带一个回车，所以末尾的 enter 由它出、
   * 其余按键原样写入；只剩 enter 时写空串（等于只按一次回车）。
   */
  async press(viewId, keys) {
    await assertRunning();
    const BYTES = { up: '\u001b[A', down: '\u001b[B', enter: '\r', esc: '\u001b' };
    let bytes = keys.map((k) => BYTES[k]).join('');
    if (keys.at(-1) === 'enter') bytes = bytes.slice(0, -1);
    const r = await osa(`${FIND}
on run argv
  set hit to my findTab(item 1 of argv)
  if hit is missing value then return "missing"
  tell application "Terminal" to do script (item 2 of argv) in tab (item 2 of hit) of window id (item 1 of hit)
  return "ok"
end run`, [viewId, bytes]);
    if (r !== 'ok') throw new Error(`Terminal 视图不存在: ${viewId}`);
  },

  async screenTail(viewId, lines) {
    await assertRunning();
    const out = await osa(`${FIND}
on run argv
  set hit to my findTab(item 1 of argv)
  if hit is missing value then return "missing:"
  tell application "Terminal" to return "ok:" & (contents of tab (item 2 of hit) of window id (item 1 of hit))
end run`, [viewId]);
    if (out.startsWith('missing:')) throw new Error(`Terminal 视图不存在: ${viewId}`);
    return tailLines(out.slice(3), lines);
  },
};
