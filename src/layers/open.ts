// open(text)：把一句话送到正确的原生会话（技术合同 §0.2）。只依赖 types.ts 里的四层合同，
// Router / Provider / Surface 全部注入，所以能用假实现逐条验证分支。
//
// 不变量（合同测试逐条断言）：
//   A1 不在这里保证（Router 的阈值负责）；A2 写入前立即重新核对 tty→pid→sessionId、状态、屏幕，
//      任一不满足绝不 write；已存活的会话绝不再起第二个 resume 进程。
//   A3 任何没送达的路径（focused-only / failed）都把正文放进剪贴板；clarify 把候选原样返回，正文仍在调用方手里。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ntrHome } from './providers/common.ts';
import type {
  LiveSession,
  OpenOutcome,
  Provider,
  ProviderId,
  RouteContext,
  RouteDecision,
  Router,
  SessionCard,
  Surface,
  SurfaceView,
} from './types.ts';

export type OpenSurface = Omit<Surface, 'openView'> & {
  openView(cwd: string, argv: string[], opts?: { windowId?: number }): Promise<SurfaceView>;
};

export interface OpenOptions {
  router: Router;
  providers: Provider[];
  surface: OpenSurface;
  /** 人已选定目标：跳过路由 */
  pick?: { provider: ProviderId; sessionId: string };
  /** 人明确要新建 */
  forceNew?: { provider: ProviderId; cwd?: string };
  /** 新 tab 开进指定 iTerm 窗口（测试隔离） */
  windowId?: number;
  /** 唤起入口前前台 iTerm 会话的 tty */
  focusedTty?: string | null;
  /** 原生"给已有会话排队消息"通道（仅对空闲的存活会话使用，不经按键） */
  queue?: Partial<Record<ProviderId, (sessionId: string, text: string) => Promise<void>>>;
  clipboard?: (text: string) => Promise<void>;
  /** 入口记录文件；缺省 $NTR_HOME|~/.ntr 下的 entry-log.jsonl */
  logPath?: string;
  /** 新建会话缺省目录根；缺省 ~/ntr-tasks（CLI 读 NTR_TASKS_DIR） */
  tasksRoot?: string;
  /** 新开视图后等待原生写出会话 id 的最长毫秒数（用于填 sessionId 与下一句的语境） */
  settleMs?: number;
  now?: () => number;
}

/** 屏幕末尾读多少行来判断审批框/草稿 */
export const SCREEN_TAIL_LINES = 16;
/** 输入行只在最后这几行里找 */
const INPUT_WINDOW = 10;

// 2026-10-13 在 Claude Code 2.1.288 与 codex-cli 0.162.1 的真实 TUI 上观察到的特征：
//   Claude 工具审批：" Do you want to proceed? / ❯ 1. Yes / 2. … / 3. No / Esc to cancel · Tab to amend"
//   Codex 命令审批："Would you like to run the following command? / › 1. Yes, proceed (y) /
//                    … / Press enter to confirm or esc to cancel"
// 其余选择类菜单（模型选择、/ 命令、信任目录）同样带编号选项或 "Enter to select"。宁可多拦：误拦只是少一次自动送达。
const PROMPT_PATTERNS: RegExp[] = [
  /Do you want to /,
  /Would you like to /,
  /Esc to cancel/i,
  /esc to cancel/i,
  /Press enter to confirm/i,
  /Enter to (?:select|confirm)/i,
  /↑\/↓ to navigate/,
];
const NUMBERED_CHOICE = [/^\s*[❯›>]?\s*1\.\s+\S/m, /^\s*[❯›>]?\s*2\.\s+\S/m];
// Codex 空输入行的占位提示；其它未收录的占位会被当成草稿（误拦，安全方向）。
const PLACEHOLDERS = /^(?:Ask Codex to do anything|Write tests for @|Improve documentation in @|Summarize recent commits|Explain this codebase|Find and fix a bug in @|Use \/skills|Implement \{feature\})/;

