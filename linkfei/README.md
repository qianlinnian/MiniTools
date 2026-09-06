# LinkFei

LinkFei 是一个使用飞书官方长连接 SDK 接收消息、调用 DeepSeek 并回复飞书的机器人。它使用本地 SQLite 保存会话、摘要、个人长期记忆、知识库、事件幂等记录和文档任务，因此重启不会丢失状态。

## 已实现

- DeepSeek Flash / Pro 问答
- 飞书官方长连接，无需公网回调地址
- SQLite WAL 持久化，不需要额外数据库服务
- 按字符预算装配上下文，旧消息自动压缩为摘要
- 用户显式长期记忆，私聊用户之间相互隔离
- 私聊个人知识库、群聊共享知识库
- 中文二元词与英文词元构成的本地稀疏向量余弦检索
- 飞书事件持久化去重，避免重复回复和重复创建文档
- 文档任务状态记录与重启中断恢复
- `/doc` 生成并创建飞书文档，Markdown 标题、列表、代码、表格和 LaTeX 公式转换为原生飞书块
- 持久化飞书主动消息队列，可发送任务结果、提醒、异常和其他后台事件；网页监控只是可选触发器之一

## 环境要求

- Node.js 22.5 或更高版本（使用内置 `node:sqlite`；当前开发环境为 Node.js 24）
- DeepSeek API Key
- 飞书企业自建应用

## 安装与配置

```powershell
npm install
Copy-Item .env.example .env
```

项目会读取根目录 `.env`。推荐配置：

```dotenv
DEEPSEEK_API_KEY=
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL_FLASH=deepseek-v4-flash
DEEPSEEK_MODEL_PRO=deepseek-v4-pro
BOT_MODEL=flash
DEEPSEEK_TIMEOUT_MS=120000

FEISHU_APP_ID=
FEISHU_APP_SECRET=
FEISHU_DOC_BASE_URL=https://feishu.cn/docx
FEISHU_LOG_LEVEL=info

LINKFEI_DB_PATH=data/linkfei.sqlite
LINKFEI_RECENT_MESSAGE_LIMIT=16
LINKFEI_CONTEXT_CHAR_BUDGET=24000
LINKFEI_SUMMARY_TRIGGER_MESSAGES=24
LINKFEI_SUMMARY_RETAIN_MESSAGES=10
```

## MiniTools 统一控制器（推荐）

LinkFei 已接入同级目录中的 [`minitools-controller`](../minitools-controller/README.md)。统一控制器同时管理 LinkFei 和 Codex 额度托盘，后续小工具也通过 `tools.json` 接入。推荐从桌面或开始菜单打开“MiniTools 控制中心”。

## LinkFei 独立托盘（备用）

如果不使用统一控制器，也可以单独安装 LinkFei 托盘，不必手工保持终端窗口：

```powershell
powershell.exe -ExecutionPolicy Bypass -File .\windows\Install.ps1
```

安装程序会创建开始菜单和桌面快捷方式，并默认随 Windows 登录启动。托盘菜单支持：

- 查看连接状态和后端 PID
- 启动、停止和重启 LinkFei
- 打开日志目录或程序目录
- 后端异常退出后自动恢复
- 退出托盘但保持机器人运行，或安全停止机器人后退出

只想临时运行而不安装快捷方式时，可以双击 `windows\Run LinkFei Tray.vbs`，或执行 `npm run tray`。不需要开机启动时，安装命令增加 `-NoAutoStart`；卸载快捷方式和开机启动项使用 `windows\Uninstall.ps1`。卸载不会删除项目、配置、SQLite 数据或日志。

托盘和后端通过仅监听 `127.0.0.1` 的随机令牌控制端点通信，运行态文件位于 `data\linkfei-runtime.json`。该端点不对局域网开放，也不包含飞书或 DeepSeek 密钥。

仍兼容已有变量：`DEEPSEEK-KEY`、`DEEPSEEK-URL`、`DEEPSEEK-MODEL-FLASH`、`DEEPSEEK-MODEL-PRO`、`App_ID` / `APP_ID` 和 `APP_SECRET`。

`.env`、`data/` 和日志均已加入 `.gitignore`。不要提交真实密钥或数据库。

## 飞书应用配置

1. 开启机器人能力。
2. 开通“获取与发送单聊、群组消息”权限。
3. 开通“读取用户发给机器人的单聊消息”事件权限 `im:message.p2p_msg:readonly`；缺少它时私聊消息不会产生 `im.message.receive_v1` 事件。
4. 如需群聊，仅 @ 机器人触发时开通“获取群组中用户@机器人消息”。
5. 申请“创建及编辑新版文档”应用身份权限。
6. 开通“转换文本为云文档块”应用身份权限 `docx:document.block:convert`，用于将 Markdown 和公式转换为原生文档块。
7. 如需运行自动清理的真实文档验收或使用 Skill 删除文档，开通“删除云空间文件夹和云文档”应用身份权限 `space:document:delete`。
7. 在“事件与回调”中选择长连接。
8. 订阅 `im.message.receive_v1`。
9. 发布应用版本并完成管理员审批。
10. 将应用加入相应测试或使用范围。

