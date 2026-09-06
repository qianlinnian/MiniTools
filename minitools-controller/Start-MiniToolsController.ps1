[CmdletBinding()]
param([switch]$NoStart,[switch]$SelfTest,[switch]$ShowOnStart,[int]$SmokeTestSeconds=0,[string]$RenderPreviewPath,[string]$DataPath)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
if(-not ('MiniToolsTaskbarIdentity' -as [type])){
Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
public static class MiniToolsTaskbarIdentity
{
    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    public static extern int SetCurrentProcessExplicitAppUserModelID(string appId);
}
'@
}
if(-not ('MiniToolsWindowTheme' -as [type])){
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class MiniToolsWindowTheme
{
    [DllImport("dwmapi.dll")]
    public static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int valueSize);
}
'@
}
[void][MiniToolsTaskbarIdentity]::SetCurrentProcessExplicitAppUserModelID('MiniTools.Controller')
[System.Windows.Forms.Application]::EnableVisualStyles()

$controllerPath = $PSScriptRoot
$configPath = Join-Path $controllerPath 'tools.json'
$iconPath = Join-Path $controllerPath 'assets\minitools-controller.ico'
$appDataPath = if($DataPath){[IO.Path]::GetFullPath($DataPath)}else{Join-Path $env:LOCALAPPDATA 'MiniToolsController'}
$logPath = Join-Path $appDataPath 'controller.log'
$runtimePath = Join-Path $appDataPath 'runtime.json'
$showRequestPath = Join-Path $appDataPath 'show.request'
$script:desired = @{}
$script:lastStart = @{}
$script:rows = @{}
$script:recovery = @{}
$script:launched = @{}
$script:exiting = $false

if (-not (Test-Path -LiteralPath $appDataPath)) { New-Item -ItemType Directory -Path $appDataPath -Force | Out-Null }
$createdNew = $false
$mutexName=if($SmokeTestSeconds -gt 0){'Local\MiniToolsController.VisualPreview'}else{'Local\MiniToolsController.SingleInstance'}
$mutex = New-Object System.Threading.Mutex($true, $mutexName, [ref]$createdNew)
if (-not $createdNew) { New-Item -ItemType File -Path $showRequestPath -Force | Out-Null; exit 0 }
Remove-Item -LiteralPath $showRequestPath -Force -ErrorAction SilentlyContinue
@{version=1;pid=$PID;startedAt=(Get-Date).ToString('o');scriptPath=$PSCommandPath}|ConvertTo-Json|Set-Content -LiteralPath $runtimePath -Encoding UTF8

