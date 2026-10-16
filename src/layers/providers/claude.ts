// Claude Code Provider。事实源：~/.claude/projects/<编码cwd>/<sessionId>.jsonl 与 ~/.claude/sessions/<pid>.json。
//
// 续接语义（2026-10-13 在后台 PTY 里用真实 claude 2.1.288 实测）：
//   `claude -r <id> "<text>"` 把正文追加到同一个 <id>.jsonl，sessionId 不变、不产生新文件
//   （没有 --fork-session 时）。所以"送达到同一会话"的判定 = 该 jsonl 新增一条与正文一致的人工输入。
// 存活映射：~/.claude/sessions/<pid>.json 的 sessionId 随 /clear 更新（实测 /clear 后换成新 id，
//   且新 id 的 transcript 随首条输入出现），所以以 pid 文件为准，不要从 transcript 反推。
//   procStart 是 UTC 墙钟（与本机时区无关），核对时用 TZ=UTC 的 ps lstart。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { LiveSession, LiveState, Provider, SessionCard } from '../types.ts';
import {
  CardBuilder,
  asOfMs,
  humanText,
  isTempCwd,
  listJsonl,
  parseJson,
  psRows,
  readRelevantLines,
  scanFiles,
  type Parsed,
  type ScanResult,
} from './common.ts';

