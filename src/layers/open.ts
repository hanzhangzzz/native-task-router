// open(text)：把一句话送到正确的原生会话（技术合同 §0.2）。只依赖 types.ts 里的四层合同，
// Router / Provider / Surface 全部注入，所以能用假实现逐条验证分支。
//
// 不变量（合同测试逐条断言）：
//   A1 不在这里保证（Router 的阈值负责）；A2 写入前立即重新核对 tty→pid→sessionId、屏幕，
//      任一不满足绝不 write；已存活的会话绝不再起第二个 resume 进程。
//      会话正在跑（busy/unknown）照样写：Claude Code 和 Codex 自己会把输入排到当前这一轮之后（2026-10-25 用户确认）；
//      屏幕停在审批/选择框时（回车会确认默认选项）：没带 answer 返回 awaiting-approval 把选项带回入口，
//      带 answer 替人选完、等框消失后再写；输入行有草稿时不写。
//   A4 送达后不切到终端：人从统一入口派活，留在原地；只有没写进去（focused-only）才把那个视图带到前台。
//   A3 任何没送达的路径（focused-only / failed）都把正文放进剪贴板；clarify 把候选原样返回，正文仍在调用方手里。
//   F  delivery === 'fork' 的续接：绝不写进开着的视图、绝不在原 id 上 resume；一律新开视图执行 forkArgv，
//      原会话正在某个进程里跑也照样分叉（分叉是新 id，不违反"同一会话不二开"）。分叉档续接的正文前加路由说明；
//      路由自动新建（带置信度的 new，不论档位）加"自动新建在项目 X"的说明（routing-note.ts）；人工 pick / forceNew 与 direct 档续接不加。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ntrHome } from './providers/common.ts';
import { routingNote, routingNoteNew } from './routing-note.ts';
import type {
  KeyPress,
  LiveSession,
  OpenOutcome,
  Provider,
  ProviderId,
  PromptInfo,
  RouteContext,
  RouteDecision,
  Router,
  SessionCard,
  Surface,
  SurfaceView,
} from './types.ts';

