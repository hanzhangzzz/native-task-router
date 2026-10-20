// 薄入口分层的共享合同（技术合同 §0，用户决定 2026-10-13）。
//
// 四层：Entry（收一句话）→ Router（索引 + 决策 + 闸门）→ Provider（谁持有原生上下文）
//       → Surface（在哪展示和交互）。各层只通过这里的类型交互；实现分别在
//       providers/、surfaces/、router/、open.ts，入口窗口在 entry/。
//
// 事实源是原生文件与原生进程：本层不保存对话内容的副本，索引可随时从原生历史重建。

export type ProviderId = 'claude' | 'codex';

/** 一个可被路由选中的原生会话（索引条目）。内容全部来自原生历史，有界截断。 */
export interface SessionCard {
  provider: ProviderId;
  sessionId: string;
  /** 原生会话的工作目录（resume 必须在这里执行） */
  cwd: string;
  /** 原生标题/名称；没有就是 null，不编造 */
  title: string | null;
  /** 首条用户输入（≤800 字符） */
  firstPrompt: string | null;
  /** 最近几条用户输入，旧→新，每条 ≤800 字符 */
  recentPrompts: string[];
  /** 最后一条助手回复的有界片段（≤800 字符），是"Agent 声称的进展"，不是事实 */
  lastReply: string | null;
  /** ISO 时间 */
  startedAt: string;
  updatedAt: string;
  /** 用户输入条数 */
  turns: number;
}

export type LiveState = 'idle' | 'busy' | 'waiting' | 'unknown';

/** 正在某个进程里运行的原生会话。 */
export interface LiveSession {
  provider: ProviderId;
  sessionId: string;
  pid: number;
  /** 控制终端，例如 /dev/ttys001；无终端（后台/-p）为 null */
  tty: string | null;
  /** 原生给出的状态；读不到就是 unknown，不猜 */
  state: LiveState;
}

export interface Provider {
  id: ProviderId;
  /** 只列交互式会话（排除 claude -p / SDK / codex exec 和临时目录里的探针会话） */
  listSessions(): Promise<SessionCard[]>;
  /** 当前存活的会话进程及其终端 */
  liveSessions(): Promise<LiveSession[]>;
  /** 在会话 cwd 里执行的原生续接命令；prompt 作为参数交给原生，不靠模拟按键 */
  resumeArgv(sessionId: string, prompt: string): string[];
  /** 新建会话的原生命令 */
  newArgv(prompt: string): string[];
  /** 在会话 cwd 里从该会话分叉出新会话并提交 prompt：新会话带上原会话的上下文，原会话文件不被改动 */
  forkArgv(sessionId: string, prompt: string): string[];
}

export type SurfaceId = 'iterm' | 'terminal';

/** Surface 上的一个可见视图（iTerm 的一个 session，或 Terminal 的一个 tab）。 */
export interface SurfaceView {
  surface: SurfaceId;
  viewId: string;
  tty: string | null;
  title: string;
}

export interface Surface {
  id: SurfaceId;
  listViews(): Promise<SurfaceView[]>;
  /** 切到该视图并把应用带到前台（用户刚按下入口，切过去是预期行为） */
  focus(viewId: string): Promise<void>;
  /** 新开视图，在 cwd 里执行 argv（由 Surface 负责 shell 转义） */
  openView(cwd: string, argv: string[]): Promise<SurfaceView>;
  /** 把一段文本作为一次输入提交：bracketed paste 包裹正文，再发一个回车 */
  write(viewId: string, text: string): Promise<void>;
  /** 读屏幕末尾若干行，用于写入前核对是否停在审批/选择框 */
  screenTail(viewId: string, lines: number): Promise<string>;
}

/** 路由语境：除输入本身外，决策可以使用的信号。 */
export interface RouteContext {
  cards: SessionCard[];
  live: LiveSession[];
  /** 入口里紧挨着的上一句及其去处（承接追问用） */
  previous?: { utterance: string; provider: ProviderId; sessionId: string; minutesAgo: number } | null;
  /** 唤起入口前位于前台的会话（若可知） */
  focusedSessionId?: string | null;
  /** "现在"的时刻（毫秒）。生产不传（取 Date.now）；离线评测传样本时刻，使"多久前活跃"和时间规则按当时计算 */
  nowMs?: number;
}

export interface RouteOption {
  provider: ProviderId;
  sessionId: string;
  probability: number | null;
}

/**
 * 自动送达的方式。direct：写进/续接原会话；fork：从原会话分叉出新会话再送达，原会话不被改动，
 * 正文前加路由说明让 Agent 自查（中间置信档，送错也不污染原会话的原生历史）。缺省视为 direct。
 */
export type Delivery = 'direct' | 'fork';

export type RouteDecision =
  | { kind: 'continue'; provider: ProviderId; sessionId: string; confidence: number; reason: string; delivery?: Delivery }
  | { kind: 'new'; provider: ProviderId; cwd: string | null; confidence: number | null; reason: string; delivery?: Delivery }
  | { kind: 'clarify'; options: RouteOption[]; reason: string };

export interface Router {
  route(text: string, ctx: RouteContext): Promise<RouteDecision & { latencyMs: number; costUsd: number | null; model: string | null }>;
}

/** open() 实际做了什么；每一种结果都能从原生侧复核。 */
export type OpenOutcome =
  | { action: 'wrote'; viewId: string; provider: ProviderId; sessionId: string }
  | { action: 'focused-only'; viewId: string; provider: ProviderId; sessionId: string; why: string }
  | {
      action: 'opened';
      viewId: string;
      provider: ProviderId;
      /** 新开视图里的会话 id；分叉时是分叉出的新 id（取不到为 null，不编造） */
      sessionId: string | null;
      cwd: string;
      /** 分叉送达时的原会话 id（原会话未被改动） */
      forkedFrom?: string;
      /** 分叉档送达（含新建）时的项目置信度，入口据此显示 */
      confidence?: number;
    }
  | {
      action: 'clarify';
      options: RouteOption[];
      /** 为什么没有自动送达（给人看） */
      reason?: string;
      /** Router 认为最可能是"新建"时的建议去处；入口据此把"新建"作为预选项（回车即新建） */
      suggestNew?: { provider: ProviderId; cwd: string | null } | null;
    }
  | { action: 'failed'; why: string };
