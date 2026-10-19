// 实验：项目优先的确定性路由（不调模型）。问题：一句话能否先确定"该去哪个项目目录"，再在项目内选会话/新建？
// 用法：node scripts/route-eval/lab/exp-project.mjs [--set dev]
import { loadSamples, poolFor, labelOf, cardId } from './data.mjs';
import { tokens, rankLexical } from '../../../src/layers/router/v2.ts';

const args = process.argv.slice(2);
const SET = args.includes('--set') ? args[args.indexOf('--set') + 1] : 'dev';
const samples = loadSamples(SET);

const base = (cwd) => (cwd ?? '').split('/').filter(Boolean).slice(-1)[0] ?? '';
const base2 = (cwd) => (cwd ?? '').split('/').filter(Boolean).slice(-2).join('/');
/** 项目名 token：目录名按 -_. 拆，≥3 位拉丁或任意汉字串（含 bigram） */
const nameTokens = (cwd) => new Set(tokens(base(cwd)).filter((t) => /[\p{Script=Han}]/u.test(t) ? true : t.length >= 3));
const distinctive = (t) => (/[\p{Script=Han}]/u.test(t) ? [...t].length >= 2 : t.length >= 4);

function groupProjects(cards) {
  const m = new Map();
  for (const c of cards) (m.get(c.cwd) ?? m.set(c.cwd, []).get(c.cwd)).push(c);
  for (const v of m.values()) v.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return m;
}
/** 项目伪卡片：把项目内会话文本合并（用 v2 的 BM25 排序器打分） */
function projectCards(projects) {
  return [...projects.entries()].map(([cwd, cs]) => ({
    provider: cs[0].provider, sessionId: cwd, cwd,
    title: cs.map((c) => c.title ?? '').filter(Boolean).slice(0, 10).join(' | ') || null,
    firstPrompt: cs.map((c) => c.firstPrompt ?? '').slice(0, 10).join('\n'),
    recentPrompts: cs.slice(0, 10).flatMap((c) => c.recentPrompts),
    lastReply: cs.slice(0, 5).map((c) => c.lastReply ?? '').join('\n'),
    startedAt: cs.at(-1).startedAt, updatedAt: cs[0].updatedAt, turns: cs.reduce((a, c) => a + c.turns, 0),
  }));
}

const R = { n: 0, labelProjectInPool: 0, nameUniq: { n: 0, ok: 0 }, nameMulti: 0, lexTop1: { n: 0, ok: 0 }, recencyTop1: { n: 0, ok: 0 },
  margin: {}, cont: { n: 0, latestInProj: 0, uniqueInProj: 0, projSize: [] }, newProj: { n: 0, brandNew: 0 } };
const TH = [1.2, 1.5, 2, 3];
for (const th of TH) R.margin[th] = { n: 0, ok: 0 };
const fails = [];

for (const s of samples) {
  const cards = await poolFor(s);
  const projects = groupProjects(cards);
  const labelCwd = s.cwd;
  const inPool = projects.has(labelCwd);
  R.n++;
  if (inPool) R.labelProjectInPool++;
  if (s.kind === 'new') { R.newProj.n++; if (!inPool) R.newProj.brandNew++; }

  // 规则 1：项目名唯一命中
  const q = new Set(tokens(s.text).filter(distinctive));
  const hits = [...projects.keys()].filter((cwd) => [...nameTokens(cwd)].some((t) => q.has(t)));
  if (hits.length === 1) { R.nameUniq.n++; if (hits[0] === labelCwd) R.nameUniq.ok++; else fails.push({ id: s.id, rule: 'name', got: base2(hits[0]), want: base2(labelCwd) }); }
  else if (hits.length > 1) R.nameMulti++;

  // 规则 2：项目级 BM25 top1 与边际
  const pcs = projectCards(projects);
  const ranked = rankLexical(s.text, pcs);
  if (ranked.length) {
    R.lexTop1.n++; if (ranked[0].cwd === labelCwd) R.lexTop1.ok++;
    // 边际：用 v2 的 rankLexical 没暴露分数，这里重算一遍简单 BM25 取分数
    const scores = bm25Scores(s.text, pcs);
    const sorted = [...scores].sort((a, b) => b.s - a.s);
    if (sorted[0] && sorted[0].s > 0) {
      const ratio = sorted[1] && sorted[1].s > 0 ? sorted[0].s / sorted[1].s : Infinity;
      for (const th of TH) if (ratio >= th) { R.margin[th].n++; if (sorted[0].c.cwd === labelCwd) R.margin[th].ok++; }
    }
  }
  // 规则 3：最近活跃项目
  const recent = [...projects.values()].sort((a, b) => b[0].updatedAt.localeCompare(a[0].updatedAt))[0];
  if (recent) { R.recencyTop1.n++; if (recent[0].cwd === labelCwd) R.recencyTop1.ok++; }

  // 项目内：续接样本的目标是否就是该项目里最近的会话 / 项目里是否只有一个会话
  if (s.kind === 'continue' && inPool) {
    const cs = projects.get(labelCwd);
    R.cont.n++; R.cont.projSize.push(cs.length);
    if (cardId(cs[0]) === labelOf(s)) R.cont.latestInProj++;
    if (cs.length === 1) R.cont.uniqueInProj++;
  }
}

