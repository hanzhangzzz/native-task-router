// 挖掘 + 切分（TE-3）：本机真实原生历史 → 评测样本。
// 用法：node scripts/route-eval/mine.mjs [--gap-min 30] [--heldout 0.4] [--out <dir>]
// 输出（默认 <主检出>/.runtime/route-eval/，gitignore）：
//   sessions.json       逻辑会话（含有界内容，供评测器预载，避免重扫 8GB 原始文件）
//   dev.jsonl / heldout.jsonl / adversarial.jsonl   样本
//   heldout.sha256      留出集冻结哈希
//   mine-stats.json     聚合统计（不含原文，可进报告）
// 留出集一旦存在就**拒绝覆盖**（冻结）；要重建须显式 --rebuild-heldout 并说明原因。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseClaude, parseCodex, finalizeExclusion } from './parse.mjs';
import { groupLogical, buildSamples } from './dataset.mjs';
import { DEFAULT_OUT, readJsonl, writeJsonl, sha256File } from './lib.mjs';

const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const GAP_MIN = Number(arg('--gap-min', 30));
const HELDOUT_FRAC = Number(arg('--heldout', 0.4));
const OUT = arg('--out', DEFAULT_OUT);
const REBUILD = args.includes('--rebuild-heldout');
// 数据快照截止时间：原生会话文件会继续增长（含正在运行的会话），固定截止时间才能让重挖得到同一份留出集。
const statsPath = path.join(OUT, 'mine-stats.json');
const priorUntil = fs.existsSync(statsPath) && !REBUILD ? JSON.parse(fs.readFileSync(statsPath, 'utf8')).until : null;
const UNTIL = Date.parse(arg('--until', priorUntil ?? new Date().toISOString()));

const home = os.homedir();
function listFiles() {
  const out = [];
  const claudeRoot = path.join(home, '.claude/projects');
  for (const d of fs.readdirSync(claudeRoot)) {
    const dir = path.join(claudeRoot, d);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const f of fs.readdirSync(dir)) if (f.endsWith('.jsonl')) out.push({ provider: 'claude', file: path.join(dir, f) });
  }
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) out.push({ provider: 'codex', file: p });
    }
  };
  walk(path.join(home, '.codex/sessions'));
  walk(path.join(home, '.codex/archived_sessions'));
  return out;
}

async function pool(items, n, fn) {
  const res = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) { const k = i++; res[k] = await fn(items[k]); }
  }));
  return res;
}

const files = listFiles();
console.error(`扫描 ${files.length} 个原生会话文件…`);
const t0 = Date.now();
const parsed = await pool(files, 6, (f) => (f.provider === 'claude' ? parseClaude(f.file) : parseCodex(f.file)));
console.error(`解析完成 ${((Date.now() - t0) / 1000).toFixed(0)}s`);

// 快照截止：丢弃截止时间之后的事件
for (const s of parsed) {
  s.inputs = s.inputs.filter((i) => i.t < UNTIL);
  s.replies = s.replies.filter((r) => r.t < UNTIL);
  s.titles = s.titles.filter((x) => x.t !== null && x.t < UNTIL);
}

// ---- 排除计数 -------------------------------------------------------------
const stats = { files: { claude: 0, codex: 0 }, excluded: {}, included: { claude: 0, codex: 0 }, inputDrops: {} };
const kept = [];
for (const s of parsed) {
  stats.files[s.provider]++;
  const why = finalizeExclusion(s);
  if (why) { const k = `${s.provider}:${why}`; stats.excluded[k] = (stats.excluded[k] ?? 0) + 1; continue; }
  stats.included[s.provider]++;
  for (const [k, v] of Object.entries(s.drops)) stats.inputDrops[k] = (stats.inputDrops[k] ?? 0) + v;
  kept.push(s);
}

