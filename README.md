# Native Task Router

**按一个快捷键说一句话，它在你本机所有 Claude Code / Codex 会话里找到该续上的那个，在你自己的 iTerm 里带着完整的原生上下文续上；没有合适的就新建。**

![拿不准时列出候选，↑↓ 选择、回车确认](docs/images/entry-choose.png)

你同时开着好几个项目、好几个 AI CLI：限流改造在一个 Codex 会话里，数据库迁移在另一个 Claude Code 会话里。想继续时，最麻烦的不是想说什么，而是记起"这件事在哪个目录、哪个工具、哪个会话"，再 `cd` 过去、找到会话、`resume`。

Native Task Router 只做这一件事：**把一句话送到对的原生会话**。它不重写 Agent，也不托管终端：续上靠原生的 `claude -r` / `codex resume`（会话的完整上下文由原生工具恢复），界面就是你自己的 iTerm，审批、工具调用、登录都照旧由原生 TUI 处理。Claude Code 和 Codex 变强，它就跟着变强；判断该续哪个会话的路由模型也可以换（见[路由模型可替换](#路由模型可替换)）。

## 快速开始

**前置条件**：macOS、[iTerm2](https://iterm2.com)、Node.js ≥ 24（已在 25.5 上测试）、已登录的 [Claude Code](https://docs.claude.com/en/docs/claude-code)（`claude` 在 PATH 里）。要续 Codex 会话还需要已登录的 `codex`。

> 路由判断通过你本机的 `claude -p --model opus` 完成，用的是你自己的 Claude 订阅额度，不需要别的 API key。每次判断会把候选会话的摘要片段发给 Anthropic，详见[隐私](#数据与隐私)。

```bash
git clone https://github.com/hanzhangzzz/native-task-router.git && cd native-task-router
npm ci                                   # 会顺带下载 Electron
```

> 命令和配置沿用内部代号 jev：`npm run jev`、`JEV_*` 环境变量、`~/.jev/` 数据目录。

先看看它认识你的哪些会话，再试一句话会被送到哪（**只判断，不送达**）：

```bash
npm run jev -- sessions                  # 列出可路由的交互会话（最近的在前）
npm run jev -- route "帮我写一个统计 nginx 日志里每小时 5xx 数量的小脚本"
```

```
新建 claude 会话（会自动新建）
236 个会话 · 3862ms · opus
```

然后启动入口，按 **Control+Option+Space** 说一句话：

```bash
npm run entry                            # 常驻入口（JEV_HOTKEY 可改快捷键）
scripts/login-item.sh install            # 可选：登录后自动启动；uninstall 撤销
```

成功的样子：一句明确指向某个旧任务的话，会切到 iTerm 里开着该会话的标签页并写进去；那个会话没开着，就新开一个标签页用原生 `resume` 续上；新话题就在新目录里开一个新会话。

## 入口怎么用

| 操作 | 作用 |
| --- | --- |
| 回车 / Shift+回车 | 发送 / 换行（输入框自动长高） |
| ↑ ↓ + 回车 | 拿不准时在候选里选；也可按 1–9 直选，N 新建 |
| ←（光标在开头） | 展开历史会话；选中后这句话**确定地**发往它，不经路由判断 |
| Esc | 关闭；没送出去的话下次打开还在 |

![← 展开历史会话](docs/images/entry-history.png)

命令行有同样的能力：`npm run jev -- open "<一句话>"`（真实送达），`--pick claude:<会话id>` 指定目标，`--new claude|codex` 直接新建。

## 它怎么工作

```
入口（输入框）──一句话──▶ 路由：本机会话索引 → 候选 → Opus 判断 → 闸门
                                                    │
                           ┌────────────────────────┼─────────────────────┐
                    续上开着的会话            续上没开的会话             新建会话
              （写进那个 iTerm 标签页）   （新标签页 claude -r / codex resume） （新标签页 claude / codex）
```

- **索引**：直接读原生历史（`~/.claude/projects`、`~/.codex/sessions`），只收交互式会话，排除 `claude -p`、`codex exec`、子代理和临时目录里的探针；按文件指纹增量缓存，热刷新约几十毫秒。
- **候选**：最近活跃的 15 个 ∪ 和这句话字面最相关的 15 个 ∪ 你上一句发往的会话 ∪ 你唤起入口时正看着的会话 ∪ 开在终端里的会话。
- **判断**：每个候选压成一张卡片（标题、第一句、最近两句、最后回复的片段、项目、多久前活跃、是否正看着/开着），连同你的上一句交给 Opus，输出去处、置信度和前 3 名。
- **闸门**：只有置信度 ≥ 0.9、且这句话有具体内容（不是"继续""好的"这类）时才自动送达；否则列出前 3 个候选，预选第 1 个，回车即送。模型出错、超时或输出无效时一律不自动。
- **送达前核对**：写进已开着的标签页前，重新核对"标签页 → 进程 → 会话"仍是目标、会话空闲、屏幕上没有审批框也没有你没发出的草稿，任何一条不满足就只切过去、把这句话放进剪贴板；一个会话已经在运行时，绝不再开第二个进程写同一个会话。

## 路由模型可替换

路由只负责"这句话该去哪"，和执行任务的 Claude Code / Codex 无关，模型可以换：

| 设置 | 效果 |
| --- | --- |
| （默认） | Opus，经本机 `claude -p`，用你的 Claude 订阅，无需 API key |
| `JEV_ROUTER_MODEL=sonnet` | 换成 `claude -p` 支持的其他模型 |
| `JEV_ROUTER_BACKEND=openrouter` + `openrouter_api_key` | 同一套候选、提示词和闸门，经 [OpenRouter](https://openrouter.ai) 调用；可再用 `JEV_ROUTER_MODEL=deepseek/deepseek-v4.1-flash` 等指定任意模型 |
| `JEV_ROUTER=interim` | 改用 OpenRouter Decisions 上的 Jev（`typesafe/jev-1.13`）做选择 |

也可以自己实现 [`Router`](src/layers/types.ts) 接口接入其他路由。注意：下面的准确率是用默认 Opus 测的；在同一评测上，DeepSeek V4.1 Flash、GPT-5.6 Luna、Qwen3.8 Flash、Haiku 5.5 的首选正确率只有 54–66%（Opus 约 73%），换模型前建议先用 `npm run jev -- route` 在自己的会话上试一试。

## 路由准不准

在作者本机约一个月的真实历史上评测（[完整方法与数据](ops/research/route-accuracy-2026-10.md)）：

- 留出集 240 条只跑一次：自动送达 22 条，**没有一条送进错误的会话**；但自动比例只有约 10%，其余都要你按一次回车确认。
- 拿不准时，预选的第 1 个约 2/3 正确，前 3 个里包含正确去处约 77%（开发集上约 90%）。
- 最难的是"继续""那个再改一下"这类没有内容的短句：它们一律不自动；入口会把你唤起时正看着的会话告诉模型，帮助这类短句选对。
- 每次判断约 3–7 秒（主要是 `claude -p` 的启动和 Opus 推理）。

样本量有限，以上数字证明不了"错误率很低"，只说明在这批数据上没有自动送错。我们选择宁可多让你按一次回车，也不自动送错。

## 已知限制

- 只支持 macOS + iTerm2；在其他终端里开着的会话不能写入，只会提示并把这句话放进剪贴板。
- Claude Code 默认只保留 30 天历史，更早的会话无法续上。
- Codex 用 `--remote` 新建的会话无法判断是否在运行。
- 路由判断依赖 `claude` CLI 已登录；判断较慢（见上）。

## 数据与隐私

- **留在本机**：会话索引缓存与入口记录在 `~/.jev/`（`cache/` 可随时删除；`entry-log.jsonl` 是 ← 历史会话的来源）。不修改任何原生历史。
- **发出去的**：每次判断，候选会话的有界片段（每张卡片的标题、首句、最近两句各约 120–160 字和回复片段）与你这句话，经你本机的 `claude -p` 发给 Anthropic（换成 OpenRouter 后端时发给 OpenRouter 及其路由到的模型供应商，请求要求不留存、不训练）。发送前会遮掉形如 `sk-…`、`ghp_…`、`AKIA…`、`token=…` 的凭证。不会发送完整对话。
- 送达的内容由原生 Claude Code / Codex 按它们自己的方式处理。

## 开发

```bash
npm test                                 # 类型检查 + 全部离线契约（不碰 iTerm、不调模型）
scripts/fresh-install.sh                 # 从零安装自检：干净克隆 → npm ci → npm test → 读会话 → 一次真实路由判断
npm run entry:ux                         # 入口界面验收（真实窗口 + 桩 CLI，不发真实消息）
JEV_LIVE_ITERM=1 npm run open:live       # 真实 iTerm 端到端；会在你的 iTerm 里建测试窗口并运行真实 claude/codex，默认不运行
```

分层结构在 [`src/layers/`](src/layers)：`providers/`（谁持有会话：claude、codex）、`surfaces/`（在哪展示：iterm）、`router/`（路由判断）、`open.ts`（编排），入口在 [`entry/`](entry)。各层之间的合同见 [`src/layers/types.ts`](src/layers/types.ts)。

## 许可

[MIT](LICENSE)