function bm25Scores(query, cards) {
  const qs = [...new Set(tokens(query))];
  const W = { title: 3, first: 2, recent: 2, reply: 1, cwd: 2 };
  const docs = cards.map((c) => {
    const f = { title: c.title ?? '', first: c.firstPrompt ?? '', recent: c.recentPrompts.join('\n'), reply: c.lastReply ?? '', cwd: base2(c.cwd) };
    const tf = new Map(); let len = 0;
    for (const [k, v] of Object.entries(f)) for (const tk of tokens(v)) { tf.set(tk, (tf.get(tk) ?? 0) + W[k]); len += W[k]; }
    return { tf, len };
  });
  const avg = docs.reduce((a, d) => a + d.len, 0) / Math.max(1, docs.length) || 1;
  const df = new Map(); for (const d of docs) for (const t of qs) if (d.tf.has(t)) df.set(t, (df.get(t) ?? 0) + 1);
  const N = docs.length, k1 = 1.2, b = 0.5;
  return cards.map((c, i) => { let s = 0; for (const t of qs) { const f = docs[i].tf.get(t); if (!f) continue; const n = df.get(t) ?? 0; s += Math.log(1 + (N - n + 0.5) / (n + 0.5)) * (f * (k1 + 1)) / (f + k1 * (1 - b + (b * docs[i].len) / avg)); } return { c, s }; });
}

const pct = (a, b) => (b ? `${a}/${b} = ${(100 * a / b).toFixed(1)}%` : '—');
const med = (xs) => { const a = [...xs].sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : null; };
console.log(`set=${SET} n=${R.n}`);
console.log(`标签项目在候选池里: ${pct(R.labelProjectInPool, R.n)}  （新建样本里全新项目: ${pct(R.newProj.brandNew, R.newProj.n)}）`);
console.log(`规则1 项目名唯一命中: 覆盖 ${pct(R.nameUniq.n, R.n)}, 命中后正确 ${pct(R.nameUniq.ok, R.nameUniq.n)}; 多项目同时命中 ${R.nameMulti}`);
console.log(`规则2 项目级 BM25 top1 正确: ${pct(R.lexTop1.ok, R.lexTop1.n)}`);
for (const th of TH) console.log(`   边际≥${th}: 覆盖 ${pct(R.margin[th].n, R.n)}, 正确 ${pct(R.margin[th].ok, R.margin[th].n)}`);
console.log(`规则3 最近活跃项目即正确: ${pct(R.recencyTop1.ok, R.recencyTop1.n)}`);
console.log(`续接样本（项目已定）: 目标=项目内最近会话 ${pct(R.cont.latestInProj, R.cont.n)}; 项目内仅一个会话 ${pct(R.cont.uniqueInProj, R.cont.n)}; 项目内会话数中位 ${med(R.cont.projSize)}`);
console.log(`规则1 失败样例（仅目录名）: ${JSON.stringify(fails.slice(0, 8))}`);
