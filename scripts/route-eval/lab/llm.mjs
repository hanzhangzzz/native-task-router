// 路由实验用的 OpenRouter 客户端（TE-4b）：磁盘缓存 + 花费账本 + 预算闸。
// 隐私：请求带 provider.data_collection=deny（只路由到不留存、不训练的供应商）；key 只从环境变量
// openrouter_api_key 读取，不打印、不落盘。缓存与账本只放 <数据目录>/lab/，不进提交。
// 缓存键 = 模型 + 请求体哈希（与 tag 无关）；命中时沿用首次调用实测的时延，用于时延统计，花费不重复计。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DEFAULT_OUT } from '../lib.mjs';

export const LAB_DIR = path.join(process.env.ROUTE_EVAL_DATA ?? path.join(DEFAULT_OUT, 'v2'), 'lab');
const CACHE_DIR = path.join(LAB_DIR, 'llm-cache');
const SPEND_FILE = path.join(LAB_DIR, 'spend.jsonl');
fs.mkdirSync(CACHE_DIR, { recursive: true });

/** 累计已花费（USD），读账本。 */
export function totalSpent() {
  if (!fs.existsSync(SPEND_FILE)) return 0;
  return fs.readFileSync(SPEND_FILE, 'utf8').split('\n').filter(Boolean).reduce((a, l) => a + (JSON.parse(l).costUsd ?? 0), 0);
}
export function spentByTag() {
  const m = {};
  if (!fs.existsSync(SPEND_FILE)) return m;
  for (const l of fs.readFileSync(SPEND_FILE, 'utf8').split('\n').filter(Boolean)) { const r = JSON.parse(l); const k = `${r.tag}|${r.model}`; m[k] = (m[k] ?? 0) + (r.costUsd ?? 0); }
  return m;
}
const HARD_STOP = Number(process.env.LAB_HARD_STOP_USD ?? 38);

const KEY = process.env.openrouter_api_key;
export const hasKey = () => !!KEY;

let inflightBudget = 0;
function recordSpend(row) { fs.appendFileSync(SPEND_FILE, JSON.stringify(row) + '\n'); }

/**
 * 一次 chat 调用。返回 { text, finish, usage, costUsd, latencyMs, cached, logprobs? , error? }。
 * 不抛错：失败返回 error 字段（调用方当作"路由失败 → 澄清"处理）。
 */
export async function chat({ model, messages, tag = 'untagged', maxTokens = 300, temperature = 0, reasoning, logprobs = false, topLogprobs, responseFormat, extra = {}, timeoutMs = 30000, retries = 2, noCache = false }) {
  const body = {
    model, messages, max_tokens: maxTokens, temperature,
    provider: { data_collection: 'deny', ...(extra.provider ?? {}) },
    usage: { include: true },
    ...(reasoning ? { reasoning } : {}),
    ...(logprobs ? { logprobs: true, top_logprobs: topLogprobs ?? 5 } : {}),
    ...(responseFormat ? { response_format: responseFormat } : {}),
    ...Object.fromEntries(Object.entries(extra).filter(([k]) => k !== 'provider')),
  };
  const key = crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
  const cacheFile = path.join(CACHE_DIR, `${key}.json`);
  if (!noCache && fs.existsSync(cacheFile)) {
    try { return { ...JSON.parse(fs.readFileSync(cacheFile, 'utf8')), cached: true }; } catch { /* 损坏则重调 */ }
  }
  if (!KEY) return { text: '', error: 'no api key', costUsd: null, latencyMs: 0, cached: false };
  if (totalSpent() + inflightBudget >= HARD_STOP) return { text: '', error: `budget hard stop $${HARD_STOP}`, costUsd: null, latencyMs: 0, cached: false };
  let lastErr = 'unknown';
  for (let attempt = 0; attempt <= retries; attempt++) {
    const started = Date.now();
    try {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}`, 'x-title': 'ntr-route-lab' },
        body: JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
      const raw = await res.text();
      const latencyMs = Date.now() - started;
      if (!res.ok) {
        lastErr = `HTTP ${res.status} ${raw.slice(0, 200).replace(KEY, '[redacted]')}`;
        if (res.status === 429 || res.status >= 500) { await new Promise((r) => setTimeout(r, 800 * (attempt + 1))); continue; }
        return { text: '', error: lastErr, costUsd: null, latencyMs, cached: false };
      }
      const j = JSON.parse(raw);
      if (j.error) { lastErr = `api error ${JSON.stringify(j.error).slice(0, 200)}`; await new Promise((r) => setTimeout(r, 800 * (attempt + 1))); continue; }
      const ch = j.choices?.[0];
      const out = {
        text: ch?.message?.content ?? '', finish: ch?.finish_reason ?? null, usage: j.usage ?? null,
        costUsd: typeof j.usage?.cost === 'number' ? j.usage.cost : null, latencyMs, model: j.model ?? model, provider: j.provider ?? null,
        logprobs: ch?.logprobs ?? null, reasoningTokens: j.usage?.completion_tokens_details?.reasoning_tokens ?? null,
      };
      recordSpend({ time: new Date().toISOString(), tag, model, costUsd: out.costUsd, latencyMs, promptTokens: j.usage?.prompt_tokens ?? null, completionTokens: j.usage?.completion_tokens ?? null });
      fs.writeFileSync(cacheFile, JSON.stringify(out));
      return { ...out, cached: false };
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
      if (attempt < retries) await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
  }
  return { text: '', error: lastErr, costUsd: null, latencyMs: 0, cached: false };
}

/** 并发池。 */
export async function pool(items, n, fn) {
  const res = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) { const k = i++; res[k] = await fn(items[k], k); }
  }));
  return res;
}
