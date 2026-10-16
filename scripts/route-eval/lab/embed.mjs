// OpenRouter 嵌入（TE-4b）：磁盘缓存，批量请求。隐私同 llm.mjs：data_collection=deny，key 只读环境变量。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { LAB_DIR } from './llm.mjs';

const KEY = process.env.openrouter_api_key;
const dir = path.join(LAB_DIR, 'emb-cache');
fs.mkdirSync(dir, { recursive: true });
const h = (model, text) => crypto.createHash('sha256').update(`${model}\n${text}`).digest('hex');
const SPEND = path.join(LAB_DIR, 'spend.jsonl');

/** texts → Float32Array[]（同序）。批量 64 条，未命中的才调用。 */
export async function embed(model, texts, { tag = 'embed', batch = 48 } = {}) {
  const out = new Array(texts.length);
  const todo = [];
  texts.forEach((t, i) => {
    const f = path.join(dir, `${h(model, t)}.bin`);
    if (fs.existsSync(f)) { const b = fs.readFileSync(f); out[i] = new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4).slice(); }
    else todo.push(i);
  });
  for (let s = 0; s < todo.length; s += batch) {
    const idx = todo.slice(s, s + batch);
    if (!KEY) throw new Error('no api key');
    let j = null;
    for (let attempt = 0; attempt < 3 && !j; attempt++) {
      const res = await fetch('https://openrouter.ai/api/v1/embeddings', {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
        body: JSON.stringify({ model, input: idx.map((i) => texts[i]), provider: { data_collection: 'deny' }, encoding_format: 'float' }), signal: AbortSignal.timeout(60000),
      });
      if (!res.ok) { if (attempt === 2) throw new Error(`embed HTTP ${res.status} ${(await res.text()).slice(0, 200)}`); await new Promise((r) => setTimeout(r, 1000 * (attempt + 1))); continue; }
      j = await res.json();
      if (!j.data) { j = null; await new Promise((r) => setTimeout(r, 1000)); }
    }
    if (!j) throw new Error('embed failed');
    const cost = typeof j.usage?.cost === 'number' ? j.usage.cost : (j.usage?.total_tokens ?? 0) * 1e-8;
    fs.appendFileSync(SPEND, JSON.stringify({ time: new Date().toISOString(), tag, model, costUsd: cost, promptTokens: j.usage?.prompt_tokens ?? null }) + '\n');
    for (const d of j.data) {
      const i = idx[d.index];
      const v = Float32Array.from(d.embedding);
      out[i] = v;
      fs.writeFileSync(path.join(dir, `${h(model, texts[i])}.bin`), Buffer.from(v.buffer));
    }
  }
  return out;
}
export function cosine(a, b) {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return d / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}