export function claudeHome(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

/** 行首（512 字节）能判定为无关的行不解码：工具结果、仅含 tool_use/thinking 的 assistant、侧链。 */
export function claudeLineWanted(head: string): boolean {
  if (head.includes('"isSidechain":true')) return false;
  if (/"type":"(?:ai-title|custom-title)"/.test(head)) return true;
  if (head.includes('"type":"user"')) return !head.includes('"type":"tool_result"');
  // assistant 行的 message 在前、外层 type 在后（常超出行首窗口），所以认 message.role
  if (head.includes('"role":"assistant"')) return !/"content":\[\{"type":"(?:tool_use|thinking)"/.test(head);
  return false;
}

function textBlocks(content: unknown): string[] | null {
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return null;
  if (content.some((b) => b?.type === 'tool_result')) return null;
  return content.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text as string);
}

export interface CardOptions {
  /** ISO 时间。只使用该时刻之前（含）的内容，用于评测防泄漏。 */
  asOf?: string;
  /** 以文件名为准的 sessionId；缺省取行内第一个 sessionId。 */
  sessionId?: string;
}

/**
 * 从 Claude transcript 的行构建卡片（生产与评测共用的唯一入口）。
 * 非交互（sdk/-p）、临时目录 cwd、没有任何人话的会话返回 null；需要原因用 parseClaudeLines。
 * 标题行（ai-title/custom-title）没有时间戳，按文件顺序判定：出现在 asOf 之后的第一条带时间戳行之前才算。
 */
export function cardFromClaudeLines(lines: string[], opts: CardOptions = {}): SessionCard | null {
  const r = parseClaudeLines(lines, opts);
  return 'card' in r ? r.card : null;
}

export function parseClaudeLines(lines: string[], opts: CardOptions = {}): Parsed {
  const limit = asOfMs(opts.asOf);
  const b = new CardBuilder();
  let sessionId = opts.sessionId ?? '';
  let cwd = '';
  let sdkEntry = false;
  let background = false;
  let seenEntry = false;
  let cut = false;
  let customTitle: string | null = null;
  let aiTitle: string | null = null;
  for (const line of lines) {
    const o = parseJson(line);
    if (!o || typeof o !== 'object') continue;
    if (o.type === 'custom-title' || o.type === 'ai-title') {
      if (cut || (sessionId && o.sessionId && o.sessionId !== sessionId)) continue;
      if (o.type === 'custom-title' && typeof o.customTitle === 'string') customTitle = o.customTitle;
      if (o.type === 'ai-title' && typeof o.aiTitle === 'string') aiTitle = o.aiTitle;
      continue;
    }
    if (o.type !== 'user' && o.type !== 'assistant') continue;
    if (o.isSidechain) continue;
    if (typeof o.sessionId === 'string') {
      if (!sessionId) sessionId = o.sessionId;
      else if (o.sessionId !== sessionId) continue;
    }
    if (typeof o.timestamp === 'string' && Date.parse(o.timestamp) > limit) {
      cut = true;
      continue;
    }
    if (!seenEntry) {
      seenEntry = true;
      if (typeof o.entrypoint === 'string' && o.entrypoint.startsWith('sdk')) sdkEntry = true;
    }
    // 旧 Jev 桌面 app 用 `claude --bg` 建的真实任务是 sdk-cli + sessionKind=bg；脚本里的 `claude -p` 没有该字段
    if (o.sessionKind === 'bg') background = true;
    if (!cwd && typeof o.cwd === 'string') cwd = o.cwd;
    b.touch(o.timestamp);
    const blocks = textBlocks(o.message?.content);
    if (!blocks) continue; // 工具结果：回合内部，不是人的输入
    if (o.type === 'user') {
      if (o.isMeta || o.isCompactSummary) continue;
      const text = blocks.map(humanText).filter(Boolean).join('\n');
      if (text) b.user(text);
    } else {
      const text = blocks.join('\n').trim();
      if (text) b.reply(text);
    }
  }
  if (sdkEntry && !background) return { excluded: 'non-interactive (sdk / claude -p)' };
  if (!sessionId || !cwd) return { excluded: 'no-session-or-cwd' };
  if (isTempCwd(cwd)) return { excluded: 'temp-cwd probe' };
  b.title = customTitle ?? aiTitle;
  const card = b.build('claude', sessionId, cwd);
  return card ? { card } : { excluded: 'no-human-input' };
}

async function parseFile(file: string): Promise<Parsed> {
  const id = path.basename(file, '.jsonl');
  return parseClaudeLines(await readRelevantLines(file, claudeLineWanted), { sessionId: id });
}

/** 只扫 projects/<dir>/<id>.jsonl 一层：更深的 subagents/ 是侧链，不是可续接的会话。 */
async function sessionFiles(): Promise<string[]> {
  const root = path.join(claudeHome(), 'projects');
  let dirs: fs.Dirent[];
  try {
    dirs = await fs.promises.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const nested = await Promise.all(dirs.filter((d) => d.isDirectory()).map((d) => listJsonl(path.join(root, d.name), false)));
  return nested.flat();
}

export async function scanClaude(): Promise<ScanResult> {
  return scanFiles('claude', await sessionFiles(), parseFile);
}

interface PidFile {
  pid: number;
  sessionId: string;
  procStart?: string;
  status?: string;
}

function mapState(status: string | undefined): LiveState {
  return status === 'busy' || status === 'idle' || status === 'waiting' ? status : 'unknown';
}

async function liveSessions(): Promise<LiveSession[]> {
  const dir = path.join(claudeHome(), 'sessions');
  let names: string[];
  try {
    names = await fs.promises.readdir(dir);
  } catch {
    return [];
  }
  const files: PidFile[] = [];
  for (const name of names) {
    if (!/^\d+\.json$/.test(name)) continue;
    const o = parseJson(await fs.promises.readFile(path.join(dir, name), 'utf8').catch(() => ''));
    if (o && Number.isInteger(o.pid) && typeof o.sessionId === 'string') files.push(o);
  }
  const rows = await psRows(files.map((f) => f.pid));
  const out: LiveSession[] = [];
  for (const f of files) {
    const row = rows.get(f.pid);
    // pid 活着还不够：启动时间必须与 pid 文件一致，否则是被复用的 pid
    if (!row || !f.procStart || row.start !== f.procStart.replace(/\s+/g, ' ')) continue;
    out.push({ provider: 'claude', sessionId: f.sessionId, pid: f.pid, tty: row.tty, state: mapState(f.status) });
  }
  return out;
}

export const claude: Provider = {
  id: 'claude',
  listSessions: async () => (await scanClaude()).cards,
  liveSessions,
  resumeArgv: (sessionId, prompt) => ['claude', '-r', sessionId, prompt],
  newArgv: (prompt) => ['claude', prompt],
};
