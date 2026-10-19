# Native Task Router

**Press a hotkey, say one sentence, and pick up the AI session you left off in.**

**[⬇ Download for macOS](https://github.com/hanzhangzzz/native-task-router/releases/latest)** (Apple silicon) · [中文](README.md) · macOS + iTerm2 · Claude Code / Codex · MIT

https://github.com/user-attachments/assets/452dcc6b-ce93-49bc-bbd7-7a03b07bc4b4

**A fresh AI session starts with amnesia.** The most complete context lives in the native session log, and `claude -r` / `codex resume` restore it exactly. The hard part is remembering where that session is.

Native Task Router remembers for you. It searches every Claude Code and Codex session on your Mac, finds the one this sentence belongs to, and continues it in your own iTerm. If nothing fits, it starts a new one.

```
Before   You remember "the rate-limit work isn't done"
         → which project was that? cd ~/code/shop-api
         → was it Claude or Codex? codex resume
         → scroll a long session list, find it, type your message

Now      ⌃⌥Space → "add a per-user quota to the rate limiter" → Enter
         → if that session is open, switch to its iTerm tab and type it there
         → if not, open a new tab and resume it natively, full context intact
```

Try it with zero risk first. This only tells you where the sentence would go and touches no session:

```bash
npm run jev -- route "add a per-user quota to the rate limiter"
```

## Why not just use resume?

| | By hand | With Native Task Router |
| --- | --- | --- |
| Finding the session | Remember the directory and the tool, `cd` there, scroll the resume list | Say one sentence; it searches across projects and across Claude Code / Codex |
| Context | A new session, or memory and summaries, all of them compressed | Native resume, the full session log |
| Interface | Learn yet another desktop app | Your iTerm and the native TUI; approvals and tools work as before |
| Wrong destination | Can't happen, you did it yourself | When unsure, it asks you to pick. In a 240-sample held-out eval, no auto-sent message went to the wrong session |

**It doesn't compete with Claude Code or Codex.** It runs no agent, hosts no terminal, and never approves anything for you. It only decides where a sentence should go. The better they get, the more useful it gets, and the routing model itself is swappable.

## Download

1. Download `Native-Task-Router-<version>-arm64.dmg` from [Releases](https://github.com/hanzhangzzz/native-task-router/releases/latest) and drag the app into Applications. Apple silicon only for now.
2. **macOS blocks the first launch**: the app is not notarized (the author has no Developer ID). Open System Settings → Privacy & Security and click "Open Anyway" near the bottom, or run `xattr -dr com.apple.quarantine "/Applications/Native Task Router.app"`.
3. It then lives in the menu bar (a small speech bubble with an arc to a star) and starts at login by default. Press **Control+Option+Space** to open the input box; the menu lets you change the hotkey, turn off start-at-login, or quit.
4. On first use, macOS may ask whether it may control iTerm and System Events. Allow it: that's how it finds the tab you're looking at and types into it.

You still need iTerm2 and a logged-in Claude Code (`claude`, used for routing); resuming Codex sessions needs a logged-in `codex`.

## Run from source

**Requirements**: macOS, [iTerm2](https://iterm2.com), Node.js ≥ 24 (tested on 25.5), and a logged-in [Claude Code](https://docs.claude.com/en/docs/claude-code) (`claude` on PATH). Resuming Codex sessions also needs a logged-in `codex`.

> By default, routing runs `claude -p --model opus` on your machine, using your own Claude subscription; no extra API key is needed. Each decision sends short snippets of candidate sessions to Anthropic; see [Data and privacy](#data-and-privacy). Commands and settings keep the internal codename jev: `npm run jev`, `JEV_*` environment variables, and the `~/.jev/` data directory.

```bash
git clone https://github.com/hanzhangzzz/native-task-router.git && cd native-task-router
npm ci                                   # also downloads Electron

npm run jev -- sessions                  # sessions it can route to (most recent first)
npm run jev -- route "write a script that counts nginx 5xx errors per hour"
```

If the routing looks right, keep the entry running and press **Control+Option+Space**:

```bash
npm run entry                            # resident input box (change the hotkey with JEV_HOTKEY)
scripts/login-item.sh install            # optional: start at login; `uninstall` reverts it
```

## Using the entry

| Key | Action |
| --- | --- |
| Enter / Shift+Enter | Send / new line (the box grows with your text) |
| ↑ ↓ + Enter | Pick a candidate when routing is unsure; 1–9 picks directly, N starts new |
| ← (caret at start) | List sessions you've sent to before; picking one sends there **deterministically**, skipping the routing step |
| Esc | Close; anything you haven't sent is still there next time |

The input box follows your macOS language (English or Chinese); set `JEV_LANG=en` or `zh` to force one.

The CLI can do the same: `npm run jev -- open "<sentence>"` delivers for real, `--pick claude:<session-id>` sets the target, and `--new claude|codex` starts a new session.

New sessions go to `~/JevTasks/<short name>-<number>`; set `JEV_TASKS_DIR` to use another folder.

## How it works

```
sentence ─▶ local session index ─▶ group by project ─▶ Opus picks a project ─▶ gate ─▶ pick a session in it ─┬─▶ type into the open iTerm tab
                                                                                                        ├─▶ new tab: claude -r / codex resume
                                                                                                        └─▶ new tab: new session in that project dir
```

- **Index**: reads native history directly (`~/.claude/projects`, `~/.codex/sessions`) and keeps only interactive sessions, excluding `claude -p`, `codex exec`, subagents, and temp-dir probes. The cache is incremental, so a warm refresh takes tens of milliseconds.
- **Project first, then session**: sessions are grouped by project directory (the 40 most recently active projects). Each project becomes a small card (directory name, last activity, what its recent sessions were about, a snippet of the last reply). The cards, your previous sentence, and the sessions you are looking at or have open go to the model, which only answers "which project does this sentence belong to" (or none of them), with a confidence and its top three. What you want is to land in the right project, where CLAUDE.md, memory, and the whole history live; which session to continue is decided by deterministic rules.
- **Picking a session inside the project**: if exactly one session of that project is open in a terminal, it types into that one. Otherwise, if the project's latest session was active within 24 hours, it resumes it natively. If it's older, it starts a new session in that project directory (Claude Code / Codex load memory and CLAUDE.md themselves). Only when several sessions are open and it can't tell them apart does it ask you.
- **Gate**: it auto-sends only when the project confidence is ≥ 0.85. Otherwise it lists the top three destinations with the first one preselected, so Enter sends it. Model errors and timeouts never auto-send.
- **Short follow-ups skip the model**: for contentless messages like "continue" or "ok", if you sent something from the entry within the last 5 minutes, it continues that session; otherwise it continues the session you were looking at when you opened the entry; failing both, it lists the open sessions. This path takes tens of milliseconds.
- **Checks right before delivery**: before typing into an open tab, it re-verifies that the tab still maps to the same process and session, that the session is idle, and that the screen shows no approval prompt and no half-typed draft of yours. If any check fails, it only switches to the tab and copies your sentence to the clipboard. It never starts a second process on a session that is already running.
- **iTerm not running**: it starts iTerm first; if iTerm opens its own blank window on launch, the session goes into that window instead of leaving an empty tab behind.

## How accurate is it?

The short version: **it would rather make you press Enter once more than send your message to the wrong place.**

Evaluated on about a month of the author's real local history ([method and data](ops/research/route-accuracy-2026-10.md), in Chinese). Sending to the wrong project is a hard error; landing in the right project but a different session than the one you had in mind is a soft one (a continuation within the same project, which a human might also pick).

- Project-first routing (current version), 145-sample dev subset: the model picks the right project 71% of the time, and the right project is in its top three 91% of the time. At confidence ≥ 0.85 it auto-sends 37% of messages with 1 wrong project (a message that should have started a new task was filed under another project); at ≥ 0.9 it auto-sends 23% with 0 wrong.
- Once the project is right, "the project's latest session" is the correct destination 90% of the time (287 continuation samples in the dev set).
- 31% of these samples are contentless follow-ups like "continue" or "ok". In the product they take the model-free fast path (previous destination / the session you were looking at). The historical data has neither signal, so the fast path's accuracy is not yet measured; only the rules are.
- The previous session-level router on the held-out set (240 samples, run once): 9% auto-sent, 0 wrong sessions. The new version has not been run on the held-out set yet.
- Each decision takes 3–7 seconds, mostly `claude -p` startup and Opus inference; the fast path takes tens of milliseconds.

The sample is small. These numbers show almost no auto-sent mistakes on this data; they don't prove a low error rate.

## Swappable routing model

Routing only decides where a sentence goes. It is separate from the Claude Code / Codex session that does the work, so you can change the model:

| Setting | Effect |
| --- | --- |
| (default) | Opus via local `claude -p`, using your Claude subscription, with no API key |
| `JEV_ROUTER_MODEL=sonnet` | Any other model `claude -p` supports |
| `JEV_ROUTER_BACKEND=openrouter` + `openrouter_api_key` | The same candidates, prompt, and gate via [OpenRouter](https://openrouter.ai); combine with e.g. `JEV_ROUTER_MODEL=deepseek/deepseek-v4.1-flash` to pick any model |
| `JEV_ROUTER=interim` | Use Jev (`typesafe/jev-1.13`) on OpenRouter Decisions to choose |

You can also implement the [`Router`](src/layers/types.ts) interface yourself. One caveat: the accuracy above was measured with the default Opus. In the same eval, DeepSeek V4.1 Flash, GPT-5.6 Luna, Qwen3.8 Flash, and Haiku 5.5 picked the right first choice only 54–66% of the time, versus about 73% for Opus. Try `npm run jev -- route` on your own sessions before switching.

## Known limitations

- macOS + iTerm2 only. Sessions open in other terminals can't be typed into; you get a notice and the sentence is copied to your clipboard.
- Claude Code keeps 30 days of history by default, so older sessions can't be resumed.
- A Codex session started with `--remote` can't be detected as running.
- Routing needs a logged-in `claude`, and it is slow (see above).
- The input box is in English or Chinese; the command-line tool's messages and logs are still in Chinese.

## Data and privacy

- **Stays on your Mac**: the session index cache and the entry log live in `~/.jev/` (`cache/` is safe to delete; `entry-log.jsonl` feeds the ← history list). Native history is never modified.
- **Leaves your Mac**: for each decision, bounded snippets of candidate sessions (per card, the title, first message, and last two messages at about 120–160 characters each, plus a reply snippet) and your sentence go to Anthropic through your local `claude -p`. With the OpenRouter backend, they go to OpenRouter and the provider it routes to, with no data retention or training requested. Credentials shaped like `sk-…`, `ghp_…`, `AKIA…`, or `token=…` are masked first. Full conversations are never sent.
- Once delivered, your message is handled by native Claude Code / Codex as usual.

## Development

```bash
npm test                                 # type check + all offline contracts (no iTerm, no model calls)
scripts/fresh-install.sh                 # clean clone → npm ci → npm test → read sessions → one real routing decision
npm run entry:ux                         # entry UI acceptance (real window + stub CLI, sends nothing real)
JEV_LIVE_ITERM=1 npm run open:live       # real iTerm end-to-end: opens a test window in your iTerm and runs real claude/codex; off by default
```

The layered code is in [`src/layers/`](src/layers): `providers/` (who owns a session: claude, codex), `surfaces/` (where it is shown: iterm), `router/` (deciding the destination), and `open.ts` (orchestration). The entry is in [`entry/`](entry). The contract between layers is [`src/layers/types.ts`](src/layers/types.ts).

## License

[MIT](LICENSE)
