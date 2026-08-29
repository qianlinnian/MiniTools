[CmdletBinding()]
param([switch]$NoAutoStart,[switch]$NoDesktopShortcut,[switch]$NoLaunch)

$ErrorActionPreference='Stop'
$launcher=Join-Path $PSScriptRoot 'Run MiniTools Controller.vbs'
$icon=Join-Path $PSScriptRoot 'assets\minitools-controller.ico'
$shell=New-Object -ComObject WScript.Shell
$startMenu=Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\MiniTools 控制中心.lnk'
$shortcut=$shell.CreateShortcut($startMenu)
$shortcut.TargetPath=$launcher;$shortcut.WorkingDirectory=$PSScriptRoot;$shortcut.IconLocation=$icon;$shortcut.Description='统一管理本机 MiniTools';$shortcut.Save()
if(-not $NoDesktopShortcut){$desktop=Join-Path ([Environment]::GetFolderPath('Desktop')) 'MiniTools 控制中心.lnk';$desktopShortcut=$shell.CreateShortcut($desktop);$desktopShortcut.TargetPath=$launcher;$desktopShortcut.WorkingDirectory=$PSScriptRoot;$desktopShortcut.IconLocation=$icon;$desktopShortcut.Description='统一管理本机 MiniTools';$desktopShortcut.Save()}
$runPath='HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
Remove-ItemProperty -Path $runPath -Name 'LinkFeiTray' -ErrorAction SilentlyContinue
Remove-ItemProperty -Path $runPath -Name 'CodexQuotaTray' -ErrorAction SilentlyContinue
Remove-ItemProperty -Path $runPath -Name 'MiniToolsController' -ErrorAction SilentlyContinue
$startupShortcut=Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup\MiniTools 控制中心.lnk'
if(-not $PSBoundParameters.ContainsKey('NoAutoStart')){$startup=$shell.CreateShortcut($startupShortcut);$startup.TargetPath=$launcher;$startup.Arguments='';$startup.WorkingDirectory=$PSScriptRoot;$startup.IconLocation=$icon;$startup.Description='登录 Windows 后启动 MiniTools 控制中心';$startup.Save();Write-Host '已启用当前用户开机启动。'}else{Remove-Item -LiteralPath $startupShortcut -Force -ErrorAction SilentlyContinue;Write-Host '按参数要求跳过开机启动。'}
Remove-Item -LiteralPath (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\LinkFei.lnk') -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath (Join-Path ([Environment]::GetFolderPath('Desktop')) 'LinkFei.lnk') -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Codex 剩余额度.lnk') -Force -ErrorAction SilentlyContinue
if(-not $NoLaunch){Start-Process -FilePath $launcher}
Write-Host 'MiniTools 控制中心已安装。' -ForegroundColor Green
