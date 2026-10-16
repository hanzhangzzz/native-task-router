// 原生历史解析（TE-3）：把 Claude / Codex 的会话文件规整成统一的事件序列。
// 只读；不改 ~/.claude、~/.codex。内容只进 .runtime/route-eval/（gitignore），不进提交。
// 约定：所有时间戳统一为毫秒（Date.parse），卡片截断一律用严格 `<`。

import fs from 'node:fs';
import os from 'node:os';
import readline from 'node:readline';
import crypto from 'node:crypto';
import { humanText } from '../../src/layers/providers/common.ts';

export const CARD_FIELD_MAX = 800;
export const RECENT_PROMPTS = 5;

// ---- 用户输入去噪 ---------------------------------------------------------

const BLOCK_TAGS = [
  'system-reminder', 'ide_opened_file', 'ide_selection', 'in-app-browser-context', 'environment_context',
  'local-command-caveat', 'user-prompt-submit-hook', 'command-message', 'turn_aborted', 'user_instructions',
];
const BLOCK_RE = BLOCK_TAGS.map((t) => new RegExp(`<${t}(?:\\s[^>]*)?>[\\s\\S]*?</${t}>`, 'g'));
const SYSTEM_PREFIXES = [
  'Caveat:', '<local-command-stdout>', '<local-command-stderr>', '<task-notification>', '<bash-input>', '<bash-stdout>',
  '<bash-stderr>', '[Request interrupted', 'This session is being continued', 'Another Claude session', '<teammate-message',
  '<heartbeat>', 'Automation:', 'You are operating in', '<command-stdout>', '# AGENTS.md instructions', '<hook_prompt', '<codex_delegation>', '<subagent_notification>',
];

/**
 * 原始用户文本 → 人真正说的话。返回 { text } 或 { drop: 原因 }。
 * 原因：system-injection（系统/工具/自动化注入）、slash-only（只有斜杠命令）、empty。
 */
export function cleanUserText(raw) {
  if (typeof raw !== 'string') return { drop: 'empty' };
  // v2：生产卡片认为不是人话的（内置斜杠命令等）评测也不当作查询，保证评测衡量的就是生产口径
  if (humanText(raw) === '' && /<command-name>|^\s*\/[A-Za-z]/.test(raw)) return { drop: 'slash-only' };
  let s = raw;
  // 斜杠命令：只有命令名没有参数 → 丢；有参数 → 只保留参数
  const cmd = s.match(/<command-name>\s*([^<]*?)\s*<\/command-name>/);
  if (cmd) {
    const args = (s.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1] ?? '').trim();
    if (!args) return { drop: 'slash-only' };
    s = args;
  }
  for (const re of BLOCK_RE) s = s.replace(re, '');
  s = s.replace(/\[@[^\]]+\]\(plugin:\/\/[^)]*\)/g, '').replace(/\[Image #\d+\]/g, '');
  // Codex 附件包装："# Files mentioned by the user: ... ## My request for Codex:\n<正文>"
  const req = s.match(/## My request(?: for Codex)?:\s*([\s\S]*)$/);
  if (req) s = req[1];
  s = s.trim();
  if (!s) return { drop: 'empty' };
  if (SYSTEM_PREFIXES.some((p) => s.startsWith(p))) return { drop: 'system-injection' };
  // 纯斜杠命令（"/compact"、"/model sonnet"）；"/Users/x/y" 这类路径开头的是正常输入
  const m = s.match(/^\/([A-Za-z][\w:-]*)(?:\s+([\s\S]*))?$/);
  if (m) {
    if (!(m[2] ?? '').trim()) return { drop: 'slash-only' };
    return { text: m[2].trim().slice(0, 4000) };
  }
  return { text: s.slice(0, 4000) };
}

// ---- 交互会话判定 ---------------------------------------------------------

const TMP_CWD = /^\/(private\/)?(tmp|var\/folders|var\/tmp)(\/|$)/;
export function isTempCwd(cwd) {
  if (!cwd) return false;
  if (TMP_CWD.test(cwd)) return true;
  const t = os.tmpdir();
  return cwd === t || cwd.startsWith(t + '/');
}
// 仓库内 .runtime 下的测试夹具目录（各任务的隔离探针会话）
export function isRuntimeFixtureCwd(cwd) {
  return !!cwd && cwd.includes('/.runtime/');
}
export function isJevScratchCwd(cwd) {
  return !!cwd && cwd.startsWith(`${os.homedir()}/JevTasks/`);
}

const hashKey = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);
const clip = (s, n = CARD_FIELD_MAX) => (s.length > n ? s.slice(0, n) : s);

async function* lines(file) {
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const l of rl) if (l) yield l;
}

