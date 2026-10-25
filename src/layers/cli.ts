// ntr CLI：`node src/layers/cli.ts open "<一句话>" [--json] [--pick claude:<id> [--answer 1-9]] [--new claude|codex] [--focused-tty /dev/ttysN]`
// 目标停在审批/选择框时：--answer N 替人选第 N 项再送达正文（正文可空，等于只答题）；不带 --answer 返回 awaiting-approval。
// 另有 `sessions`（卡片摘要）、`live`（存活映射）。入口窗口（entry/main.cjs）以子进程调用 `open --json`。
// 终端：iTerm 与 Terminal 都支持；新开会话去哪个见 surfaces/multi.ts 的 pickTarget（NTR_TERMINAL=iterm|terminal 可指定）。
// 测试隔离：--window-id N（或 NTR_WINDOW_ID）把新 tab 开进指定 iTerm 窗口。
import { claude } from './providers/claude.ts';
import { codex } from './providers/codex.ts';
import { codexQueue } from './providers/codex-queue.ts';
import { iterm, itermRunning } from './surfaces/iterm.ts';
import { terminal, terminalRunning } from './surfaces/terminal.ts';
import { createMulti, itermInstalled } from './surfaces/multi.ts';
import { interimRouter } from './router/interim.ts';
import { createRouterV2 } from './router/v2.ts';
import { createRouterV3 } from './router/v3.ts';
import { guarded } from './guard.ts';
import { approvalPrompt, entryLogPath, open, parsePrompt, readHistory, readPrevious, SCREEN_TAIL_LINES } from './open.ts';
import type { OpenOutcome, Provider, ProviderId, Router, SessionCard } from './types.ts';

// 入口借 Electron 的 Node 跑本 CLI，靠 ELECTRON_RUN_AS_NODE=1；它只在进程启动时读一次。立刻删掉，
// 否则会传给所有子进程：冷启动的 iTerm 及其中每个 shell 都会带上它，在里面启动的 Electron 程序全被当成 Node 运行。
delete process.env.ELECTRON_RUN_AS_NODE;

// NTR_ONLY_UNDER=<目录>：只路由这个目录下的会话（演示、录屏、教程用，避免真实会话出镜）
const onlyUnder = process.env.NTR_ONLY_UNDER ? process.env.NTR_ONLY_UNDER.replace(/\/+$/, '') + '/' : null;
const providers: Provider[] = [claude, codex].map((p) =>
  onlyUnder ? { ...p, listSessions: async () => (await p.listSessions()).filter((c) => (c.cwd + '/').startsWith(onlyUnder)) } : p,
);

/** 默认 Router v3（项目优先，经本机 `claude -p`）；NTR_ROUTER=v2 退回会话级路由，=interim 退回过渡路由（需要 OpenRouter key）。 */
async function pickRouter(): Promise<Router> {
  const r = process.env.NTR_ROUTER;
  return r === 'interim' ? interimRouter : r === 'v2' ? createRouterV2() : createRouterV3();
}
const isProvider = (s: string): s is ProviderId => s === 'claude' || s === 'codex';

const terminals = (focusedTty: string | null = null) =>
  createMulti({
    surfaces: { iterm, terminal },
    running: (s) => (s === 'iterm' ? itermRunning() : terminalRunning()),
    itermInstalled,
    focusedTty,
    env: process.env.NTR_TERMINAL,
  });

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  args.splice(i, v === undefined ? 1 : 2);
  return v;
}

