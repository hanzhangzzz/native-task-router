# Native Task Router

**Press a hotkey, say one sentence, and pick up the AI session you left off in.**

**[⬇ Download for macOS](https://github.com/hanzhangzzz/native-task-router/releases/latest)** (Apple silicon) · [中文](README.zh-CN.md) · macOS + iTerm2 / Terminal · Claude Code / Codex · MIT

https://github.com/user-attachments/assets/f5c2aade-38ee-4310-a9bd-0a5ddf0957f3

**A fresh AI session starts with amnesia.** The most complete context lives in the native session log, and `claude -r` / `codex resume` restore it exactly. The hard part is remembering where that session is.

Native Task Router remembers for you. It searches every Claude Code and Codex session on your Mac, finds the one this sentence belongs to, and continues it in your own iTerm or Terminal. If nothing fits, it starts a new one.

```
Before   You remember "the rate-limit work isn't done"
         → which project was that? cd ~/code/shop-api
         → was it Claude or Codex? codex resume
         → scroll a long session list, find it, type your message

Now      ⌃⌥Space → "add a per-user quota to the rate limiter" → Enter
         → if that session is open, type it into its tab (iTerm or Terminal) without switching you there; if it's mid-task, the tool queues it after the current turn
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
| Interface | Learn yet another desktop app | Your iTerm / Terminal and the native TUI; when a task stops to ask, its options come back into the input box |
| Wrong destination | Can't happen, you did it yourself | When unsure, it asks you to pick; medium-confidence continuations go into a fork, leaving the original untouched |

**It doesn't compete with Claude Code or Codex.** It runs no agent, hosts no terminal, and never approves anything for you. It only decides where a sentence should go. The better they get, the more useful it gets, and the routing model itself is swappable.

## Download

**With Homebrew**:

```bash
brew trust hanzhangzzz/tap                              # third-party taps must be trusted first; some Homebrew versions refuse them otherwise
brew install --cask hanzhangzzz/tap/native-task-router
```

Then continue from step 2. From 0.7.0 on, the menu bar icon shows ↑ when a new version is out; click **Update to x.y.z and restart** to upgrade in place (the download must match the published SHA-256 and the same signing certificate). `brew upgrade --cask native-task-router` works too.

**Or download the dmg by hand**:

1. Download `Native-Task-Router-<version>-arm64.dmg` from [Releases](https://github.com/hanzhangzzz/native-task-router/releases/latest) and drag the app into Applications. Apple silicon only for now.
2. **macOS blocks the first launch**: the app is not notarized (the author has no Developer ID). Open System Settings → Privacy & Security and click "Open Anyway" near the bottom, or run `xattr -dr com.apple.quarantine "/Applications/Native Task Router.app"`.
3. It then lives in the menu bar (a small speech bubble with an arc to a star) and starts at login by default. Press **Control+Option+Space** to open the input box; the menu lets you change the hotkey, pick a skin for the input box (Aurora by default, plus Neon, Phosphor, Daylight, Ember, Candy, Comic and Pixel), turn off start-at-login, or quit.
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
| ← (caret at start) | Open the task list: tasks open in your terminal first (in tab order, with their status and the agent's last reply), then other recent sessions. Type to filter, press a digit to pick, ⌘N to start a new one in that project. Picking one sends there **deterministically**, skipping the routing step |
| Esc | Close; anything you haven't sent is still there next time |

The input box follows your macOS language (English or Chinese); set `NTR_LANG=en` or `zh` to force one.

### Approving from the entry (0.12.0)

When a task stops in the terminal to ask (Claude Code's "Do you want to proceed?", Codex's numbered choices), your sentence is held instead of sent: the question and options come back into the input box, and you pick with ↑↓ or a digit and confirm with Enter. It presses the arrow keys and Enter in that tab for you, waits until the screen leaves the choice box, then delivers the held sentence automatically.

- Tasks waiting on you are marked "awaiting approval" in the task list; picking one goes straight to its options. If answering brings up the next question, that one comes back too.
- Options are parsed from the screen's numbering starting at 1, and the arrows walk down from the currently highlighted one. If the screen is no longer on a choice box, nothing is pressed and the sentence is delivered as usual.
- Only arrow keys and Enter are ever pressed; nothing else is touched.

The CLI can do the same: `npm run ntr -- open "<sentence>"` delivers for real, `--pick claude:<session-id>` sets the target, `--new claude|codex` starts a new session, and `--answer <n>` picks option n in a choice box and then delivers the sentence.

New sessions go to `~/ntr-tasks/<short name>-<number>`; set `NTR_TASKS_DIR` to use another folder.

## Voice wake (experimental)

Turn on **Voice wake** in the menu bar, then say **"小卡拉米"** (xiǎo kǎ lā mǐ; change it under **Change wake word…**, any 3–6 Chinese characters) and your task, in one breath or after the chime. Waking opens the same input box as the hotkey, and your words appear in it as you speak. When you stop, it sends after a 3-second countdown: press any key to stop the countdown and edit, or Esc to cancel. The result is shown in the box and read back to you; when routing is unsure, the options are listed in the box as usual. If the box already holds an unsent message, the spoken text is added after it and nothing is sent automatically.

- The first time, macOS asks for microphone access and the app downloads ~130 MB of models into `~/.ntr/cache/models`.
- Everything runs offline with [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) and the [X-ASR](https://github.com/Gilgamesh-J/X-ASR) Mandarin–English model; no audio leaves your Mac and nothing is recorded to disk. Each sentence is transcribed locally and the wake word is matched by pinyin, allowing for how it's said in casual speech ("小卡了你" counts) — but only near the start of an utterance (at most two filler syllables before it): similar syllables buried mid-sentence in background conversation don't wake it (since 0.13.2). Each wake is logged with its transcript line to `~/.ntr/cache/wake-log.jsonl` so false triggers can be traced.
- Mixed Chinese and English works ("用 Codex 跑一下 npm test"). Common developer words and the project names of your recent sessions are passed to the recognizer as hotwords, so they come out spelled right. Whatever it still gets wrong, you can fix during the countdown; the router and the agent are language models and read past the odd homophone.
- The macOS microphone indicator is on exactly while voice wake is on; turning it off releases the microphone. Listening costs about 2% of one CPU core and ~300 MB of memory (the speech model).
- If it doesn't wake, raise the input volume in System Settings → Sound → Input.

The listener can also run on its own, from a terminal or another machine (needs ffmpeg):

```bash
cd satellite && npm install && npm run models
npm start                          # NTR_VOICE_DEBUG=1 prints every sentence it hears; NTR_WAKE_WORD=… changes the wake word
npm start -- --wav x.wav           # a 16 kHz mono recording instead of the microphone
```

`NTR_MIC=<index>` picks another input (`ffmpeg -f avfoundation -list_devices true -i ""` lists them). The app takes the sentence on `127.0.0.1:47615` (`NTR_VOICE_PORT`) and only accepts requests that carry the token in `~/.ntr/voice-token`, so web pages can't post to it.

## Optional remote add-on

The public repository and app are a complete local desktop product: input box, session index, routing, native terminal delivery, local voice and updates build and run independently. Starting with 0.14.0, the phone page, remote bridge, authentication and relay implementation belong to a separate private add-on and are absent from public source and app packages.

Obtain the add-on from a trusted source, extract it, then choose **Install remote add-on…** from the app menu and select its directory. It executes with local permissions; format and version validation are not a security certification. Remote access stays off after every successful install or update. Enable it explicitly from the menu; later normal launches restore the setting you enabled.

Before upgrading from 0.13.3 or an earlier integrated version, obtain the add-on. Without it the app provides local features only. Existing remote configuration, tokens and task history are kept. The add-on lives outside the app bundle and survives local app updates; uninstalling it also keeps configuration and history. Historical public source, tags and releases remain available.

## How it works

```
sentence ─▶ local session index ─▶ group by project, list recent threads ─▶ Opus picks project + thread (or new) ─▶ gate ─┬─▶ type into the open terminal tab
                                                                                                                    ├─▶ new tab: claude -r / codex resume
                                                                                                                    ├─▶ new tab: new session in that project dir
                                                                                                                    └─▶ middle-tier continuation: new tab, forked; original untouched
```

- **Index**: reads native history directly (`~/.claude/projects`, `~/.codex/sessions`) and keeps only interactive sessions, excluding `claude -p`, `codex exec`, subagents, and temp-dir probes. Codex 0.163+ compresses older sessions into `.jsonl.zst`; those are read too, decompressed on the fly without touching the files. The cache is incremental, so a warm refresh takes tens of milliseconds; the first run after an upgrade rebuilds it, about 2 seconds for a thousand Codex sessions.
- **Project and thread in one decision**: sessions are grouped by project directory (the 40 most recently active projects). Each project lists up to 4 threads active in the last 14 days (or its latest one if none), each with its tool, last activity, status (focused / open / running / closed), and a one-line topic (first and latest message). Together with your previous sentence, this goes to the model, which answers which project the sentence belongs to and whether it continues one of its threads or starts a new one there (or belongs to no existing project), with one confidence for the project and one for the thread, a short reason, and its top three. One project often has several tasks in parallel, so the focused tab, the latest thread, and open tabs are only weak hints; the thread is chosen by how well the sentence matches each thread's topic.
- **Which tool a new thread uses**: the tool of that project's latest session, unless the sentence explicitly names one ("use codex …", "let Claude …"). Claude Code / Codex load memory and CLAUDE.md themselves.
- **The gate**: it sends automatically only with at least 0.85 confidence in the project and at least 0.7 in the thread (which one to continue, or that it should be new); if either falls short, you confirm.
  - **Project ≥ 0.95 and thread ≥ 0.85, direct**: types into the open tab, or resumes the session natively.
  - **Other automatic continuations, forked**: still sent automatically, but the original session is never touched. It forks that session into a new one (`claude -r <id> --fork-session` / `codex fork <id>`) that carries all of its context and receives the sentence in a new tab. The original session's history file doesn't change by a single byte, even if it is open in a terminal right now. One routing note goes in front of the text: the message was delivered automatically, with this confidence, and if it is unrelated to the project or session, the agent should say so and stop without changing any files.
  - **A new thread, started automatically only when most confident**: only with project ≥ 0.95 does it start a new session in that project directory (or a new directory if it belongs to no project), with no fork; the new session also starts with a note: this message was started automatically in project X, and if it doesn't belong there, the agent should say so and stop. Below 0.95 you confirm, with "new session in project X" preselected, so Enter does it. A new session has neither an original session to protect by forking nor an existing thread to anchor it, so it gets the same bar as direct delivery.
  - **Not confident enough, you confirm**: it lists the model's top projects, each with its best thread there or a new one, with the first preselected, so Enter sends it.
  - Model errors and timeouts never auto-send. Whatever you pick by hand in the entry (← task list, the candidate list, new) is always delivered directly, without a note.
  - Why a forked tier: a wrong send writes the sentence and the agent's reply into the wrong session's native history, and that can't be undone. "Type it but don't press Enter until you confirm" would mean watching the terminal. Forking lets this band go out automatically without dirtying any existing session. A wrong thread in the forked tier doesn't dirty the original session; the cost is that the new session lacks the context you meant to continue.
- **Short follow-ups skip the model**: for contentless messages like "continue" or "ok", if you sent something from the entry within the last 5 minutes, it continues that session; otherwise it asks you, with the session you were looking at first and the other open sessions after it by recency. This path takes tens of milliseconds.
- **Checks right before delivery**: before typing into an open tab, it re-verifies that the tab still maps to the same process and session and that the screen holds no half-typed draft of yours. A screen stopped on an approval prompt no longer blocks delivery: the sentence is held, the question and options come back into the entry for you to pick (see above), and after the arrows and Enter are pressed and the screen leaves the choice box, it is delivered automatically. A session that's busy is fine: Claude Code and Codex queue the message after the current turn. After typing it in, you stay where you are; only if a check fails does it switch to the tab and copy your sentence to the clipboard. It never starts a second process on a session that is already running.
- **Which terminal a new session opens in**: the one you were looking at when you opened the input box; otherwise the one that is running (iTerm if both are); if neither is running, iTerm, or Terminal when iTerm isn't installed. Set `NTR_TERMINAL=iterm` or `NTR_TERMINAL=terminal` to pin it.
- **Terminal opens a new window**: Terminal's scripting interface can only open windows; a tab would need simulated keystrokes that steal focus, so it doesn't. If Terminal isn't running, it is started without an extra blank window and brought to the front once the window is ready, the same as a cold-started iTerm. If Terminal is already running, it doesn't steal focus.
- **iTerm not running**: it starts iTerm first; if iTerm opens its own blank window on launch, the session goes into that window instead of leaving an empty tab behind.

## How accurate is it?

The short version: **five in six automatic sends get both project and thread right, and the tier that writes straight into an original session never hit the wrong project; 28% of sentences go out automatically, and the rest ask you to press Enter once.**

Evaluated on about a month of the author's real local history ([method and data](ops/research/route-accuracy-2026-10.md), in Chinese). Held-out set, 253 samples. An automatic send counts as fully right only if both project and thread are right: a continuation must land in the session you actually returned to, and a new task must be routed to a new thread. 31% of the samples are contentless follow-ups like "continue" or "ok"; offline there is no entry context, so they all go to confirmation.

**The numbers below are a post-hoc filter of a single held-out run, not an independent validation.** The held-out set was run once (when the bar for new sessions was still 0.85 and the thread gate was 0.7). The rule "start a new session automatically only at 0.95 or above" was adopted after seeing those results, and the table applies it to the same results. The thread gate 0.5 (default since 0.12.1) was likewise applied post-hoc to the same run — the development set had no rows where it makes a difference, so 0.5 was picked after seeing this run; the entry log now records both confidences to retune on real usage later.

| | Automatic (of 253) | Fully right | Right project, wrong thread | Wrong project | Written into the original session (wrong project) | Forked fully right | New sessions fully right |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Default (thread gate 0.5) | 72 (28%) | 59 | 10 | 3 | 14 (0) | 43 / 53 | 4 / 5 |
| Thread gate 0.7 (the setting shipped in 0.6.0–0.12.0) | 60 (24%) | 50 | 7 | 3 | 14 (0) | 35 / 42 | 3 / 4 |
| Thread gate 0 | 74 (29%) | 59 | 12 | 3 | 14 (0) | 43 / 55 | 4 / 5 |
| 0.5.0 (model picks the project, rules pick the session) | 91 (36%) | 68 | 17 | 6 | — | — | — |

- Compared with 0.5.0, fewer sentences go out automatically, and the ones that do are more accurate: fully right rises from three in four to five in six, wrong-project sends drop from 6 to 3, and "new session in the wrong project" drops from 6 to 1 (same held-out set, same counting). 0.5.0 was originally reported as 70 / 17 / 4 because that count did not check which project a new session landed in; 2 of them landed in the wrong one. Here it is recounted with "both project and thread right".
- For more automatic sends, set `NTR_ROUTER_THREAD_CONFIDENCE` to 0: about 29% automatic, at the cost of more wrong threads (all in the forked tier, so the original session is untouched; the new session just lacks the context you meant to continue). The 0.12.1 default of 0.5 sits between: +12 automatic sends over 0.7 on the same run, 9 of them fully right, and no new wrong-project sends — the extra cost is 3 wrong-thread forks.
- The 3 remaining wrong-project sends: 2 in the forked tier, original sessions untouched; 1 new session for a sentence that belonged to a directory you had just created, placed into an existing project instead.
- Each decision takes about 5 seconds at p50 and 8 seconds at p90, mostly `claude -p` startup and Opus inference; at API prices that is about $0.09 per decision (no extra charge on a subscription). The fast path takes tens of milliseconds.

The sample is small and reflects one person's habits. These numbers describe this data, not a general error rate.

## Swappable routing model

Routing only decides where a sentence goes. It is separate from the Claude Code / Codex session that does the work, so you can change the model:

| Setting | Effect |
| --- | --- |
| (default) | Opus via local `claude -p`, using your Claude subscription, with no API key |
| `NTR_ROUTER_MODEL=sonnet` | Any other model `claude -p` supports |
| `NTR_ROUTER_MIN_CONFIDENCE=0.97` | Project confidence needed to write straight into the original session (default 0.95); higher means fewer direct sends |
| `NTR_ROUTER_FORK_CONFIDENCE=0.9` | Project confidence needed for any automatic delivery (default 0.85); below it you confirm. It can't be higher than the direct threshold; a bad value is an error |
| `NTR_ROUTER_THREAD_CONFIDENCE=0` | Thread confidence needed for automatic delivery (default 0.5 since 0.12.1); higher means fewer automatic sends with more accurate threads, 0 ignores the thread, see the table above |
| `NTR_ROUTER_NEW_CONFIDENCE=0.97` | Project confidence needed to start a new session automatically (defaults to `NTR_ROUTER_MIN_CONFIDENCE`); it can't be lower than the forked threshold, and a bad value is an error |
| `NTR_ROUTER_BACKEND=openrouter` + `openrouter_api_key` | The same candidates, prompt, and gate via [OpenRouter](https://openrouter.ai); combine with e.g. `NTR_ROUTER_MODEL=deepseek/deepseek-v4.1-flash` to pick any model |
| `NTR_ROUTER=interim` | Use Jev (`typesafe/jev-1.13`) on OpenRouter Decisions to choose |

You can also implement the [`Router`](src/layers/types.ts) interface yourself. One caveat: the gate thresholds were calibrated for the default Opus, and other models report confidence differently. Try `npm run ntr -- route` on your own sessions before switching.

## Known limitations

- macOS with iTerm2 or Terminal only. Sessions open in other terminals such as Ghostty or Warp can't be typed into; you get a notice and the sentence is copied to your clipboard.
- Claude Code keeps 30 days of history by default, so older sessions can't be resumed.
- A Codex session started with `--remote` can't be detected as running.
- Approvals are recognized by the common questions and numbered choices starting at 1; other styles aren't detected, and the sentence is copied to the clipboard with a switch to the tab, with nothing pressed.
- Routing needs a logged-in `claude`, and it is slow: each decision waits for `claude -p` to start and Opus to answer; the short-follow-up fast path skips the model.
- The input box is in English or Chinese; the command-line tool's messages and logs are still in Chinese.

## Data and privacy

- **Stays on your Mac**: the session index cache and the entry log live in `~/.ntr/` (`cache/` is safe to delete; `entry-log.jsonl` records what you sent from the entry, which the router uses to understand short follow-ups like "continue"; before 0.3 the directory was `~/.jev/` and is renamed as-is on first launch). Native history is never modified.
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

Release order: publish the GitHub Release → `scripts/release-cask.sh <version>` to sync the Homebrew cask → `scripts/verify-install.sh <version>` to check the install path a stranger would take. It installs with a fresh Homebrew in a temporary directory, downloads from the Release again, checks the hash, version, signature, quarantine flag and Gatekeeper assessment, then runs one decide-only route against sample history. It doesn't touch your Homebrew, your installed app or your session data, and deletes everything when done. It can't cover the first launch on a brand-new macOS.

The layered code is in [`src/layers/`](src/layers): `providers/` (who owns a session: claude, codex), `surfaces/` (where it is shown: iterm, terminal, with multi dispatching between them), `router/` (deciding the destination), and `open.ts` (orchestration). The entry is in [`entry/`](entry). The contract between layers is [`src/layers/types.ts`](src/layers/types.ts).

## License

[MIT](LICENSE)
