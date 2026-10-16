// 真实 iTerm 测试的安全护栏（2026-10-14 事故后加入）：测试跑在用户正在用的 iTerm 上。
// 实测（2026-10-14）：对含多个会话的窗口执行 `close window`，iTerm 会挂出模态确认框
// "Close Window #N? This window will be closed. [Cancel] [OK]"（用户只关了单会话的关闭确认），
// AppleScript 照样返回成功、窗口不关；旧测试因此改成往会话里输入 `exit`，又留下关不掉的
// "0 个会话的窗口对象"。两者叠加让用户的 iTerm 卡死、无法正常退出。
// 正确做法：逐个 close 测试窗口里的会话（单个会话关闭不弹确认），最后一个关掉后窗口随之消失。
//   - 必须显式 JEV_LIVE_ITERM=1 才运行（默认不碰用户的 iTerm）；
//   - 只建一个测试窗口，收尾逐个关闭其中的会话（绝不对整个窗口 close），并核对 iTerm 的窗口对象回到测试前；
//   - Ctrl-C / 被终止 / 未捕获异常时同样关闭测试窗口。
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const osa = async (script) => (await run('osascript', ['-e', script], { timeout: 15000 })).stdout.trim();
const windowIds = async () => (await osa('tell application "iTerm" to get id of every window')).split(',').map((s) => s.trim()).filter(Boolean);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 没有 JEV_LIVE_ITERM=1 就退出（退出码 2，不算通过）。 */
export function requireLiveOptIn(name) {
  if (process.env.JEV_LIVE_ITERM === '1') return;
  console.error(`NOT_RUN ${name}: 会在你正在用的 iTerm 里建测试窗口并运行真实 Claude/Codex。确认要跑时设置 JEV_LIVE_ITERM=1。`);
  process.exit(2);
}

/** 建一个测试窗口并记下基线；返回 { wid, close() }。close() 幂等，返回 { ok, detail }。 */
export async function openTestWindow() {
  const baseline = new Set(await windowIds());
  const wid = Number(await osa('tell application "iTerm" to return id of (create window with default profile)'));
  let closing = null;
  const close = () =>
    (closing ??= (async () => {
      for (let i = 0; i < 40; i++) {
        const now = await windowIds();
        if (!now.includes(String(wid))) break;
        try {
          await osa(`tell application "iTerm"\n  if (count of tabs of window id ${wid}) > 0 then close (current session of first tab of window id ${wid})\nend tell`);
        } catch (e) {
          // 最后一个会话退出后窗口可能恰好在检查与关闭之间消失（-1728 找不到窗口），以重新检查为准
          if ((await windowIds()).includes(String(wid))) return { ok: false, detail: `关闭测试会话失败: ${e.message}` };
          break;
        }
        await sleep(500);
      }
      // 多标签页时最后几个会话是异步退出的（全套实测里约需十几秒），给足 30 秒再判
      for (let i = 0; i < 15; i++) {
        const now = await windowIds();
        if (!now.includes(String(wid)) && now.every((id) => baseline.has(id))) return { ok: true, detail: `窗口对象回到测试前（${now.length} 个）` };
        await sleep(2000);
      }
      const now = await windowIds();
      return { ok: false, detail: `测试后 iTerm 窗口对象 [${now}] 与测试前 [${[...baseline]}] 不一致` };
    })());
  const onSignal = (sig) => {
    void close().finally(() => process.exit(sig === 'uncaught' ? 1 : 130));
  };
  process.once('SIGINT', () => onSignal('SIGINT'));
  process.once('SIGTERM', () => onSignal('SIGTERM'));
  process.once('uncaughtException', (e) => {
    console.error(e);
    onSignal('uncaught');
  });
  return { wid, close };
}
