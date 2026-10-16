// Router v2 离线契约（TE-4b）：全部合成夹具，注入假模型响应，不联网。
// node --experimental-strip-types scripts/route-eval/contracts-router-v2.mjs
import { createRouterV2, redact, selectCandidates, parseOutput, labelCards, gate, buildMessages, openRouterComplete, DEFAULT_POLICY, contentFree, claudeCliComplete, signalsOf, cleanReply, noiseTitle } from '../../src/layers/router/v2.ts';

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { if (ok) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name} ${detail}`); } };

const T0 = Date.parse('2026-09-01T12:00:00Z');
const iso = (min) => new Date(T0 - min * 60000).toISOString();
const card = (i, o = {}) => ({ provider: i % 2 ? 'codex' : 'claude', sessionId: `sid-${i}`, cwd: `/Users/fixture/proj${i % 3}`, title: `任务${i} 标题`, firstPrompt: `FIRST-${i} 首句`, recentPrompts: [`r${i}a`, `r${i}b`], lastReply: `REPLY-${i}`, startedAt: iso(1000 + i), updatedAt: iso(i * 10), turns: 3 + i, ...o });
const cards = Array.from({ length: 6 }, (_, i) => card(i + 1)); // sid-1 最近 … sid-6 最旧
const ctx = (extra = {}) => ({ cards, live: [], ...extra });
const idOf = (c) => `${c.provider}:${c.sessionId}`;
// 假模型：按 labelCards 的标签把"选 S<k>"翻译成 sid；这里直接读取提示词里的卡片行来找标签
const labelOfSid = (messages, sid) => {
  const user = messages[1].content; const i = user.indexOf(`FIRST-${sid.split('-')[1]}`);
  const head = user.lastIndexOf('[S', i); return user.slice(head + 1, user.indexOf(']', head));
};
const reply = (json) => async () => ({ text: JSON.stringify(json), costUsd: 0.01 });
const pick = (sid, conf, top = []) => async (req) => { const l = sid === 'NEW' ? 'NEW' : labelOfSid(req.messages, sid); return { text: JSON.stringify({ choice: l, confidence: conf, top3: [l, ...top.map((t) => (t === 'NEW' ? 'NEW' : labelOfSid(req.messages, t)))] }), costUsd: 0.01 }; };
const router = (complete, policy = {}, env) => createRouterV2({ complete, now: () => T0, policy: { ...policy }, env });
const two = { models: [{ model: 'm-a', order: 'recent-first' }, { model: 'm-b', order: 'recent-last' }] };

// ---- 凭证清洗 ----
const secrets = ['sk-abcdefgh12345678', 'ghp_abcdefghijklmnop1234', 'AKIAABCDEFGHIJKLMNOP', 'xoxb-1234567890-abcdef', 'password=hunter2', 'token: abc123', 'Bearer abcdefghijklmnop1234', 'aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bC1dE3fG5'];
for (const s of secrets) check(`redact: ${s.slice(0, 8)}…`, !redact(`前 ${s} 后`).includes(s.split(/[=: ]/).pop()) || redact(`前 ${s} 后`).includes('[REDACTED]'));
check('redact 不误伤路径与普通句子', redact('/Users/a/.openclaw/workspace/xiaohongshu/2026-3-11/OpenClaw橙皮书.pdf 帮我看下') === '/Users/a/.openclaw/workspace/xiaohongshu/2026-3-11/OpenClaw橙皮书.pdf 帮我看下');
{
  const dirty = cards.map((c) => ({ ...c, lastReply: 'key sk-LEAKLEAK12345678 end', firstPrompt: 'password=hunter2' }));
  const msgs = buildMessages('ghp_LEAKLEAKLEAKLEAKLEAK', labelCards(dirty, 'recent-first'), { utterance: 'token=zzz999', provider: 'claude', sessionId: 'sid-1', minutesAgo: 1 }, T0);
  const all = JSON.stringify(msgs);
  check('提示词中卡片/上一句/正文的凭证都被清洗', !/LEAKLEAK|hunter2|zzz999/.test(all));
}

// ---- 召回 ----
{
  const many = Array.from({ length: 80 }, (_, i) => card(i + 1, { title: i === 70 ? '独特关键词火星基地' : `普通${i}`, firstPrompt: i === 70 ? '火星基地方案' : `首句${i}` }));
  const cand = selectCandidates('火星基地进展', { cards: many, live: [] }, 20, 20);
  check('召回：最近 20 ∪ 词面命中，词面命中的老卡片在内', cand.some((c) => c.sessionId === 'sid-71') && cand.length <= 40);
  const withPrev = selectCandidates('随便', { cards: many, live: [], previous: { utterance: 'x', provider: many[60].provider, sessionId: many[60].sessionId, minutesAgo: 1 } }, 5, 5);
  check('召回：上一句去处必在候选', withPrev.some((c) => c.sessionId === many[60].sessionId));
  check('召回：按最近活跃降序', cand.every((c, i) => i === 0 || cand[i - 1].updatedAt >= c.updatedAt));
}

// ---- 解析 / 闸门 ----
{
  const lab = labelCards(cards, 'recent-first');
  check('解析：合法', parseOutput('{"choice":"S2","confidence":0.9,"top3":["S2","NEW","S9"]}', lab).choice === idOf(lab[1].card));
  check('解析：非法 id 首选无效', !parseOutput('{"choice":"S99","confidence":0.99,"top3":[]}', lab).ok);
  check('解析：垃圾文本无效', !parseOutput('我觉得是第二个', lab).ok);
  check('解析：置信度越界视为缺失', parseOutput('{"choice":"S1","confidence":1.7}', lab).confidence === null);
  const ok = { ok: true, choice: 'a', confidence: 0.95, top3: [] };
  const Q = '把任务3里那个导出报表的接口改成分页返回';
  check('闸门：全满足才自动', gate([ok, ok], { minConfidence: 0.9 }, Q).auto);
  check('闸门：阈值不足', !gate([{ ...ok, confidence: 0.85 }], { minConfidence: 0.9 }, Q).auto);
  check('闸门：缺置信度', !gate([{ ...ok, confidence: null }], { minConfidence: 0.9 }, Q).auto);
  check('闸门：首选不一致', !gate([ok, { ...ok, choice: 'b' }], { minConfidence: 0.9 }, Q).auto);
  check('闸门：任一失败', !gate([ok, null], { minConfidence: 0.9 }, Q).auto);
  check('闸门：无模型', !gate([], { minConfidence: 0.9 }, Q).auto);
}

// ---- 路由 ----
const Q = '把任务3里那个导出报表的接口改成分页返回';
const QN = '帮我调研一下家里 NAS 的备份方案和价格对比';
{
  const r = await router(pick('sid-3', 0.97, ['sid-1', 'NEW'])).route(Q, ctx());
  check('高置信 → 自动续接目标会话', r.kind === 'continue' && r.sessionId === 'sid-3' && r.auto === true && r.holdReason === null);
  check('无论自动与否都有 3 个 ranked，首个是首选', r.ranked.length === 3 && r.ranked[0].kind === 'session' && r.ranked[0].sessionId === 'sid-3');
  check('费用与模型被记录', r.costUsd === 0.01 && r.model === DEFAULT_POLICY.models[0].model && typeof r.latencyMs === 'number');
}
{
  const r = await router(pick('sid-3', 0.6, ['sid-1', 'sid-2'])).route(Q, ctx());
  check('低置信 → 不自动，clarify，预选仍是首选', r.kind === 'clarify' && !r.auto && r.options[0].sessionId === 'sid-3' && r.ranked.length === 3);
}
{
  const r = await router(pick('NEW', 0.97, ['sid-1'])).route(QN, ctx());
  check('NEW 高置信 → 自动新建，cwd 无可靠依据为 null', r.kind === 'new' && r.auto && r.cwd === null && r.ranked[0].kind === 'new');
  const r2 = await router(pick('NEW', 0.97, ['sid-1'])).route(QN, ctx({ previous: { utterance: '上一句', provider: cards[0].provider, sessionId: 'sid-1', minutesAgo: 2 } }));
  check('NEW 且上一句刚去过且模型认为相关 → 沿用其项目与 provider', r2.kind === 'new' && r2.cwd === cards[0].cwd && r2.provider === cards[0].provider);
  const r3 = await router(pick('NEW', 0.97, [])).route(QN, ctx({ previous: { utterance: '上一句', provider: cards[0].provider, sessionId: 'sid-1', minutesAgo: 2 } }));
  check('NEW 但模型未把上一句去处列入前三 → cwd 仍为 null', r3.kind === 'new' && r3.cwd === null);
  const r4 = await router(pick('NEW', 0.5)).route(Q, ctx());
  check('NEW 低置信 → 不自动', r4.kind === 'clarify' && !r4.auto && r4.ranked.some((o) => o.kind === 'new'));
}
{
  const r = await router(async () => new Promise((res) => setTimeout(() => res({ text: '', costUsd: null, error: 'TimeoutError' }), 5))).route(Q, ctx());
  check('超时/错误 → 不自动，仍给最近活跃的前 3', r.kind === 'clarify' && !r.auto && r.ranked.length === 3 && r.ranked[0].sessionId === 'sid-1');
  const r2 = await router(async () => { throw new Error('boom'); }).route(Q, ctx());
  check('调用抛错 → 不自动', r2.kind === 'clarify' && !r2.auto);
  const r3 = await router(reply({ choice: 'S99', confidence: 0.99, top3: ['S99'] })).route(Q, ctx());
  check('选了不存在的 id → 不自动', r3.kind === 'clarify' && !r3.auto);
  const r4 = await router(async () => ({ text: '乱码', costUsd: 0.01 })).route(Q, ctx());
  check('输出无法解析 → 不自动', r4.kind === 'clarify' && !r4.auto);
  const r5 = await createRouterV2({ env: { JEV_ROUTER_BACKEND: 'openrouter' }, now: () => T0 }).route(Q, ctx());
  check('OpenRouter 后端缺 key → 不自动（不联网）', r5.kind === 'clarify' && !r5.auto);
  const r6 = await router(pick('sid-2', 0.97), {}).route(Q, ctx({ cards: [] }));
  check('没有任何会话 → 不崩溃、不自动续接', r6.kind !== 'continue');
}
{
  const calls = [];
  const complete = async (req) => { calls.push(req); return pick('sid-2', 0.95, ['sid-1'])(req); };
  const r = await router(complete, two).route(Q, ctx());
  check('双模型：两个顺序相反的调用并行发出', calls.length === 2 && calls[0].messages[1].content.indexOf('FIRST-1') < calls[0].messages[1].content.indexOf('FIRST-6') && calls[1].messages[1].content.indexOf('FIRST-1') > calls[1].messages[1].content.indexOf('FIRST-6'));
  check('双模型：一致且高置信 → 自动，费用累加', r.auto && r.costUsd === 0.02);
  let n = 0;
  const r2 = await router(async (req) => (n++ ? pick('sid-4', 0.95)(req) : pick('sid-2', 0.95)(req)), two).route(Q, ctx());
  check('双模型：首选不一致 → 不自动', !r2.auto && r2.kind === 'clarify');
  let m = 0;
  const r3 = await router(async (req) => (m++ ? { text: '', costUsd: null, error: 'x' } : pick('sid-2', 0.99)(req)), two).route(Q, ctx());
  check('双模型：一个失败 → 不自动', !r3.auto);
}
{
  let body = null;
  const orig = globalThis.fetch;
  globalThis.fetch = async (_u, init) => { body = JSON.parse(init.body); return new Response(JSON.stringify({ choices: [{ message: { content: '{}' } }], usage: { cost: 0.002 } }), { status: 200 }); };
  const res = await openRouterComplete({ openrouter_api_key: 'k' })({ model: 'm', messages: [], maxTokens: 10, timeoutMs: 1000 });
  globalThis.fetch = orig;
  check('OpenRouter 请求带 data_collection=deny 且读到费用', body.provider.data_collection === 'deny' && res.costUsd === 0.002);
}

// ---- 无内容短句 / 本机 claude 后端 ----
{
  for (const t of ['继续', '好，开始吧。', '继续，做完为止。', 'ok', '改一下', '再试一次！']) check(`无内容短句：${t}`, contentFree(t));
  for (const t of [Q, QN, '/tmp/demo/notes.txt 继续排查导出报表为空的问题']) check(`有内容：${t.slice(0, 12)}`, !contentFree(t));
  const r = await router(pick('sid-3', 0.99, ['sid-1'])).route('继续。', ctx());
  check('短句即使模型高置信 → 不自动，但首选仍预选', r.kind === 'clarify' && !r.auto && r.options[0].sessionId === 'sid-3' && /太短|具体内容/.test(r.holdReason));
  const bad = await claudeCliComplete('/nonexistent/claude-bin')({ model: 'opus', messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }], maxTokens: 10, timeoutMs: 2000 });
  check('claude 后端起不来 → 返回 error（路由随之不自动）', !!bad.error && bad.text === '');
  const r2 = await createRouterV2({ complete: claudeCliComplete('/nonexistent/claude-bin'), now: () => T0 }).route(Q, ctx());
  check('claude 后端失败 → clarify', r2.kind === 'clarify' && !r2.auto);
}

// ---- v2.1：正看着 / 开着的会话、标题与回复清洗 ----
{
  const many = Array.from({ length: 50 }, (_, i) => card(i + 1)); // 远超召回上限
  const live = [{ provider: 'claude', sessionId: 'sid-48', pid: 1, tty: '/dev/ttys9', state: 'idle' }, { provider: 'codex', sessionId: 'sid-45', pid: 2, tty: '/dev/ttys8', state: 'busy' }, { provider: 'claude', sessionId: 'sid-44', pid: 3, tty: null, state: 'idle' }];
  const c2 = { cards: many, live, focusedSessionId: 'sid-48' };
  const cand = selectCandidates('无关的一句话', c2, 3, 3).map((c) => c.sessionId);
  check('正看着的会话即使很旧也进入候选', cand.includes('sid-48'));
  check('开在终端里的会话进入候选；没有终端的后台进程不算', cand.includes('sid-45') && !cand.includes('sid-44'));
  const sig = signalsOf(c2);
  check('signalsOf：focused 与 open', sig.focused === 'claude:sid-48' && sig.open.has('codex:sid-45') && !sig.open.has('claude:sid-44'));
  const labeled = labelCards(selectCandidates('无关的一句话', c2, 3, 3), 'recent-first');
  const user = buildMessages('无关的一句话', labeled, null, T0, sig)[1].content;
  check('卡片标注 focused / open', /\[S\d+\][^\n]*· focused/.test(user) && /\[S\d+\][^\n]*codex[^\n]*· open/.test(user));
  const plain = buildMessages('无关的一句话', labeled, null, T0)[1].content;
  check('不传信号时不标注', !/· (focused|open)/.test(plain));
  check('噪音标题判定', noiseTitle('jev-45fa21a9') && noiseTitle(null) && !noiseTitle('数据库迁移'));
  const nl = labelCards([card(1, { title: 'jev-45fa21a9', lastReply: '## 结论\n| a | b |\n|---|---|\n| 1 | 2 |\n**重点**：先修 OCR。\n```js\nconsole.log(1)\n```\n然后重跑。' })], 'recent-first');
  const u2 = buildMessages('x', nl, null, T0)[1].content;
  check('噪音标题不进 prompt', !u2.includes('jev-45fa21a9') && !u2.includes('title:'));
  check('回复去掉表格/代码/标题/强调，保留叙述', u2.includes('reply: 结论 重点：先修 OCR。 然后重跑。'), u2);
  check('cleanReply 空值安全', cleanReply(null) === '');
}

// ---- 路由模型可替换（JEV_ROUTER_MODEL） ----
{
  const seen = [];
  const rec = async (req) => { seen.push(req.model); return { text: '', costUsd: null, error: 'x' }; };
  await createRouterV2({ complete: rec, env: { JEV_ROUTER_MODEL: 'sonnet' }, now: () => T0 }).route('把任务3里那个导出报表的接口改成分页返回', ctx());
  check('JEV_ROUTER_MODEL 覆盖 claude -p 的模型别名', seen[0] === 'sonnet');
  await createRouterV2({ complete: rec, env: {}, now: () => T0 }).route('把任务3里那个导出报表的接口改成分页返回', ctx());
  check('不设时默认 opus', seen[1] === 'opus');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
