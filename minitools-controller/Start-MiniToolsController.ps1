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
}

function Read-JsonFile([string]$Path) {
    if (-not $Path -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    try { return Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json }
    catch { return $null }
}

function Get-ToolState($Tool) {
    $runtime = Read-JsonFile $Tool.RuntimePath
    if ($Tool.Kind -eq 'http-runtime') {
        if (-not $runtime.port -or -not $runtime.token) { return [pscustomobject]@{ Running=$false; Detail='已停止'; Runtime=$runtime } }
        try {
            $headers = @{ Authorization = 'Bearer {0}' -f $runtime.token }
            $health = Invoke-RestMethod -Uri ('http://127.0.0.1:{0}/health' -f $runtime.port) -Headers $headers -Method Get -TimeoutSec 2
            return [pscustomobject]@{ Running=[bool]$health.ok; Detail=if($health.state -eq 'connected'){'已连接'}else{[string]$health.state}; Runtime=$runtime; Health=$health }
        } catch { return [pscustomobject]@{ Running=$false; Detail='无响应'; Runtime=$runtime } }
    }
    if ($Tool.Kind -eq 'managed-process') {
        if (-not $runtime.pid) { return [pscustomobject]@{ Running=$false; Detail='已停止'; Runtime=$runtime } }
        $process = Get-Process -Id ([int]$runtime.pid) -ErrorAction SilentlyContinue
        return [pscustomobject]@{ Running=[bool]$process; Detail=if($process){'运行中'}else{'进程已退出'}; Runtime=$runtime }
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
    if ((Get-ToolState $Tool).Running) { return $true }
    $script:lastStart[$Tool.Id] = Get-Date
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
        Write-ControllerLog "启动 $($Tool.Id)，PID $($process.Id)。"
        for ($attempt=0; $attempt -lt 20; $attempt++) {
            Start-Sleep -Milliseconds 500
            if ((Get-ToolState $Tool).Running) { return $true }
            if ($process.HasExited) { break }
        }
        throw "$($Tool.Name) 未能在 10 秒内就绪。"
    } catch {
        Write-ControllerLog "启动 $($Tool.Id) 失败：$($_.Exception.Message)"
        if (-not $Quiet) { [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, 'MiniTools 控制中心', 'OK', 'Error') | Out-Null }
        return $false
    }
}

function Stop-ManagedTool($Tool, [switch]$Quiet) {
    $script:desired[$Tool.Id] = $false
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

function Update-AllStates {
    $runningCount = 0
    $availableCount = 0
    foreach ($tool in $tools) {
        $state = Get-ToolState $tool
        if ($state.Running) { $runningCount++ }
        if ($tool.Kind -eq 'static-tool' -and $state.Available) { $availableCount++ }
        $row = $script:rows[$tool.Id]
        if ($row) {
            $healthy = $state.Running -or ($tool.Kind -eq 'static-tool' -and $state.Available)
            $row.Status.Text = if($healthy){'●  ' + $state.Detail}else{'○  ' + $state.Detail}
            $row.Start.Enabled = ($tool.Kind -ne 'static-tool') -and (-not $state.Running)
            $row.Stop.Enabled = ($tool.Kind -ne 'static-tool') -and $state.Running
            $mutedBackground=[Drawing.Color]::FromArgb(243,244,246);$mutedForeground=[Drawing.Color]::FromArgb(156,163,175);$mutedBorder=[Drawing.Color]::FromArgb(209,213,219)
            $row.Open.BackColor=[Drawing.Color]::White;$row.Open.ForeColor=[Drawing.Color]::FromArgb(31,41,55);$row.Open.FlatAppearance.BorderColor=[Drawing.Color]::FromArgb(75,85,99)
            if($state.Running){
                $row.Panel.BackColor=[Drawing.Color]::FromArgb(240,253,244);$row.Accent.BackColor=[Drawing.Color]::FromArgb(22,163,74)
                $row.Status.BackColor=[Drawing.Color]::FromArgb(22,163,74);$row.Status.ForeColor=[Drawing.Color]::White
                $row.Start.BackColor=$mutedBackground;$row.Start.ForeColor=$mutedForeground;$row.Start.FlatAppearance.BorderColor=$mutedBorder
                $row.Stop.BackColor=[Drawing.Color]::FromArgb(220,38,38);$row.Stop.ForeColor=[Drawing.Color]::White;$row.Stop.FlatAppearance.BorderColor=[Drawing.Color]::FromArgb(220,38,38)
            }elseif($tool.Kind -eq 'static-tool' -and $state.Available){
                $row.Panel.BackColor=[Drawing.Color]::FromArgb(239,246,255);$row.Accent.BackColor=[Drawing.Color]::FromArgb(37,99,235)
                $row.Status.BackColor=[Drawing.Color]::FromArgb(37,99,235);$row.Status.ForeColor=[Drawing.Color]::White
                foreach($button in @($row.Start,$row.Stop)){$button.BackColor=$mutedBackground;$button.ForeColor=$mutedForeground;$button.FlatAppearance.BorderColor=$mutedBorder}
                $row.Open.BackColor=[Drawing.Color]::FromArgb(37,99,235);$row.Open.ForeColor=[Drawing.Color]::White;$row.Open.FlatAppearance.BorderColor=[Drawing.Color]::FromArgb(37,99,235)
            }else{
                $row.Panel.BackColor=[Drawing.Color]::White;$row.Accent.BackColor=[Drawing.Color]::FromArgb(156,163,175)
                $row.Status.BackColor=[Drawing.Color]::FromArgb(229,231,235);$row.Status.ForeColor=[Drawing.Color]::FromArgb(75,85,99)
                $row.Start.BackColor=[Drawing.Color]::FromArgb(22,163,74);$row.Start.ForeColor=[Drawing.Color]::White;$row.Start.FlatAppearance.BorderColor=[Drawing.Color]::FromArgb(22,163,74)
                $row.Stop.BackColor=$mutedBackground;$row.Stop.ForeColor=$mutedForeground;$row.Stop.FlatAppearance.BorderColor=$mutedBorder
            }
        }
        if (-not $state.Running -and $script:desired[$tool.Id] -and $tool.RestartOnFailure -and ((Get-Date)-$script:lastStart[$tool.Id]).TotalSeconds -ge 15) {
            [void](Start-ManagedTool $tool -Quiet)
        }
    }
    $notifyIcon.Text = ("MiniTools：{0} 个运行，{1} 个静态工具可用" -f $runningCount,$availableCount)
    $summaryLabel.Text = ("{0} 个工具 · {1} 个运行 · {2} 个静态工具可用" -f $tools.Count,$runningCount,$availableCount)
}

$form = New-Object System.Windows.Forms.Form
$form.Text = 'MiniTools 控制中心'
$form.Size = New-Object Drawing.Size 700, (190 + 112 * $tools.Count)
$form.MinimumSize = $form.Size
$form.MaximumSize = $form.Size
$form.StartPosition = 'CenterScreen'
$form.BackColor = [Drawing.Color]::FromArgb(245,247,251)
$form.Font = New-Object Drawing.Font 'Microsoft YaHei UI', 9
$form.ShowInTaskbar = $true
$form.FormBorderStyle = [Windows.Forms.FormBorderStyle]::FixedSingle
$form.MaximizeBox = $false
if (Test-Path -LiteralPath $iconPath) { $form.Icon = New-Object Drawing.Icon $iconPath }

$titleLabel = New-Object Windows.Forms.Label
$titleLabel.Text = 'MiniTools 控制中心'
$titleLabel.Font = New-Object Drawing.Font 'Microsoft YaHei UI', 18, ([Drawing.FontStyle]::Bold)
$titleLabel.Location = New-Object Drawing.Point 24,20
$titleLabel.AutoSize = $true
$summaryLabel = New-Object Windows.Forms.Label
$summaryLabel.Text = '正在检查工具状态…'
$summaryLabel.ForeColor = [Drawing.Color]::FromArgb(100,108,125)
$summaryLabel.Location = New-Object Drawing.Point 28,58
$summaryLabel.AutoSize = $true
$form.Controls.AddRange(@($titleLabel,$summaryLabel))

$y = 92
foreach ($tool in $tools) {
    $panel = New-Object Windows.Forms.Panel
    $panel.Location = New-Object Drawing.Point 24,$y
    $panel.Size = New-Object Drawing.Size 635,94
    $panel.BackColor = [Drawing.Color]::White
    $panel.BorderStyle = [Windows.Forms.BorderStyle]::FixedSingle
    $accent = New-Object Windows.Forms.Panel
    $accent.Location = New-Object Drawing.Point 0,0
    $accent.Size = New-Object Drawing.Size 6,92
    $accent.BackColor = [Drawing.Color]::FromArgb(156,163,175)
    $name = New-Object Windows.Forms.Label
    $name.Text = $tool.Name
    $name.Font = New-Object Drawing.Font 'Microsoft YaHei UI',11,([Drawing.FontStyle]::Bold)
    $name.Location = New-Object Drawing.Point 22,12
    $name.AutoSize = $true
    $description = New-Object Windows.Forms.Label
    $description.Text = $tool.Description
    $description.ForeColor = [Drawing.Color]::FromArgb(100,108,125)
    $description.Location = New-Object Drawing.Point 22,42
    $description.Size = New-Object Drawing.Size 300,38
    $status = New-Object Windows.Forms.Label
    $status.Text = '检查中…'
    $status.Location = New-Object Drawing.Point 330,16
    $status.Size = New-Object Drawing.Size 120,26
    $status.TextAlign = [Drawing.ContentAlignment]::MiddleCenter
    $status.Font = New-Object Drawing.Font 'Microsoft YaHei UI',9,([Drawing.FontStyle]::Bold)
    $start = New-Object Windows.Forms.Button
    $start.Text = '启动'; $start.Location = New-Object Drawing.Point 330,48; $start.Size = New-Object Drawing.Size 82,30
    $stop = New-Object Windows.Forms.Button
    $stop.Text = '停止'; $stop.Location = New-Object Drawing.Point 420,48; $stop.Size = New-Object Drawing.Size 82,30
    $open = New-Object Windows.Forms.Button
    $open.Text = '打开'; $open.Location = New-Object Drawing.Point 510,48; $open.Size = New-Object Drawing.Size 82,30
    if($tool.Kind -eq 'static-tool'){$start.Text='—';$stop.Text='—'}
    foreach($button in @($start,$stop,$open)){$button.FlatStyle=[Windows.Forms.FlatStyle]::Flat;$button.FlatAppearance.BorderSize=1;$button.FlatAppearance.BorderColor=[Drawing.Color]::Black;$button.Cursor=[Windows.Forms.Cursors]::Hand;$button.TabStop=$false;$button.Add_MouseUp({$form.ActiveControl=$null})}
    $start.BackColor=[Drawing.Color]::White;$start.ForeColor=[Drawing.Color]::Black;$start.UseVisualStyleBackColor=$false
    $stop.BackColor=[Drawing.Color]::White;$stop.ForeColor=[Drawing.Color]::Black;$stop.UseVisualStyleBackColor=$false
    $open.BackColor=[Drawing.Color]::White;$open.ForeColor=[Drawing.Color]::Black;$open.UseVisualStyleBackColor=$false
    $capturedTool = $tool
    $start.Add_Click({ $script:desired[$capturedTool.Id]=$true; [void](Start-ManagedTool $capturedTool); Update-AllStates }.GetNewClosure())
    $stop.Add_Click({ [void](Stop-ManagedTool $capturedTool); Update-AllStates }.GetNewClosure())
    $open.Add_Click({ Show-Tool $capturedTool }.GetNewClosure())
    $panel.Controls.AddRange(@($accent,$name,$description,$status,$start,$stop,$open))
    $form.Controls.Add($panel)
    $script:rows[$tool.Id] = [pscustomobject]@{Panel=$panel;Accent=$accent;Status=$status;Start=$start;Stop=$stop;Open=$open}
    $y += 106
}

$openRoot = New-Object Windows.Forms.Button
$openRoot.Text = '打开 MiniTools 文件夹'
$openRoot.Location = New-Object Drawing.Point 24,$y
$openRoot.Size = New-Object Drawing.Size 170,34
$openRoot.FlatStyle=[Windows.Forms.FlatStyle]::Flat;$openRoot.FlatAppearance.BorderColor=[Drawing.Color]::Black;$openRoot.BackColor=[Drawing.Color]::White;$openRoot.ForeColor=[Drawing.Color]::Black;$openRoot.UseVisualStyleBackColor=$false;$openRoot.TabStop=$false;$openRoot.Add_MouseUp({$form.ActiveControl=$null})
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
$timer.Add_Tick({if(Test-Path -LiteralPath $showRequestPath){Remove-Item -LiteralPath $showRequestPath -Force -ErrorAction SilentlyContinue;$form.Show();$form.Activate()};Update-AllStates})
$timer.Start()
$smokeTimer = $null
if($SmokeTestSeconds -gt 0){$smokeTimer=New-Object Windows.Forms.Timer;$smokeTimer.Interval=[math]::Max(1000,$SmokeTestSeconds*1000);$smokeTimer.Add_Tick({$smokeTimer.Stop();$script:exiting=$true;[Windows.Forms.Application]::Exit()});$smokeTimer.Start()}
$previewTimer=$null
if($ShowOnStart -and $RenderPreviewPath){$previewTimer=New-Object Windows.Forms.Timer;$previewTimer.Interval=1200;$previewTimer.Add_Tick({$previewTimer.Stop();$bitmap=New-Object Drawing.Bitmap $form.Width,$form.Height;$rectangle=New-Object Drawing.Rectangle 0,0,$form.Width,$form.Height;$form.DrawToBitmap($bitmap,$rectangle);$bitmap.Save($RenderPreviewPath,[Drawing.Imaging.ImageFormat]::Png);$bitmap.Dispose()});$previewTimer.Start()}
try {
    foreach($tool in $tools){if($script:desired[$tool.Id] -and -not (Get-ToolState $tool).Running){[void](Start-ManagedTool $tool -Quiet)}}
    Update-AllStates
    if($ShowOnStart){$form.Show()}
    Write-ControllerLog ("进入消息循环，ShowOnStart={0}，Visible={1}，Handle={2}。" -f $ShowOnStart,$form.Visible,$form.Handle)
    [Windows.Forms.Application]::Run()
} finally {
    Write-ControllerLog '控制器正在退出。'
    $timer.Stop();$timer.Dispose();if($smokeTimer){$smokeTimer.Stop();$smokeTimer.Dispose()};if($previewTimer){$previewTimer.Stop();$previewTimer.Dispose()};$notifyIcon.Visible=$false;$notifyIcon.Dispose();$menu.Dispose();$form.Dispose();try{$runtime=Read-JsonFile $runtimePath;if([int]$runtime.pid -eq $PID){Remove-Item -LiteralPath $runtimePath -Force}}catch{};$mutex.Dispose()
}
