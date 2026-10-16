// 数据集构造（TE-3）：纯函数，可用合成夹具做契约测试。
// groupLogical：resume/fork 复制旧历史的多个文件 → 同一逻辑会话；buildSamples：续接/新建标注、切分、难例标签。

const ACTIVE_DAYS = 14;
const SHORT_RE = /^(继续|继续吧|接着|然后|再看看|再看看吧|改一下|改改|可以|可以的|好的?|行|嗯|ok|okay|go|continue|yes|y|对|是的|咋样了|怎么样了|进展如何|完成了吗|然后呢|再来|重试|试试|开始|开始吧|修一下|看看)[\s。!！?？.,，]*$/i;

export function groupLogical(kept) {
  const parent = new Map();
  const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  const union = (a, b) => { a = find(a); b = find(b); if (a !== b) parent.set(a, b); };
  kept.forEach((s) => parent.set(s.file, s.file));
  const ownerOf = new Map();
  for (const s of kept) for (const i of s.inputs) {
    const k = `${s.provider}|${i.id}`;
    if (ownerOf.has(k)) union(ownerOf.get(k), s.file); else ownerOf.set(k, s.file);
  }
  const groups = new Map();
  for (const s of kept) { const r = find(s.file); (groups.get(r) ?? groups.set(r, []).get(r)).push(s); }
  const logical = [];
  let mergedGroups = 0;
  for (const members of groups.values()) {
    members.sort((a, b) => (a.firstT ?? 0) - (b.firstT ?? 0));
    if (members.length > 1) mergedGroups++;
    const canon = members[0];
    const seen = new Set();
    const inputs = [];
    for (const m of members) {
      let first = true; // 非主文件里第一条新增输入 = resume/fork 后第一条输入
      for (const i of m.inputs) {
        if (seen.has(i.id)) continue;
        seen.add(i.id);
        inputs.push({ ...i, viaResumeCopy: m !== canon && first });
        first = false;
      }
    }
    inputs.sort((a, b) => a.t - b.t);
    const rseen = new Set();
    const replies = [];
    for (const m of members) for (const r of m.replies) { const k = `${r.t}|${r.text.length}`; if (!rseen.has(k)) { rseen.add(k); replies.push(r); } }
    replies.sort((a, b) => a.t - b.t);
    if (inputs.length === 0) continue;
    logical.push({
      key: `${canon.provider}:${canon.sessionId}`, provider: canon.provider, sessionId: canon.sessionId,
      files: members.map((m) => m.file), cwd: canon.cwd, originator: canon.originator ?? null,
      firstInputT: inputs[0].t, inputs, replies, titles: members.flatMap((m) => m.titles),
    });
  }
  logical.sort((a, b) => a.firstInputT - b.firstInputT);
  return { logical, mergedGroups };
}

const lowerBound = (arr, x) => { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m].t < x) lo = m + 1; else hi = m; } return lo; };
const updatedAsOf = (L, t) => {
  const i = lowerBound(L.inputs, t) - 1; if (i < 0) return null;
  const j = lowerBound(L.replies, t) - 1;
  return Math.max(L.inputs[i].t, j >= 0 ? L.replies[j].t : 0);
};