// ---- 逻辑会话 + 样本 + 切分 ------------------------------------------------
const { logical, mergedGroups } = groupLogical(kept);
const { samples: raw, cutoffMs, sens, sensHeld, conts } = buildSamples(logical, { gapMin: GAP_MIN, heldoutFrac: HELDOUT_FRAC });


// ---- 落盘 ----------------------------------------------------------------
fs.mkdirSync(OUT, { recursive: true });
const heldPath = path.join(OUT, 'heldout.jsonl');
const dev = raw.filter((s) => s.split === 'dev');
const held = raw.filter((s) => s.split === 'heldout');
if (fs.existsSync(heldPath) && !REBUILD) {
  // 冻结：已有留出集时只允许结果完全一致（同一份输入数据 → 同一份哈希），否则拒绝
  const tmp = path.join(OUT, 'heldout.candidate.jsonl');
  writeJsonl(tmp, held);
  const same = sha256File(tmp) === sha256File(heldPath);
  fs.rmSync(tmp);
  if (!same) {
    console.error('拒绝：留出集已冻结且新挖掘结果与之不同（原生历史增长或规则变化）。显式 --rebuild-heldout 才会重建并作废之前的账本。');
    process.exit(2);
  }
} else {
  writeJsonl(heldPath, held);
  fs.writeFileSync(path.join(OUT, 'heldout.sha256'), `${sha256File(heldPath)}  heldout.jsonl\n`);
  if (REBUILD) fs.rmSync(path.join(OUT, 'heldout-ledger.jsonl'), { force: true });
}
writeJsonl(path.join(OUT, 'dev.jsonl'), dev);

// 对抗集：来自开发期的难例（可反复跑）；留出期的难例随留出集一起一次性评测并按 tag 单列
const ADV_TAGS = ['short-followup', 'same-project-multi', 'cross-tool-same-project', 'new-in-existing-project', 'exact-repeat-of-earlier'];
const adv = dev.filter((s) => s.tags.some((t) => ADV_TAGS.includes(t)));
writeJsonl(path.join(OUT, 'adversarial.jsonl'), adv);

fs.writeFileSync(path.join(OUT, 'sessions.json'), JSON.stringify(logical.map((L) => ({
  key: L.key, provider: L.provider, sessionId: L.sessionId, files: L.files, cwd: L.cwd, firstInputT: L.firstInputT,
  inputs: L.inputs.map(({ t, text, id, gapMs, viaResumeCopy }) => ({ t, text, id, gapMs, viaResumeCopy })), replies: L.replies, titles: L.titles,
}))));

const count = (arr, f) => arr.reduce((m, x) => { const k = f(x); m[k] = (m[k] ?? 0) + 1; return m; }, {});
const summarize = (arr) => ({
  total: arr.length, byKind: count(arr, (s) => s.kind), byProvider: count(arr, (s) => `${s.kind}/${s.provider}`),
  tags: count(arr.flatMap((s) => s.tags.map((t) => ({ t }))), (x) => x.t),
});
const out = {
  minedAt: new Date().toISOString(), until: new Date(UNTIL).toISOString(), gapMin: GAP_MIN, heldoutFrac: HELDOUT_FRAC, cutoff: Number.isFinite(cutoffMs) ? new Date(cutoffMs).toISOString() : null,
  files: stats.files, included: stats.included, excluded: stats.excluded, inputDropsInIncludedSessions: stats.inputDrops,
  logicalSessions: { total: logical.length, byProvider: count(logical, (L) => L.provider), mergedGroups },
  dev: summarize(dev), heldout: summarize(held), adversarialDev: summarize(adv),
  continuationBySplitProvider: count(conts.map((s) => ({ k: `${s.split}/${s.provider}/${s.reason}` })), (x) => x.k),
  gapSensitivity: sens, gapSensitivityInHeldoutWindow: sensHeld, heldoutSha256: sha256File(heldPath),
};
fs.writeFileSync(path.join(OUT, 'mine-stats.json'), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