/** 屏幕末尾是否停在审批/选择框；是则返回原因。 */
export function approvalPrompt(tail: string): string | null {
  if (PROMPT_PATTERNS.some((p) => p.test(tail))) return '屏幕停在审批/选择框';
  if (NUMBERED_CHOICE.every((p) => p.test(tail))) return '屏幕出现编号选项框';
  return null;
}

/** 输入行里是否已有未提交的草稿（最后一个 ❯/› 行后面有文字）；是则返回原因。多行草稿只看首行。 */
export function pendingDraft(tail: string): string | null {
  const lines = tail.split('\n').slice(-INPUT_WINDOW);
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i]!.match(/^\s*[❯›]\s?(.*)$/);
    if (!m) continue;
    const text = m[1]!.trim();
    if (text && !PLACEHOLDERS.test(text)) return '输入行里有未提交的草稿';
    return null;
  }
  return null;
}

export { ntrHome };

export function entryLogPath(): string {
  return path.join(ntrHome(), 'entry-log.jsonl');
}

export function pbcopy(text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn('pbcopy', [], { stdio: ['pipe', 'ignore', 'ignore'] });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`pbcopy exit ${code}`))));
    p.stdin.end(text);
  });
}

interface LogEntry {
  ts: number;
  input: string;
  decision: Record<string, unknown>;
  outcome: OpenOutcome;
}

export interface HistoryItem {
  provider: ProviderId;
  sessionId: string;
  /** 最近一次发往这个会话的那句话 */
  lastInput: string;
  ts: number;
}

/**
 * 入口历史：最近送达过（写入 / 新开 / 只聚焦）的会话，按会话去重、新的在前。
 * 入口里按 ← 展开，选中即确定地发往该会话，不经过 Jev 判断。
 */