export type OpenSurface = Omit<Surface, 'openView' | 'id'> & {
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
  /** 新 tab 开进指定 iTerm 窗口（测试隔离；给了就固定用 iTerm） */
  windowId?: number;
  /** 唤起入口前前台终端（iTerm 或 Terminal）会话的 tty */
  focusedTty?: string | null;
  /** 目标停在选项框时替人选第几项（1 起），选完等框消失再送达正文；缺省把选项框原样交给入口 */
  answer?: number;
  /** 选完后等屏幕离开选项框的最长毫秒数（默认 6 秒） */
  answerWaitMs?: number;
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
  /Working directory\s*(?:·|$)/im,
  /Use session directory \(/,
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

const OPTION_LINE = /^\s*[❯›>]?\s*(\d)\.\s+(\S.*)$/;
const QUESTIONISH = /(do you want|would you like|proceed\s*\?|to (?:select|confirm|continue)|choose|确认|选择|批准|继续)/i;

/**
 * 选项框解析（approvalPrompt 为真的屏幕）：末尾连续编号 1..n 的选项行 + 它们上方的问题与上文。
 * 编号不是从 1 连续排下来的（认不准选项对应关系）时 options 为空，入口只给"确认当前高亮项"。
 */
export function parsePrompt(tail: string): PromptInfo {
  const lines = tail.split('\n');
  let end = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (OPTION_LINE.test(lines[i]!)) {
      end = i;
      break;
    }
  }
  if (end < 0) return { question: lines.find((l) => /Working directory/.test(l))?.trim() ?? null, context: tail.trim().slice(-1200), options: [] };
  const options: Array<{ label: string }> = [];
  let expect = Number(lines[end]!.match(OPTION_LINE)![1]);
  let i = end;
  for (; i >= 0; i--) {
    const m = lines[i]!.match(OPTION_LINE);
    if (!m || Number(m[1]) !== expect) break;
    options.unshift({ label: m[2]!.trim().slice(0, 120) });
    expect -= 1;
  }
  if (options.length === 0 || expect !== 0) return { question: null, context: null, options: [] };
  // 选项上方：最近的"问题样"行是问题；问题与选项之间（或问题上方最近）的非空行是上文
  const above: number[] = [];
  for (let j = i; j >= 0 && above.length < 4; j--) {
    if (lines[j]!.trim() !== '') above.push(j);
  }
  const text = (j: number) => lines[j]!.trim().slice(0, 200);
  let question: string | null = null;
  let context: string | null = null;
  const qi = above.find((j) => QUESTIONISH.test(lines[j]!));
  if (qi !== undefined) {
    question = text(qi);
    const between = above.find((j) => j > qi); // 问题与选项之间：被审批的命令多在这
    const nextUp = above.find((j) => j < qi);
    context = between !== undefined ? text(between) : nextUp !== undefined ? text(nextUp) : null;
  } else if (above.length) {
    question = text(above[0]!);
    context = above[1] !== undefined ? text(above[1]!) : null;
  }
  return { question, context, options };
}

/** 替人选第 option 项要按的键：光标在 1 上，↓ 到第 n 项再回车。 */
export function answerKeys(option: number): KeyPress[] {
  return [...Array(Math.max(0, option - 1)).fill('down'), 'enter'] as KeyPress[];
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
      const x = r as RouteDecision & { via?: string; project?: string | null; ranked?: unknown[]; modelConfidence?: number | null; threadConfidence?: number | null };
      // modelConfidence / threadConfidence 在 clarify 时也记：真实入口分布是调闸门的唯一依据（2026-10-26 起补记）
      decisionLog = { source: 'router', kind: r.kind, model: r.model, latencyMs: r.latencyMs, costUsd: r.costUsd, reason: r.reason, via: x.via ?? null, project: x.project ?? null, modelConfidence: x.modelConfidence ?? null, threadConfidence: x.threadConfidence ?? null };
      if (r.kind !== 'clarify') Object.assign(decisionLog, { provider: r.provider, sessionId: r.kind === 'continue' ? r.sessionId : null, confidence: r.confidence, delivery: r.delivery ?? 'direct' });
    }

    if (decision.kind === 'clarify') {
      // Router v2 附带按相关度排好的 ranked（可含"新建"）；第一项是新建时把它作为预选
      const rankedIn = (decision as { ranked?: Array<{ kind: string; provider?: ProviderId; sessionId?: string; cwd?: string | null }> }).ranked;
      const first = rankedIn?.[0];
      const suggestNew = first?.kind === 'new' && first.provider ? { provider: first.provider, cwd: first.cwd ?? null } : null;
      // 全部候选按 Router 的顺序透传：排第二及以后的"项目内新建"也带着目录，不退化成新目录
      type Ranked = NonNullable<Extract<OpenOutcome, { action: 'clarify' }>['ranked']>;
      const ranked: Ranked = [];
      for (const o of rankedIn ?? []) {
        if (o.kind === 'new' && o.provider) ranked.push({ kind: 'new', provider: o.provider, cwd: o.cwd ?? null });
        else if (o.kind === 'session' && o.provider && o.sessionId) ranked.push({ kind: 'session', provider: o.provider, sessionId: o.sessionId });
      }
      return finish({ action: 'clarify', options: decision.options, reason: decision.reason, suggestNew, ...(ranked.length ? { ranked } : {}) });
    }

    // ---- new ----
    if (decision.kind === 'new') {
      const provider = byId.get(decision.provider);
      if (!provider) return await failed(`没有 ${decision.provider} 的 Provider`);
      // 不预先检查目录是否存在：项目常在 ~/Desktop、~/Documents 下，stat 会触发 macOS 文件夹授权弹框，被拒时还会误判为不存在。
      // 命令是 `cd <目录> && …`，目录不在时 claude 不会启动，iTerm 里能看到报错，正文也在那条命令里。
      const cwd = decision.cwd ?? newTaskDir(opts.tasksRoot ?? path.join(os.homedir(), 'ntr-tasks'), text);
      // 路由自动新建（有置信度）一律带说明，让新会话自查是否开错了目录；人工 --new（置信度 null）不加
      const body = decision.confidence !== null ? routingNoteNew(text, decision.confidence, path.basename(cwd)) : text;
      const view = await opts.surface.openView(cwd, provider.newArgv(body), { windowId: opts.windowId });
      const sessionId = await settle(provider, view, opts.settleMs ?? 2500);
      const nativePrompt = await startupPrompt(opts.surface, view);
      return finish({ action: 'opened', viewId: view.viewId, provider: provider.id, sessionId, cwd, ...(nativePrompt ? { nativePrompt } : {}) });
    }

    // ---- continue ----
    const provider = byId.get(decision.provider);
    if (!provider) return await failed(`没有 ${decision.provider} 的 Provider`);
    const sessionId = decision.sessionId;
    const target = { provider: provider.id, sessionId };

    // 分叉档：不看原会话是否存活、开在哪，一律新开视图分叉（F）。原会话的 cwd 从索引取
    if (decision.delivery === 'fork') {
      const card = cards.find((c) => c.provider === provider.id && c.sessionId === sessionId);
      if (!card) return await failed(`找不到会话 ${provider.id}:${sessionId}`);
      const view = await opts.surface.openView(card.cwd, provider.forkArgv(sessionId, routingNote(text, decision.confidence)), { windowId: opts.windowId });
      const forkId = await settle(provider, view, opts.settleMs ?? 2500, sessionId);
      const nativePrompt = await startupPrompt(opts.surface, view);
      return finish({ action: 'opened', viewId: view.viewId, provider: provider.id, sessionId: forkId, cwd: card.cwd, forkedFrom: sessionId, confidence: decision.confidence, ...(nativePrompt ? { nativePrompt } : {}) });
    }

    // 写入前立即重新取：存活映射与视图列表都用此刻的，而不是路由时的
    const holders = (await allLive()).filter((l) => l.provider === provider.id && l.sessionId === sessionId);

    if (holders.length === 0) {
      const card = cards.find((c) => c.provider === provider.id && c.sessionId === sessionId);
      if (!card) return await failed(`找不到会话 ${provider.id}:${sessionId}`);
      const view = await opts.surface.openView(card.cwd, provider.resumeArgv(sessionId, text), { windowId: opts.windowId });
      await settle(provider, view, opts.settleMs ?? 2500);
      const nativePrompt = await startupPrompt(opts.surface, view);
      return finish({ action: 'opened', viewId: view.viewId, ...target, cwd: card.cwd, ...(nativePrompt ? { nativePrompt } : {}) });
    }

    // 已存活：绝不二开。以下只可能 write / queue / awaiting-approval / answered / focused-only / failed
    if (holders.length > 1) return await failed(`会话 ${sessionId} 同时被 ${holders.length} 个进程持有，无法确定写哪个`);
    const holder = holders[0]!;
    const views = holder.tty ? (await opts.surface.listViews()).filter((v) => v.tty === holder.tty) : [];
    const view = views.length === 1 ? views[0]! : null;
    /** 屏幕此刻停在选项框时的解析结果；否则 null。 */
    const screenPrompt = async (): Promise<PromptInfo | null> => {
      if (!view) return null;
      const tail = await opts.surface.screenTail(view.viewId, SCREEN_TAIL_LINES);
      return approvalPrompt(tail) ? parsePrompt(tail) : null;
    };

    // Codex 空闲：走原生 queue 通道，不依赖视图/按键，也不会碰到输入行里的草稿
    // （忙时不用它：排进去的消息会随取消这一轮丢失；忙时按键写入，由 Codex 界面自己排队）。
    // 屏幕停在选项框时也绝不 queue：Codex 停在审批框时状态正是 idle（上一轮已 task_complete），
    // 队列里的消息会随"取消"整个丢掉，所以先看屏幕，是选项框就交给下面的审批分支。
    const queue = opts.queue?.[provider.id];
    let promptInfo: PromptInfo | null = null;
    if (queue && holder.state === 'idle') {
      promptInfo = await screenPrompt();
      if (!promptInfo) {
        await queue(sessionId, text);
        return finish({ action: 'wrote', viewId: view?.viewId ?? '', ...target });
      }
    }

    if (!view) {
      const why = !holder.tty
        ? '会话存活但没有终端（后台进程）'
        : views.length > 1
          ? `终端 ${holder.tty} 对应多个终端视图，无法确定写哪个`
          : `会话存活在 iTerm / Terminal 之外（${holder.tty}，pid ${holder.pid}），不能写入也不能再开第二个进程`;
      return await failed(why);
    }

    // 审批分支（2026-10-25 用户确认的第二期）：屏幕停在选项框时，没带 answer 就把选项带回入口选；
    // 带了就替人按 ↓×(n-1)+↵，等屏幕离开选项框（连着的下一个选项框原样带回入口）再走普通送达闸门。
    promptInfo ??= await screenPrompt();
    let pressed = false;
    if (promptInfo) {
      if (opts.answer == null) {
        const why = await keep('屏幕停在审批/选择框');
        return finish({ action: 'awaiting-approval', viewId: view.viewId, ...target, prompt: promptInfo, why });
      }
      await opts.surface.press(view.viewId, answerKeys(opts.answer));
      pressed = true;
      const deadline = Date.now() + (opts.answerWaitMs ?? 6000);
      for (;;) {
        await sleep(320);
        const now = await opts.surface.screenTail(view.viewId, SCREEN_TAIL_LINES);
        if (!approvalPrompt(now)) break;
        if (Date.now() >= deadline) {
          if (JSON.stringify(parsePrompt(now)) !== JSON.stringify(promptInfo)) {
            const why = await keep('选项后面又出现一个选项框');
            return finish({ action: 'awaiting-approval', viewId: view.viewId, ...target, prompt: parsePrompt(now), why });
          }
          return await failed(`选了选项 ${opts.answer}，屏幕仍停在选项框（按键没有生效？）`);
        }
      }
    }
    if (!text) return finish({ action: 'answered', viewId: view.viewId, ...target, option: pressed ? opts.answer! : null });

    // 普通送达闸门：全部重新取（视图/映射 + 屏幕），选项已答完或本来就没有
    const block = await whyNotWrite(holder, await allLive(), view, opts.surface);
    if (block) {
      const why = await keep(block);
      await opts.surface.focus(view.viewId);
      return finish({ action: 'focused-only', viewId: view.viewId, ...target, why });
    }
    await opts.surface.write(view.viewId, text);
    return finish({ action: 'wrote', viewId: view.viewId, ...target, ...(pressed ? { answeredOption: opts.answer } : {}) });
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
  const tail = await surface.screenTail(view.viewId, SCREEN_TAIL_LINES);
  return approvalPrompt(tail) ?? pendingDraft(tail);
}

