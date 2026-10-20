# Native Task Router

**Press a hotkey, say one sentence, and pick up the AI session you left off in.**

**[⬇ Download for macOS](https://github.com/hanzhangzzz/native-task-router/releases/latest)** (Apple silicon) · [中文](README.md) · macOS + iTerm2 / Terminal · Claude Code / Codex · MIT

https://github.com/user-attachments/assets/452dcc6b-ce93-49bc-bbd7-7a03b07bc4b4

**A fresh AI session starts with amnesia.** The most complete context lives in the native session log, and `claude -r` / `codex resume` restore it exactly. The hard part is remembering where that session is.

Native Task Router remembers for you. It searches every Claude Code and Codex session on your Mac, finds the one this sentence belongs to, and continues it in your own iTerm or Terminal. If nothing fits, it starts a new one.

```
Before   You remember "the rate-limit work isn't done"
         → which project was that? cd ~/code/shop-api
         → was it Claude or Codex? codex resume
         → scroll a long session list, find it, type your message

Now      ⌃⌥Space → "add a per-user quota to the rate limiter" → Enter
         → if that session is open, switch to its tab (iTerm or Terminal) and type it there
         → if not, open a new tab (a new window in Terminal) and resume it natively, full context intact
         → if it's less sure, fork that session into a new one that carries the context, leaving the original untouched
```

Try it with zero risk first. This only tells you where the sentence would go and touches no session:

```bash
npm run ntr -- route "add a per-user quota to the rate limiter"
```

## Why not just use resume?

| | By hand | With Native Task Router |
| --- | --- | --- |
| Finding the session | Remember the directory and the tool, `cd` there, scroll the resume list | Say one sentence; it searches across projects and across Claude Code / Codex |
| Context | A new session, or memory and summaries, all of them compressed | Native resume, the full session log |
| Interface | Learn yet another desktop app | Your iTerm / Terminal and the native TUI; approvals and tools work as before |
| Wrong destination | Can't happen, you did it yourself | When unsure, it asks you to pick. In a 240-sample held-out eval, no auto-sent message went to the wrong session |

**It doesn't compete with Claude Code or Codex.** It runs no agent, hosts no terminal, and never approves anything for you. It only decides where a sentence should go. The better they get, the more useful it gets, and the routing model itself is swappable.

## Download

**With Homebrew**:

```bash
brew trust hanzhangzzz/tap                              # third-party taps must be trusted first; some Homebrew versions refuse them otherwise
brew install --cask hanzhangzzz/tap/native-task-router
```

Then continue from step 2. Upgrade later with `brew upgrade --cask native-task-router`.

**Or download the dmg by hand**:

1. Download `Native-Task-Router-<version>-arm64.dmg` from [Releases](https://github.com/hanzhangzzz/native-task-router/releases/latest) and drag the app into Applications. Apple silicon only for now.
2. **macOS blocks the first launch**: the app is not notarized (the author has no Developer ID). Open System Settings → Privacy & Security and click "Open Anyway" near the bottom, or run `xattr -dr com.apple.quarantine "/Applications/Native Task Router.app"`.
3. It then lives in the menu bar (a small speech bubble with an arc to a star) and starts at login by default. Press **Control+Option+Space** to open the input box; the menu lets you change the hotkey, turn off start-at-login, or quit.
4. On first use, macOS may ask whether it may control iTerm (or Terminal) and System Events. Allow it: that's how it finds the tab you're looking at and types into it.

You still need iTerm2 or the built-in Terminal, and a logged-in Claude Code (`claude`, used for routing); resuming Codex sessions needs a logged-in `codex`.

## Run from source

**Requirements**: macOS, [iTerm2](https://iterm2.com) or the built-in Terminal, Node.js ≥ 24 (tested on 25.5), and a logged-in [Claude Code](https://docs.claude.com/en/docs/claude-code) (`claude` on PATH). Resuming Codex sessions also needs a logged-in `codex`.

> By default, routing runs `claude -p --model opus` on your machine, using your own Claude subscription; no extra API key is needed. Each decision sends short snippets of candidate sessions to Anthropic; see [Data and privacy](#data-and-privacy).

```bash
git clone https://github.com/hanzhangzzz/native-task-router.git && cd native-task-router
npm ci                                   # also downloads Electron

npm run ntr -- sessions                  # sessions it can route to (most recent first)
npm run ntr -- route "write a script that counts nginx 5xx errors per hour"
```

If the routing looks right, keep the entry running and press **Control+Option+Space**:

```bash
npm run entry                            # resident input box (change the hotkey with NTR_HOTKEY)
scripts/login-item.sh install            # optional: start at login; `uninstall` reverts it
```

## Using the entry

| Key | Action |
| --- | --- |
| Enter / Shift+Enter | Send / new line (the box grows with your text) |
| ↑ ↓ + Enter | Pick a candidate when routing is unsure; 1–9 picks directly, N starts new |
| ← (caret at start) | List sessions you've sent to before; picking one sends there **deterministically**, skipping the routing step |
| Esc | Close; anything you haven't sent is still there next time |

The input box follows your macOS language (English or Chinese); set `NTR_LANG=en` or `zh` to force one.

The CLI can do the same: `npm run ntr -- open "<sentence>"` delivers for real, `--pick claude:<session-id>` sets the target, and `--new claude|codex` starts a new session.

New sessions go to `~/ntr-tasks/<short name>-<number>`; set `NTR_TASKS_DIR` to use another folder.

## How it works

```
sentence ─▶ local session index ─▶ group by project, list recent threads ─▶ Opus picks project + thread (or new) ─▶ gate ─┬─▶ type into the open terminal tab
                                                                                                                    ├─▶ new tab: claude -r / codex resume
                                                                                                                    ├─▶ new tab: new session in that project dir
                                                                                                                    └─▶ middle-tier continuation: new tab, forked; original untouched
```

- **Index**: reads native history directly (`~/.claude/projects`, `~/.codex/sessions`) and keeps only interactive sessions, excluding `claude -p`, `codex exec`, subagents, and temp-dir probes. The cache is incremental, so a warm refresh takes tens of milliseconds.
- **Project and thread in one decision**: sessions are grouped by project directory (the 40 most recently active projects). Each project lists up to 4 threads active in the last 14 days (or its latest one if none), each with its tool, last activity, status (focused / open / running / closed), and a one-line topic (first and latest message). Together with your previous sentence, this goes to the model, which answers which project the sentence belongs to and whether it continues one of its threads or starts a new one there (or belongs to no existing project), with a confidence, a short reason, and its top three. One project often has several tasks in parallel, so the focused tab, the latest thread, and open tabs are only weak hints; the thread is chosen by how well the sentence matches each thread's topic.
- **Which tool a new thread uses**: the tool of that project's latest session, unless the sentence explicitly names one ("use codex …", "let Claude …"). Claude Code / Codex load memory and CLAUDE.md themselves.
- **A three-tier gate** (confidence covers project and thread together):
  - **≥ 0.95, direct**: types into the open tab, or resumes the session natively.
  - **0.85–0.95, continuations are forked**: still sent automatically, but the original session is never touched. It forks that session into a new one (`claude -r <id> --fork-session` / `codex fork <id>`) that carries all of its context and receives the sentence in a new tab. The original session's history file doesn't change by a single byte, even if it is open in a terminal right now. One routing note goes in front of the text: the message was delivered automatically, with this confidence, and if it is unrelated to the project or session, the agent should say so and stop without changing any files. When this tier decides on a new thread, it just starts one without a note: a new session touches no existing one.
  - **< 0.85, you confirm**: it lists the model's top three destinations with the first one preselected, so Enter sends it.
  - Model errors and timeouts never auto-send. Whatever you pick by hand in the entry (← history, the candidate list) is always delivered directly, without a note.
  - Why a middle tier: a wrong send writes the sentence and the agent's reply into the wrong session's native history, and that can't be undone. "Type it but don't press Enter until you confirm" would mean watching the terminal. Forking lets this band go out automatically without dirtying any existing session.
- **Short follow-ups skip the model**: for contentless messages like "continue" or "ok", if you sent something from the entry within the last 5 minutes, it continues that session; otherwise it asks you, with the session you were looking at first and the other open sessions after it by recency. This path takes tens of milliseconds.
- **Checks right before delivery**: before typing into an open tab, it re-verifies that the tab still maps to the same process and session, that the session is idle, and that the screen shows no approval prompt and no half-typed draft of yours. If any check fails, it only switches to the tab and copies your sentence to the clipboard. It never starts a second process on a session that is already running.
- **Which terminal a new session opens in**: the one you were looking at when you opened the input box; otherwise the one that is running (iTerm if both are); if neither is running, iTerm, or Terminal when iTerm isn't installed. Set `NTR_TERMINAL=iterm` or `NTR_TERMINAL=terminal` to pin it.
- **Terminal opens a new window**: Terminal's scripting interface can only open windows; a tab would need simulated keystrokes that steal focus, so it doesn't. If Terminal isn't running, it is started without an extra blank window and brought to the front once the window is ready, the same as a cold-started iTerm. If Terminal is already running, it doesn't steal focus.
- **iTerm not running**: it starts iTerm first; if iTerm opens its own blank window on launch, the session goes into that window instead of leaving an empty tab behind.

## How accurate is it?

The short version: **now that the model also picks the thread inside a project, almost every automatic send is fully right, but the automatic share drops from about 38% to about 15%; the rest asks you to press Enter once.** This version (v3.1) has only been evaluated on the development set. It missed the automatic-rate bar set in advance, so the held-out set was not run.

Evaluated on about a month of the author's real local history ([method and data](ops/research/route-accuracy-2026-10.md), in Chinese). An automatic send counts as fully right only if both project and thread are right: a continuation must land in the session you actually returned to, and a new task must be routed to a new thread. A wrong project is a hard error.

Development set, 433 samples, both versions run once on the same data. 29% are contentless follow-ups like "continue" or "ok"; offline there is no entry context, so they all go to confirmation.

| Version | Automatic (share of all) | Fully right | Right project, wrong thread | Wrong project | ≥ 0.95 direct |
| --- | --- | --- | --- | --- | --- |
| v3.0: model picks the project, rules pick the session | 163 (38%) | 116 | 41 | 6 | 62, 0 wrong project |
| v3.1: model picks project and thread | 64 (15%) | 58 | 5 | 1 | 0 |

- v3.1's confidence covers project and thread together, and the model gives lower numbers than for the project alone (at most 0.93). So this version never writes directly into an original session; every automatic continuation is forked. The confidence is honest: above 0.85, 91% are fully right; around 0.8, 87%.
- Most of the drop comes from new tasks: for sentences that really started a new thread, the model usually says "new" too, but is unsure which project it belongs to, mostly below 0.6.
- v3.0 on the 253-sample held-out set (2026-10-19): 36% automatic, 4 wrong-project sends (all in the forked tier), 20 sends at ≥ 0.95 with no wrong project.
- You can pick the thresholds: `NTR_ROUTER_MIN_CONFIDENCE` is the direct line (default 0.95) and `NTR_ROUTER_FORK_CONFIDENCE` the forked line (default 0.85). Setting both to 0.95 turns the forked tier off.
- The fast path for short follow-ups depends on a live entry signal (the previous sentence) that historical data lacks, so its accuracy is not yet measured; only the rules are.
- Each decision takes about 5 seconds at p50 and 8 seconds at p90, mostly `claude -p` startup and Opus inference; at API prices that is about $0.06 per decision (no extra charge on a subscription). The fast path takes tens of milliseconds.

The sample is small and reflects one person's habits. These numbers describe this data, not a general error rate.

## Swappable routing model

Routing only decides where a sentence goes. It is separate from the Claude Code / Codex session that does the work, so you can change the model:

| Setting | Effect |
| --- | --- |
| (default) | Opus via local `claude -p`, using your Claude subscription, with no API key |
| `NTR_ROUTER_MODEL=sonnet` | Any other model `claude -p` supports |
| `NTR_ROUTER_MIN_CONFIDENCE=0.97` | Confidence threshold for direct delivery (default 0.95); higher means fewer sends straight into the original session |
| `NTR_ROUTER_FORK_CONFIDENCE=0.9` | Confidence threshold for forked delivery (default 0.85); below it you confirm. It can't be higher than the direct threshold; a bad value is an error |
| `NTR_ROUTER_BACKEND=openrouter` + `openrouter_api_key` | The same candidates, prompt, and gate via [OpenRouter](https://openrouter.ai); combine with e.g. `NTR_ROUTER_MODEL=deepseek/deepseek-v4.1-flash` to pick any model |
| `NTR_ROUTER=interim` | Use Jev (`typesafe/jev-1.13`) on OpenRouter Decisions to choose |

You can also implement the [`Router`](src/layers/types.ts) interface yourself. One caveat: the accuracy above was measured with the default Opus. In the same eval, DeepSeek V4.1 Flash, GPT-5.6 Luna, Qwen3.8 Flash, and Haiku 5.5 picked the right first choice only 54–66% of the time, versus about 73% for Opus. Try `npm run ntr -- route` on your own sessions before switching.

## Known limitations

- macOS with iTerm2 or Terminal only. Sessions open in other terminals such as Ghostty or Warp can't be typed into; you get a notice and the sentence is copied to your clipboard.
- Claude Code keeps 30 days of history by default, so older sessions can't be resumed.
- A Codex session started with `--remote` can't be detected as running.
- Routing needs a logged-in `claude`, and it is slow (see above).
- The input box is in English or Chinese; the command-line tool's messages and logs are still in Chinese.

## Data and privacy

- **Stays on your Mac**: the session index cache and the entry log live in `~/.ntr/` (`cache/` is safe to delete; `entry-log.jsonl` feeds the ← history list; before 0.3 the directory was `~/.jev/` and is renamed as-is on first launch). Native history is never modified.
- A forked delivery adds one more session file to the native directories (`~/.claude/projects` for Claude Code, `~/.codex/sessions` for Codex). It holds a copy of the original session plus the new message with its routing note; the original file is unchanged. Delete forks you don't need like any other session.
- **Leaves your Mac**: for each decision, bounded snippets of candidate sessions (per card, the title, first message, and last two messages at about 120–160 characters each, plus a reply snippet) and your sentence go to Anthropic through your local `claude -p`. With the OpenRouter backend, they go to OpenRouter and the provider it routes to, with no data retention or training requested. Credentials shaped like `sk-…`, `ghp_…`, `AKIA…`, or `token=…` are masked first. Full conversations are never sent.
- Once delivered, your message is handled by native Claude Code / Codex as usual.

## Development

```bash
npm test                                 # type check + all offline contracts (no terminal, no model calls)
scripts/fresh-install.sh                 # clean clone → npm ci → npm test → read sessions → one real routing decision
npm run entry:ux                         # entry UI acceptance (real window + stub CLI, sends nothing real)
NTR_LIVE_ITERM=1 npm run open:live       # real iTerm end-to-end: opens a test window in your iTerm and runs real claude/codex; off by default
NTR_LIVE_TERMINAL=1 npm run terminal:live  # real Terminal acceptance: tests only in Terminal windows it opens, closes them one by one; off by default
```

The layered code is in [`src/layers/`](src/layers): `providers/` (who owns a session: claude, codex), `surfaces/` (where it is shown: iterm, terminal, with multi dispatching between them), `router/` (deciding the destination), and `open.ts` (orchestration). The entry is in [`entry/`](entry). The contract between layers is [`src/layers/types.ts`](src/layers/types.ts).

## License

[MIT](LICENSE)
