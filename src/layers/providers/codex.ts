// Codex Provider。事实源：~/.codex/sessions/YYYY/MM/DD/rollout-*-<threadId>.jsonl 与 ~/.codex/session_index.jsonl。
//
// 存活映射（2026-10-13 在后台 PTY 里用真实 codex 0.162.1 实测）：
//   1. 独立运行的 TUI：原生二进制（node 包装器 `node …/bin/codex` 的子进程）持有当前线程的
//      rollout 文件（fd 常开，空闲时也持有；`codex resume <id>` 未输入任何内容时也已持有），
//      文件名末尾的 UUID 就是 thread id。→ lsof 取 rollout 路径。
//   2. `--remote` 模式（TUI 连共享 app-server，如旧 desktop 宿主）：TUI 自己不持有 rollout，
//      文件在 app-server 手里；此时只能读 TUI 命令行里的 `resume <id>`。
//   3. 两者都没有（remote 模式下的全新会话）无法确定映射，不返回——宁缺毋滥。
//   多代理时同一进程会持有子线程的 rollout，用 session_meta 的 source.subagent 排除。
// 续接语义（实测）：`codex resume <id> "<text>"` 把正文追加到原 rollout 文件，不产生新文件、不换 thread id。
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
  normalizeTty,
  parseJson,
  readRelevantLines,
  run,
  scanFiles,
  type Parsed,
  type ScanResult,
} from './common.ts';

