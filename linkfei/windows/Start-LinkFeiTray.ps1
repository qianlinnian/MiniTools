[CmdletBinding()]
param([switch]$NoStart)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$projectPath = Split-Path -Parent $PSScriptRoot
$runtimePath = Join-Path $projectPath 'data\linkfei-runtime.json'
$logsPath = Join-Path $projectPath 'logs'
$trayLogPath = Join-Path $logsPath 'linkfei-tray.log'
$script:desiredRunning = -not $NoStart
$script:lastRestartAttempt = [datetime]::MinValue
$script:exiting = $false

if (-not (Test-Path -LiteralPath $logsPath)) {
    New-Item -ItemType Directory -Path $logsPath -Force | Out-Null
}

$createdNew = $false
$mutex = [System.Threading.Mutex]::new($true, 'Local\LinkFeiTray', [ref]$createdNew)
if (-not $createdNew) { exit 0 }

function Write-TrayLog([string]$Message) {
    Add-Content -LiteralPath $trayLogPath -Value ('{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message) -Encoding UTF8
}

function Get-NodePath {
    if ($env:LINKFEI_NODE_PATH -and (Test-Path -LiteralPath $env:LINKFEI_NODE_PATH -PathType Leaf)) {
        return $env:LINKFEI_NODE_PATH
    }
    $command = Get-Command node -ErrorAction SilentlyContinue
    if ($command -and $command.Source) { return $command.Source }
    $fallback = Join-Path $env:ProgramFiles 'nodejs\node.exe'
    if (Test-Path -LiteralPath $fallback -PathType Leaf) { return $fallback }
    throw '没有找到 Node.js。请安装 Node.js 22.5+，或设置 LINKFEI_NODE_PATH。'
}

function Read-Runtime {
    if (-not (Test-Path -LiteralPath $runtimePath -PathType Leaf)) { return $null }
    try { return Get-Content -LiteralPath $runtimePath -Raw -Encoding UTF8 | ConvertFrom-Json }
    catch { return $null }
}

function Get-LinkFeiState {
    $runtime = Read-Runtime
    if (-not $runtime -or -not $runtime.port -or -not $runtime.token) {
        return [pscustomobject]@{ Running = $false; Runtime = $runtime; Health = $null }
    }
    try {
        $headers = @{ Authorization = 'Bearer {0}' -f $runtime.token }
        $health = Invoke-RestMethod -Uri ('http://127.0.0.1:{0}/health' -f $runtime.port) -Headers $headers -Method Get -TimeoutSec 2
        return [pscustomobject]@{ Running = [bool]$health.ok; Runtime = $runtime; Health = $health }
    } catch {
        return [pscustomobject]@{ Running = $false; Runtime = $runtime; Health = $null }
    }
}

function Show-Balloon([string]$Title, [string]$Message, [System.Windows.Forms.ToolTipIcon]$Icon = [System.Windows.Forms.ToolTipIcon]::Info) {
    $notifyIcon.BalloonTipTitle = $Title
    $notifyIcon.BalloonTipText = $Message
    $notifyIcon.BalloonTipIcon = $Icon
    $notifyIcon.ShowBalloonTip(4000)
}

function Start-LinkFeiBackend([switch]$Quiet) {
    $state = Get-LinkFeiState
    if ($state.Running) { return $true }
    $script:lastRestartAttempt = Get-Date
    if (Test-Path -LiteralPath $runtimePath) {
        Remove-Item -LiteralPath $runtimePath -Force
    }
    try {
        $nodePath = Get-NodePath
        $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
        $outLog = Join-Path $logsPath "linkfei-$stamp.out.log"
        $errLog = Join-Path $logsPath "linkfei-$stamp.err.log"
        $process = Start-Process -FilePath $nodePath -ArgumentList 'src/index.mjs' -WorkingDirectory $projectPath -RedirectStandardOutput $outLog -RedirectStandardError $errLog -WindowStyle Hidden -PassThru
        Write-TrayLog "启动后端 PID $($process.Id)。"
        for ($attempt = 0; $attempt -lt 20; $attempt++) {
            Start-Sleep -Milliseconds 500
            $state = Get-LinkFeiState
            if ($state.Running) {
                if (-not $Quiet) { Show-Balloon 'LinkFei 已启动' '飞书长连接正在建立或已经连接。' }
                return $true
            }
            if ($process.HasExited) { break }
        }
        throw "后端未能在 10 秒内就绪。请查看 $errLog"
    } catch {
        Write-TrayLog "启动失败：$($_.Exception.Message)"
        if (-not $Quiet) { Show-Balloon 'LinkFei 启动失败' $_.Exception.Message ([System.Windows.Forms.ToolTipIcon]::Error) }
        return $false
    }
}

function Stop-LinkFeiBackend([switch]$Quiet) {
    $script:desiredRunning = $false
    $state = Get-LinkFeiState
    if (-not $state.Running) {
        if (-not $Quiet) { Show-Balloon 'LinkFei 已停止' '后端当前没有运行。' }
        return $true
    }
    try {
        $headers = @{ Authorization = 'Bearer {0}' -f $state.Runtime.token }
        Invoke-RestMethod -Uri ('http://127.0.0.1:{0}/shutdown' -f $state.Runtime.port) -Headers $headers -Method Post -TimeoutSec 2 | Out-Null
        for ($attempt = 0; $attempt -lt 20; $attempt++) {
            Start-Sleep -Milliseconds 250
            if (-not (Get-LinkFeiState).Running) {
                Write-TrayLog '后端已优雅停止。'
                if (-not $Quiet) { Show-Balloon 'LinkFei 已停止' '数据库和通知服务已经安全关闭。' }
                return $true
            }
        }
        throw '后端没有在 5 秒内停止。'
    } catch {
        Write-TrayLog "停止失败：$($_.Exception.Message)"
        if (-not $Quiet) { Show-Balloon 'LinkFei 停止失败' $_.Exception.Message ([System.Windows.Forms.ToolTipIcon]::Error) }
        return $false
    }
}

function Update-TrayState {
    $state = Get-LinkFeiState
    if ($state.Running) {
        $notifyIcon.Text = 'LinkFei：运行中'
        $statusItem.Text = '状态：运行中（PID {0}）' -f $state.Health.pid
        $startItem.Enabled = $false
        $stopItem.Enabled = $true
        $restartItem.Enabled = $true
    } else {
        $notifyIcon.Text = 'LinkFei：已停止'
        $statusItem.Text = '状态：已停止'
        $startItem.Enabled = $true
        $stopItem.Enabled = $false
        $restartItem.Enabled = $false
        if ($script:desiredRunning -and ((Get-Date) - $script:lastRestartAttempt).TotalSeconds -ge 15) {
            [void](Start-LinkFeiBackend -Quiet)
        }
    }
}

$menu = [System.Windows.Forms.ContextMenuStrip]::new()
$statusItem = $menu.Items.Add('状态：检查中…')
$statusItem.Enabled = $false
[void]$menu.Items.Add('-')
$startItem = $menu.Items.Add('启动 LinkFei')
$stopItem = $menu.Items.Add('停止 LinkFei')
$restartItem = $menu.Items.Add('重启 LinkFei')
[void]$menu.Items.Add('-')
$openLogsItem = $menu.Items.Add('打开日志文件夹')
$openProjectItem = $menu.Items.Add('打开程序目录')
[void]$menu.Items.Add('-')
$exitKeepItem = $menu.Items.Add('退出托盘（保持机器人运行）')
$exitStopItem = $menu.Items.Add('停止机器人并退出托盘')

$notifyIcon = [System.Windows.Forms.NotifyIcon]::new()
$notifyIcon.Icon = [System.Drawing.SystemIcons]::Application
$notifyIcon.Text = 'LinkFei：正在启动'
$notifyIcon.ContextMenuStrip = $menu
$notifyIcon.Visible = $true

$startItem.Add_Click({
    $script:desiredRunning = $true
    [void](Start-LinkFeiBackend)
    Update-TrayState
})
$stopItem.Add_Click({
    [void](Stop-LinkFeiBackend)
    Update-TrayState
})
$restartItem.Add_Click({
    [void](Stop-LinkFeiBackend -Quiet)
    $script:desiredRunning = $true
    [void](Start-LinkFeiBackend)
    Update-TrayState
})
$openLogsItem.Add_Click({ Start-Process -FilePath 'explorer.exe' -ArgumentList ('"{0}"' -f $logsPath) })
$openProjectItem.Add_Click({ Start-Process -FilePath 'explorer.exe' -ArgumentList ('"{0}"' -f $projectPath) })
$notifyIcon.Add_DoubleClick({
    $state = Get-LinkFeiState
    if ($state.Running) { Show-Balloon 'LinkFei 正在运行' ('后端 PID：{0}' -f $state.Health.pid) }
    else { Show-Balloon 'LinkFei 已停止' '右键托盘图标可以启动。' ([System.Windows.Forms.ToolTipIcon]::Warning) }
})
$exitKeepItem.Add_Click({
    $script:desiredRunning = $false
    $script:exiting = $true
    [System.Windows.Forms.Application]::ExitThread()
})
$exitStopItem.Add_Click({
    [void](Stop-LinkFeiBackend -Quiet)
    $script:exiting = $true
    [System.Windows.Forms.Application]::ExitThread()
})

$timer = [System.Windows.Forms.Timer]::new()
$timer.Interval = 5000
$timer.Add_Tick({ Update-TrayState })
$timer.Start()

try {
    Update-TrayState
    if ($script:desiredRunning -and -not (Get-LinkFeiState).Running) {
        [void](Start-LinkFeiBackend)
    }
    Update-TrayState
    [System.Windows.Forms.Application]::Run()
} finally {
    $timer.Stop()
    $timer.Dispose()
    $notifyIcon.Visible = $false
    $notifyIcon.Dispose()
    $menu.Dispose()
    $mutex.ReleaseMutex()
    $mutex.Dispose()
}
