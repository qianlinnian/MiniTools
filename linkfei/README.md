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
| `/help` | 查看帮助 |

私聊知识按发送者隔离；群聊知识按群聊共享。个人长期记忆只能在私聊中管理和使用，群聊问答绝不检索个人记忆；群聊对话上下文本身是群共享的。

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