function brief(c: SessionCard) {
  return { provider: c.provider, sessionId: c.sessionId, title: c.title, project: c.cwd.split('/').pop(), cwd: c.cwd, last: c.recentPrompts.at(-1)?.slice(0, 80) ?? null, reply: c.lastReply?.slice(0, 160) ?? null, updatedAt: c.updatedAt };
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const cmd = args.shift();
  // `--` 之后全是正文，不再解析选项（正文可能以 -- 开头）
  const dd = args.indexOf('--');
  const literal = dd >= 0 ? args.splice(dd).slice(1) : null;
  if (cmd === 'sessions') {
    const cards = (await Promise.all(providers.map((p) => p.listSessions()))).flat().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    for (const c of cards.slice(0, Number(flag(args, '--limit') ?? 30))) console.log(JSON.stringify(brief(c)));
    console.error(`共 ${cards.length} 个交互会话`);
    return 0;
  }
  if (cmd === 'route') {
    // 只判断、不送达：看这句话会被发到哪（不开标签页、不写入任何会话、不记入口日志）
    const json = args.includes('--json');
    if (json) args.splice(args.indexOf('--json'), 1);
    const focusedTty = flag(args, '--focused-tty') ?? null;
    const text = (literal ?? args).join(' ').trim();
    if (!text) { console.error('缺少要判断的文字'); return 2; }
    const cards = (await Promise.all(providers.map((p) => p.listSessions()))).flat();
    const live = (await Promise.all(providers.map((p) => p.liveSessions()))).flat();
    const focusedSessionId = focusedTty ? (live.find((l) => l.tty === focusedTty)?.sessionId ?? null) : null;
    const d = await (await pickRouter()).route(text, { cards, live, previous: readPrevious(entryLogPath(), Date.now()), focusedSessionId });
    const name = (p: ProviderId, id: string) => { const c = cards.find((x) => x.provider === p && x.sessionId === id); return c ? `${p} · ${c.cwd.split('/').pop()} · ${c.title ?? c.firstPrompt?.slice(0, 40) ?? id}` : `${p}:${id}`; };
    const conf = d.kind !== 'clarify' && d.confidence !== null ? `置信度 ${d.confidence.toFixed(2)}，` : '';
    const fork = d.kind !== 'clarify' && d.delivery === 'fork';
    if (json) console.log(JSON.stringify(d));
    else if (d.kind === 'continue') console.log(fork ? `[fork] 分叉续接 ${name(d.provider, d.sessionId)}（${conf}会自动送进分叉出的新会话，原会话不动，正文前加路由说明）` : `[direct] 续接 ${name(d.provider, d.sessionId)}（${conf}会直接送达）`);
    else if (d.kind === 'new') console.log(`[${fork ? 'fork' : 'direct'}] 新建 ${d.provider} 会话${d.cwd ? ` 于 ${d.cwd}` : ''}（${conf}会自动新建${fork ? '，正文前加路由说明' : ''}）`);
    else console.log(`[clarify] 拿不准（${d.reason}），入口会列出：\n${d.options.map((o, i) => `  ${i + 1}. ${name(o.provider, o.sessionId)}${o.probability == null ? '' : `（${o.probability}）`}`).join('\n')}`);
    console.error(`${cards.length} 个会话 · ${d.latencyMs}ms · ${d.model ?? ''}`);
    return 0;
  }
  if (cmd === 'history') {
    // 入口按 ← 展开的历史会话（一行 JSON 数组）；会话已不在索引里（被清理/归档）的不列出
    const cards = (await Promise.all(providers.map((p) => p.listSessions()))).flat();
    const items = readHistory(entryLogPath(), Number(flag(args, '--limit') ?? 20)).flatMap((h) => {
      const c = cards.find((x) => x.provider === h.provider && x.sessionId === h.sessionId);
      return c ? [{ ...h, card: brief(c) }] : [];
    });
    console.log(JSON.stringify(items));
    return 0;
  }
  if (cmd === 'tasks') {
    // 入口按 ← 展开的任务列表（一行 JSON）：running = 终端里开着的会话，按终端里窗口、标签页的顺序；
    // recent = 其余会话，按最近活动，最多 --limit 条（默认 60，入口里打字筛选用）。
    // running 的每一项都读一次屏幕末尾：停在审批/选择框的任务带上问题与选项，入口里直接选。
    const surface = terminals();
    const [cards, live, views] = await Promise.all([
      Promise.all(providers.map((p) => p.listSessions())).then((a) => a.flat()),
      Promise.all(providers.map((p) => p.liveSessions())).then((a) => a.flat()),
      surface.listViews(),
    ]);
    const card = (p: ProviderId, id: string) => cards.find((c) => c.provider === p && c.sessionId === id);
    const running = (
      await Promise.all(
        views.map(async (v, i) => {
          const here = live.filter((l) => l.tty && l.tty === v.tty);
          if (here.length !== 1) return []; // 同一终端多个会话：认不准，不列
          const l = here[0]!, c = card(l.provider, l.sessionId);
          let prompt = null;
          try {
            const tail = await surface.screenTail(v.viewId, SCREEN_TAIL_LINES);
            prompt = approvalPrompt(tail) ? parsePrompt(tail) : null;
          } catch {
            /* 屏幕读不到就当没有审批框 */
          }
          return [{ provider: l.provider, sessionId: l.sessionId, state: l.state, viewId: v.viewId, order: i, viewTitle: v.title, card: c ? brief(c) : null, ...(prompt ? { prompt } : {}) }];
        }),
      )
    ).flat();
    const open = new Set(running.map((r) => `${r.provider}:${r.sessionId}`));
    const recent = cards
      .filter((c) => !open.has(`${c.provider}:${c.sessionId}`))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, Number(flag(args, '--limit') ?? 60))
      .map((c) => ({ provider: c.provider, sessionId: c.sessionId, card: brief(c) }));
    console.log(JSON.stringify({ running, recent }));
    return 0;
  }
  if (cmd === 'live') {
    const live = (await Promise.all(providers.map((p) => p.liveSessions()))).flat();
    const views = await terminals().listViews();
    for (const l of live) console.log(JSON.stringify({ ...l, viewId: views.find((v) => v.tty && v.tty === l.tty)?.viewId ?? null }));
    return 0;
  }
  if (cmd !== 'open') {
    console.error('用法: ntr open "<一句话>" [--json] [--pick claude:<id> [--answer 1-9]] [--new claude|codex [--cwd <目录>]] [--focused-tty /dev/ttysN] | route "<一句话>"（只判断不送达） | sessions | live | history | tasks');
    return 2;
  }

  const json = args.includes('--json');
  if (json) args.splice(args.indexOf('--json'), 1);
  const pickRaw = flag(args, '--pick');
  const newRaw = flag(args, '--new');
  const newCwd = flag(args, '--cwd');
  const answerRaw = flag(args, '--answer');
  const focusedTty = flag(args, '--focused-tty') ?? null;
  const win = flag(args, '--window-id') ?? process.env.NTR_WINDOW_ID;
  const text = (literal ?? args).join(' ').trim();
  let answer: number | undefined;
  if (answerRaw !== undefined) {
    answer = Number(answerRaw);
    if (!Number.isInteger(answer) || answer < 1 || answer > 9) {
      console.error('--answer 取值: 1–9（选项框的第几项）');
      return 2;
    }
    if (!pickRaw) {
      console.error('--answer 要和 --pick 一起用：先知道答给哪个会话');
      return 2;
    }
  }
  if (!text && answer === undefined) {
    console.error('缺少要发送的文字');
    return 2;
  }
  let pick: { provider: ProviderId; sessionId: string } | undefined;
  if (pickRaw) {
    const [p, ...rest] = pickRaw.split(':');
    if (!p || !isProvider(p) || rest.length === 0) {
      console.error('--pick 格式: claude:<id> 或 codex:<id>');
      return 2;
    }
    pick = { provider: p, sessionId: rest.join(':') };
  }
  if (newRaw !== undefined && !isProvider(newRaw)) {
    console.error('--new 取值: claude | codex');
    return 2;
  }

  const g = guarded(terminals(focusedTty), codexQueue);
  const outcome = await open(text, {
    router: await pickRouter(),
    providers,
    surface: g.surface,
    pick,
    answer,
    forceNew: newRaw === undefined ? undefined : { provider: newRaw as ProviderId, cwd: newCwd },
    focusedTty,
    windowId: win ? Number(win) : undefined,
    queue: { codex: g.queue },
    tasksRoot: process.env.NTR_TASKS_DIR || undefined,
  });
  const cards = outcome.action === 'clarify' || ('sessionId' in outcome && outcome.sessionId) || (outcome.action === 'opened' && outcome.forkedFrom) ? (await Promise.all(providers.map((p) => p.listSessions()))).flat() : [];
  const card = (p: ProviderId, id: string | null) => cards.find((c) => c.provider === p && c.sessionId === id);
  if (json) {
    const enriched: Record<string, unknown> = { ...outcome };
    if (outcome.action === 'clarify') {
      enriched.options = outcome.options.map((o) => ({ ...o, card: card(o.provider, o.sessionId) ? brief(card(o.provider, o.sessionId)!) : null }));
    } else if ('sessionId' in outcome) {
      const c = card(outcome.provider, outcome.sessionId);
      if (c) enriched.card = brief(c);
      // 分叉送达时入口显示的是原会话的名字（新会话刚起，索引里可能还没有它）
      const from = outcome.action === 'opened' && outcome.forkedFrom ? card(outcome.provider, outcome.forkedFrom) : undefined;
      if (from) enriched.forkedFromCard = brief(from);
    }
    console.log(JSON.stringify(enriched));
  } else {
    console.log(describe(outcome, card));
  }
  return outcome.action === 'failed' ? 1 : 0;
}

