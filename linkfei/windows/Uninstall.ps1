[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$startMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\LinkFei.lnk'
$desktop = Join-Path ([Environment]::GetFolderPath('Desktop')) 'LinkFei.lnk'
foreach ($shortcut in @($startMenu, $desktop)) {
    if (Test-Path -LiteralPath $shortcut) { Remove-Item -LiteralPath $shortcut -Force }
}
$runPath = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
Remove-ItemProperty -Path $runPath -Name 'LinkFeiTray' -ErrorAction SilentlyContinue
Write-Host 'LinkFei 托盘快捷方式和开机启动项已移除。当前运行实例可从托盘菜单退出。' -ForegroundColor Green