// ---- Claude ---------------------------------------------------------------

function claudeUserText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  if (content.some((b) => b?.type === 'tool_result')) return null;
  return content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n');
}

export async function parseClaude(file) {
  const sess = {
    provider: 'claude', file, sessionId: null, cwd: null, interactive: true, exclude: null,
    drops: {}, inputs: [], replies: [], titles: [], firstT: null, lastT: null,
  };
  let lastActT = null; // 上一条真实活动（user/assistant 行）的时间
  let lastLineT = null;
  const tag = (r) => { sess.drops[r] = (sess.drops[r] ?? 0) + 1; };
  for await (const line of lines(file)) {
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    const ty = d.type;
    const t = d.timestamp ? Date.parse(d.timestamp) : null;
    if (t) lastLineT = t;
    if (d.sessionId && !sess.sessionId) sess.sessionId = d.sessionId;
    if (ty === 'ai-title' && d.aiTitle) { sess.titles.push({ t: lastLineT, title: clip(String(d.aiTitle), 200) }); continue; }
    if (ty === 'custom-title' && d.customTitle) {
      sess.titles.push({ t: lastLineT, title: clip(String(d.customTitle), 200), custom: true });
      continue;
    }
    if (ty !== 'user' && ty !== 'assistant') continue;
    if (!t) continue;
    if (d.isSidechain) { lastActT = t; continue; }
    if (!sess.cwd && d.cwd) sess.cwd = d.cwd;
    if (ty === 'user') {
      if (d.sessionKind === 'bg') sess.exclude ??= 'claude-bg';
      if (d.entrypoint && d.entrypoint !== 'cli') sess.exclude ??= `claude-${d.entrypoint}`;
      const text = claudeUserText(d.message?.content);
      const nonHuman =
        d.isMeta || d.isCompactSummary || text === null ||
        (d.origin?.kind && d.origin.kind !== 'human') || d.promptSource === 'system' || d.promptSource === 'sdk' ||
        d.turnOrigin === 'scheduled' || d.turnOrigin === 'task_notification';
      if (!nonHuman) {
        const c = cleanUserText(text);
        if (c.drop) tag(c.drop);
        else {
          sess.inputs.push({ t, text: c.text, id: d.uuid ?? hashKey(`${t}${c.text}`), gapMs: lastActT ? t - lastActT : null });
        }
      } else if (text !== null && !d.isMeta) tag('system-injection');
      lastActT = t;
      sess.firstT ??= t; sess.lastT = t;
    } else {
      const blocks = d.message?.content;
      if (Array.isArray(blocks)) {
        const txt = blocks.filter((b) => b?.type === 'text' && b.text).map((b) => b.text).join('\n').trim();
        if (txt) sess.replies.push({ t, text: clip(txt) });
      }
      lastActT = t;
      sess.firstT ??= t; sess.lastT = t;
    }
  }
  if (sess.titles.some((x) => x.custom && /^jev-/.test(x.title))) sess.exclude ??= 'jev-managed';
  return sess;
}

// ---- Codex ----------------------------------------------------------------

const CODEX_ACT_RE = /"type":"response_item","payload":\{"type":"(function_call|function_call_output|custom_tool_call|custom_tool_call_output|reasoning|web_search_call|tool_search_call|tool_search_output)"/;
const CODEX_TS_RE = /^\{"timestamp":"([^"]+)"/;
const INTERACTIVE_ORIGINATORS = new Set(['Codex Desktop', 'codex-tui', 'codex_cli_rs']);

