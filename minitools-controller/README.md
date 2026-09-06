# MiniTools 控制中心

统一管理 `MiniTools` 目录中的本地小工具。目前已接入：

- LinkFei 飞书助手
- Codex 额度托盘
- Zotero Reading Toolkit

双击 `Run MiniTools Controller.vbs` 可临时运行。安装桌面、开始菜单和当前用户开机启动入口：

```powershell
powershell.exe -ExecutionPolicy Bypass -File .\Install.ps1
```

控制中心提供每个工具的状态、启动、停止和打开操作，并根据 `tools.json` 的 `restartOnFailure` 配置自动恢复意外退出的工具。关闭主窗口只会隐藏到通知区；托盘菜单可选择保留工具运行或停止全部后退出。

## 接入新工具

在 `tools.json` 的 `tools` 数组增加一项。当前支持：

- `http-runtime`：工具提供带令牌的本地健康检查和关闭端点，例如 LinkFei。
- `managed-process`：工具写入包含 PID 的运行态 JSON，并响应停止/显示请求文件，例如 Codex 额度托盘。
- `static-tool`：不需要常驻进程的工具，控制中心显示安装状态并提供打开入口，例如 Zotero Reading Toolkit。

路径可相对控制器目录，也可使用 `%LOCALAPPDATA%` 等环境变量；启动参数中的 `${toolPath}` 会替换为工具目录。每个工具可以独立设置登录后启动和异常退出自动恢复。

## 故障恢复改进

启动改为异步检查，不再阻塞窗口等待十秒。存活但未就绪的进程以黄色状态显示，不会重复启动；失败后按 15、30、60、120、240 秒退避，连续五次启动未能稳定运行则暂停恢复，点击“启动”重新尝试。服务健康持续 60 秒后清零失败次数。主动停止会关闭当前控制器会话内的自动恢复。卡片显示启动错误和重试倒计时。

运行 `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Test-Recovery.ps1` 可验证恢复策略，不会启动或停止实际工具。