function Write-ControllerLog([string]$Message) {
    try { Add-Content -LiteralPath $logPath -Value ('{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message) -Encoding UTF8 }
    catch { }
}
trap { Write-ControllerLog ("致命错误：{0}（行 {1}）" -f $_.Exception.Message,$_.InvocationInfo.ScriptLineNumber); exit 1 }

function Expand-ConfiguredPath([string]$Value, [string]$ToolPath) {
    if ([string]::IsNullOrWhiteSpace($Value)) { return $null }
    $expanded = [Environment]::ExpandEnvironmentVariables($Value).Replace('${toolPath}', $ToolPath)
    if ([IO.Path]::IsPathRooted($expanded)) { return [IO.Path]::GetFullPath($expanded) }
    return [IO.Path]::GetFullPath((Join-Path $controllerPath $expanded))
}

function Initialize-Tool($Raw) {
    $toolPath = Expand-ConfiguredPath $Raw.workingDirectory $controllerPath
    [pscustomobject]@{
        Id = [string]$Raw.id
        Name = [string]$Raw.name
        Description = [string]$Raw.description
        Kind = [string]$Raw.kind
        ToolPath = $toolPath
        RuntimePath = Expand-ConfiguredPath $Raw.runtimePath $toolPath
        StopRequestPath = Expand-ConfiguredPath $Raw.stopRequestPath $toolPath
        ShowRequestPath = Expand-ConfiguredPath $Raw.showRequestPath $toolPath
        LogsDirectory = Expand-ConfiguredPath $Raw.logsDirectory $toolPath
        AutoStart = [bool]$Raw.autoStart
        RestartOnFailure = [bool]$Raw.restartOnFailure
        Start = $Raw.start
    }
}

if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) { throw "找不到工具清单：$configPath" }
$configuration = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
$tools = @($configuration.tools | ForEach-Object { Initialize-Tool $_ })
Write-ControllerLog ("已加载 {0} 个工具配置。" -f $tools.Count)
foreach ($tool in $tools) {
    $script:desired[$tool.Id] = (-not $NoStart) -and $tool.AutoStart
    $script:lastStart[$tool.Id] = [datetime]::MinValue
    $script:recovery[$tool.Id] = @{ Attempts=0; Next=[datetime]::MinValue; HealthySince=$null; Paused=$false; LastError=$null }
}

function Read-JsonFile([string]$Path) {
    if (-not $Path -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    try { return Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json }
    catch { return $null }
}

function Test-ToolProcess($Tool, $Runtime) {
    $tracked = $script:launched[$Tool.Id]
    if ($tracked -and -not $tracked.HasExited) { return $true }
    if ($Runtime.pid) {
        $candidate = Get-Process -Id ([int]$Runtime.pid) -ErrorAction SilentlyContinue
        if ($candidate) { return $true }
    }
    return $false
}

function Get-ToolState($Tool) {
    $runtime = Read-JsonFile $Tool.RuntimePath
    if ($Tool.Kind -eq 'http-runtime') {
        if (-not $runtime.port -or -not $runtime.token) { $alive=Test-ToolProcess $Tool $runtime; return [pscustomobject]@{ Running=$alive; Healthy=$false; Detail=if($alive){'启动中/未就绪'}else{'已停止'}; Runtime=$runtime } }
        try {
            $headers = @{ Authorization = 'Bearer {0}' -f $runtime.token }
            $health = Invoke-RestMethod -Uri ('http://127.0.0.1:{0}/health' -f $runtime.port) -Headers $headers -Method Get -TimeoutSec 2
            return [pscustomobject]@{ Running=$true; Healthy=([bool]$health.ok -and $health.state -eq 'connected'); Detail=if($health.state -eq 'connected'){'已连接'}else{[string]$health.state}; Runtime=$runtime; Health=$health }
        } catch { $alive=Test-ToolProcess $Tool $runtime; return [pscustomobject]@{ Running=$alive; Healthy=$false; Detail=if($alive){'进程存活/无响应'}else{'已停止'}; Runtime=$runtime } }
    }
    if ($Tool.Kind -eq 'managed-process') {
        if (-not $runtime.pid) { $alive=Test-ToolProcess $Tool $runtime; return [pscustomobject]@{ Running=$alive; Healthy=$false; Detail=if($alive){'启动中/未就绪'}else{'已停止'}; Runtime=$runtime } }
        $process = Get-Process -Id ([int]$runtime.pid) -ErrorAction SilentlyContinue
        return [pscustomobject]@{ Running=[bool]$process; Healthy=[bool]$process; Detail=if($process){'运行中'}else{'进程已退出'}; Runtime=$runtime }
    }
    if ($Tool.Kind -eq 'static-tool') {
        $available = Test-Path -LiteralPath $Tool.ToolPath -PathType Container
        return [pscustomobject]@{ Running=$false; Available=$available; Detail=if($available){'已安装'}else{'目录缺失'}; Runtime=$null }
    }
    return [pscustomobject]@{ Running=$false; Detail='不支持的适配器'; Runtime=$runtime }
}

function Resolve-Executable($Tool) {
    $configured = [Environment]::ExpandEnvironmentVariables([string]$Tool.Start.executable)
    $command = Get-Command $configured -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($command) { return $command.Source }
    $fallback = [Environment]::ExpandEnvironmentVariables([string]$Tool.Start.fallbackExecutable)
    if ($fallback -and (Test-Path -LiteralPath $fallback -PathType Leaf)) { return $fallback }
    throw "没有找到 $configured。"
}

function Quote-Argument([string]$Value) {
    if ($Value -notmatch '[\s"]') { return $Value }
    return '"{0}"' -f ($Value.Replace('"','\"'))
}

function Start-ManagedTool($Tool, [switch]$Quiet) {
    $recovery = $script:recovery[$Tool.Id]
    if (-not $Quiet) { $recovery.Attempts=0; $recovery.Paused=$false; $recovery.LastError=$null }

    if ((Get-ToolState $Tool).Running) { return $true }
    $script:lastStart[$Tool.Id] = Get-Date
    $recovery.Attempts++
    $recovery.HealthySince=$null
    $recovery.Next=(Get-Date).AddSeconds([math]::Min(300,15*[math]::Pow(2,$recovery.Attempts-1)))
    $recovery.Paused=$recovery.Attempts -ge 5
    foreach ($stale in @($Tool.RuntimePath, $Tool.StopRequestPath, $Tool.ShowRequestPath)) {
        if ($stale -and (Test-Path -LiteralPath $stale)) { Remove-Item -LiteralPath $stale -Force }
    }
    try {
        $executable = Resolve-Executable $Tool
        $arguments = @($Tool.Start.arguments | ForEach-Object {
            Quote-Argument (([Environment]::ExpandEnvironmentVariables([string]$_)).Replace('${toolPath}', $Tool.ToolPath))
        }) -join ' '
        $parameters = @{
            FilePath = $executable
            ArgumentList = $arguments
            WorkingDirectory = $Tool.ToolPath
            WindowStyle = 'Hidden'
            PassThru = $true
        }
        if ([bool]$Tool.Start.redirectLogs) {
            if (-not (Test-Path -LiteralPath $Tool.LogsDirectory)) { New-Item -ItemType Directory -Path $Tool.LogsDirectory -Force | Out-Null }
            $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
            $parameters.RedirectStandardOutput = Join-Path $Tool.LogsDirectory "$($Tool.Id)-$stamp.out.log"
            $parameters.RedirectStandardError = Join-Path $Tool.LogsDirectory "$($Tool.Id)-$stamp.err.log"
        }
        $process = Start-Process @parameters
        $script:launched[$Tool.Id] = $process
        Write-ControllerLog "启动 $($Tool.Id)，PID $($process.Id)。"
        # Readiness is checked by the timer, so a slow startup never blocks the UI.
        return $true
    } catch {
        $recovery.LastError=$_.Exception.Message
        Write-ControllerLog "启动 $($Tool.Id) 失败：$($_.Exception.Message)"
        if (-not $Quiet) { [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, 'MiniTools 控制中心', 'OK', 'Error') | Out-Null }
        return $false
    }
}

function Stop-ManagedTool($Tool, [switch]$Quiet) {
    $script:desired[$Tool.Id] = $false
    Write-ControllerLog "用户停止 $($Tool.Id)，自动恢复已关闭。"
    $state = Get-ToolState $Tool
    if (-not $state.Running) { return $true }
    try {
        if ($Tool.Kind -eq 'http-runtime') {
            $headers = @{ Authorization = 'Bearer {0}' -f $state.Runtime.token }
            Invoke-RestMethod -Uri ('http://127.0.0.1:{0}/shutdown' -f $state.Runtime.port) -Headers $headers -Method Post -TimeoutSec 2 | Out-Null
        } elseif ($Tool.Kind -eq 'managed-process') {
            $parent = Split-Path -Parent $Tool.StopRequestPath
            if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
            New-Item -ItemType File -Path $Tool.StopRequestPath -Force | Out-Null
        }
        for ($attempt=0; $attempt -lt 24; $attempt++) {
            Start-Sleep -Milliseconds 250
            if (-not (Get-ToolState $Tool).Running) { Write-ControllerLog "停止 $($Tool.Id)。"; return $true }
        }
        throw "$($Tool.Name) 没有在 6 秒内停止。"
    } catch {
        Write-ControllerLog "停止 $($Tool.Id) 失败：$($_.Exception.Message)"
        if (-not $Quiet) { [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, 'MiniTools 控制中心', 'OK', 'Error') | Out-Null }
        return $false
    }
}

function Show-Tool($Tool) {
    if ($Tool.ShowRequestPath -and (Get-ToolState $Tool).Running) {
        New-Item -ItemType File -Path $Tool.ShowRequestPath -Force | Out-Null
    } else {
        Start-Process -FilePath 'explorer.exe' -ArgumentList ('"{0}"' -f $Tool.ToolPath)
    }
}

if ($SelfTest) {
    foreach ($tool in $tools) {
        if ($tool.Kind -notin @('http-runtime','managed-process','static-tool')) { throw "不支持的工具适配器：$($tool.Kind)" }
        if (-not (Test-Path -LiteralPath $tool.ToolPath -PathType Container)) { throw "工具目录不存在：$($tool.ToolPath)" }
        $state = Get-ToolState $tool
        $stateText=if($tool.Kind -eq 'static-tool' -and $state.Available){'available'}elseif($state.Running){'running'}else{'stopped'}
        Write-Output ("PASS {0}: {1}" -f $tool.Id,$stateText)
    }
    Remove-Item -LiteralPath $runtimePath -Force -ErrorAction SilentlyContinue
    $mutex.ReleaseMutex();$mutex.Dispose()
    exit 0
}

function Get-SystemTheme {
    try {
        $setting = Get-ItemPropertyValue -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize' -Name 'AppsUseLightTheme' -ErrorAction Stop
        if ([int]$setting -eq 0) { return 'dark' }
    } catch { }
    return 'light'
}

$script:currentTheme = $null
$script:palette = $null
function Set-SystemTheme([switch]$Force) {
    $theme = Get-SystemTheme
    if (-not $Force -and $script:currentTheme -eq $theme) { return $false }
    $script:currentTheme = $theme
    if ($theme -eq 'dark') {
        $script:palette = [pscustomobject]@{
            Canvas=[Drawing.Color]::FromArgb(11,11,11); Panel=[Drawing.Color]::FromArgb(20,20,20); Text=[Drawing.Color]::FromArgb(238,238,238)
            Secondary=[Drawing.Color]::FromArgb(145,145,145); Border=[Drawing.Color]::FromArgb(70,70,70); PanelBorder=[Drawing.Color]::FromArgb(46,46,46)
            Hover=[Drawing.Color]::FromArgb(42,42,42); Inactive=[Drawing.Color]::FromArgb(88,88,88); AccentInactive=[Drawing.Color]::FromArgb(98,98,98)
            PrimaryBackground=[Drawing.Color]::FromArgb(238,238,238); PrimaryText=[Drawing.Color]::FromArgb(12,12,12); PrimaryHover=[Drawing.Color]::FromArgb(205,205,205)
        }
        $darkMode = 1
    } else {
        $script:palette = [pscustomobject]@{
            Canvas=[Drawing.Color]::FromArgb(246,246,243); Panel=[Drawing.Color]::White; Text=[Drawing.Color]::FromArgb(24,24,24)
            Secondary=[Drawing.Color]::FromArgb(98,98,98); Border=[Drawing.Color]::FromArgb(191,191,187); PanelBorder=[Drawing.Color]::FromArgb(218,218,214)
            Hover=[Drawing.Color]::FromArgb(238,238,235); Inactive=[Drawing.Color]::FromArgb(148,148,148); AccentInactive=[Drawing.Color]::FromArgb(142,142,138)
            PrimaryBackground=[Drawing.Color]::FromArgb(24,24,24); PrimaryText=[Drawing.Color]::FromArgb(248,248,248); PrimaryHover=[Drawing.Color]::FromArgb(62,62,62)
        }
        $darkMode = 0
    }
    $ui = $script:palette
    if ($form) {
        $form.BackColor=$ui.Canvas;$titleLabel.ForeColor=$ui.Text;$summaryLabel.ForeColor=$ui.Secondary;$eyebrowLabel.ForeColor=$ui.Secondary;$headerLine.BackColor=$ui.PanelBorder
        $openRoot.BackColor=$ui.Panel;$openRoot.ForeColor=$ui.Text;$openRoot.FlatAppearance.BorderColor=$ui.Border;$openRoot.FlatAppearance.MouseOverBackColor=$ui.Hover
        [void][MiniToolsWindowTheme]::DwmSetWindowAttribute($form.Handle,20,[ref]$darkMode,4)
        foreach($row in $script:rows.Values){$row.Name.ForeColor=$ui.Text;$row.Description.ForeColor=$ui.Secondary;$row.Panel.Invalidate()}
    }
    return $true
}

function Update-AllStates {
    $runningCount = 0
    $availableCount = 0
    foreach ($tool in $tools) {
        $state = Get-ToolState $tool
        $recovery = $script:recovery[$tool.Id]
        if ($state.Running -and $state.Healthy) {
            if (-not $recovery.HealthySince) { $recovery.HealthySince=Get-Date }
            if (((Get-Date)-$recovery.HealthySince).TotalSeconds -ge 60) { $recovery.Attempts=0; $recovery.Paused=$false; $recovery.LastError=$null }
        } else { $recovery.HealthySince=$null }
        if (-not $state.Running -and $script:desired[$tool.Id] -and $tool.RestartOnFailure) {
            if ($recovery.Paused) { $state.Detail='恢复暂停/请启动' }
            else { $state.Detail='重试 {0}s ({1}/5)' -f [math]::Max(0,[math]::Ceiling(($recovery.Next-(Get-Date)).TotalSeconds)), $recovery.Attempts }
        }
        if ($state.Running) { $runningCount++ }
        if ($tool.Kind -eq 'static-tool' -and $state.Available) { $availableCount++ }
        $row = $script:rows[$tool.Id]
        if ($row) {
            $healthy = $state.Running -or ($tool.Kind -eq 'static-tool' -and $state.Available)
            $row.Description.Text = if($recovery.LastError){$recovery.LastError}else{$tool.Description}
            $row.Status.Text = if($healthy){'●  ' + $state.Detail}else{'○  ' + $state.Detail}
            $canStart = ($tool.Kind -ne 'static-tool') -and (-not $state.Running)
            $canStop = ($tool.Kind -ne 'static-tool') -and $state.Running
            # Keep inactive controls legible on a dark surface; the click handlers below are state-guarded.
            $row.Start.Enabled = $true
            $row.Stop.Enabled = $true
            # The surface always stays monochrome. Colour is reserved for a state that needs attention.
            $ui=$script:palette;$panelBackground=$ui.Panel;$buttonBackground=$ui.Panel
            $text=$ui.Text;$secondary=$ui.Secondary;$border=$ui.Border
            $row.Panel.BackColor=$panelBackground
            foreach($button in @($row.Start,$row.Stop,$row.Open)){
                $button.BackColor=$buttonBackground;$button.ForeColor=$text;$button.FlatAppearance.BorderColor=$border
                $button.FlatAppearance.MouseOverBackColor=$ui.Hover
            }
            $row.Status.BackColor=$panelBackground;$row.Status.ForeColor=$secondary
            $row.Accent.BackColor=$ui.AccentInactive
            if($state.Running -and $state.Healthy){
                $row.Status.ForeColor=$text;$row.Accent.BackColor=$ui.Text
            }elseif($tool.Kind -eq 'static-tool' -and $state.Available){
                $row.Status.ForeColor=$text;$row.Accent.BackColor=$ui.Border
            }elseif($state.Running){
                $row.Status.ForeColor=[Drawing.Color]::FromArgb(222,184,92);$row.Accent.BackColor=[Drawing.Color]::FromArgb(222,184,92)
            }
            if($recovery.LastError){
                $row.Status.ForeColor=[Drawing.Color]::FromArgb(225,103,103);$row.Accent.BackColor=[Drawing.Color]::FromArgb(225,103,103)
            }
            if($canStart){
                $row.Start.BackColor=$ui.PrimaryBackground;$row.Start.ForeColor=$ui.PrimaryText;$row.Start.FlatAppearance.BorderColor=$ui.PrimaryBackground
                $row.Start.FlatAppearance.MouseOverBackColor=$ui.PrimaryHover
                $row.Start.Cursor=[Windows.Forms.Cursors]::Hand
            }else{$row.Start.ForeColor=$ui.Inactive;$row.Start.FlatAppearance.BorderColor=$ui.PanelBorder;$row.Start.Cursor=[Windows.Forms.Cursors]::Default}
            if($canStop){$row.Stop.Cursor=[Windows.Forms.Cursors]::Hand}else{$row.Stop.ForeColor=$ui.Inactive;$row.Stop.FlatAppearance.BorderColor=$ui.PanelBorder;$row.Stop.Cursor=[Windows.Forms.Cursors]::Default}
        }
        if (-not $state.Running -and $script:desired[$tool.Id] -and $tool.RestartOnFailure -and -not $recovery.Paused -and (Get-Date) -ge $recovery.Next) {
            [void](Start-ManagedTool $tool -Quiet)
        }
    }
    $notifyIcon.Text = ("MiniTools：{0} 个运行，{1} 个静态工具可用" -f $runningCount,$availableCount)
    $summaryLabel.Text = ("{0} 个工具 · {1} 个运行 · {2} 个静态工具可用" -f $tools.Count,$runningCount,$availableCount)
}

$form = New-Object System.Windows.Forms.Form
$form.Text = 'MiniTools 控制中心'
$form.Size = New-Object Drawing.Size 730, (202 + 112 * $tools.Count)
$form.MinimumSize = $form.Size
$form.MaximumSize = $form.Size
$form.StartPosition = 'CenterScreen'
$form.BackColor = [Drawing.Color]::FromArgb(246,246,243)
$form.Font = New-Object Drawing.Font 'Microsoft YaHei UI', 9
$form.ShowInTaskbar = $true
$form.FormBorderStyle = [Windows.Forms.FormBorderStyle]::FixedSingle
$form.MaximizeBox = $false
if (Test-Path -LiteralPath $iconPath) { $form.Icon = New-Object Drawing.Icon $iconPath }
$form.Add_Shown({Set-SystemTheme -Force;Update-AllStates})

$titleLabel = New-Object Windows.Forms.Label
$titleLabel.Text = 'MiniTools 控制中心'
$titleLabel.Font = New-Object Drawing.Font 'Microsoft YaHei UI', 16, ([Drawing.FontStyle]::Bold)
$titleLabel.Location = New-Object Drawing.Point 24,20
$titleLabel.AutoSize = $true
$titleLabel.ForeColor = [Drawing.Color]::FromArgb(24,24,24)
$summaryLabel = New-Object Windows.Forms.Label
$summaryLabel.Text = '正在检查本机服务…'
$summaryLabel.ForeColor = [Drawing.Color]::FromArgb(98,98,98)
$summaryLabel.Location = New-Object Drawing.Point 26,53
$summaryLabel.AutoSize = $true
$eyebrowLabel = New-Object Windows.Forms.Label
$eyebrowLabel.Text = 'LOCAL TOOL ORCHESTRATOR'
$eyebrowLabel.Font = New-Object Drawing.Font 'Consolas',8
$eyebrowLabel.ForeColor = [Drawing.Color]::FromArgb(98,98,98)
$eyebrowLabel.Location = New-Object Drawing.Point 505,25
$eyebrowLabel.AutoSize = $true
$headerLine = New-Object Windows.Forms.Panel
$headerLine.Location = New-Object Drawing.Point 24,78
$headerLine.Size = New-Object Drawing.Size 665,1
$headerLine.BackColor = [Drawing.Color]::FromArgb(218,218,214)
$form.Controls.AddRange(@($titleLabel,$summaryLabel,$eyebrowLabel,$headerLine))

$y = 96
foreach ($tool in $tools) {
    $panel = New-Object Windows.Forms.Panel
    $panel.Location = New-Object Drawing.Point 24,$y
    $panel.Size = New-Object Drawing.Size 665,94
    $panel.BackColor = [Drawing.Color]::White
    $panel.Add_Paint({param($sender,$eventArgs);$pen=New-Object Drawing.Pen $script:palette.PanelBorder;$eventArgs.Graphics.DrawRectangle($pen,0,0,$sender.ClientSize.Width-1,$sender.ClientSize.Height-1);$pen.Dispose()})
    $accent = New-Object Windows.Forms.Panel
    $accent.Location = New-Object Drawing.Point 0,0
    $accent.Size = New-Object Drawing.Size 2,92
    $accent.BackColor = [Drawing.Color]::FromArgb(142,142,138)
    $name = New-Object Windows.Forms.Label
    $name.Text = $tool.Name
    $name.Font = New-Object Drawing.Font 'Microsoft YaHei UI',11,([Drawing.FontStyle]::Bold)
    $name.Location = New-Object Drawing.Point 22,12
    $name.AutoSize = $true
    $name.ForeColor = [Drawing.Color]::FromArgb(24,24,24)
    $description = New-Object Windows.Forms.Label
    $description.Text = $tool.Description
    $description.ForeColor = [Drawing.Color]::FromArgb(98,98,98)
    $description.Location = New-Object Drawing.Point 22,42
    $description.Size = New-Object Drawing.Size 300,38
    $status = New-Object Windows.Forms.Label
    $status.Text = '检查中…'
    $status.Location = New-Object Drawing.Point 350,14
    $status.Size = New-Object Drawing.Size 286,26
    $status.TextAlign = [Drawing.ContentAlignment]::MiddleRight
    $status.Font = New-Object Drawing.Font 'Consolas',9
    $status.ForeColor = [Drawing.Color]::FromArgb(98,98,98)
    $start = New-Object Windows.Forms.Button
    $start.Text = '启动'; $start.Location = New-Object Drawing.Point 380,48; $start.Size = New-Object Drawing.Size 82,30
    $stop = New-Object Windows.Forms.Button
    $stop.Text = '停止'; $stop.Location = New-Object Drawing.Point 470,48; $stop.Size = New-Object Drawing.Size 82,30
    $open = New-Object Windows.Forms.Button
    $open.Text = '打开'; $open.Location = New-Object Drawing.Point 560,48; $open.Size = New-Object Drawing.Size 82,30
    if($tool.Kind -eq 'static-tool'){$start.Text='—';$stop.Text='—'}
    foreach($button in @($start,$stop,$open)){$button.FlatStyle=[Windows.Forms.FlatStyle]::Flat;$button.FlatAppearance.BorderSize=1;$button.FlatAppearance.BorderColor=[Drawing.Color]::FromArgb(191,191,187);$button.FlatAppearance.MouseOverBackColor=[Drawing.Color]::FromArgb(238,238,235);$button.Cursor=[Windows.Forms.Cursors]::Hand;$button.TabStop=$false;$button.Add_MouseUp({$form.ActiveControl=$null})}
    $start.BackColor=[Drawing.Color]::White;$start.ForeColor=[Drawing.Color]::FromArgb(24,24,24);$start.UseVisualStyleBackColor=$false
    $stop.BackColor=[Drawing.Color]::White;$stop.ForeColor=[Drawing.Color]::FromArgb(24,24,24);$stop.UseVisualStyleBackColor=$false
    $open.BackColor=[Drawing.Color]::White;$open.ForeColor=[Drawing.Color]::FromArgb(24,24,24);$open.UseVisualStyleBackColor=$false
    $capturedTool = $tool
    $start.Add_Click({ if($capturedTool.Kind -ne 'static-tool' -and -not (Get-ToolState $capturedTool).Running){$script:desired[$capturedTool.Id]=$true;[void](Start-ManagedTool $capturedTool);Update-AllStates} }.GetNewClosure())
    $stop.Add_Click({ if($capturedTool.Kind -ne 'static-tool' -and (Get-ToolState $capturedTool).Running){[void](Stop-ManagedTool $capturedTool);Update-AllStates} }.GetNewClosure())
    $open.Add_Click({ Show-Tool $capturedTool }.GetNewClosure())
    $panel.Controls.AddRange(@($accent,$name,$description,$status,$start,$stop,$open))
    $form.Controls.Add($panel)
    $script:rows[$tool.Id] = [pscustomobject]@{Panel=$panel;Accent=$accent;Name=$name;Status=$status;Description=$description;Start=$start;Stop=$stop;Open=$open}
    $y += 106
}

$openRoot = New-Object Windows.Forms.Button
$openRoot.Text = '打开 MiniTools 文件夹'
$openRoot.Location = New-Object Drawing.Point 24,$y
$openRoot.Size = New-Object Drawing.Size 170,34
$openRoot.FlatStyle=[Windows.Forms.FlatStyle]::Flat;$openRoot.FlatAppearance.BorderColor=[Drawing.Color]::FromArgb(191,191,187);$openRoot.FlatAppearance.MouseOverBackColor=[Drawing.Color]::FromArgb(238,238,235);$openRoot.BackColor=[Drawing.Color]::White;$openRoot.ForeColor=[Drawing.Color]::FromArgb(24,24,24);$openRoot.UseVisualStyleBackColor=$false;$openRoot.TabStop=$false;$openRoot.Add_MouseUp({$form.ActiveControl=$null})
$openRoot.Add_Click({ Start-Process explorer.exe -ArgumentList ('"{0}"' -f (Split-Path -Parent $controllerPath)) })
$form.Controls.Add($openRoot)

$menu = New-Object Windows.Forms.ContextMenuStrip
$openCenterItem = $menu.Items.Add('打开 MiniTools 控制中心')
[void]$menu.Items.Add('-')
foreach ($tool in $tools) {
    $submenu = New-Object Windows.Forms.ToolStripMenuItem $tool.Name
    $startMenu = $submenu.DropDownItems.Add('启动')
    $stopMenu = $submenu.DropDownItems.Add('停止')
    $showMenu = $submenu.DropDownItems.Add('打开')
    if($tool.Kind -eq 'static-tool'){$startMenu.Enabled=$false;$stopMenu.Enabled=$false}
    $capturedTool = $tool
    $startMenu.Add_Click({$script:desired[$capturedTool.Id]=$true;[void](Start-ManagedTool $capturedTool);Update-AllStates}.GetNewClosure())
    $stopMenu.Add_Click({[void](Stop-ManagedTool $capturedTool);Update-AllStates}.GetNewClosure())
    $showMenu.Add_Click({Show-Tool $capturedTool}.GetNewClosure())
    [void]$menu.Items.Add($submenu)
}
[void]$menu.Items.Add('-')
$exitKeep = $menu.Items.Add('退出控制器（保持工具运行）')
$stopExit = $menu.Items.Add('停止全部并退出')

$notifyIcon = New-Object Windows.Forms.NotifyIcon
$notifyIcon.Icon = if(Test-Path -LiteralPath $iconPath){New-Object Drawing.Icon $iconPath}else{[Drawing.SystemIcons]::Application}
$notifyIcon.Text = 'MiniTools 控制中心'
$notifyIcon.ContextMenuStrip = $menu
$notifyIcon.Visible = $true
Write-ControllerLog '主窗体和托盘图标已创建。'
$openCenterItem.Add_Click({$form.Show();$form.Activate()})
$notifyIcon.Add_DoubleClick({$form.Show();$form.Activate()})
$exitKeep.Add_Click({$script:exiting=$true;[Windows.Forms.Application]::Exit()})
$stopExit.Add_Click({foreach($tool in $tools){[void](Stop-ManagedTool $tool -Quiet)};$script:exiting=$true;[Windows.Forms.Application]::Exit()})
$form.Add_FormClosing({param($sender,$eventArgs);if(-not $script:exiting -and $eventArgs.CloseReason -eq [Windows.Forms.CloseReason]::UserClosing){$eventArgs.Cancel=$true;$form.Hide()}})

$timer = New-Object Windows.Forms.Timer
$timer.Interval = 5000
$timer.Add_Tick({if(Test-Path -LiteralPath $showRequestPath){Remove-Item -LiteralPath $showRequestPath -Force -ErrorAction SilentlyContinue;$form.Show();$form.Activate()};[void](Set-SystemTheme);Update-AllStates})
$timer.Start()
$smokeTimer = $null
if($SmokeTestSeconds -gt 0){$smokeTimer=New-Object Windows.Forms.Timer;$smokeTimer.Interval=[math]::Max(1000,$SmokeTestSeconds*1000);$smokeTimer.Add_Tick({$smokeTimer.Stop();$script:exiting=$true;[Windows.Forms.Application]::Exit()});$smokeTimer.Start()}
$previewTimer=$null
if($ShowOnStart -and $RenderPreviewPath){$previewTimer=New-Object Windows.Forms.Timer;$previewTimer.Interval=1200;$previewTimer.Add_Tick({$previewTimer.Stop();$bitmap=New-Object Drawing.Bitmap $form.Width,$form.Height;$rectangle=New-Object Drawing.Rectangle 0,0,$form.Width,$form.Height;$form.DrawToBitmap($bitmap,$rectangle);$bitmap.Save($RenderPreviewPath,[Drawing.Imaging.ImageFormat]::Png);$bitmap.Dispose()});$previewTimer.Start()}
try {
    foreach($tool in $tools){if($script:desired[$tool.Id] -and -not (Get-ToolState $tool).Running){[void](Start-ManagedTool $tool -Quiet)}}
    [void](Set-SystemTheme -Force)
    Update-AllStates
    if($ShowOnStart){$form.Show()}
    Write-ControllerLog ("进入消息循环，ShowOnStart={0}，Visible={1}，Handle={2}。" -f $ShowOnStart,$form.Visible,$form.Handle)
    [Windows.Forms.Application]::Run()
} finally {
    Write-ControllerLog '控制器正在退出。'
    $timer.Stop();$timer.Dispose();if($smokeTimer){$smokeTimer.Stop();$smokeTimer.Dispose()};if($previewTimer){$previewTimer.Stop();$previewTimer.Dispose()};$notifyIcon.Visible=$false;$notifyIcon.Dispose();$menu.Dispose();$form.Dispose();try{$runtime=Read-JsonFile $runtimePath;if([int]$runtime.pid -eq $PID){Remove-Item -LiteralPath $runtimePath -Force}}catch{};$mutex.Dispose()
}
