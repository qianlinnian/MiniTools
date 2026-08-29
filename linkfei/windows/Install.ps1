[CmdletBinding()]
param(
    [switch]$NoAutoStart,
    [switch]$NoDesktopShortcut,
    [switch]$NoLaunch
)

$ErrorActionPreference = 'Stop'
$launcher = Join-Path $PSScriptRoot 'Run LinkFei Tray.vbs'
if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) { throw "找不到托盘启动器：$launcher" }

$shell = New-Object -ComObject WScript.Shell
$startMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\LinkFei.lnk'
$shortcut = $shell.CreateShortcut($startMenu)
$shortcut.TargetPath = $launcher
$shortcut.WorkingDirectory = $PSScriptRoot
$shortcut.Description = '启动 LinkFei 飞书机器人托盘程序'
$shortcut.Save()

if (-not $NoDesktopShortcut) {
    $desktop = [Environment]::GetFolderPath('Desktop')
    $desktopShortcut = $shell.CreateShortcut((Join-Path $desktop 'LinkFei.lnk'))
    $desktopShortcut.TargetPath = $launcher
    $desktopShortcut.WorkingDirectory = $PSScriptRoot
    $desktopShortcut.Description = '启动 LinkFei 飞书机器人托盘程序'
    $desktopShortcut.Save()
}

$runPath = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
if (-not $NoAutoStart) {
    $command = 'wscript.exe "{0}"' -f $launcher
    Set-ItemProperty -Path $runPath -Name 'LinkFeiTray' -Value $command -Type String
}

if (-not $NoLaunch) { Start-Process -FilePath $launcher }
Write-Host 'LinkFei 托盘程序已安装。' -ForegroundColor Green
Write-Host ('程序目录：{0}' -f (Split-Path -Parent $PSScriptRoot))
