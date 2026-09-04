# Codex 剩余额度（Windows 托盘）

一个轻量、无主窗口常驻的 Windows 通知区域工具。它使用 Codex 官方 App Server 的只读 `account/rateLimits/read` 接口，显示当前额度窗口的剩余百分比和重置时间。

程序会监听官方 `account/rateLimits/updated` 变更通知，并每 60 秒主动校准一次。接口定义见 [OpenAI 官方 Codex App Server 文档](https://developers.openai.com/codex/app-server/)。

从 v1.3.0 起，程序每 60 秒重新建立一次只读连接，以同步 Codex 当前登录账号。刷新期间会保留原有数字，且额度和主题没有变化时不会重建图标，因此不会因定时刷新而闪烁。

从 v1.4.1 起，详情面板的额度卡片采用原位增量更新，并启用双缓冲。额度变化时只修改数字、进度条和重置时间，不再销毁并重建大块面板。

从 v1.4.2 起，手动点击“刷新额度”后按钮会立即显示“正在刷新”并暂时禁用；完成后短暂显示“已刷新”，超时则显示“重试刷新”。因此即使额度数字没有变化，也能明确看到点击已经生效。

从 v1.4.3 起，详情面板底部只显示接口返回的当前套餐类型（例如 `team`、`plus` 或 `pro`），不再显示接口来源和连接方式文字。

左键弹窗采用圆角卡片式界面，突出显示剩余百分比、使用进度、最近重置时间及各额度窗口，并会随 Windows 深色/浅色主题切换。

## 直接运行

1. 确保已安装并登录 Codex（Codex 桌面版或较新的 Codex CLI）。
2. 双击 **Run Codex Quota Tray.vbs**。
3. Windows 通知区域会直接显示剩余百分比数字，例如 `40` 表示剩余 40%。左键查看详情，右键可刷新、设置开机自动运行或退出。

如果数字被 Windows 收进“隐藏的图标”，请在任务栏设置中把“Codex 剩余额度”设为始终显示。固定后，它会出现在输入法、网络和音量图标所在的任务栏通知区域；具体顺序由 Windows 控制。

## 安装到当前用户

在此文件夹中右键 `Install.ps1`，选择“使用 PowerShell 运行”。安装器会：

- 复制程序到 `%LOCALAPPDATA%\Programs\CodexQuotaTray`；
- 创建开始菜单快捷方式；
- 默认启用当前用户的开机自动运行；
- 启动托盘工具。

从旧版本升级时，请先右键旧托盘图标并选择“退出”，再运行新版 `Install.ps1`，数字图标会立即生效。

不想启用开机启动时，可在 PowerShell 中执行：

```powershell
.\Install.ps1 -NoAutoStart
```

## 数据与安全

- 主数据源是 OpenAI 官方 Codex App Server，而不是网页抓取或解析 Codex 私有缓存。
- 工具调用已经登录的本地 `codex app-server`，不读取、复制或记录登录令牌。
- 只发送初始化握手和 `account/rateLimits/read` 只读请求，不创建对话、不消耗模型额度。
- 本地缓存只包含额度百分比、窗口和重置时间，位于 `%LOCALAPPDATA%\CodexQuotaTray\quota-cache.json`。
- 日志位于 `%LOCALAPPDATA%\CodexQuotaTray\app.log`，不记录认证信息。

## 额度显示规则

Codex 可能同时返回短周期和长周期额度窗口。托盘图标显示 `codex` 主额度中“剩余最少”的窗口，因为它最先构成实际限制；详情面板列出所有窗口。

## 兼容性与诊断

支持 Windows 10/11，使用系统自带的 Windows PowerShell 5.1、WinForms 和 System.Drawing，无需另装 .NET SDK。

运行自检：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Start-CodexQuotaTray.ps1 -SelfTest
```

只读取一次真实额度并打印结果：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Start-CodexQuotaTray.ps1 -Probe
```

如果显示感叹号：

1. 打开 Codex，确认已登录 ChatGPT 账户；
2. 更新 Codex 桌面版或 Codex CLI；
3. 右键托盘图标选择“刷新额度”；这个操作会重新建立连接，以便立即识别刚切换的账号；
4. 查看 `%LOCALAPPDATA%\CodexQuotaTray\app.log`。

较旧的 Codex CLI 若没有 `account/rateLimits/read`，工具会保留上次成功读取的缓存并给出错误提示，不会转而抓取网页或读取凭据文件。

## 卸载

运行 `Uninstall.ps1` 会移除开机启动项和开始菜单快捷方式。退出托盘程序后，再删除 `%LOCALAPPDATA%\Programs\CodexQuotaTray` 文件夹即可。

## 项目文件

- `Start-CodexQuotaTray.ps1`：主程序、官方接口客户端和托盘 UI。
- `Run Codex Quota Tray.vbs`：隐藏 PowerShell 控制台的双击启动器。
- `Install.ps1`：当前用户安装与开机启动。
- `Uninstall.ps1`：移除启动项和快捷方式。
