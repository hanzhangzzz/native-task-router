// 组合 Surface：同时管 iTerm 与 Terminal。对外的 viewId 带终端前缀（`iterm:<session id>`、
// `terminal:<tty>`），focus / write / screenTail 按前缀分发给对应终端，open.ts 不需要知道有几种终端。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { OpenSurface } from '../open.ts';
import type { SurfaceId, SurfaceView } from '../types.ts';

const IDS: readonly SurfaceId[] = ['iterm', 'terminal'];
const isId = (s: string): s is SurfaceId => (IDS as readonly string[]).includes(s);

export function encodeViewId(surface: SurfaceId, id: string): string {
  return `${surface}:${id}`;
}

export function decodeViewId(viewId: string): { surface: SurfaceId; id: string } {
  const i = viewId.indexOf(':');
  const surface = i > 0 ? viewId.slice(0, i) : '';
  if (!isId(surface) || i === viewId.length - 1) throw new Error(`无法识别的终端视图: ${viewId}`);
  return { surface, id: viewId.slice(i + 1) };
}

export interface TargetFacts {
  /** NTR_TERMINAL 的值 */
  env?: string;
  /** 唤起入口前前台那个 tty 属于哪个终端 */
  focusedOwner: SurfaceId | null;
  running: Record<SurfaceId, boolean>;
  itermInstalled: boolean;
}

/** 新开会话去哪个终端：NTR_TERMINAL 指定 > 用户刚才在看的那个 > 正在运行的（都在跑选 iTerm） > 装了 iTerm 选 iTerm > Terminal。 */
export function pickTarget(f: TargetFacts): SurfaceId {
  if (f.env) {
    if (isId(f.env)) return f.env;
    throw new Error(`NTR_TERMINAL 只能是 iterm 或 terminal，当前是 "${f.env}"`);
  }
  if (f.focusedOwner) return f.focusedOwner;
  if (f.running.iterm) return 'iterm';
  if (f.running.terminal) return 'terminal';
  return f.itermInstalled ? 'iterm' : 'terminal';
}

export function itermInstalled(): boolean {
  return ['/Applications', path.join(os.homedir(), 'Applications')].some((d) => fs.existsSync(path.join(d, 'iTerm.app')));
}

export interface MultiDeps {
  surfaces: Record<SurfaceId, OpenSurface>;
  running: (s: SurfaceId) => Promise<boolean>;
  itermInstalled: () => boolean;
  /** 唤起入口前前台终端会话的 tty */
  focusedTty?: string | null;
  env?: string;
}

export function createMulti(d: MultiDeps): OpenSurface {
  // 某个终端列不出视图（例如用户拒绝了对它的自动化授权）时按"没有视图"处理，不拖垮另一个终端：
  // 少列视图只会让 open 走 failed / 只聚焦，不会写错会话。
  const views = async (s: SurfaceId): Promise<SurfaceView[]> =>
    (await d.surfaces[s].listViews().catch(() => [])).map((v) => ({ ...v, viewId: encodeViewId(s, v.viewId) }));
  const listAll = async () => (await Promise.all(IDS.map(views))).flat();
  const route = (viewId: string) => {
    const { surface, id } = decodeViewId(viewId);
    return { s: d.surfaces[surface], id };
  };

  return {
    listViews: listAll,
    focus: async (viewId) => { const r = route(viewId); await r.s.focus(r.id); },
    write: async (viewId, text) => { const r = route(viewId); await r.s.write(r.id, text); },
    press: async (viewId, keys) => { const r = route(viewId); await r.s.press(r.id, keys); },
    screenTail: async (viewId, lines) => { const r = route(viewId); return r.s.screenTail(r.id, lines); },

    /** windowId 只对 iTerm 有意义（测试把新 tab 隔离进指定 iTerm 窗口），给了就固定开在 iTerm。 */
    async openView(cwd, argv, opts) {
      let target: SurfaceId;
      if (opts?.windowId !== undefined) target = 'iterm';
      else {
        const focusedOwner = d.focusedTty ? ((await listAll()).find((v) => v.tty === d.focusedTty)?.surface ?? null) : null;
        const [iterm, terminal] = await Promise.all(IDS.map((s) => d.running(s)));
        target = pickTarget({ env: d.env, focusedOwner, running: { iterm: iterm!, terminal: terminal! }, itermInstalled: d.itermInstalled() });
      }
      const v = await d.surfaces[target].openView(cwd, argv, opts);
      return { ...v, viewId: encodeViewId(target, v.viewId) };
    },
  };
}
