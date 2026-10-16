// jev CLI：`node src/layers/cli.ts open "<一句话>" [--json] [--pick claude:<id>] [--new claude|codex] [--focused-tty /dev/ttysN]`
// 另有 `sessions`（卡片摘要）、`live`（存活映射）。入口窗口（entry/main.cjs）以子进程调用 `open --json`。
// 测试隔离：--window-id N（或 JEV_WINDOW_ID）把新 tab 开进指定 iTerm 窗口。
import { claude } from './providers/claude.ts';
import { codex } from './providers/codex.ts';
import { codexQueue } from './providers/codex-queue.ts';
import { iterm } from './surfaces/iterm.ts';
import { interimRouter } from './router/interim.ts';
import { createRouterV2 } from './router/v2.ts';
import { guarded } from './guard.ts';
import { entryLogPath, open, readHistory, readPrevious } from './open.ts';
import type { OpenOutcome, ProviderId, Router, SessionCard } from './types.ts';

const providers = [claude, codex];

/** 默认 Router v2（TE-4b 冻结策略，经本机 `claude -p`）；JEV_ROUTER=interim 退回过渡路由（需要 OpenRouter key）。 */
async function pickRouter(): Promise<Router> {
  return process.env.JEV_ROUTER === 'interim' ? interimRouter : createRouterV2();
}
const isProvider = (s: string): s is ProviderId => s === 'claude' || s === 'codex';

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  args.splice(i, v === undefined ? 1 : 2);
  return v;
}

function brief(c: SessionCard) {
  return { provider: c.provider, sessionId: c.sessionId, title: c.title, project: c.cwd.split('/').pop(), cwd: c.cwd, last: c.recentPrompts.at(-1)?.slice(0, 80) ?? null, updatedAt: c.updatedAt };
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
    if (json) console.log(JSON.stringify(d));
    else if (d.kind === 'continue') console.log(`续接 ${name(d.provider, d.sessionId)}（置信度 ${d.confidence}，会自动送达）`);
    else if (d.kind === 'new') console.log(`新建 ${d.provider} 会话${d.cwd ? ` 于 ${d.cwd}` : ''}（会自动新建）`);
    else console.log(`拿不准（${d.reason}），入口会列出：\n${d.options.map((o, i) => `  ${i + 1}. ${name(o.provider, o.sessionId)}${o.probability == null ? '' : `（${o.probability}）`}`).join('\n')}`);
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
  if (cmd === 'live') {
    const live = (await Promise.all(providers.map((p) => p.liveSessions()))).flat();
    const views = await iterm.listViews();
    for (const l of live) console.log(JSON.stringify({ ...l, viewId: views.find((v) => v.tty && v.tty === l.tty)?.viewId ?? null }));
    return 0;
  }
  if (cmd !== 'open') {
    console.error('用法: jev open "<一句话>" [--json] [--pick claude:<id>] [--new claude|codex [--cwd <目录>]] [--focused-tty /dev/ttysN] | route "<一句话>"（只判断不送达） | sessions | live | history');
    return 2;
  }

  const json = args.includes('--json');
  if (json) args.splice(args.indexOf('--json'), 1);
  const pickRaw = flag(args, '--pick');
  const newRaw = flag(args, '--new');
  const newCwd = flag(args, '--cwd');
  const focusedTty = flag(args, '--focused-tty') ?? null;
  const win = flag(args, '--window-id') ?? process.env.JEV_WINDOW_ID;
  const text = (literal ?? args).join(' ').trim();
  if (!text) {
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

  const g = guarded(iterm, codexQueue);
  const outcome = await open(text, {
    router: await pickRouter(),
    providers,
    surface: g.surface,
    pick,
    forceNew: newRaw === undefined ? undefined : { provider: newRaw as ProviderId, cwd: newCwd },
    focusedTty,
    windowId: win ? Number(win) : undefined,
    queue: { codex: g.queue },
  });
  const cards = outcome.action === 'clarify' || ('sessionId' in outcome && outcome.sessionId) ? (await Promise.all(providers.map((p) => p.listSessions()))).flat() : [];
  const card = (p: ProviderId, id: string | null) => cards.find((c) => c.provider === p && c.sessionId === id);
  if (json) {
    const enriched: Record<string, unknown> = { ...outcome };
    if (outcome.action === 'clarify') {
      enriched.options = outcome.options.map((o) => ({ ...o, card: card(o.provider, o.sessionId) ? brief(card(o.provider, o.sessionId)!) : null }));
    } else if ('sessionId' in outcome) {
      const c = card(outcome.provider, outcome.sessionId);
      if (c) enriched.card = brief(c);
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
    case 'wrote': return `已送达 ${name(o.provider, o.sessionId)}`;
    case 'focused-only': return `只聚焦 ${name(o.provider, o.sessionId)}: ${o.why}`;
    case 'opened': return `已新开 ${o.provider} 于 ${o.cwd}${o.sessionId ? `（会话 ${o.sessionId}）` : ''}`;
    case 'clarify': return `需要选择${o.reason ? `（${o.reason}）` : ''}:\n${o.suggestNew ? `  建议新建 ${o.suggestNew.provider}${o.suggestNew.cwd ? ` 于 ${o.suggestNew.cwd}` : ''}\n` : ''}${o.options.map((x, i) => `  ${i + 1}. ${name(x.provider, x.sessionId)}${x.probability === null ? '' : ` (${x.probability.toFixed(2)})`}`).join('\n')}`;
    case 'failed': return `失败: ${o.why}`;
  }
}

process.exitCode = await main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  return 1;
});