/**
 * 新开视图后等原生写出 pid/rollout，拿到真实 sessionId；超时返回 null（不编造）。
 * 分叉时传 notId=原会话 id：该 tty 上若暂时报的是原 id（进程还没换成分叉的新 id），不当成结果，
 * 否则下一句的"上一句"语境会指回原会话，短句就会直接写进原会话。
 */
async function settle(provider: Provider, view: SurfaceView, ms: number, notId?: string): Promise<string | null> {
  if (!view.tty || ms <= 0) return null;
  const until = Date.now() + ms;
  for (;;) {
    const hit = (await provider.liveSessions()).find((l) => l.tty === view.tty && l.sessionId !== notId);
    if (hit) return hit.sessionId;
    if (Date.now() >= until) return null;
    await sleep(400);
  }
}

/** 只观察原生选择框，不代替用户决定启动目录/信任。 */
async function startupPrompt(surface: OpenSurface, view: SurfaceView): Promise<PromptInfo | null> {
  try {
    const tail = await surface.screenTail(view.viewId, SCREEN_TAIL_LINES);
    return approvalPrompt(tail) ? parsePrompt(tail) : null;
  } catch { return null; }
}

/** 仅补查入口曾打开且仍存在的视图；启动尚无 sessionId 时也可反馈等待。 */
export async function startupWaits(surface: OpenSurface, logPath: string, views: SurfaceView[]) {
  let lines: string[];
  try { lines = fs.readFileSync(logPath, 'utf8').trim().split('\n').slice(-100); } catch { return []; }
  const opened = new Map<string, Extract<OpenOutcome, { action: 'opened' }>>();
  for (const line of lines) {
    try { const o = JSON.parse(line).outcome; if (o?.action === 'opened') opened.set(o.viewId, o); } catch { /* ignore malformed log rows */ }
  }
  return (await Promise.all(views.map(async (view) => {
    const o = opened.get(view.viewId);
    if (!o) return [];
    const prompt = await startupPrompt(surface, view);
    return prompt ? [{ provider: o.provider, sessionId: null, viewId: view.viewId, viewTitle: view.title, state: 'waiting', nativeWaiting: true, prompt, card: null }] : [];
  }))).flat();
}