export function buildSamples(logical, { gapMin = 30, heldoutFrac = 0.4, splitBy = 'global' } = {}) {
  const raw = [];
  for (const L of logical) {
    L.inputs.forEach((inp, idx) => {
      const base = { text: inp.text, t: new Date(inp.t).toISOString(), tMs: inp.t, provider: L.provider, cwd: L.cwd, turnIdx: idx, sessionKey: L.key, gapMin: inp.gapMs == null ? null : Math.round(inp.gapMs / 60000) };
      if (idx === 0) raw.push({ ...base, kind: 'new', label: 'NEW' });
      else if (inp.viaResumeCopy || (inp.gapMs != null && inp.gapMs >= gapMin * 60000)) {
        raw.push({ ...base, kind: 'continue', label: { provider: L.provider, sessionId: L.sessionId }, reason: inp.viaResumeCopy ? 'resume-copy' : 'gap' });
      }
    });
  }
  raw.sort((a, b) => a.tMs - b.tMs);
  const sens = {};
  for (const g of [10, 15, 30, 60, 120]) {
    sens[g] = logical.reduce((n, L) => n + L.inputs.filter((inp, idx) => idx > 0 && (inp.viaResumeCopy || (inp.gapMs != null && inp.gapMs >= g * 60000))).length, 0);
  }
  const conts = raw.filter((s) => s.kind === 'continue');
  const cutIdx = Math.floor(conts.length * (1 - heldoutFrac));
  let cutoffMs = conts[cutIdx]?.tMs ?? Infinity;
  // v2：按 provider 分层的时间切分——每个 provider 内按时间排序，早的进 dev，其余进 held-out，避免工具习惯被切开
  const cutoffByProvider = {};
  if (splitBy === 'provider') {
    for (const p of new Set(raw.map((s) => s.provider))) {
      const c = conts.filter((s) => s.provider === p);
      cutoffByProvider[p] = c[Math.floor(c.length * (1 - heldoutFrac))]?.tMs ?? Infinity;
    }
    raw.forEach((s) => { s.split = s.tMs >= cutoffByProvider[s.provider] ? 'heldout' : 'dev'; });
    cutoffMs = Math.min(...Object.values(cutoffByProvider));
  } else {
    raw.forEach((s) => { s.split = s.tMs >= cutoffMs ? 'heldout' : 'dev'; });
  }
  // 敏感性（留出期内）：不同间隔阈值下，该时间窗里的续接样本数
  const sensHeld = {};
  for (const g of [10, 15, 30, 60, 120]) {
    sensHeld[g] = logical.reduce((n, L) => n + L.inputs.filter((inp, idx) => idx > 0 && inp.t >= cutoffMs && (inp.viaResumeCopy || (inp.gapMs != null && inp.gapMs >= g * 60000))).length, 0);
  }

  // 同一句话（≥4 字）此前在别的会话里出现过：模型凭字面相似可能被"相同旧输入"吸引，标签本身也更软
  const norm = (x) => x.replace(/\s+/g, ' ').trim();
  const seenText = new Map();
  for (const L of logical) for (const i of L.inputs) {
    const k = norm(i.text);
    if ([...k].length < 4) continue;
    (seenText.get(k) ?? seenText.set(k, []).get(k)).push({ t: i.t, key: L.key });
  }
  for (const s of raw) {
    const tags = [];
    const selfKeyForRepeat = s.kind === 'continue' ? `${s.label.provider}:${s.label.sessionId}` : null;
    const prior = seenText.get(norm(s.text))?.some((e) => e.t < s.tMs && e.key !== selfKeyForRepeat);
    if (prior) tags.push('exact-repeat-of-earlier');
    const compact = s.text.replace(/\s+/g, '');
    const short = compact.length <= 8 || SHORT_RE.test(s.text.trim());
    const active = logical.filter((L) => L.firstInputT < s.tMs && L.cwd && (() => { const u = updatedAsOf(L, s.tMs); return u !== null && s.tMs - u <= ACTIVE_DAYS * 86400000; })());
    if (s.kind === 'continue') {
      const selfKey = `${s.label.provider}:${s.label.sessionId}`;
      if (short) tags.push('short-followup');
      const target = logical.find((L) => L.key === selfKey);
      const sameProject = active.filter((L) => L.key !== selfKey && L.cwd === target.cwd);
      if (sameProject.length) tags.push('same-project-multi');
      if (sameProject.some((L) => L.provider !== target.provider)) tags.push('cross-tool-same-project');
    } else {
      if (active.some((L) => L.cwd === s.cwd)) tags.push('new-in-existing-project');
      if (short) tags.push('short-new');
    }
    s.tags = tags;
    s.poolSize = logical.filter((L) => L.firstInputT < s.tMs).length;
  }
  raw.forEach((s, i) => { s.id = `${s.split[0]}${String(i).padStart(5, '0')}-${s.kind[0]}`; delete s.tMs; });
  return { samples: raw, cutoffMs, cutoffByProvider, sens, sensHeld, conts };
}

/**
 * "上一句"语境信号（v2）：查询前 windowMin 分钟内，用户在任意会话里最近一条人工输入。
 * allInputs 按时间升序 [{t, text, provider, sessionId}]；严格早于查询时刻。存活/前台会话历史里拿不到，不在此伪造。
 */
export function attachPrev(samples, allInputs, windowMin = 60) {
  let n = 0;
  for (const s of samples) {
    const t = Date.parse(s.t);
    let lo = 0, hi = allInputs.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (allInputs[m].t < t) lo = m + 1; else hi = m; }
    const p = allInputs[lo - 1];
    if (p && t - p.t <= windowMin * 60000) {
      s.prev = { utterance: p.text.slice(0, 300), provider: p.provider, sessionId: p.sessionId, minutesAgo: Math.round(((t - p.t) / 60000) * 10) / 10 };
      n++;
    } else s.prev = null;
    s.prevSameAsTarget = !!(s.prev && s.kind === 'continue' && s.prev.provider === s.label.provider && s.prev.sessionId === s.label.sessionId);
  }
  return n;
}