export function codexHome(): string {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

/** 只要 session_meta 与 user/assistant 消息；开场注入的 AGENTS.md / environment_context 在行首就能认出来，不解码。 */
export function codexLineWanted(head: string): boolean {
  if (head.includes('"type":"session_meta"')) return true;
  if (!head.includes('"type":"response_item"') || !head.includes('"payload":{"type":"message"')) return false;
  if (!/"role":"(?:user|assistant)"/.test(head)) return false;
  return !/"text":"(?:# AGENTS\.md instructions|<environment_context>)/.test(head);
}

export interface CodexCardOptions {
  /** ISO 时间。只使用该时刻之前（含）的内容，用于评测防泄漏。 */
  asOf?: string;
  /** 线程标题（来自 session_index.jsonl，rollout 里没有）；评测按需自行决定是否传入。 */
  title?: string | null;
}

/**
 * 从 Codex rollout 的行构建卡片（生产与评测共用的唯一入口）。
 * codex exec、子代理、临时目录 cwd、没有任何人话的会话返回 null；需要原因用 parseCodexLines。
 */
export function cardFromCodexLines(lines: string[], opts: CodexCardOptions = {}): SessionCard | null {
  const r = parseCodexLines(lines, opts);
  return 'card' in r ? r.card : null;
}

export function parseCodexLines(lines: string[], opts: CodexCardOptions = {}): Parsed {
  const limit = asOfMs(opts.asOf);
  const b = new CardBuilder();
  let id = '';
  let cwd = '';
  let startedAt = '';
  let excluded: string | null = null;
  let finalReply: string | null = null;
  let anyReply: string | null = null;
  for (const line of lines) {
    const o = parseJson(line);
    if (!o || typeof o !== 'object') continue;
    const p = o.payload;
    if (o.type === 'session_meta' && p) {
      id = String(p.id ?? p.session_id ?? '');
      cwd = typeof p.cwd === 'string' ? p.cwd : '';
      startedAt = typeof p.timestamp === 'string' ? p.timestamp : (o.timestamp ?? '');
      if (p.source && typeof p.source === 'object' && p.source.subagent) excluded = 'subagent';
      else if (p.source === 'exec' || p.originator === 'codex_exec') excluded = 'non-interactive (codex exec)';
      continue;
    }
    if (o.type !== 'response_item' || p?.type !== 'message') continue;
    if (typeof o.timestamp === 'string' && Date.parse(o.timestamp) > limit) continue;
    const blocks: any[] = Array.isArray(p.content) ? p.content : [];
    b.touch(o.timestamp);
    if (p.role === 'user') {
      const text = blocks
        .filter((c) => c?.type === 'input_text' && typeof c.text === 'string')
        .map((c) => humanText(c.text))
        .filter(Boolean)
        .join('\n');
      if (text) b.user(text);
    } else if (p.role === 'assistant') {
      const text = blocks
        .filter((c) => c?.type === 'output_text' && typeof c.text === 'string')
        .map((c) => c.text)
        .join('\n')
        .trim();
      if (!text) continue;
      anyReply = text;
      if (p.phase === 'final_answer') finalReply = text;
    }
  }
  if (excluded) return { excluded };
  if (!id || !cwd) return { excluded: 'no-session-or-cwd' };
  if (isTempCwd(cwd)) return { excluded: 'temp-cwd probe' };
  if (Date.parse(startedAt) > limit) return { excluded: 'no-human-input' };
  b.title = opts.title ?? null;
  const reply = finalReply ?? anyReply;
  if (reply) b.reply(reply);
  const card = b.build('codex', id, cwd, startedAt || undefined);
  return card ? { card } : { excluded: 'no-human-input' };
}

async function parseFile(file: string): Promise<Parsed> {
  return parseCodexLines(await readRelevantLines(file, codexLineWanted));
}

async function threadTitles(): Promise<Map<string, string>> {
  const titles = new Map<string, string>();
  let raw = '';
  try {
    raw = await fs.promises.readFile(path.join(codexHome(), 'session_index.jsonl'), 'utf8');
  } catch {
    return titles;
  }
  for (const line of raw.split('\n')) {
    const o = parseJson(line);
    if (o && typeof o.id === 'string' && typeof o.thread_name === 'string') titles.set(o.id, o.thread_name);
  }
  return titles;
}

/**
 * 默认只索引 sessions/。archived_sessions/ 里的会话被用户归档过：`codex resume <id>` 会先弹
 * "This conversation is archived — Unarchive and resume / Cancel"（2026-10-13 实测），不能直接续上，
 * 所以只计数、不入库。includeArchived 仅用于评估索引覆盖与耗时。
 */
export async function scanCodex(opts: { includeArchived?: boolean } = {}): Promise<ScanResult> {
  const files = await listJsonl(path.join(codexHome(), 'sessions'), true);
  const archived = await listJsonl(path.join(codexHome(), 'archived_sessions'), false);
  if (opts.includeArchived) files.push(...archived);
  const result = await scanFiles(opts.includeArchived ? 'codex-with-archived' : 'codex', files, parseFile);
  if (!opts.includeArchived && archived.length > 0) result.excluded['archived (resume needs unarchive)'] = archived.length;
  // 标题在 rollout 之外且会独立变化，不进文件指纹缓存，出口处补上
  const titles = await threadTitles();
  result.cards = result.cards.map((c) => ({ ...c, title: titles.get(c.sessionId) ?? c.title }));
  return result;
}

const NON_TUI = new Set(['exec', 'e', 'review', 'login', 'logout', 'mcp', 'plugin', 'app-server', 'exec-server', 'app', 'completion', 'update', 'doctor', 'sandbox', 'debug', 'apply', 'a', 'queue', 'archive', 'delete', 'unarchive', 'cloud', 'features', 'help', 'agents', 'migrate-rollouts', 'remote-control']);
const VALUE_FLAGS = new Set(['-c', '--config', '-m', '--model', '-p', '--profile', '-C', '--cd', '-s', '--sandbox', '-a', '--ask-for-approval', '--remote', '--remote-auth-token-env', '-i', '--image', '--enable', '--disable', '--add-dir', '--local-provider']);

/** 命令行是否是 codex 交互 TUI；是则给出 `resume <id>` 里的 id（若有）。 */
export function parseCodexTui(command: string): { resumeId: string | null } | null {
  const tokens = command.trim().split(/\s+/);
  let i = 0;
  if (path.basename(tokens[i] ?? '') === 'node') i += 1;
  if (path.basename(tokens[i] ?? '') !== 'codex') return null;
  i += 1;
  const next = (): string | undefined => {
    while (i < tokens.length && tokens[i]!.startsWith('-')) i += VALUE_FLAGS.has(tokens[i]!) ? 2 : 1;
    return tokens[i++];
  };
  const sub = next();
  if (sub && NON_TUI.has(sub)) return null;
  if (sub === 'resume') {
    const id = next();
    return { resumeId: id && UUID.test(id) ? id : null };
  }
  return { resumeId: null };
}

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const ROLLOUT_ID = /rollout-.*-([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.jsonl$/;

async function isSubagentRollout(file: string): Promise<boolean> {
  const fh = await fs.promises.open(file, 'r');
  try {
    const buf = Buffer.alloc(1 << 20);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    const first = buf.toString('utf8', 0, bytesRead).split('\n')[0]!;
    const meta = parseJson(first);
    return !!meta?.payload?.source?.subagent;
  } catch {
    return false;
  } finally {
    await fh.close();
  }
}

/** 原生自己写的回合生命周期事件决定忙闲：最后一个 task_started 之后没有 task_complete/turn_aborted 即忙。 */
export async function rolloutState(file: string): Promise<LiveState> {
  try {
    const fh = await fs.promises.open(file, 'r');
    try {
      const size = (await fh.stat()).size;
      const len = Math.min(size, 512 * 1024);
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, size - len);
      const tail = buf.toString('utf8');
      const started = tail.lastIndexOf('"type":"task_started"');
      const done = Math.max(tail.lastIndexOf('"type":"task_complete"'), tail.lastIndexOf('"type":"turn_aborted"'));
      if (started < 0 && done < 0) return 'unknown';
      return started > done ? 'busy' : 'idle';
    } finally {
      await fh.close();
    }
  } catch {
    return 'unknown';
  }
}

async function liveSessions(): Promise<LiveSession[]> {
  const out = await run('ps', ['-axww', '-o', 'pid=,tty=,command=']);
  const tuis: { pid: number; tty: string; resumeId: string | null }[] = [];
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\S+)\s+(.*)$/);
    const tty = m ? normalizeTty(m[2]!) : null;
    const tui = m && tty ? parseCodexTui(m[3]!) : null;
    if (m && tty && tui) tuis.push({ pid: Number(m[1]), tty, resumeId: tui.resumeId });
  }
  if (tuis.length === 0) return [];
  const lsof = await run('lsof', ['-nP', '-F', 'pn', '-p', tuis.map((t) => t.pid).join(',')]);
  const held = new Map<number, string[]>();
  let cur = 0;
  for (const line of lsof.split('\n')) {
    if (line.startsWith('p')) cur = Number(line.slice(1));
    else if (line.startsWith('n') && ROLLOUT_ID.test(line)) held.set(cur, [...(held.get(cur) ?? []), line.slice(1)]);
  }
  const byTty = new Map<string, typeof tuis>();
  for (const t of tuis) byTty.set(t.tty, [...(byTty.get(t.tty) ?? []), t]);
  const result: LiveSession[] = [];
  for (const [tty, procs] of byTty) {
    // 原生二进制是持有者；没有持有者时（remote）退回包装进程 + 命令行 id
    const holders = procs.filter((p) => held.has(p.pid));
    let sessionId: string | null = null;
    let file: string | null = null;
    let best = -1;
    for (const h of holders) {
      for (const f of held.get(h.pid)!) {
        if (await isSubagentRollout(f)) continue;
        const mtime = (await fs.promises.stat(f).catch(() => null))?.mtimeMs ?? 0;
        if (mtime > best) {
          best = mtime;
          file = f;
          sessionId = f.match(ROLLOUT_ID)![1]!;
        }
      }
    }
    const pid = holders[0]?.pid ?? procs[0]!.pid;
    if (!sessionId) sessionId = procs.find((p) => p.resumeId)?.resumeId ?? null;
    if (!sessionId) continue;
    result.push({ provider: 'codex', sessionId, pid, tty, state: file ? await rolloutState(file) : 'unknown' });
  }
  return result;
}

export const codex: Provider = {
  id: 'codex',
  listSessions: async () => (await scanCodex()).cards,
  liveSessions,
  resumeArgv: (sessionId, prompt) => ['codex', 'resume', sessionId, prompt],
  newArgv: (prompt) => ['codex', prompt],
};