## 命令

| 命令 | 作用 |
| --- | --- |
| 直接发送文字 | 使用默认模型，结合会话、相关记忆和知识库回答 |
| `/pro 问题` | 使用 Pro 模型 |
| `/doc 标题` | 生成并创建飞书文档 |
| `/doc 标题 \| 要求` | 按指定要求创建文档 |
| `/new` | 开始新会话，保留长期记忆和知识库 |
| `/reset` | 清除当前会话，保留长期记忆和知识库 |
| `/remember 内容` | 保存个人长期记忆 |
| `/memory` | 查看个人长期记忆及编号 |
| `/forget 编号` | 删除指定长期记忆 |
| `/forget all` | 删除自己的全部长期记忆 |
| `/kb add 标题 \| 内容` | 导入一条知识；正文可以另起一行 |
| `/kb list` | 列出当前私聊或群聊知识 |
| `/kb search 关键词` | 显式检索知识库 |
| `/kb delete 编号` | 删除当前范围的一条知识 |
| `/tasks` | 查看当前会话最近的文档任务 |
| `/notify bind` | 绑定飞书主动消息收件人 |
| `/notify test` | 主动发送一条飞书测试消息 |
| `/notify status` | 查看主动消息队列状态 |
| `/watch ...` | 可选：让网页变化触发飞书消息 |
| `/help` | 查看帮助 |

私聊知识按发送者隔离；群聊知识按群聊共享。个人长期记忆只能在私聊中管理和使用，群聊问答绝不检索个人记忆；群聊对话上下文本身是群共享的。

## 自然语言操作

除斜杠指令外，LinkFei 会先通过本地确定性路由识别高置信度操作，再调用同一套后端能力。例如：

- `创建飞书文档，标题是项目周报，内容包括本周进展和风险`
- `用 Pro 模型分析这个方案`
- `记住我喜欢简洁回答`、`查看我的长期记忆`
- `知识库添加：发布流程 | 先灰度再全量`、`在知识库中搜索发布风险`
- `查看最近文档任务`
- `给我发一条飞书主动消息测试`、`查看通知状态`
- `监控这个页面 https://status.example.com 每 30 分钟`
- `查看网页监控`、`立即检查网页监控 1`、`暂停网页监控 1`、`恢复网页监控 1`

意图不完整时会询问缺失信息，例如创建文档但未提供标题。为避免误操作，自然语言不会直接删除长期记忆、知识库条目或网页监控；确认编号后使用对应的 `/forget`、`/kb delete` 或 `/watch delete` 命令。

## 飞书主动消息

飞书主动消息是一条通用的手机通知通道，并不依赖网页监控。任何获得用户授权的 Codex 任务或本地后台流程，都可以把任务完成、任务失败、定时提醒、状态变化、异常告警或简短结果摘要写入可靠发送队列，再由 LinkFei 主动发送到已绑定的飞书私聊。

网页监控只是其中一个可选触发器：页面发生变化时，它同样把消息放入这条通用队列。即使完全不使用 `/watch`，`/notify` 和 Codex 的 `linkfei-notify` Skill 仍可独立发送飞书消息。

## 记忆与摘要机制

每次问答都会持久化到 `messages`。装配模型请求时会使用：系统提示、已有摘要、与当前问题相关的个人记忆、相关知识片段、最近消息以及当前问题。

消息数超过 `LINKFEI_SUMMARY_TRIGGER_MESSAGES` 后，旧消息通过 Flash 模型压缩成事实摘要，只保留最近 `LINKFEI_SUMMARY_RETAIN_MESSAGES` 条原始消息。`/reset` 与 `/new` 仅删除当前会话和摘要；只有 `/forget` 会删除长期记忆。

知识检索完全在本地完成，不会为了计算向量把知识内容发送给第三方。正常问答时，命中的知识片段会作为提示上下文发送给已配置的 DeepSeek API。

## 数据与恢复

默认数据库为 `data/linkfei.sqlite`，同时可能存在 `-wal` 和 `-shm` 文件。备份时应先正常停止机器人，再复制整个 `data` 目录。启动时，未完成的文档任务会标记为“已中断”；最近 7 天的飞书消息 ID 用于持久化去重。

## 验证与启动

```powershell
npm run check:config
npm run check:deepseek
npm run check:memory
npm test
npm start
```

