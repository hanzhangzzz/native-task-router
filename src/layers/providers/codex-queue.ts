// Codex 原生"给已有会话排队消息"通道：`codex queue --thread <id> --message <text>`。
//
// 2026-10-13 实测（codex-cli 0.162.1）：对正显示在 TUI 里、空闲的线程，消息立即作为一条人工输入进入
// 同一个 rollout 并触发回复，不经过任何按键模拟；线程在不在 iTerm 里无关。
// 两个坑：① 带 `-c` 覆盖项会报 "cannot queue through an embedded app server while a local
// app-server daemon is running"，所以这里不加 -c（queue 不是 TUI，没有更新菜单）；
// ② 线程正停在审批框时排队的消息会随"取消"一起丢失（rollout 里没有），所以只对空闲会话使用。
import { execFile } from 'node:child_process';

export function codexQueue(threadId: string, text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('codex', ['queue', `--thread=${threadId}`, `--message=${text}`], { timeout: 30_000 }, (err, _out, stderr) => {
      if (err) reject(new Error(`codex queue 失败: ${(stderr || err.message).trim().slice(0, 300)}`));
      else resolve();
    });
  });
}
