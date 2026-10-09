# Claude Codex Bridge

用 Claude 桌面版写方案和验收，用本地 Codex（跑你自己的中转模型）一次只执行一个任务。

Claude 只负责“写方案、看检查点、写下一版方案”，所以它会话里的 token 消耗很小；
真正读代码、改文件、跑命令的是 Codex，过程在本地页面里实时显示，不占 Claude 的上下文。

## 它怎么工作

1. 你在 Claude 里把方案写好。
2. Claude 调用 `codex_start`，把项目路径和整份方案交给桥接器。
3. 桥接器把方案写成项目里的 `PLAN.md`，拆成任务，只启动第一个任务（`T1`）。
4. Codex 干完一个任务就停下，Claude 收到一份检查点，等你回复「继续」。
5. 你回复「继续」后，Claude 调用 `codex_continue`，只启动下一个任务。
6. 全部任务完成后，最终报告以普通消息出现在 Claude 对话里，同时写进项目里的 `REPORT.md`。

约束：一次只跑一个任务、每个任务后必须由你点头、查看页面只监听 `127.0.0.1`、
不给 Claude 任何通用 shell 工具。

## 安装前检查

在 `outputs/claude-codex-bridge` 目录里执行：

```powershell
npm install
npm run smoke
```

`npm run smoke` 是自检命令，会逐行打印：

- `node:` 使用的 Node 可执行文件
- `codex:` 找到的 Codex 可执行文件
- `session root:` 会话和日志目录
- `claude config:` Claude 桌面版配置文件
- `claude config` 后面的括号状态：`installed` / `not installed` / `stale` / `invalid` / `unreadable`
- `viewer:` 本地页面能否绑定 `127.0.0.1` 并正确返回
- `provider:` 中转服务能否连上（只打印主机和端口，不打印任何密钥）

只要 Codex 可执行文件找不到、Node 找不到或会话目录不可写，自检会以非 0 退出码结束；
Claude 配置没装、中转服务没开只会出现在 `warning:` 行里。
想检查别的主机或端口，可以设置 `CODEX_BRIDGE_PROVIDER_HOST` / `CODEX_BRIDGE_PROVIDER_PORT`。

## 安装 MCP 条目

```powershell
npm run install-claude
```

它会：

- 先备份现有配置为 `claude_desktop_config.json.backup-<时间戳>`，并打印备份路径；
- 保留配置里原有的 `preferences` 和其它 `mcpServers` 条目；
- 只写入（或更新）`mcpServers.claude-codex-bridge`，指向当前 Node 和 `src/server.mjs` 的绝对路径。

重复执行是安全的：内容一致时不会改动文件，也不会产生新备份。
安装脚本会优先使用实际存在的 `%LOCALAPPDATA%\Claude-3p\claude_desktop_config.json`；
没有这个文件时才使用 `%APPDATA%\Claude\claude_desktop_config.json`。
用 `npm run install-claude -- --config <路径>` 可以对其它配置文件试装，
或者设置 `CLAUDE_DESKTOP_CONFIG_PATH` 指定配置文件。

## 重启 Claude 桌面版

配置文件只在启动时读取，所以安装后必须**完全退出** Claude 桌面版
（包括右下角托盘图标里的进程），再重新打开。

重开后，Claude 的工具列表里应该出现这些工具：
`codex_start`、`codex_watch`、`codex_continue`、`codex_retry`、`codex_cancel`、
`codex_status`、`codex_open_viewer`。

## 开始一份方案

1. 在 Claude 里让它写方案（只写“做什么、怎么算做完”，不要贴整份源码）。
2. 让 Claude 调用 `codex_start`：
   - `repoPath`：项目文件夹的绝对路径
   - `planMarkdown`：整份方案原文
   - `checkpointMode`：`per_task`
   - 可选 `writeMode`：`workspace-write`（默认）或 `read-only`
3. 桥接器会校验路径、写 `PLAN.md`、创建会话，并且只启动 `T1`。

如果项目里已经有 `PLAN.md`，桥接器不会覆盖，会先停下来问你；
你确认后，Claude 再带 `overwritePlan: true` 重新调用一次。

## 看实时执行过程

任务启动后，本机会自动弹出查看页面，地址形如
`http://127.0.0.1:<端口>/view/<会话ID>?token=<令牌>`。

页面是**只读加一个取消按钮**的诊断视图：只显示归一化后的摘要、命令、验证结果和工具活动，
不显示隐藏推理，也不会把密钥写出来。关掉页面不影响后台执行。

想再打开：让 Claude 调用 `codex_open_viewer`，或者 `codex_status` 返回的 `viewerUrl`。

## 每个任务之后回复「继续」

检查点出现后，Claude 会把它作为普通消息显示给你（任务号、摘要、改了几个文件）。

只有你明确回复「继续」时，Claude 才应该调用 `codex_continue`；
其它回复不应该启动下一个任务。如果你不回，桥接器就一直停在原地等。

Claude 在等待期间会反复调用 `codex_watch`，这是正常的长等待，不是卡死。

## 取消与重试

- 取消：点查看页面右下角的「取消当前任务」，或者让 Claude 调用 `codex_cancel`。
  已经完成的检查点会保留，不会倒退。
- 重试：中转服务掉线、任务失败或进程中途退出后，让 Claude 调用 `codex_retry`
  重试**当前**任务；已完成的任务不会重跑。
- 无沙箱重试：默认不做。只有你明确同意后才允许，并且需要在你的确认下才使用。

## 查看状态和最终报告

- 状态：`codex_status` 返回当前状态、当前任务、最近检查点、报告内容和查看页面地址。
- 最终报告：所有任务完成后，`codex_watch` / `codex_continue` 会返回
  `nextAction: display_final_report`，Claude 把它当普通消息显示出来。

## 日志和报告在哪

会话目录：`%LOCALAPPDATA%\ClaudeCodexBridge\sessions\<会话ID>\`

- `session.json`：会话状态、任务列表、检查点
- `events.jsonl`：归一化后的事件流（写入前已做密钥隐藏）
- `codex.stdout.jsonl`：Codex 的原始 JSON 输出
- `codex.stderr.log`：Codex 的错误输出
- `tasks\<任务号>.md`：单个任务的报告

项目里的文件：

- `<项目文件夹>\PLAN.md`：桥接器写入的方案原文
- `<项目文件夹>\REPORT.md`：累积的报告，所有任务完成后是最新版本（原子写入）

## 恢复 Claude 配置

```powershell
npm run restore-claude
```

默认用同名配置文件里时间戳最新的备份恢复，并打印来源备份路径。
也可以用 `npm run restore-claude -- --backup <备份文件>` 指定某一个备份。
恢复是直接覆盖：它先用备份内容替换当前配置，再让你重启 Claude 桌面版；
所以恢复前先看清打印出来的来源备份是不是你要的那一版。

## 现在还没完成的

真实安装和人工验收记录在 `ACCEPTANCE.md`，会由最终验收步骤补齐
（安装到真实 Claude 配置、重启 Claude、跑一个无害临时项目、再跑 `C:\Users\王\Desktop\单词` 的副本）。
