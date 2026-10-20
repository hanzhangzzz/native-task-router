// 生产卡片构建（TE-4b 评测集 v2）：评测卡片 = src/layers/providers 的生产实现，而不是评测自带的近似。
//
// 防泄漏：生产实现的 asOf 是"≤"语义（时间戳 > asOf 的行被截掉），评测要求严格 `<`（查询那一刻的输入
// 不能进卡片），所以这里一律传 asOf = t - 1ms（时间戳是毫秒，等价于严格小于）。
// 另外留 2 秒安全边距（CUT_MARGIN_MS）：Codex 同一条用户输入有两条记录（response_item 与 event_msg），时间戳差约 1ms，
// 评测用 event_msg 的时间当查询时刻，若只防 1ms 会让查询本身漏进自己的卡片（挖出 v2 时实测发现，见 contracts-v2）。
// 查询都是"隔 ≥30 分钟后的输入"或"会话首条"，丢掉查询前 2 秒的内容不影响任何真实候选。
// Codex 标题来自 ~/.codex/session_index.jsonl 的 thread_name；它只有一个"最后更新时间"，只有
// updated_at 早于查询时刻才使用，否则不用（防泄漏，偏保守：活跃会话的标题在评测里往往取不到，生产里能取到）。
//
// 性能：同一会话在两个相邻事件之间卡片不变，所以按 (文件, 截断位置, 标题可用) 记忆；构建时只喂截断位置之前的行。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cardFromClaudeLines, claudeLineWanted } from '../../src/layers/providers/claude.ts';
import { cardFromCodexLines, codexLineWanted } from '../../src/layers/providers/codex.ts';
import { readRelevantLines } from '../../src/layers/providers/common.ts';
import zlib from 'node:zlib';
import { DEFAULT_OUT } from './lib.mjs';

export const CUT_MARGIN_MS = 2000;
const TS_RE = /"timestamp":"([^"]+)"/;

// codex-cli 0.163 起会把较旧的 rollout 原地压缩成 <文件>.jsonl.zst（2026-10-19 本机实测：143 个评测会话里 136 个被压缩）。
// 评测集引用的是挖掘时的 .jsonl 路径；原文件不在而 .zst 在时，解压一份到评测数据目录的缓存里读（只读原生文件，不改动它）。
const ZST_CACHE = path.join(process.env.ROUTE_EVAL_DATA ?? path.join(DEFAULT_OUT, 'v2'), 'zst-cache');
export function resolveNative(file) {
  if (fs.existsSync(file)) return file;
  const zst = `${file}.zst`;
  if (!fs.existsSync(zst)) return null;
  const out = path.join(ZST_CACHE, path.basename(file));
  if (!fs.existsSync(out)) {
    fs.mkdirSync(ZST_CACHE, { recursive: true });
    fs.writeFileSync(`${out}.tmp`, zlib.zstdDecompressSync(fs.readFileSync(zst)));
    fs.renameSync(`${out}.tmp`, out);
  }
  return out;
}

/** file → { lines, stamps: [{i, t}] }，按需加载并缓存（只含生产实现会读的行）。 */
const loaded = new Map();
async function load(provider, file) {
  if (!loaded.has(file)) {
    loaded.set(file, (async () => {
      const lines = await readRelevantLines(resolveNative(file), provider === 'claude' ? claudeLineWanted : codexLineWanted);
      const stamps = [];
      lines.forEach((l, i) => {
        const m = l.match(TS_RE);
        if (m) { const t = Date.parse(m[1]); if (!Number.isNaN(t)) stamps.push({ i, t }); }
      });
      return { lines, stamps };
    })());
  }
  return loaded.get(file);
}

let codexTitles = null;
/** Codex 线程标题索引：id → { name, updatedMs }。 */
export function codexTitleIndex() {
  if (codexTitles) return codexTitles;
  codexTitles = new Map();
  const f = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'session_index.jsonl');
  try {
    for (const l of fs.readFileSync(f, 'utf8').split('\n')) {
      if (!l) continue;
      try {
        const o = JSON.parse(l);
        if (typeof o.id === 'string' && typeof o.thread_name === 'string') codexTitles.set(o.id, { name: o.thread_name, updatedMs: Date.parse(o.updated_at) });
      } catch { /* 半行 */ }
    }
  } catch { /* 没有索引 */ }
  return codexTitles;
}
export function setCodexTitleIndex(map) { codexTitles = map; }

const memo = new Map();
const stats = { builds: 0, hits: 0 };
export const prodCardStats = () => ({ ...stats });

/** 生产卡片，asOf 之前（严格小于）的内容。无卡片返回 null。 */
export async function buildProdCard(provider, file, asOfIso, opts = {}) {
  const t = Date.parse(asOfIso);
  const limit = t - CUT_MARGIN_MS;
  // 原生历史会被清理（Claude 默认只留 30 天）：评测集引用的文件不在了，就当这个会话当时不在库里
  if (!resolveNative(file)) { stats.missing = (stats.missing ?? 0) + 1; return null; }
  const { lines, stamps } = await load(provider, file);
  // 截断位置：第一条时间戳 > limit 的行；之前的行一起交给生产实现
  let cutIdx = lines.length;
  let kept = 0;
  for (const s of stamps) { if (s.t > limit) { cutIdx = s.i; break; } kept++; }
  if (kept === 0) return null;
  const sessionId = provider === 'claude' ? path.basename(file, '.jsonl') : null;
  let title = null;
  if (provider === 'codex' && opts.titles !== false) {
    // Codex 标题键是 thread id，即 session_meta 的 id；文件名末尾的 UUID 与之相同
    const id = path.basename(file, '.jsonl').match(/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/)?.[1];
    const e = id ? (opts.titleIndex ?? codexTitleIndex()).get(id) : null;
    if (e && e.updatedMs < t) title = e.name;
  }
  const key = `${file}|${cutIdx}|${title ?? ''}`;
  if (memo.has(key)) { stats.hits++; return memo.get(key); }
  stats.builds++;
  const prefix = lines.slice(0, cutIdx);
  const asOf = new Date(limit).toISOString();
  const card = provider === 'claude'
    ? cardFromClaudeLines(prefix, { asOf, sessionId })
    : cardFromCodexLines(prefix, { asOf, title });
  memo.set(key, card);
  return card;
}

/** 评测用的会话清单项（写进 sessions.json 的 v2 格式）。firstInputT = 首条相关行时间。 */
export async function describeSession(provider, file) {
  const { stamps } = await load(provider, file);
  return stamps.length ? stamps[0].t : null;
}
export function releaseLines(file) { loaded.delete(file); }