function describe(o: OpenOutcome, card: (p: ProviderId, id: string | null) => SessionCard | undefined): string {
  const name = (p: ProviderId, id: string | null) => {
    const c = card(p, id);
    return `${p} 会话 ${c?.title ?? c?.cwd.split('/').pop() ?? id ?? '(新)'}`;
  };
  switch (o.action) {
    case 'wrote': return `已送达 ${name(o.provider, o.sessionId)}${o.answeredOption ? `（先选了选项 ${o.answeredOption}）` : ''}`;
    case 'awaiting-approval': return `任务在等批准${o.prompt.question ? `：${o.prompt.question}` : '，回到入口选一下'}`;
    case 'answered': return o.option == null ? '屏幕已不在选项框，没有按键' : `已选选项 ${o.option}`;
    case 'focused-only': return `只聚焦 ${name(o.provider, o.sessionId)}: ${o.why}`;
    case 'opened':
      if (o.forkedFrom) return `已分叉续接 ${name(o.provider, o.forkedFrom)} · 置信度 ${o.confidence?.toFixed(2) ?? '?'}${o.sessionId ? `（新会话 ${o.sessionId}，原会话未改动）` : '（原会话未改动）'}`;
      return `已新开 ${o.provider} 于 ${o.cwd}${o.sessionId ? `（会话 ${o.sessionId}）` : ''}`;
    case 'clarify': return `需要选择${o.reason ? `（${o.reason}）` : ''}:\n${o.suggestNew ? `  建议新建 ${o.suggestNew.provider}${o.suggestNew.cwd ? ` 于 ${o.suggestNew.cwd}` : ''}\n` : ''}${o.options.map((x, i) => `  ${i + 1}. ${name(x.provider, x.sessionId)}${x.probability === null ? '' : ` (${x.probability.toFixed(2)})`}`).join('\n')}`;
    case 'failed': return `失败: ${o.why}`;
  }
}

process.exitCode = await main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  return 1;
});