export function readHistory(logPath: string, limit = 20): HistoryItem[] {
  let raw: string;
  try {
    raw = fs.readFileSync(logPath, 'utf8');
  } catch {
    return [];
  }
  const out: HistoryItem[] = [];
  const seen = new Set<string>();
  const lines = raw.split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    let e: LogEntry;
    try {
      e = JSON.parse(lines[i]!) as LogEntry;
    } catch {
      continue;
    }
    const o = e.outcome;
    if (!o || !(o.action === 'wrote' || o.action === 'opened' || o.action === 'focused-only') || !o.sessionId) continue;
    const key = `${o.provider}:${o.sessionId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ provider: o.provider, sessionId: o.sessionId, lastInput: e.input, ts: e.ts });
  }
  return out;
}

/** 入口记录里最近一条有去处的句子，作为下一次路由的"上一句"语境。 */
export function readPrevious(logPath: string, nowMs: number): RouteContext['previous'] {
  let raw: string;
  try {
    raw = fs.readFileSync(logPath, 'utf8');
  } catch {
    return null;
  }
  const lines = raw.split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 20); i--) {
    let e: LogEntry;
    try {
      e = JSON.parse(lines[i]!) as LogEntry;
    } catch {
      continue;
    }
    const o = e.outcome;
    if ((o.action === 'wrote' || o.action === 'focused-only' || o.action === 'opened') && o.sessionId) {
      return {
        utterance: e.input,
        provider: o.provider,
        sessionId: o.sessionId,
        minutesAgo: Math.max(0, Math.round((nowMs - e.ts) / 60_000)),
      };
    }
  }
  return null;
}

function appendLog(logPath: string, entry: LogEntry): void {
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true, mode: 0o700 });
    fs.appendFileSync(logPath, JSON.stringify(entry) + '\n', { mode: 0o600 });
  } catch {
    /* 记录是语境增强，写不进不影响送达 */
  }
}

/** 由输入生成目录短名：保留字母数字和 CJK，最多 24 个字符。 */
export function shortName(text: string): string {
  const s = text.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 24).replace(/-+$/g, '');
  return s || 'task';
}

function newTaskDir(root: string, text: string): string {
  for (;;) {
    const suffix = String(Math.floor(Math.random() * 10_000)).padStart(4, '0');
    const dir = path.join(root, `${shortName(text)}-${suffix}`);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function open(text: string, opts: OpenOptions): Promise<OpenOutcome> {
  const now = opts.now ?? Date.now;
  const logPath = opts.logPath ?? entryLogPath();
  const copy = opts.clipboard ?? pbcopy;
  const byId = new Map(opts.providers.map((p) => [p.id, p]));
  let decisionLog: Record<string, unknown> = {};

  const finish = (outcome: OpenOutcome): OpenOutcome => {
    appendLog(logPath, { ts: now(), input: text, decision: decisionLog, outcome });
    return outcome;
  };
  /** 没送达：正文进剪贴板（A3）。剪贴板也失败时把事实写进原因，调用方仍持有正文。 */
  const keep = async (why: string): Promise<string> => {
    try {
      await copy(text);
      return `${why}；正文已放进剪贴板`;
    } catch (e) {
      return `${why}；且写剪贴板失败(${e instanceof Error ? e.message : String(e)})，请从输入框重新复制`;
    }
  };
  const failed = async (why: string): Promise<OpenOutcome> => finish({ action: 'failed', why: await keep(why) });

  try {
    const allLive = async (): Promise<LiveSession[]> => (await Promise.all(opts.providers.map((p) => p.liveSessions()))).flat();
    const cards: SessionCard[] = (await Promise.all(opts.providers.map((p) => p.listSessions()))).flat();

    // ---- 决策 ----
    let decision: RouteDecision;
    if (opts.pick) {
      decision = { kind: 'continue', provider: opts.pick.provider, sessionId: opts.pick.sessionId, confidence: 1, reason: '人已选定' };
      decisionLog = { source: 'pick', provider: opts.pick.provider, sessionId: opts.pick.sessionId };
    } else if (opts.forceNew) {
      decision = { kind: 'new', provider: opts.forceNew.provider, cwd: opts.forceNew.cwd ?? null, confidence: null, reason: '人要求新建' };
      decisionLog = { source: 'forceNew', provider: opts.forceNew.provider };
    } else {
      const live = await allLive();
      const focusedSessionId = opts.focusedTty ? (live.find((l) => l.tty === opts.focusedTty)?.sessionId ?? null) : null;
      const r = await opts.router.route(text, { cards, live, previous: readPrevious(logPath, now()), focusedSessionId });
      decision = r;
      const x = r as RouteDecision & { via?: string; project?: string | null; ranked?: unknown[] };
      decisionLog = { source: 'router', kind: r.kind, model: r.model, latencyMs: r.latencyMs, costUsd: r.costUsd, reason: r.reason, via: x.via ?? null, project: x.project ?? null };
      if (r.kind !== 'clarify') Object.assign(decisionLog, { provider: r.provider, sessionId: r.kind === 'continue' ? r.sessionId : null });
    }

    if (decision.kind === 'clarify') {
      // Router v2 附带按相关度排好的 ranked（可含"新建"）；第一项是新建时把它作为预选
      const first = (decision as { ranked?: Array<{ kind: string; provider?: ProviderId; cwd?: string | null }> }).ranked?.[0];
      const suggestNew = first?.kind === 'new' && first.provider ? { provider: first.provider, cwd: first.cwd ?? null } : null;
      return finish({ action: 'clarify', options: decision.options, reason: decision.reason, suggestNew });
    }

    // ---- new ----
    if (decision.kind === 'new') {
      const provider = byId.get(decision.provider);
      if (!provider) return await failed(`没有 ${decision.provider} 的 Provider`);
      // 不预先检查目录是否存在：项目常在 ~/Desktop、~/Documents 下，stat 会触发 macOS 文件夹授权弹框，被拒时还会误判为不存在。
      // 命令是 `cd <目录> && …`，目录不在时 claude 不会启动，iTerm 里能看到报错，正文也在那条命令里。
      const cwd = decision.cwd ?? newTaskDir(opts.tasksRoot ?? path.join(os.homedir(), 'ntr-tasks'), text);
      const view = await opts.surface.openView(cwd, provider.newArgv(text), { windowId: opts.windowId });
      const sessionId = await settle(provider, view, opts.settleMs ?? 2500);
      return finish({ action: 'opened', viewId: view.viewId, provider: provider.id, sessionId, cwd });
    }

    // ---- continue ----
    const provider = byId.get(decision.provider);
    if (!provider) return await failed(`没有 ${decision.provider} 的 Provider`);
    const sessionId = decision.sessionId;
    const target = { provider: provider.id, sessionId };

    // 写入前立即重新取：存活映射与视图列表都用此刻的，而不是路由时的
    const holders = (await allLive()).filter((l) => l.provider === provider.id && l.sessionId === sessionId);

    if (holders.length === 0) {
      const card = cards.find((c) => c.provider === provider.id && c.sessionId === sessionId);
      if (!card) return await failed(`找不到会话 ${provider.id}:${sessionId}`);
      const view = await opts.surface.openView(card.cwd, provider.resumeArgv(sessionId, text), { windowId: opts.windowId });
      return finish({ action: 'opened', viewId: view.viewId, ...target, cwd: card.cwd });
    }

    // 已存活：绝不二开。以下只可能 write / queue / focused-only / failed
    if (holders.length > 1) return await failed(`会话 ${sessionId} 同时被 ${holders.length} 个进程持有，无法确定写哪个`);
    const holder = holders[0]!;
    const views = holder.tty ? (await opts.surface.listViews()).filter((v) => v.tty === holder.tty) : [];
    const view = views.length === 1 ? views[0]! : null;

    // Codex 空闲：走原生 queue 通道，不依赖视图/按键，也不会碰到输入行里的草稿
    const queue = opts.queue?.[provider.id];
    if (queue && holder.state === 'idle') {
      await queue(sessionId, text);
      if (view) await opts.surface.focus(view.viewId).catch(() => {});
      return finish({ action: 'wrote', viewId: view?.viewId ?? '', ...target });
    }

    if (!view) {
      const why = !holder.tty
        ? '会话存活但没有终端（后台进程）'
        : views.length > 1
          ? `终端 ${holder.tty} 对应多个 iTerm 视图，无法确定写哪个`
          : `会话存活在 iTerm 之外（${holder.tty}，pid ${holder.pid}），不能写入也不能再开第二个进程`;
      return await failed(why);
    }

    const block = await whyNotWrite(holder, await allLive(), view, opts.surface);
    if (block) {
      const why = await keep(block);
      await opts.surface.focus(view.viewId);
      return finish({ action: 'focused-only', viewId: view.viewId, ...target, why });
    }
    await opts.surface.write(view.viewId, text);
    await opts.surface.focus(view.viewId).catch(() => {});
    return finish({ action: 'wrote', viewId: view.viewId, ...target });
  } catch (e) {
    return await failed(`open 出错: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** 写入前最后一轮核对（全部重新取）：视图仍在且 tty 不变、该 tty 上只有这一个存活会话、状态 idle、屏幕没有审批框也没有草稿。返回不能写的原因。 */
async function whyNotWrite(holder: LiveSession, liveNow: LiveSession[], view: SurfaceView, surface: OpenSurface): Promise<string | null> {
  const viewsNow = (await surface.listViews()).filter((v) => v.tty === holder.tty);
  if (viewsNow.length !== 1 || viewsNow[0]!.viewId !== view.viewId) return '终端对应的视图发生变化或不唯一';
  const here = liveNow.filter((l) => l.tty === holder.tty);
  if (here.length !== 1 || here[0]!.sessionId !== holder.sessionId || here[0]!.pid !== holder.pid) return '该终端上的会话映射发生变化或不唯一';
  if (here[0]!.state !== 'idle') return `会话状态是 ${here[0]!.state}，不是 idle`;
  const tail = await surface.screenTail(view.viewId, SCREEN_TAIL_LINES);
  return approvalPrompt(tail) ?? pendingDraft(tail);
}

/** 新开视图后等原生写出 pid/rollout，拿到真实 sessionId；超时返回 null（不编造）。 */
async function settle(provider: Provider, view: SurfaceView, ms: number): Promise<string | null> {
  if (!view.tty || ms <= 0) return null;
  const until = Date.now() + ms;
  for (;;) {
    const hit = (await provider.liveSessions()).find((l) => l.tty === view.tty);
    if (hit) return hit.sessionId;
    if (Date.now() >= until) return null;
    await sleep(400);
  }
}
