[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
$runPath='HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
Remove-ItemProperty -Path $runPath -Name 'MiniToolsController' -ErrorAction SilentlyContinue
$shortcuts=@((Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\MiniTools 控制中心.lnk'),(Join-Path ([Environment]::GetFolderPath('Desktop')) 'MiniTools 控制中心.lnk'),(Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup\MiniTools 控制中心.lnk'))
foreach($shortcut in $shortcuts){Remove-Item -LiteralPath $shortcut -Force -ErrorAction SilentlyContinue}
Write-Host 'MiniTools 控制中心快捷方式和开机启动项已移除。工具和数据均已保留。' -ForegroundColor Green
