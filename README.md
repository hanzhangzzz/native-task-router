# Native Task Router

**按一个快捷键，说一句话，接着上次那个 AI 会话干活。**

**[⬇ 下载 macOS 版](https://github.com/hanzhangzzz/native-task-router/releases/latest)**（Apple 芯片）· [English](README.en.md) · macOS + iTerm2 · Claude Code / Codex · MIT

https://github.com/user-attachments/assets/684fab3c-b819-46d8-9556-9d4d585ee505

**新开一个 AI 会话，等于让它失忆。** 最完整的上下文就在原生会话记录里，`claude -r` 和 `codex resume` 能把它原样恢复。难的是记住它在哪。

Native Task Router 替你记。它在你本机所有 Claude Code / Codex 会话里，找到这句话该去的那个，在你自己的 iTerm 里续上；没有合适的，就新开一个。

```
以前   想起"限流那块还没做完"
       → 那是哪个项目来着？cd ~/code/shop-api
       → 当时用的 Claude 还是 Codex？codex resume
       → 在一长串会话里找到它，再把话敲进去

现在   ⌃⌥Space → "限流那块再加一个按用户维度的配额" → 回车
       → 那个会话正开着，就切到它的 iTerm 标签页写进去
       → 没开着，就新开一个标签页，用原生 resume 带着完整上下文续上
```

先零风险试一下，它只告诉你会发去哪，不碰任何会话：

```bash
npm run jev -- route "限流那块再加一个按用户维度的配额"
```

## 为什么不直接用 resume

| | 自己找 | 用它 |
| --- | --- | --- |
| 找到会话 | 记住项目目录和工具，`cd` 进去，再翻 resume 列表 | 说一句话，跨项目、跨 Claude Code / Codex 一起找 |
| 上下文 | 新开会话，或者靠记忆、摘要，都是压缩过的 | 原生 resume，完整的会话记录 |
| 界面 | 换一个新桌面 app，重新学一遍 | 还是你的 iTerm 和原生 TUI，审批、工具照旧 |
| 送错怎么办 | 不存在，因为全靠你自己 | 拿不准就让你选；240 条留出评测里自动送达没有一次送错 |

**它不和 Claude Code、Codex 抢饭碗。** 不跑 Agent，不托管终端，不替你批审批，只负责"这句话该去哪"。它们越强，它越好用；判断去处的路由模型也可以换。

## 下载安装

1. 从 [Releases](https://github.com/hanzhangzzz/native-task-router/releases/latest) 下载 `Native-Task-Router-<版本>-arm64.dmg`，把应用拖进"应用程序"。目前只有 Apple 芯片版本。
2. **第一次打开会被 macOS 拦下**：应用没有经过苹果公证（作者没有开发者证书）。打开"系统设置 → 隐私与安全性"，在页面下方点"仍要打开"。也可以在终端执行 `xattr -dr com.apple.quarantine "/Applications/Native Task Router.app"`。
3. 打开后它常驻在菜单栏（`›_` 图标），默认开机自动启动。按 **Control+Option+Space** 唤起输入框；菜单里可以改快捷键、关掉开机启动、退出。
4. 第一次使用时，macOS 可能会询问是否允许它控制 iTerm 和"系统事件"，点允许：它要据此找到你正在看的标签页，并把话写进去。

同样需要：iTerm2、已登录的 Claude Code（`claude`，用来判断去处）；续 Codex 会话需要已登录的 `codex`。

## 从源码运行

**前置条件**：macOS、[iTerm2](https://iterm2.com)、Node.js ≥ 24（已在 25.5 上测试）、已登录的 [Claude Code](https://docs.claude.com/en/docs/claude-code)（`claude` 在 PATH 里）。要续 Codex 会话，还需要已登录的 `codex`。

> 默认用你本机的 `claude -p --model opus` 判断去处，走你自己的 Claude 订阅，不需要额外的 API key。每次判断会把候选会话的摘要片段发给 Anthropic，详见[数据与隐私](#数据与隐私)。命令和配置沿用内部代号 jev：`npm run jev`、`JEV_*` 环境变量、`~/.jev/` 数据目录。

```bash
git clone https://github.com/hanzhangzzz/native-task-router.git && cd native-task-router
npm ci                                   # 会顺带下载 Electron

npm run jev -- sessions                  # 它认识你的哪些会话（最近的在前）
npm run jev -- route "帮我写一个统计 nginx 日志里每小时 5xx 数量的小脚本"
```

```
新建 claude 会话（会自动新建）
236 个会话 · 3862ms · opus
```

觉得判断靠谱，就把入口常驻起来，按 **Control+Option+Space** 说话：

```bash
npm run entry                            # 常驻入口（JEV_HOTKEY 可改快捷键）
scripts/login-item.sh install            # 可选：登录后自动启动；uninstall 撤销
```

## 入口怎么用

![拿不准时列出候选，↑↓ 选择、回车确认](docs/images/entry-choose.png)

| 操作 | 作用 |
| --- | --- |
| 回车 / Shift+回车 | 发送 / 换行（输入框跟着内容长高） |
| ↑ ↓ + 回车 | 拿不准时在候选里选；也可以按 1–9 直选，N 新建 |
| ←（光标在开头） | 展开你发过的会话；选中后这句话**确定地**发过去，不经过判断 |
| Esc | 关掉；没发出去的话，下次打开还在 |

输入框的界面语言跟随 macOS（中文或英文）；`JEV_LANG=zh` 或 `en` 可以指定。

![← 展开历史会话](docs/images/entry-history.png)

命令行也能做同样的事：`npm run jev -- open "<一句话>"` 真实送达，`--pick claude:<会话id>` 指定目标，`--new claude|codex` 直接新建。

## 它怎么工作

```
一句话 ─▶ 本机会话索引 ─▶ 候选 ─▶ Opus 判断 ─▶ 闸门 ─┬─▶ 写进正开着的 iTerm 标签页
                                                     ├─▶ 新标签页 claude -r / codex resume
                                                     └─▶ 新标签页新建会话
```

- **索引**：直接读原生历史（`~/.claude/projects`、`~/.codex/sessions`），只收你亲手用过的交互式会话，排除 `claude -p`、`codex exec`、子代理和临时探针。增量缓存，热刷新几十毫秒。
- **候选**：最近活跃的 15 个，加上和这句话字面最相关的 15 个，再加上你上一句发往的、你唤起入口时正看着的、正开在终端里的会话。
- **判断**：每个候选压成一张小卡片（标题、第一句、最近两句、最后回复的片段、项目、多久前活跃），连同你的上一句一起交给模型，要它给出去处、置信度和前三名。
- **闸门**：只有置信度 ≥ 0.9，并且这句话有具体内容（"继续""好的"这类不算）才自动送达。否则列出前三个候选，预选第一个，回车就送。模型出错、超时，一律不自动。
- **送达前再核对一次**：要写进已开着的标签页，先确认"标签页 → 进程 → 会话"还是那个、会话空闲、屏幕上没有审批框，也没有你打了一半的草稿。任何一条不满足，就只切过去，把这句话放进剪贴板。同一个会话已经在跑，就绝不再开第二个进程去写它。

## 路由准不准

先说结论：**宁可多让你按一次回车，也不把话送错地方。**

在作者本机约一个月的真实历史上评测（[方法与完整数据](ops/research/route-accuracy-2026-10.md)）：

- 留出集 240 条，只跑一次：自动送达 22 条，**没有一条送进错误的会话**。
- 但说实话，自动的比例只有一成左右，大多数时候还是要你按一次回车确认。
- 需要确认时，预选的第一个大约 2/3 是对的；前三个里包含正确去处的，留出集约 77%，开发集约 90%。
- 最难的是"继续""那个再改一下"这种没有内容的短句。它们一律不自动；入口会把你唤起时正看着哪个会话告诉模型，帮这类短句选对。
- 每次判断要 3 到 7 秒，主要花在 `claude -p` 启动和 Opus 推理上。

样本量有限。这些数字说明"在这批数据上没有自动送错"，证明不了"错误率很低"。

## 路由模型可替换

路由只管"这句话该去哪"，跟执行任务的 Claude Code / Codex 是两回事，模型可以换：

| 设置 | 效果 |
| --- | --- |
| （默认） | Opus，经本机 `claude -p`，用你的 Claude 订阅，不需要 API key |
| `JEV_ROUTER_MODEL=sonnet` | 换成 `claude -p` 支持的其他模型 |
| `JEV_ROUTER_BACKEND=openrouter` + `openrouter_api_key` | 同一套候选、提示词和闸门，经 [OpenRouter](https://openrouter.ai) 调用；再用 `JEV_ROUTER_MODEL=deepseek/deepseek-v4.1-flash` 之类指定任意模型 |
| `JEV_ROUTER=interim` | 改用 OpenRouter Decisions 上的 Jev（`typesafe/jev-1.13`）来选 |

也可以自己实现 [`Router`](src/layers/types.ts) 接口，接入别的路由。提醒一句：上面的准确率是用默认 Opus 测的；同一套评测里，DeepSeek V4.1 Flash、GPT-5.6 Luna、Qwen3.8 Flash、Haiku 5.5 的首选正确率只有 54–66%（Opus 约 73%）。换模型之前，先用 `npm run jev -- route` 在自己的会话上试试。

## 已知限制

- 只支持 macOS + iTerm2。在别的终端里开着的会话写不进去，只会提示你，并把这句话放进剪贴板。
- Claude Code 默认只保留 30 天历史，更早的会话续不上。
- Codex 用 `--remote` 新建的会话，判断不了它是否还在运行。
- 判断依赖 `claude` 已登录，而且偏慢（见上）。

## 数据与隐私

- **留在本机**：会话索引缓存和入口记录都在 `~/.jev/`（`cache/` 随时可删；`entry-log.jsonl` 是 ← 历史会话的来源）。不修改任何原生历史。
- **发出去的**：每次判断，把候选会话的有界片段（每张卡片的标题、首句、最近两句各约 120–160 字，加上回复片段）和你这句话，经你本机的 `claude -p` 发给 Anthropic；换成 OpenRouter 后端时，发给 OpenRouter 及它路由到的模型供应商（请求要求不留存、不训练）。发送前会遮掉形如 `sk-…`、`ghp_…`、`AKIA…`、`token=…` 的凭证。不会发送完整对话。
- 送达之后，内容由原生 Claude Code / Codex 按它们自己的方式处理。

## 开发

```bash
npm test                                 # 类型检查 + 全部离线契约（不碰 iTerm、不调模型）
scripts/fresh-install.sh                 # 从零安装自检：干净克隆 → npm ci → npm test → 读会话 → 一次真实判断
npm run entry:ux                         # 入口界面验收（真实窗口 + 桩 CLI，不发真实消息）
JEV_LIVE_ITERM=1 npm run open:live       # 真实 iTerm 端到端：会在你的 iTerm 里建测试窗口、跑真实 claude/codex，默认不运行
```

分层代码在 [`src/layers/`](src/layers)：`providers/`（谁持有会话：claude、codex）、`surfaces/`（在哪展示：iterm）、`router/`（判断去处）、`open.ts`（编排）；入口在 [`entry/`](entry)。各层之间的合同见 [`src/layers/types.ts`](src/layers/types.ts)。

## 许可

[MIT](LICENSE)