`npm run check:feishu-doc` 会在飞书中创建一份真实验收文档，回读块结构，确认标题、列表、引用、代码块、表格、分隔线、富文本样式以及 `$...$`/`$$...$$` 原生公式元素，随后把测试文档移入回收站并确认不可读取。只应在明确需要端到端验证时执行。

长连接适合本地开发和单实例运行。请确保同一个飞书应用同一时间只有一个 LinkFei 实例处理消息。

## 通知记录与差异摘要

- `/notify history`（或 `/notify 历史`）：私聊查看最近十条通知的编号、状态、尝试次数及下次发送时间，仅显示当前私聊的记录。
- `/notify retry 编号`（或 `/notify 重试 编号`）：把失败或等待重试的通知重新排队；已发送、发送中和已排队的通知不可重复重发。实际发送由后台下一次发送周期处理。
- 网页变化通知显示前 1200 字摘要中变化区段的移除与新增内容；每段最多展示 500 字。这是摘要比较，并非完整页面差异；摘要未变时明确提示变化位于其他区域。

## 飞书控制 Codex

电脑运行 LinkFei 与已登录的 Codex CLI，手机只需飞书可用；电脑仍需要能够连接 Codex 服务。消息通过飞书长连接到达 LinkFei，再经本机 stdio 调用 Codex App Server，无需把电脑端口暴露到公网。

先在自己的飞书私聊绑定 `/notify bind`，在电脑的 LinkFei 目录执行 `node scripts/setup-codex-remote.mjs`。它将当前已绑定的个人用户与私聊固定写入 `data/codex-remote.json`；之后重新绑定通知收件人不会转移 Codex 控制权。重启 LinkFei 后生效。配置不存在时入口关闭。可以在本地配置 `enabled: false` 后重启关闭入口。

目前授权项目别名为 `linkfei`（MiniTools 保存项目根目录）和 `linkfei-service`（LinkFei 子目录）。只能通过本地配置增减项目，不接受聊天传入任意路径。使用工作区写入沙箱与按需审批；不传递 shell 命令字符串启动 Codex。

| 飞书消息 | 用途 |
| --- | --- |
| `/codex help` | 查看帮助 |
| `/codex projects` | 授权项目列表 |
| `/codex new linkfei \| 检查项目测试情况，先不要修改代码` | 在 MiniTools 项目根创建远程任务 |
| `/codex list` | 最近十个远程任务 |
| `/codex status 1` | 查看任务状态及最近输出 |
| `/codex send 1 \| 继续处理刚才发现的问题` | 继续已结束的任务，或给执行中的任务追加指令 |
| `/codex stop 1` | 请求中断正在执行的任务 |
| `/codex approve 确认码` | 批准显示的单次命令，确认码十分钟有效且不可重复使用 |
| `/codex deny 确认码` | 拒绝这一次命令 |

任务完成或失败后，结果通过持久化通知队列自动回传，长内容分段发送。普通消息仍由原 LinkFei 聊天处理；只有 `/codex` 前缀触发远程控制。重启或断连时不会自动重放任务，标记状态待核验；`status` 始终读取持久会话，因此能同步桌面端后来追加的回合。LinkFei 每 20 秒只读检查已登记会话，桌面端新增并完成的回合会回传一次；这不是 Codex heartbeat 自动化。无法核验的任务需在电脑处理。

当前版本一次执行一个远程任务。远程任务有自己的本地编号和 Codex 会话，不直接接管桌面 App 已在运行的任务。Codex App Server 的公开 `thread/start` 参数没有桌面 `projectId`，只能传工作目录；因此 `linkfei` 默认使用保存项目的精确根目录，但桌面侧边栏归属仍由桌面应用决定。配置未指定 `model` 时从 CLI 的 `model/list` 选取默认模型，不能假设桌面 App 的模型均可用。本机验收时 CLI 默认可用模型为 GPT-5.5，未列出 Astra。

支持可完整显示且不包含已识别凭据的单次命令审批。文件越界授权、交互式问答及其他尚不支持的请求会被拒绝并提示，不自动放行。原始协议与 stderr 不写入日志；回传内容做凭据脱敏，但用户仍不应把凭据写进任务指令。

验证命令：

- `node scripts/check-codex.mjs`：只读检查登录与模型，不创建任务。
- `node --test`：完整离线测试。
- `node scripts/check-codex-turn.mjs --run`：显式执行一次固定短语的真实模型验收，会消耗少量额度，测试任务随后归档；不向飞书发消息。
- `node scripts/reload-linkfei.mjs`：检查运行状态及远程入口开关。
- `node scripts/reload-linkfei.mjs --reload`：确认没有处理中任务后，请求后端退出并等待现有控制器恢复。

协议参考：[Codex App Server 官方文档](https://developers.openai.com/codex/app-server/)。
