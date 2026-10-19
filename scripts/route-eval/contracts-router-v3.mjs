// Router v3（项目优先）离线契约：全部合成夹具，注入假模型响应，不联网、不碰 iTerm。
// node scripts/route-eval/contracts-router-v3.mjs
import { createRouterV3, groupProjects, labelProjects, parseOutputV3, buildMessagesV3, pickInProject, fastPath, DEFAULT_POLICY_V3 } from '../../src/layers/router/v3.ts';

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { if (ok) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name} ${detail}`); } };

const T0 = Date.parse('2026-09-01T12:00:00Z');
const iso = (min) => new Date(T0 - min * 60000).toISOString();
// 三个项目：projA 两个会话（最近 10 分钟 / 3 天前），projB 一个会话（2 小时前），projC 一个会话（5 天前）
const card = (sid, cwd, minAgo, o = {}) => ({ provider: 'claude', sessionId: sid, cwd, title: `任务 ${sid}`, firstPrompt: `FIRST-${sid} 首句`, recentPrompts: [`r-${sid}-a`, `r-${sid}-b`], lastReply: `REPLY-${sid}`, startedAt: iso(minAgo + 500), updatedAt: iso(minAgo), turns: 4, ...o });
const A = '/Users/fixture/code/projA', B = '/Users/fixture/code/projB', C = '/Users/fixture/code/projC';
const cards = [card('a1', A, 10), card('a2', A, 3 * 24 * 60, { provider: 'codex' }), card('b1', B, 120), card('c1', C, 5 * 24 * 60)];
const ctx = (extra = {}) => ({ cards, live: [], previous: null, focusedSessionId: null, ...extra });
const labelOfCwd = (messages, cwd) => { const u = messages[1].content; const i = u.indexOf(cwd.split('/').slice(-2).join('/')); const h = u.lastIndexOf('[P', i); return u.slice(h + 1, u.indexOf(']', h)); };
const pick = (cwd, conf, top = []) => async (req) => { const l = (x) => (x === 'NEW_PROJECT' ? x : labelOfCwd(req.messages, x)); return { text: JSON.stringify({ choice: l(cwd), confidence: conf, top3: [l(cwd), ...top.map(l)] }), costUsd: 0.01 }; };
const router = (complete, policy = {}) => createRouterV3({ complete, now: () => T0, policy });
const Q = '把导出报表的接口改成分页返回';

// ---- 分组与提示词 ----
{
  const ps = groupProjects(cards);
  check('项目按最近活跃降序，项目内会话也按最近在前', ps.map((p) => p.cwd).join() === [A, B, C].join() && ps[0].sessions[0].sessionId === 'a1');
  const lab = labelProjects(ps, 2);
  check('maxProjects 截断', lab.length === 2 && lab[1].project.cwd === B);
  const msgs = buildMessagesV3(Q, labelProjects(ps, 40), ctx({ live: [{ provider: 'claude', sessionId: 'b1', pid: 1, tty: '/dev/ttys001', state: 'idle' }], focusedSessionId: 'b1' }), T0);
  check('提示词标出 focused 项目，含项目目录名与会话首句', /projB[^\n]*focused/.test(msgs[1].content) && msgs[1].content.includes('FIRST-a1'));
  check('提示词凭证清洗', !buildMessagesV3('token=zzz999', labelProjects(ps, 40), ctx(), T0)[1].content.includes('zzz999'));
}
// ---- 解析 ----
{
  const lab = labelProjects(groupProjects(cards), 40);
  check('解析：P2 → projB', parseOutputV3('{"choice":"P2","confidence":0.9,"top3":["P2","NEW_PROJECT"]}', lab).choice === B);
  check('解析：NEW_PROJECT', parseOutputV3('{"choice":"new_project","confidence":0.9}', lab).choice === 'NEW_PROJECT');
  check('解析：未知标签无效', !parseOutputV3('{"choice":"P9","confidence":0.9}', lab).ok);
  check('解析：垃圾无效', !parseOutputV3('第二个吧', lab).ok);
}
// ---- 项目内选会话 ----
{
  const [pa, pb, pc] = groupProjects(cards);
  check('项目内最近会话 ≤24h → 续接它', pickInProject(pa, ctx(), T0, 24).sessionId === 'a1');
  check('项目内最近会话 >24h → 在项目目录新建，provider 沿用', (() => { const r = pickInProject(pc, ctx(), T0, 24); return r.kind === 'new' && r.cwd === C && r.provider === 'claude'; })());
  const live1 = [{ provider: 'codex', sessionId: 'a2', pid: 1, tty: '/dev/ttys002', state: 'idle' }];
  check('项目里恰有一个开着的会话 → 写进它（即使不是最近的）', (() => { const r = pickInProject(pa, ctx({ live: live1 }), T0, 24); return r.kind === 'continue' && r.sessionId === 'a2' && r.why === 'open'; })());
  const live2 = [...live1, { provider: 'claude', sessionId: 'a1', pid: 2, tty: '/dev/ttys003', state: 'idle' }];
  check('多个开着且无前台 → ambiguous', pickInProject(pa, ctx({ live: live2 }), T0, 24).kind === 'ambiguous');
  check('多个开着、正看着其一 → 续接它', pickInProject(pa, ctx({ live: live2, focusedSessionId: 'a2' }), T0, 24).sessionId === 'a2');
  check('后台进程（无 tty）不算开着', pickInProject(pb, ctx({ live: [{ provider: 'claude', sessionId: 'b1', pid: 3, tty: null, state: 'idle' }] }), T0, 24).why === 'recent');
}
// ---- 快路径 ----
{
  const live = [{ provider: 'claude', sessionId: 'b1', pid: 1, tty: '/dev/ttys001', state: 'idle' }];
  check('有内容的句子不走快路径', fastPath(Q, ctx({ live, focusedSessionId: 'b1' }), DEFAULT_POLICY_V3) === null);
  const f1 = fastPath('继续', ctx({ previous: { utterance: '上一句', provider: 'claude', sessionId: 'c1', minutesAgo: 2 }, live, focusedSessionId: 'b1' }), DEFAULT_POLICY_V3);
  check('短句 + 5 分钟内刚发过 → 续上一句去处（优先于前台）', f1.decision.kind === 'continue' && f1.decision.sessionId === 'c1');
  const f2 = fastPath('继续', ctx({ previous: { utterance: '上一句', provider: 'claude', sessionId: 'c1', minutesAgo: 30 }, live, focusedSessionId: 'b1' }), DEFAULT_POLICY_V3);
  check('短句 + 上一句太久 + 正看着 b1 → 续 b1', f2.decision.kind === 'continue' && f2.decision.sessionId === 'b1');
  const f3 = fastPath('好的', ctx({ live }), DEFAULT_POLICY_V3);
  check('短句无语境 → 不自动，开着的会话排第一', f3.decision.kind === 'clarify' && f3.decision.options[0].sessionId === 'b1' && f3.decision.options.length === 3);
}
// ---- 路由 ----
{
  let calls = 0;
  const r = await router(async (req) => { calls++; return pick(B, 0.95, [A])(req); }).route(Q, ctx());
  check('高置信选 projB → 自动续接 b1（≤24h）', r.kind === 'continue' && r.sessionId === 'b1' && r.auto && r.via === 'model' && r.project === B && calls === 1);
  check('ranked 首项即去处，带置信度；含 3 项', r.ranked[0].kind === 'session' && r.ranked[0].sessionId === 'b1' && r.ranked[0].probability === 0.95 && r.ranked.length === 3);
}
{
  const r = await router(pick(C, 0.95, [A])).route(Q, ctx());
  check('高置信选 projC（最近会话 >24h）→ 自动在 projC 新建', r.kind === 'new' && r.cwd === C && r.auto);
  const r2 = await router(pick('NEW_PROJECT', 0.95, [A])).route('调研一下家里 NAS 的备份方案', ctx());
  check('NEW_PROJECT 高置信 → 新建，cwd 为 null，provider 沿用最近项目', r2.kind === 'new' && r2.cwd === null && r2.provider === 'claude' && r2.auto);
}
{
  const r = await router(pick(B, 0.6, [A, C])).route(Q, ctx());
  check('低置信 → clarify，预选仍是首选 b1，ranked 含 top3 映射', r.kind === 'clarify' && !r.auto && r.options[0].sessionId === 'b1' && r.ranked.length === 3 && r.ranked[1].sessionId === 'a1' && r.ranked[2].kind === 'new' && r.ranked[2].cwd === C);
  const r2 = await router(pick(B, 0.95)).route(Q, ctx({ live: [{ provider: 'claude', sessionId: 'b1', pid: 1, tty: '/dev/ttys001', state: 'idle' }] }));
  check('选中项目里恰有一个开着的会话 → 续接它', r2.kind === 'continue' && r2.sessionId === 'b1' && r2.reason.includes('终端'));
  const live2 = [{ provider: 'claude', sessionId: 'a1', pid: 1, tty: '/dev/ttys001', state: 'idle' }, { provider: 'codex', sessionId: 'a2', pid: 2, tty: '/dev/ttys002', state: 'idle' }];
  const r3 = await router(pick(A, 0.95)).route(Q, ctx({ live: live2 }));
  check('选中项目里开着多个且无前台 → 不自动', r3.kind === 'clarify' && !r3.auto && r3.holdReason.includes('同时开着'));
}
{
  const r = await router(async () => ({ text: '', costUsd: null, error: 'TimeoutError' })).route(Q, ctx());
  check('超时 → 不自动，仍给最近项目的去处', r.kind === 'clarify' && !r.auto && r.ranked[0].sessionId === 'a1');
  const r2 = await router(async () => { throw new Error('boom'); }).route(Q, ctx());
  check('抛错 → 不自动', r2.kind === 'clarify' && !r2.auto);
  const r3 = await router(async () => ({ text: '{"choice":"P99","confidence":0.99}', costUsd: 0 })).route(Q, ctx());
  check('选了不存在的项目 → 不自动', r3.kind === 'clarify' && !r3.auto);
  const r4 = await router(pick(B, 0.95)).route(Q, ctx({ cards: [] }));
  check('没有任何会话 → 不崩溃、不续接', r4.kind !== 'continue');
  let called = false;
  const r5 = await router(async () => { called = true; return pick(B, 0.95)(); }).route('继续', ctx({ focusedSessionId: 'b1', live: [{ provider: 'claude', sessionId: 'b1', pid: 1, tty: '/dev/ttys001', state: 'idle' }] }));
  check('短句走快路径，不调模型', r5.via === 'fast' && r5.kind === 'continue' && r5.sessionId === 'b1' && !called);
  const r7 = await createRouterV3({ complete: pick(B, 0.9), env: { NTR_ROUTER_MIN_CONFIDENCE: '0.95' }, now: () => T0 }).route(Q, ctx());
  check('NTR_ROUTER_MIN_CONFIDENCE 提高阈值后 0.9 不再自动', r7.kind === 'clarify' && !r7.auto);
  const r6 = await createRouterV3({ env: { NTR_ROUTER_BACKEND: 'openrouter' }, now: () => T0 }).route(Q, ctx());
  check('OpenRouter 后端缺 key → 不自动（不联网）', r6.kind === 'clarify' && !r6.auto);
}

console.log(`\n${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
