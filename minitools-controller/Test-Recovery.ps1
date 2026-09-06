$ErrorActionPreference='Stop'
$tokens=$null;$parseErrors=$null
$source=Join-Path $PSScriptRoot 'Start-MiniToolsController.ps1'
$ast=[Management.Automation.Language.Parser]::ParseFile($source,[ref]$tokens,[ref]$parseErrors)
if($parseErrors.Count){throw ($parseErrors | Out-String)}
foreach($name in @('Test-ToolProcess','Get-ToolState','Start-ManagedTool','Update-AllStates')){
 $fn=$ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name},$true)
 Invoke-Expression $fn.Extent.Text
}
function Assert($condition,$message){if(-not $condition){throw $message}}
function Read-JsonFile { return $null }
function Write-ControllerLog {}
function Resolve-Executable { throw 'missing executable' }
$script:launched=@{sample=[pscustomobject]@{HasExited=$false}}
$tool=[pscustomobject]@{Id='sample';Name='sample';Kind='http-runtime';RuntimePath=$null;StopRequestPath=$null;ShowRequestPath=$null;RestartOnFailure=$true}
$state=Get-ToolState $tool
Assert ($state.Running -and -not $state.Healthy) 'An unready live process must prevent duplicate launch'
$script:launched=@{}
$script:recovery=@{sample=@{Attempts=0;Next=[datetime]::MinValue;HealthySince=$null;Paused=$false}}
$script:lastStart=@{}
for($attempt=1;$attempt -le 5;$attempt++){
 [void](Start-ManagedTool $tool -Quiet)
 Assert ($script:recovery.sample.Attempts -eq $attempt) 'Failed attempts must be counted'
 $delay=($script:recovery.sample.Next-(Get-Date)).TotalSeconds
 Assert ($delay -gt (15*[math]::Pow(2,$attempt-1)-3)) 'Backoff must increase'
}
Assert $script:recovery.sample.Paused 'Five failures must pause recovery'
$script:desired=@{sample=$true};$script:rows=@{};$tools=@($tool)
$notifyIcon=[pscustomobject]@{Text=''};$summaryLabel=[pscustomobject]@{Text=''}
Update-AllStates
Assert ($script:recovery.sample.Attempts -eq 5) 'Paused recovery must not launch again'
$script:launched.sample=[pscustomobject]@{HasExited=$false}
[void](Start-ManagedTool $tool)
Assert ($script:recovery.sample.Attempts -eq 0 -and -not $script:recovery.sample.Paused) 'Manual start resets recovery budget'
$script:launched=@{}
$script:desired.sample=$false;$script:recovery.sample.Next=[datetime]::MinValue
Update-AllStates
Assert ($script:recovery.sample.Attempts -eq 0) 'User stop must disable automatic launch'
Write-Output 'PASS controller: live process guard, backoff, pause, manual reset, user stop'
