import fs from 'node:fs';
import type { OpenSurface } from './open.ts';

/**
 * 测试隔离闸门：NTR_GUARD_FILE 指向 {views:[viewId], sessions:[sessionId]}，只允许碰名单里的视图/会话，
 * 其余一律抛错（open 会转成 failed + 剪贴板）。真实路由冒烟时防止误写用户自己的会话；生产不设置。
 * 名单里的视图既可写组合 Surface 的带前缀 id（`iterm:<id>`、`terminal:<tty>`），也可写终端自己的裸 id。
 */
type Queue = (sessionId: string, text: string) => Promise<void>;

export function guarded(surface: OpenSurface, queue: Queue, file = process.env.NTR_GUARD_FILE): { surface: OpenSurface; queue: Queue } {
  if (!file) return { surface, queue };
  const allow = (): { views: string[]; sessions: string[] } => JSON.parse(fs.readFileSync(file, 'utf8'));
  const ownView = (v: string): boolean => {
    const views = allow().views;
    return views.includes(v) || views.includes(v.replace(/^(?:iterm|terminal):/, ''));
  };
  const deny = (what: string): never => {
    throw new Error(`NTR_GUARD_FILE 拒绝: ${what}`);
  };
  return {
    surface: {
      ...surface,
      write: async (v, t) => (ownView(v) ? surface.write(v, t) : deny(`write ${v}`)),
      press: async (v, k) => (ownView(v) ? surface.press(v, k) : deny(`press ${v}`)),
      focus: async (v) => (ownView(v) ? surface.focus(v) : deny(`focus ${v}`)),
      openView: async (cwd, argv, o) => {
        const i = argv.findIndex((a) => a === '-r' || a === 'resume');
        const id = i >= 0 ? argv[i + 1] : undefined;
        return id && !allow().sessions.includes(id) ? deny(`resume ${id}`) : surface.openView(cwd, argv, o);
      },
    },
    queue: async (id, t) => (allow().sessions.includes(id) ? queue(id, t) : deny(`queue ${id}`)),
  };
}