export async function parseCodex(file) {
  const sess = {
    provider: 'codex', file, sessionId: null, cwd: null, interactive: true, exclude: null,
    drops: {}, inputs: [], replies: [], titles: [], firstT: null, lastT: null, originator: null, forkedFrom: null,
  };
  let lastActT = null;
  let actBeforeTurn = null;
  const tag = (r) => { sess.drops[r] = (sess.drops[r] ?? 0) + 1; };
  let n = 0;
  for await (const line of lines(file)) {
    n++;
    const head = line.length > 400 ? line.slice(0, 400) : line;
    const tm = head.match(CODEX_TS_RE);
    const t = tm ? Date.parse(tm[1]) : null;
    if (n === 1) {
      let d;
      try { d = JSON.parse(line); } catch { sess.exclude = 'unparsable'; return sess; }
      const p = d.payload ?? {};
      sess.sessionId = p.id ?? null; sess.cwd = p.cwd ?? null; sess.originator = p.originator ?? null;
      sess.forkedFrom = p.forked_from_id ?? null;
      if (typeof p.source !== 'string') sess.exclude = 'codex-subagent';
      else if (p.source === 'exec') sess.exclude = 'codex-exec';
      else if (!INTERACTIVE_ORIGINATORS.has(p.originator)) sess.exclude = `codex-originator:${p.originator}`;
      else if (isTempCwd(p.cwd)) sess.exclude = 'temp-cwd';
      else if (isJevScratchCwd(p.cwd)) sess.exclude = 'jev-scratch-cwd';
      else if (isRuntimeFixtureCwd(p.cwd)) sess.exclude = 'runtime-fixture-cwd';
      if (sess.exclude) return sess; // 已确定排除，不必扫完整个文件
      continue;
    }
    if (!t) continue;
    if (head.includes('"payload":{"type":"task_started"')) { actBeforeTurn = lastActT; continue; }
    if (CODEX_ACT_RE.test(head)) { lastActT = t; sess.firstT ??= t; sess.lastT = t; continue; }
    if (!line.includes('"item_completed"')) continue;
    if (line.includes('"type":"UserMessage"')) {
      let d;
      try { d = JSON.parse(line); } catch { continue; }
      const item = d.payload?.item;
      if (item?.type !== 'UserMessage') continue;
      const raw = (item.content ?? []).filter((b) => b?.type === 'text').map((b) => b.text).join('\n');
      const c = cleanUserText(raw);
      if (c.drop) tag(c.drop);
      else sess.inputs.push({ t, text: c.text, id: hashKey(`${t}${c.text}`), gapMs: actBeforeTurn ? t - actBeforeTurn : null });
      sess.firstT ??= t; sess.lastT = t;
      lastActT = t;
    } else if (line.includes('"type":"AgentMessage"')) {
      let d;
      try { d = JSON.parse(line); } catch { continue; }
      const item = d.payload?.item;
      if (item?.type !== 'AgentMessage') continue;
      const txt = (item.content ?? []).filter((b) => b?.text).map((b) => b.text).join('\n').trim();
      if (txt) sess.replies.push({ t, text: clip(txt), final: item.phase === 'final_answer' });
      lastActT = t; sess.firstT ??= t; sess.lastT = t;
    }
  }
  return sess;
}

// ---- 公共：入口 -----------------------------------------------------------

const memo = new Map();
/** 预载已解析结果（评测时从 sessions 数据集载入，避免重复扫 8GB 原始文件）。 */
export function registerParsed(file, parsed) { memo.set(file, Promise.resolve(parsed)); }

export function parseSessionFile(provider, file) {
  if (!memo.has(file)) memo.set(file, provider === 'claude' ? parseClaude(file) : parseCodex(file));
  return memo.get(file);
}

export function finalizeExclusion(s) {
  if (s.exclude) return s.exclude;
  if (isTempCwd(s.cwd)) return 'temp-cwd';
  if (isJevScratchCwd(s.cwd)) return 'jev-scratch-cwd';
  if (isRuntimeFixtureCwd(s.cwd)) return 'runtime-fixture-cwd';
  if (!s.cwd) return 'no-cwd';
  if (s.inputs.length === 0) return 'no-human-input';
  return null;
}
