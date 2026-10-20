// Router v3.1（项目 → 线程）离线契约：全部合成夹具，注入假模型响应，不联网、不碰终端。
// node scripts/route-eval/contracts-router-v3.mjs
import { createRouterV3, groupProjects, labelProjects, parseOutputV3, buildMessagesV3, fastPath, namedProvider, threadStatus, DEFAULT_POLICY_V3, ROUTER_V3_VERSION } from '../../src/layers/router/v3.ts';

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { if (ok) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name} ${detail}`); } };

const T0 = Date.parse('2026-09-01T12:00:00Z');
const iso = (min) => new Date(T0 - min * 60000).toISOString();
const DAY = 24 * 60;
// projA：三条线程（a1 10 分钟前在改导出接口；a2 3 天前 codex 在写登录页；a3 20 天前），projB 一条（2 小时前），projC 一条（30 天前）
const card = (sid, cwd, minAgo, o = {}) => ({ provider: 'claude', sessionId: sid, cwd, title: `任务 ${sid}`, firstPrompt: `FIRST-${sid} 首句`, recentPrompts: [`r-${sid}-a`, `r-${sid}-b`], lastReply: `REPLY-${sid}`, startedAt: iso(minAgo + 500), updatedAt: iso(minAgo), turns: 4, ...o });
const A = '/Users/fixture/code/projA', B = '/Users/fixture/code/projB', C = '/Users/fixture/code/projC';
const cards = [
  card('a1', A, 10, { firstPrompt: 'FIRST-a1 把导出报表的接口改成分页返回' }),
  card('a2', A, 3 * DAY, { provider: 'codex', firstPrompt: 'FIRST-a2 登录页加上验证码' }),
  card('a3', A, 20 * DAY),
  card('b1', B, 120),
  card('c1', C, 30 * DAY, { provider: 'codex' }),
];
const ctx = (extra = {}) => ({ cards, live: [], previous: null, focusedSessionId: null, ...extra });
const tty = (sid, provider = 'claude', state = 'idle', n = 1) => ({ provider, sessionId: sid, pid: n, tty: `/dev/ttys00${n}`, state });

// 假模型：按目录名和 FIRST-<sid> 在提示词里找回标签，返回指定的项目 + 线程
const labels = (u, cwd, sid) => {
  const name = cwd.split('/').slice(-2).join('/');
  const at = u.indexOf(`] · ${name} ·`);
  const p = u.slice(u.lastIndexOf('[P', at) + 1, at);
  if (sid === 'NEW') return { p, t: 'NEW' };
  const line = u.slice(at).split('\n').find((l) => l.includes(`FIRST-${sid} `));
  return { p, t: line ? line.trim().split(' ')[0] : 'T9' };
};
const dest = (u, d) => { if (d === 'NEW_PROJECT') return 'NEW_PROJECT'; const x = labels(u, d[0], d[1]); return `${x.p}/${x.t}`; };
const pick = (target, conf, top = []) => async (req) => {
  const u = req.messages[1].content;
  const main = target === 'NEW_PROJECT' ? { p: 'NEW_PROJECT', t: 'NEW' } : labels(u, target[0], target[1]);
  return { text: JSON.stringify({ project: main.p, thread: main.t, confidence: conf, reason: '话题一致', top3: [target, ...top].map((d) => dest(u, d)) }), costUsd: 0.01 };
};
const router = (complete, env = {}) => createRouterV3({ complete, now: () => T0, env });
const Q = '导出接口分页之后前端的页码也要改';

check('版本号已升到 v3.1', ROUTER_V3_VERSION.startsWith('v3.1-'));

// ---- 分组、线程列表与提示词 ----
{
  const ps = groupProjects(cards);
  check('项目按最近活跃降序，项目内线程也按最近在前', ps.map((p) => p.cwd).join() === [A, B, C].join() && ps[0].sessions.map((c) => c.sessionId).join() === 'a1,a2,a3');
  const lab = labelProjects(ps, DEFAULT_POLICY_V3, T0);
  check('默认每项目最多 4 条、14 天窗：projA 列 a1,a2（a3 20 天前不列）', lab[0].threads.map((t) => `${t.label}:${t.card.sessionId}`).join() === 'T1:a1,T2:a2');
  check('窗内一条都没有 → 仍列最近 1 条（projC）', lab[2].threads.length === 1 && lab[2].threads[0].card.sessionId === 'c1');
  check('threadsPerProject 截断', labelProjects(ps, { ...DEFAULT_POLICY_V3, threadsPerProject: 1, threadWindowDays: 60 }, T0)[0].threads.length === 1);
  check('maxProjects 截断', labelProjects(ps, { ...DEFAULT_POLICY_V3, maxProjects: 2 }, T0).length === 2);
  const live = [tty('b1', 'claude', 'busy', 1), tty('a1', 'claude', 'idle', 2), { provider: 'codex', sessionId: 'a2', pid: 3, tty: null, state: 'idle' }];
  const c = ctx({ live, focusedSessionId: 'a1' });
  check('线程状态：正看着 / 开着 tab+running / 后台 / 已关闭', threadStatus(cards[0], c) === 'focused, idle' && threadStatus(cards[3], c) === 'open tab, running' && threadStatus(cards[1], c) === 'background, idle' && threadStatus(cards[2], c) === 'closed');
  const u = buildMessagesV3(Q, lab, c, T0)[1].content;
  check('提示词每条线程带标签、provider、相对时间、状态、首句与最近一句', /T2 · codex · 3d ago · background, idle · .*FIRST-a2 登录页加上验证码 ‖ r-a2-b/.test(u), u.split('\n').find((l) => l.includes('FIRST-a2')));
  const prevU = buildMessagesV3(Q, lab, ctx({ previous: { utterance: '上一句', provider: 'codex', sessionId: 'a2', minutesAgo: 7 } }), T0)[1].content;
  check('上一句标出去处（项目/线程）与分钟数', /<previous_utterance minutes_ago="7" went_to="P1\/T2">/.test(prevU));
  check('提示词凭证清洗', !buildMessagesV3('token=zzz999', lab, ctx(), T0)[1].content.includes('zzz999'));
}
// ---- 解析 ----
{
  const lab = labelProjects(groupProjects(cards), DEFAULT_POLICY_V3, T0);
  const p1 = parseOutputV3('{"project":"P1","thread":"T2","confidence":0.9,"reason":"x","top3":["P1/T2","P1/NEW","NEW_PROJECT"]}', lab);
  check('解析：P1/T2 → projA 的 a2；top3 含项目内 NEW 与 NEW_PROJECT', p1.ok && p1.dest.project === A && p1.dest.thread.sessionId === 'a2' && p1.top3.length === 3 && p1.top3[1].thread === null && p1.top3[1].project === A && p1.top3[2].project === 'NEW_PROJECT');
  const p2 = parseOutputV3('{"project":"p2","thread":"new","confidence":0.9}', lab);
  check('解析：项目内 NEW（大小写不敏感）', p2.ok && p2.dest.project === B && p2.dest.thread === null);
  const p3 = parseOutputV3('{"project":"NEW_PROJECT","thread":"T1","confidence":0.9}', lab);
  check('解析：NEW_PROJECT 的线程一律 NEW', p3.ok && p3.dest.project === 'NEW_PROJECT' && p3.dest.thread === null);
  check('解析：未列出的线程标签无效（projA 的 T3 是 20 天前的 a3，未列出）', !parseOutputV3('{"project":"P1","thread":"T3","confidence":0.9}', lab).ok);
  check('解析：缺线程字段无效', !parseOutputV3('{"project":"P1","confidence":0.9}', lab).ok);
  check('解析：未知项目无效', !parseOutputV3('{"project":"P9","thread":"NEW","confidence":0.9}', lab).ok);
  check('解析：垃圾无效', !parseOutputV3('第二个吧', lab).ok);
}
// ---- 点名 provider ----
{
  check('点名：用 codex / 让 Claude / use codex', namedProvider('用 codex 把这个脚本重写一遍') === 'codex' && namedProvider('让Claude看看这段日志') === 'claude' && namedProvider('please use codex for this') === 'codex');
  check('点名：没点名或两个都点 → null', namedProvider('把导出接口改成分页') === null && namedProvider('用 codex 和 claude 各跑一遍') === null);
}
// ---- 快路径 ----
{
  const live = [tty('b1', 'claude', 'idle', 1), tty('a2', 'codex', 'idle', 2)];
  check('有内容的句子不走快路径', fastPath(Q, ctx({ live, focusedSessionId: 'b1' }), DEFAULT_POLICY_V3) === null);
  const f1 = fastPath('继续', ctx({ previous: { utterance: '上一句', provider: 'claude', sessionId: 'c1', minutesAgo: 2 }, live, focusedSessionId: 'b1' }), DEFAULT_POLICY_V3);
  check('短句 + 5 分钟内刚发过 → 续上一句去处（优先于前台）', f1.decision.kind === 'continue' && f1.decision.sessionId === 'c1');
  const f2 = fastPath('继续', ctx({ previous: { utterance: '上一句', provider: 'claude', sessionId: 'c1', minutesAgo: 30 }, live, focusedSessionId: 'a2' }), DEFAULT_POLICY_V3);
  check('短句 + 上一句太久 + 正看着 a2 → 不自动；正看着的排第一，其余开着的按最近活跃其次', f2.decision.kind === 'clarify' && f2.decision.options.map((o) => o.sessionId).join() === 'a2,b1,a1', JSON.stringify(f2.decision.options));
  const f3 = fastPath('好的', ctx({ live, focusedSessionId: 'b1' }), DEFAULT_POLICY_V3);
  check('短句无上一句、正看着 b1 → clarify，b1 第一', f3.decision.kind === 'clarify' && f3.decision.options[0].sessionId === 'b1' && f3.decision.options[1].sessionId === 'a2' && f3.decision.options.length === 3);
  const f4 = fastPath('好的', ctx(), DEFAULT_POLICY_V3);
  check('短句无任何语境 → clarify，最近会话排第一', f4.decision.kind === 'clarify' && f4.decision.options[0].sessionId === 'a1');
}
// ---- 路由：线程由模型按话题选 ----
{
  let calls = 0;
  const r = await router(async (req) => { calls++; return pick([A, 'a2'], 0.96, [[A, 'a1']])(req); }).route('登录页的图形验证码换成滑块验证，并补上失败重试', ctx({ live: [tty('a1', 'claude', 'idle', 1)], focusedSessionId: 'a1' }));
  check('同项目多线程：按话题选中非最近、未开着的 a2（不因 a1 正看着而写进 a1）', r.kind === 'continue' && r.sessionId === 'a2' && r.provider === 'codex' && r.auto && r.delivery === 'direct' && r.project === A && r.thread === 'a2' && calls === 1, JSON.stringify({ kind: r.kind, sid: r.sessionId }));
  check('ranked 首项即去处，带置信度；含 3 项', r.ranked[0].kind === 'session' && r.ranked[0].sessionId === 'a2' && r.ranked[0].probability === 0.96 && r.ranked.length === 3 && r.ranked[1].sessionId === 'a1');
  check('理由带上模型的一句话', r.reason.includes('话题一致') && r.modelReason === '话题一致');
}
{
  const r = await router(pick([A, 'NEW'], 0.96)).route('给这个项目加一个 CSV 导入功能', ctx({ live: [tty('a1', 'claude', 'idle', 1)], focusedSessionId: 'a1' }));
  check('明确的新话题 → 在项目目录新开线程（不续正看着的 a1），provider 沿用项目最近会话', r.kind === 'new' && r.cwd === A && r.provider === 'claude' && r.auto && r.delivery === 'direct' && r.thread === 'NEW');
  const rc = await router(pick([C, 'NEW'], 0.96)).route('再加一个把结果导出成 PDF 文件的功能', ctx());
  check('项目内 NEW：provider 沿用该项目最近会话（projC 是 codex）', rc.kind === 'new' && rc.cwd === C && rc.provider === 'codex');
  const rn = await router(pick([C, 'NEW'], 0.96)).route('用 claude 给它补单元测试', ctx());
  check('句子点名 claude → 覆盖项目最近会话的 provider', rn.kind === 'new' && rn.provider === 'claude');
}
{
  const r = await router(pick('NEW_PROJECT', 0.96, [[A, 'NEW']])).route('调研一下家里 NAS 的备份方案', ctx());
  check('NEW_PROJECT → 新建，cwd 为 null，provider 沿用全局最近会话', r.kind === 'new' && r.cwd === null && r.provider === 'claude' && r.auto && r.project === null && r.thread === 'NEW');
  const r2 = await router(pick('NEW_PROJECT', 0.96)).route('用 codex 调研一下家里 NAS 的备份方案', ctx());
  check('NEW_PROJECT + 点名 codex → codex', r2.kind === 'new' && r2.provider === 'codex');
}
{
  const r = await router(pick([B, 'b1'], 0.6, [[A, 'a2'], [A, 'NEW']])).route(Q, ctx());
  check('低置信 → clarify，候选按模型 ranked：b1、a2、projA 新建', r.kind === 'clarify' && !r.auto && r.options[0].sessionId === 'b1' && r.ranked.map((o) => o.kind === 'new' ? `new:${o.cwd}` : o.sessionId).join() === `b1,a2,new:${A}`);
  const r2 = await router(pick([A, 'NEW'], 0.5, [[A, 'a1']])).route(Q, ctx());
  check('低置信且首选是项目内新建 → ranked 第一项是新建（入口据此预选新建）', r2.kind === 'clarify' && r2.ranked[0].kind === 'new' && r2.ranked[0].cwd === A);
}
{
  const r = await router(async () => ({ text: '', costUsd: null, error: 'TimeoutError' })).route(Q, ctx());
  check('超时 → 不自动，候选为最近线程', r.kind === 'clarify' && !r.auto && r.ranked[0].sessionId === 'a1' && r.ranked.length === 3);
  const r2 = await router(async () => { throw new Error('boom'); }).route(Q, ctx());
  check('抛错 → 不自动', r2.kind === 'clarify' && !r2.auto);
  const r3 = await router(async () => ({ text: '{"project":"P1","thread":"T7","confidence":0.99}', costUsd: 0 })).route(Q, ctx());
  check('选了不存在的线程 → 不自动', r3.kind === 'clarify' && !r3.auto && r3.holdReason === '模型输出无效');
  const r4 = await router(pick([B, 'b1'], 0.95)).route(Q, ctx({ cards: [] }));
  check('没有任何会话 → 不崩溃、不续接', r4.kind !== 'continue');
  let called = false;
  const r5 = await router(async () => { called = true; return { text: '', costUsd: null }; }).route('继续', ctx({ previous: { utterance: 'x', provider: 'claude', sessionId: 'b1', minutesAgo: 1 } }));
  check('短句走快路径，不调模型', r5.via === 'fast' && r5.kind === 'continue' && r5.sessionId === 'b1' && !called);
  const r6 = await createRouterV3({ env: { NTR_ROUTER_BACKEND: 'openrouter' }, now: () => T0 }).route(Q, ctx());
  check('OpenRouter 后端缺 key → 不自动（不联网）', r6.kind === 'clarify' && !r6.auto);
}

// ---- 三档闸门：≥direct → direct；[fork, direct) → 续接 fork、NEW 直接新建；<fork → clarify ----
{
  check('默认阈值（dev 重标定）：direct 0.92、fork 0.88、NEW 0.60', DEFAULT_POLICY_V3.minConfidence === 0.92 && DEFAULT_POLICY_V3.forkConfidence === 0.88 && DEFAULT_POLICY_V3.newConfidence === 0.6);
  const at = (conf, env = {}, target = [B, 'b1']) => router(pick(target, conf), env).route(Q, ctx());
  const tier = (r) => (r.kind === 'clarify' ? 'clarify' : r.delivery);
  for (const [conf, want] of [[1, 'direct'], [0.92, 'direct'], [0.9199, 'fork'], [0.9, 'fork'], [0.88, 'fork'], [0.8799, 'clarify'], [0.6, 'clarify'], [0, 'clarify']]) {
    const r = await at(conf);
    check(`续接 置信度 ${conf} → ${want}`, tier(r) === want && r.auto === (want !== 'clarify'), JSON.stringify({ kind: r.kind, delivery: r.delivery }));
  }
  const rf = await at(0.88);
  check('fork 档续接：kind continue、同一线程、原因写明分叉', rf.kind === 'continue' && rf.sessionId === 'b1' && rf.delivery === 'fork' && rf.reason.includes('分叉'), rf.reason);
  const rn = await at(0.88, {}, [A, 'NEW']);
  check('fork 档的项目内 NEW → 直接新建（delivery direct，不分叉；路由说明由 open.ts 按置信度加）', rn.kind === 'new' && rn.cwd === A && rn.delivery === 'direct' && rn.auto && rn.confidence === 0.88);
  const rnp = await at(0.9, {}, 'NEW_PROJECT');
  check('fork 档的 NEW_PROJECT → 直接新建', rnp.kind === 'new' && rnp.cwd === null && rnp.delivery === 'direct');
  check('NEW 用单独阈值：0.6 → 自动新建，0.5999 → clarify（续接 0.6 则 clarify）', tier(await at(0.6, {}, [A, 'NEW'])) === 'direct' && tier(await at(0.5999, {}, [A, 'NEW'])) === 'clarify' && tier(await at(0.6)) === 'clarify');
  check('NTR_ROUTER_NEW_CONFIDENCE=0.8：NEW 0.79 → clarify，0.8 → 新建', tier(await at(0.79, { NTR_ROUTER_NEW_CONFIDENCE: '0.8' }, [A, 'NEW'])) === 'clarify' && tier(await at(0.8, { NTR_ROUTER_NEW_CONFIDENCE: '0.8' }, [A, 'NEW'])) === 'direct');
  check('NTR_ROUTER_NEW_CONFIDENCE 不影响续接档', tier(await at(0.89, { NTR_ROUTER_NEW_CONFIDENCE: '0.99' })) === 'fork');
  const rc = await at(0.6);
  check('clarify 不带 delivery', rc.kind === 'clarify' && rc.delivery === undefined);

  check('NTR_ROUTER_MIN_CONFIDENCE=0.9：0.92 → direct', tier(await at(0.92, { NTR_ROUTER_MIN_CONFIDENCE: '0.9' })) === 'direct');
  check('NTR_ROUTER_MIN_CONFIDENCE=0.9：0.89 → fork', tier(await at(0.89, { NTR_ROUTER_MIN_CONFIDENCE: '0.9' })) === 'fork');
  check('NTR_ROUTER_FORK_CONFIDENCE=0.7：0.75 → fork', tier(await at(0.75, { NTR_ROUTER_FORK_CONFIDENCE: '0.7' })) === 'fork');
  check('NTR_ROUTER_FORK_CONFIDENCE=0.7：0.69 → clarify', tier(await at(0.69, { NTR_ROUTER_FORK_CONFIDENCE: '0.7' })) === 'clarify');
  check('fork = direct（关掉分叉档）：0.94 → clarify，0.95 → direct', tier(await at(0.94, { NTR_ROUTER_MIN_CONFIDENCE: '0.95', NTR_ROUTER_FORK_CONFIDENCE: '0.95' })) === 'clarify' && tier(await at(0.95, { NTR_ROUTER_MIN_CONFIDENCE: '0.95', NTR_ROUTER_FORK_CONFIDENCE: '0.95' })) === 'direct');
  check('空串视为未设置', tier(await at(0.9, { NTR_ROUTER_MIN_CONFIDENCE: '', NTR_ROUTER_FORK_CONFIDENCE: ' ' })) === 'fork');
  const throws = (env) => { try { createRouterV3({ complete: pick([B, 'b1'], 0.9), env }); return false; } catch (e) { return e instanceof Error; } };
  check('非法：FORK 高于 MIN → 报错', throws({ NTR_ROUTER_FORK_CONFIDENCE: '0.97' }) && throws({ NTR_ROUTER_MIN_CONFIDENCE: '0.8' }) && throws({ NTR_ROUTER_MIN_CONFIDENCE: '0.9', NTR_ROUTER_FORK_CONFIDENCE: '0.91' }));
  check('非法 NTR_ROUTER_NEW_CONFIDENCE → 报错；合法不报错', throws({ NTR_ROUTER_NEW_CONFIDENCE: '-0.1' }) && throws({ NTR_ROUTER_NEW_CONFIDENCE: '1.2' }) && throws({ NTR_ROUTER_NEW_CONFIDENCE: 'abc' }) && !throws({ NTR_ROUTER_NEW_CONFIDENCE: '0' }) && !throws({ NTR_ROUTER_NEW_CONFIDENCE: '1' }));
  check('非法：不在 0–1 或不是数 → 报错', throws({ NTR_ROUTER_FORK_CONFIDENCE: '-0.1' }) && throws({ NTR_ROUTER_FORK_CONFIDENCE: '1.5' }) && throws({ NTR_ROUTER_FORK_CONFIDENCE: 'abc' }) && throws({ NTR_ROUTER_MIN_CONFIDENCE: '2' }) && throws({ NTR_ROUTER_MIN_CONFIDENCE: 'NaN' }));
  check('合法边界不报错：0 与 1', !throws({ NTR_ROUTER_MIN_CONFIDENCE: '1', NTR_ROUTER_FORK_CONFIDENCE: '0' }));
  const f = await router(async () => { throw new Error('不应调用'); }).route('继续', ctx({ previous: { utterance: 'x', provider: 'claude', sessionId: 'c1', minutesAgo: 1 } }));
  check('快路径（承接上一句）→ direct', f.via === 'fast' && f.delivery === 'direct');
}

console.log(`\n${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
