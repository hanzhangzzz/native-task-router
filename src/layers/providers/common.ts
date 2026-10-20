// Provider 共用件：用户输入去噪、卡片累加器、流式取行、指纹缓存、进程信息。
//
// 去噪原则：卡片只放"人真正说的话"。原生历史里 user 角色混有系统注入（reminder、hook 输出、
// 斜杠命令回显、工具结果、技能展开、压缩摘要），它们不是任务描述，进了卡片会把路由带偏。
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import type { LiveState, ProviderId, SessionCard } from '../types.ts';
import { stripRoutingNote } from '../routing-note.ts';

export const FIELD_LIMIT = 800;
export const RECENT_PROMPTS = 5;

export function clip(text: string, limit = FIELD_LIMIT): string {
  const t = text.trim();
  if (t.length <= limit) return t;
  // 按码点截断，避免劈开代理对
  return Array.from(t).slice(0, limit).join('');
}

/** 卡片会交给外部模型，凭证形态的片段先抹掉。 */
export function redact(text: string): string {
  return text
    .replace(/\b(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]{16,}/g, '[credential omitted]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+/gi, 'Bearer [credential omitted]')
    .replace(/((?:API_KEY|TOKEN|PASSWORD|SECRET)\s*[:=]\s*)[^\s,;]+/gi, '$1[credential omitted]');
}

const NOISE_TAGS =
  'system-reminder|local-command-caveat|local-command-stdout|local-command-stderr|command-message|command-name|command-args|' +
  'bash-input|bash-stdout|bash-stderr|task-notification|user-prompt-submit-hook|' +
  'recommended_plugins|environment_context|permissions(?: instructions)?|collaboration_mode|skills_instructions|' +
  'subagent_notification|turn_aborted|skill|image|user_shell_command|codex_internal_context|external_codex_apps_open_page|' +
  'send_user_message_question_reply';
const NOISE_BLOCK = new RegExp(`<(${NOISE_TAGS})(?:\\s[^>]*)?>[\\s\\S]*?</\\1>`, 'g');
const NOISE_OPEN = new RegExp(`^<(?:${NOISE_TAGS})(?:\\s|>)`);
const NOISE_PREFIX = [
  /^<\/[\w-]+>$/, // 图片块的孤立收尾标签
  /^Caveat:/,
  /^Stop hook feedback:/,
  /^\[Request interrupted by user/,
  /^\[Image[: ]/,
  /^# AGENTS\.md instructions\b/,
  /^Base directory for this skill:/,
  /^This session is being continued from a previous conversation/,
  /^Continue from where you left off/,
  /^Another Claude session\b/,
  /^UserPromptSubmit hook\b/,
];

// 原生内置的会话控制命令：只是操作界面，不描述任务；带不带参数都不算人话。
const BUILTIN_COMMANDS = new Set([
  'model', 'clear', 'resume', 'compact', 'help', 'config', 'status', 'exit', 'quit', 'login', 'logout', 'cost', 'context',
  'init', 'memory', 'permissions', 'mcp', 'agents', 'ide', 'vim', 'terminal-setup', 'doctor', 'rename', 'usage', 'fast',
  'effort', 'theme', 'export', 'copy', 'rewind', 'bug', 'hooks', 'plugin', 'plugins', 'review', 'new', 'fork', 'plan', 'stats',
]);

/** 斜杠命令没有任务内容：内置命令、或没带参数的命令，返回空串；技能命令带参数则保留 "/x args"。 */
function slashCommandText(name: string, args: string): string {
  const bare = name.replace(/^\//, '').trim();
  return BUILTIN_COMMANDS.has(bare) || !args ? '' : `/${bare} ${args}`;
}

/**
 * 一段 user 文本里"人真正说的话"。全是注入内容时返回空串。
 * 斜杠命令（<command-name>/x</command-name><command-args>…）是人敲的，但内置命令只是操作界面，
 * 不算人话；技能命令带参数时保留为 "/x args"。
 */
export function humanText(raw: string): string {
  const command = raw.match(/<command-name>([\s\S]*?)<\/command-name>/)?.[1]?.trim();
  if (command) {
    const args = raw.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1]?.trim() ?? '';
    return slashCommandText(command, args);
  }
  let text = stripRoutingNote(raw.replace(NOISE_BLOCK, '').trim()).trim();
  if (!text || NOISE_OPEN.test(text)) return '';
  if (NOISE_PREFIX.some((re) => re.test(text))) return '';
  const plain = text.match(/^\/([a-z][\w:-]*)(?:\s+([\s\S]*))?$/);
  if (plain) return slashCommandText(plain[1]!, plain[2]?.trim() ?? '');
  // 只剩一个绝对路径（拖入终端的目录/文件）不是任务描述
  if (!text.includes('\n') && path.isAbsolute(text) && !text.includes(' ')) return '';
  text = redact(text);
  return text;
}

const TEMP_ROOTS = ['/tmp/', '/private/tmp/', '/var/folders/', '/private/var/'];
export function isTempCwd(cwd: string): boolean {
  const c = cwd.endsWith('/') ? cwd : `${cwd}/`;
  return TEMP_ROOTS.some((root) => c.startsWith(root));
}

/** 逐条累加，最后出卡片。asOf 由调用方在喂入前裁剪，这里不关心时间过滤。 */
export class CardBuilder {
  firstPrompt: string | null = null;
  recent: string[] = [];
  lastReply: string | null = null;
  turns = 0;
  startedAt: string | null = null;
  updatedAt: string | null = null;
  title: string | null = null;

  touch(ts: string | undefined): void {
    if (!ts) return;
    this.startedAt ??= ts;
    this.updatedAt = ts;
  }
  user(text: string): void {
    this.turns += 1;
    const t = clip(text);
    this.firstPrompt ??= t;
    this.recent.push(t);
    if (this.recent.length > RECENT_PROMPTS) this.recent.shift();
  }
  reply(text: string): void {
    const t = clip(redact(text));
    if (t) this.lastReply = t;
  }
  build(provider: ProviderId, sessionId: string, cwd: string, startedAt?: string): SessionCard | null {
    if (this.turns === 0) return null;
    const started = startedAt ?? this.startedAt ?? this.updatedAt;
    if (!started) return null;
    return {
      provider,
      sessionId,
      cwd,
      title: this.title ? clip(this.title) : null,
      firstPrompt: this.firstPrompt,
      recentPrompts: this.recent,
      lastReply: this.lastReply,
      startedAt: started,
      updatedAt: this.updatedAt ?? started,
      turns: this.turns,
    };
  }
}

/** asOf（ISO）→ 毫秒；无效值视为未设置。 */
export function asOfMs(asOf: string | undefined): number {
  if (!asOf) return Infinity;
  const t = Date.parse(asOf);
  return Number.isNaN(t) ? Infinity : t;
}

export function parseJson(line: string): any | null {
  try {
    return JSON.parse(line);
  } catch {
    return null; // 并发写入的半行
  }
}

const HEAD_BYTES = 512;
const MAX_LINE_BYTES = 64 * 1024 * 1024;

/**
 * 流式读取 jsonl，只返回 accept(行首 512 字节) 为真的行。
 * 工具结果、大块 base64 等无关的巨行靠行首就被丢弃，不拼接、不解码，所以数百 MB 的历史也能快速扫过。
 * `.zst`（codex-cli 0.163 起把旧 rollout 原地压成 .jsonl.zst）边读边解压，只读、不落盘解压副本。
 */
export async function readRelevantLines(file: string, accept: (head: string) => boolean): Promise<string[]> {
  const out: string[] = [];
  let parts: Buffer[] = [];
  let len = 0;
  let mode: 'head' | 'keep' | 'skip' = 'head';
  const reset = () => {
    parts = [];
    len = 0;
    mode = 'head';
  };
  const headOf = (buf: Buffer) => buf.toString('utf8', 0, Math.min(buf.length, HEAD_BYTES));
  const endOfLine = () => {
    if (mode !== 'skip' && len > 0) {
      const buf = Buffer.concat(parts, len);
      if (mode === 'keep' || accept(headOf(buf))) out.push(buf.toString('utf8'));
    }
    reset();
  };
  const raw = fs.createReadStream(file, { highWaterMark: 1 << 20 });
  const stream = file.endsWith('.zst') ? raw.pipe(zlib.createZstdDecompress()) : raw;
  if (stream !== raw) raw.on('error', (e) => stream.destroy(e));
  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      let pos = 0;
      while (pos < chunk.length) {
        const nl = chunk.indexOf(10, pos);
        const end = nl < 0 ? chunk.length : nl;
        if (mode !== 'skip') {
          parts.push(chunk.subarray(pos, end));
          len += end - pos;
          if (mode === 'head' && len >= HEAD_BYTES) {
            mode = accept(headOf(Buffer.concat(parts, len))) ? 'keep' : 'skip';
            if (mode === 'skip') {
              parts = [];
              len = 0;
            }
          }
          if (len > MAX_LINE_BYTES) {
            parts = [];
            len = 0;
            mode = 'skip';
          }
        }
        if (nl < 0) break;
        endOfLine();
        pos = nl + 1;
      }
    }
    endOfLine(); // 无换行的末行可能是半行，解析层会跳过
  } finally {
    stream.destroy();
    raw.destroy();
  }
  return out;
}

/** 列出 .jsonl；zst 为真时也收 .jsonl.zst（读取见 readRelevantLines）。 */
export async function listJsonl(root: string, recursive: boolean, zst = false): Promise<string[]> {
  const out: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(root, { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return out;
    throw e;
  }
  for (const e of entries) {
    const full = path.join(root, e.name);
    if (e.isFile() && (e.name.endsWith('.jsonl') || (zst && e.name.endsWith('.jsonl.zst')))) out.push(full);
    else if (e.isDirectory() && recursive) out.push(...(await listJsonl(full, true, zst)));
  }
  return out;
}

// ---- 指纹缓存：key = 文件路径，指纹 = mtime+size。缓存可删可重建。 ----

export type Parsed = { card: SessionCard } | { excluded: string };
interface CacheEntry {
  m: number;
  s: number;
  p: Parsed;
}
/**
 * 缓存版本 = 解析相关源码（本文件、claude.ts、codex.ts、../routing-note.ts）的内容哈希：解析规则一变，旧缓存自动作废。
 * 缓存只按 mtime+size 判断文件是否变化，不会察觉规则变化，所以不能靠人记得升版本号。
 */
let cacheVersion: string | null = null;
function currentCacheVersion(): string {
  if (!cacheVersion) {
    const h = createHash('sha256');
    for (const f of ['common.ts', 'claude.ts', 'codex.ts', '../routing-note.ts']) h.update(fs.readFileSync(new URL(f, import.meta.url)));
    cacheVersion = h.digest('hex').slice(0, 16);
  }
  return cacheVersion;
}

/** 数据目录：$NTR_HOME 或 ~/.ntr。0.2 以前叫 ~/.jev：第一次用新版本时整体改名（入口历史、设置、缓存原样保留）。 */
export function ntrHome(): string {
  if (process.env.NTR_HOME) return process.env.NTR_HOME;
  const home = path.join(os.homedir(), '.ntr');
  const legacy = path.join(os.homedir(), '.jev');
  if (!fs.existsSync(home) && fs.existsSync(legacy)) { try { fs.renameSync(legacy, home); } catch { /* 改名失败就用新目录，不动旧目录 */ } }
  return home;
}

export function cacheDir(): string {
  return path.join(ntrHome(), 'cache');
}

export function loadCache(name: string): Map<string, CacheEntry> {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(cacheDir(), `${name}.json`), 'utf8'));
    if (raw.version === currentCacheVersion()) return new Map(Object.entries(raw.files as Record<string, CacheEntry>));
  } catch {
    /* 没有或损坏：当冷启动 */
  }
  return new Map();
}

