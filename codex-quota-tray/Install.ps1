[CmdletBinding()]
param(
    [switch]$NoAutoStart,
    [switch]$NoLaunch
)

$ErrorActionPreference = 'Stop'
$source = Split-Path -Parent $PSCommandPath
$target = Join-Path $env:LOCALAPPDATA 'Programs\CodexQuotaTray'
$startMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
$shortcutPath = Join-Path $startMenu 'Codex 剩余额度.lnk'

if (-not (Test-Path -LiteralPath $target)) { New-Item -ItemType Directory -Path $target -Force | Out-Null }
$installFiles = @('Start-CodexQuotaTray.ps1', 'Run Codex Quota Tray.vbs', 'Uninstall.ps1', 'README.md')
foreach ($fileName in $installFiles) {
    Copy-Item -LiteralPath (Join-Path $source $fileName) -Destination $target -Force
}

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = Join-Path $target 'Run Codex Quota Tray.vbs'
$shortcut.WorkingDirectory = $target
$shortcut.Description = '在 Windows 通知区域显示 Codex 剩余额度'
$shortcut.Save()

$runPath = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
if (-not $NoAutoStart) {
    $powershell = Join-Path $PSHOME 'powershell.exe'
    $script = Join-Path $target 'Start-CodexQuotaTray.ps1'
    $command = '"{0}" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{1}"' -f $powershell, $script
    Set-ItemProperty -Path $runPath -Name 'CodexQuotaTray' -Value $command -Type String
}

if (-not $NoLaunch) {
    Start-Process -FilePath (Join-Path $target 'Run Codex Quota Tray.vbs')
}

Write-Host 'Codex 剩余额度已安装。' -ForegroundColor Green
Write-Host ('安装位置：{0}' -f $target)
