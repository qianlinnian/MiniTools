[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$target = Join-Path $env:LOCALAPPDATA 'Programs\CodexQuotaTray'
$shortcutPath = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Codex 剩余额度.lnk'

Remove-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'CodexQuotaTray' -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $shortcutPath -Force -ErrorAction SilentlyContinue

if ((Test-Path -LiteralPath $target) -and ((Resolve-Path -LiteralPath $target).Path -eq $target)) {
    Write-Host '请先从托盘图标右键退出程序，然后删除以下文件夹：'
    Write-Host $target
} else {
    Write-Host 'Codex 剩余额度的开机启动项和开始菜单快捷方式已移除。'
}