export function saveCache(name: string, files: Map<string, CacheEntry>): void {
  fs.mkdirSync(cacheDir(), { recursive: true });
  const file = path.join(cacheDir(), `${name}.json`);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ version: currentCacheVersion(), files: Object.fromEntries(files) }));
  fs.renameSync(tmp, file);
}

export interface ScanResult {
  cards: SessionCard[];
  /** 被排除的文件数，按原因分类 */
  excluded: Record<string, number>;
  files: number;
  reparsed: number;
}

/**
 * 增量扫描：指纹没变的文件直接用缓存，变了或新增的重新解析，消失的丢掉。
 * 解析失败（读不到文件）不入缓存，下次重试。
 */
export async function scanFiles(
  name: string,
  files: string[],
  parse: (file: string) => Promise<Parsed>,
): Promise<ScanResult> {
  const cache = loadCache(name);
  const next = new Map<string, CacheEntry>();
  const todo: { file: string; m: number; s: number }[] = [];
  for (const file of files) {
    let st: fs.Stats;
    try {
      st = await fs.promises.stat(file);
    } catch {
      continue; // 扫描途中被删
    }
    const hit = cache.get(file);
    if (hit && hit.m === st.mtimeMs && hit.s === st.size) next.set(file, hit);
    else todo.push({ file, m: st.mtimeMs, s: st.size });
  }
  let cursor = 0;
  const worker = async () => {
    while (cursor < todo.length) {
      const job = todo[cursor++]!;
      try {
        next.set(job.file, { m: job.m, s: job.s, p: await parse(job.file) });
      } catch {
        /* 读失败：下次再试 */
      }
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  if (todo.length > 0 || next.size !== cache.size) saveCache(name, next);
  const cards: SessionCard[] = [];
  const excluded: Record<string, number> = {};
  for (const entry of next.values()) {
    if ('card' in entry.p) cards.push(entry.p.card);
    else excluded[entry.p.excluded] = (excluded[entry.p.excluded] ?? 0) + 1;
  }
  return { cards, excluded, files: files.length, reparsed: todo.length };
}

// ---- 进程信息 ----

export function run(cmd: string, args: string[], env: Record<string, string> = {}): Promise<string> {
  return new Promise((resolve) => {
    // LC_ALL=C：lstart 等输出随区域设置变化（旧记录 S1-26）
    // ps -p 列表里有已退出的 pid 会返回非零但仍输出其余行，所以不看退出码
    execFile(cmd, args, { env: { ...process.env, LC_ALL: 'C', ...env }, maxBuffer: 16 << 20 }, (_err, stdout) =>
      resolve(stdout ?? ''),
    );
  });
}

/** `ps -o tty=` 的值（ttys001 / ?? / 空）规范为 /dev/ttysNNN；无终端为 null。 */
export function normalizeTty(raw: string): string | null {
  const t = raw.trim();
  if (!t || t === '??' || t === '?') return null;
  return t.startsWith('/dev/') ? t : `/dev/${t}`;
}

export interface PsRow {
  pid: number;
  tty: string | null;
  /** UTC 的 lstart，空白折叠，形如 "Thu Oct 8 11:42:48 2026" */
  start: string;
  command: string;
}

/** 一次 ps 取多个 pid 的 tty/启动时间/命令行；已退出的 pid 不在结果里。TZ=UTC 与 Claude 写 procStart 的口径一致。 */
export async function psRows(pids: number[]): Promise<Map<number, PsRow>> {
  const rows = new Map<number, PsRow>();
  // 先用 kill(0) 剔除已退出/非法的 pid：ps 遇到非法 pid 会整条命令失败，不能让一个坏 pid 文件拖垮全部
  pids = pids.filter((pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === 'EPERM';
    }
  });
  if (pids.length === 0) return rows;
  const out = await run('ps', ['-ww', '-o', 'pid=,tty=,lstart=,command=', '-p', pids.join(',')], { TZ: 'UTC' });
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\S+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]{8}\s+\d{4})\s+(.*)$/);
    if (m) rows.set(Number(m[1]), { pid: Number(m[1]), tty: normalizeTty(m[2]!), start: m[3]!.replace(/\s+/g, ' '), command: m[4]! });
  }
  return rows;
}

export type { LiveState };
