[CmdletBinding()]
param(
    [switch]$Probe,
    [switch]$SelfTest,
    [int]$SmokeTestSeconds = 0,
    [switch]$ShowOnStart,
    [string]$RenderPreviewPath,
    [string]$RenderIconPreviewPath
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$transportSource = @'
using System;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.IO;
using System.Text;

public sealed class CodexAppServerTransport : IDisposable
{
    private readonly ConcurrentQueue<string> output = new ConcurrentQueue<string>();
    private readonly ConcurrentQueue<string> errors = new ConcurrentQueue<string>();
    private readonly object sendLock = new object();
    private Process process;

    public bool IsRunning
    {
        get { return process != null && !process.HasExited; }
    }

    public void Start(string executable, string arguments)
    {
        Stop();
        var info = new ProcessStartInfo
        {
            FileName = executable,
            Arguments = arguments,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardOutputEncoding = new UTF8Encoding(false),
            StandardErrorEncoding = new UTF8Encoding(false),
            WindowStyle = ProcessWindowStyle.Hidden
        };

        process = new Process { StartInfo = info, EnableRaisingEvents = true };
        process.OutputDataReceived += delegate(object sender, DataReceivedEventArgs e)
        {
            if (!String.IsNullOrWhiteSpace(e.Data)) output.Enqueue(e.Data);
        };
        process.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs e)
        {
            if (!String.IsNullOrWhiteSpace(e.Data)) errors.Enqueue(e.Data);
        };
        process.Start();
        // Windows PowerShell 5.1 creates redirected stdin with a UTF-8 BOM.
        // Put that preamble on its own disposable line so it cannot prefix the
        // first JSON-RPC request. Subsequent lines are clean UTF-8.
        process.StandardInput.WriteLine();
        process.StandardInput.Flush();
        process.BeginOutputReadLine();
        process.BeginErrorReadLine();
    }

    public void Send(string json)
    {
        lock (sendLock)
        {
            if (!IsRunning) throw new InvalidOperationException("Codex app-server is not running.");
            process.StandardInput.WriteLine(json);
            process.StandardInput.Flush();
        }
    }

    public string[] DrainOutput()
    {
        var items = new System.Collections.Generic.List<string>();
        string value;
        while (output.TryDequeue(out value)) items.Add(value);
        return items.ToArray();
    }

    public string[] DrainErrors()
    {
        var items = new System.Collections.Generic.List<string>();
        string value;
        while (errors.TryDequeue(out value)) items.Add(value);
        return items.ToArray();
    }

    public void Stop()
    {
        if (process == null) return;
        try
        {
            if (!process.HasExited)
            {
                try { process.StandardInput.Close(); } catch { }
                if (!process.WaitForExit(800)) process.Kill();
            }
        }
        catch { }
        finally
        {
            process.Dispose();
            process = null;
        }
    }

    public void Dispose() { Stop(); }
}

public static class NativeIcon
{
    [System.Runtime.InteropServices.DllImport("user32.dll", CharSet = System.Runtime.InteropServices.CharSet.Auto)]
    public static extern bool DestroyIcon(IntPtr handle);
}
'@

if (-not ('CodexAppServerTransport' -as [type])) {
    Add-Type -TypeDefinition $transportSource -ReferencedAssemblies @('System.dll')
}

$script:AppName = 'CodexQuotaTray'
$script:AppTitle = 'Codex 剩余额度'
$script:Version = '1.4.0'
$script:AppDataDirectory = Join-Path $env:LOCALAPPDATA $script:AppName
$script:LogPath = Join-Path $script:AppDataDirectory 'app.log'
$script:CachePath = Join-Path $script:AppDataDirectory 'quota-cache.json'
$script:RuntimePath = Join-Path $script:AppDataDirectory 'runtime.json'
$script:StopRequestPath = Join-Path $script:AppDataDirectory 'stop.request'
$script:ShowRequestPath = Join-Path $script:AppDataDirectory 'show.request'
$script:StartupRegistryPath = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$script:StartupValueName = 'CodexQuotaTray'
$script:Transport = $null
$script:Initialized = $false
$script:Snapshot = $null
$script:RequestId = 10
$script:LastRequestAt = [datetime]::MinValue
$script:LastResponseAt = [datetime]::MinValue
$script:LastThemeIsLight = $null
$script:LastIconKey = $null
$script:LastRowsKey = $null
$script:ReconnectAt = [datetime]::MinValue
$script:ConnectionState = '正在连接 Codex…'
$script:ExitRequested = $false

if (-not (Test-Path -LiteralPath $script:AppDataDirectory)) {
    New-Item -ItemType Directory -Path $script:AppDataDirectory -Force | Out-Null
}

function Write-AppLog {
    param([string]$Message)
    try {
        $line = '{0:yyyy-MM-dd HH:mm:ss}  {1}' -f (Get-Date), $Message
        Add-Content -LiteralPath $script:LogPath -Value $line -Encoding UTF8
        $log = Get-Item -LiteralPath $script:LogPath -ErrorAction SilentlyContinue
        if ($log -and $log.Length -gt 1048576) {
            Move-Item -LiteralPath $script:LogPath -Destination ($script:LogPath + '.old') -Force
        }
    } catch { }
}

function Get-PropertyValue {
    param($Object, [string]$Name)
    if ($null -eq $Object) { return $null }
    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property) { return $null }
    return $property.Value
}

function ConvertTo-QuotaSnapshot {
    param($Payload)

    if ($null -eq $Payload) { return $null }
    $bucketMap = Get-PropertyValue $Payload 'rateLimitsByLimitId'
    $single = Get-PropertyValue $Payload 'rateLimits'
    $windows = New-Object System.Collections.ArrayList

    $buckets = @()
    if ($null -ne $bucketMap) {
        foreach ($property in $bucketMap.PSObject.Properties) {
            $buckets += [pscustomobject]@{ Key = $property.Name; Value = $property.Value }
        }
    } elseif ($null -ne $single) {
        $key = Get-PropertyValue $single 'limitId'
        if ([string]::IsNullOrWhiteSpace([string]$key)) { $key = 'codex' }
        $buckets += [pscustomobject]@{ Key = [string]$key; Value = $single }
    } elseif ($null -ne (Get-PropertyValue $Payload 'primary')) {
        $key = Get-PropertyValue $Payload 'limitId'
        if ([string]::IsNullOrWhiteSpace([string]$key)) { $key = 'codex' }
        $buckets += [pscustomobject]@{ Key = [string]$key; Value = $Payload }
    }

    foreach ($bucketEntry in $buckets) {
        $bucket = $bucketEntry.Value
        $name = Get-PropertyValue $bucket 'limitName'
        if ([string]::IsNullOrWhiteSpace([string]$name)) { $name = $bucketEntry.Key }
        foreach ($slot in @('primary', 'secondary')) {
            $window = Get-PropertyValue $bucket $slot
            if ($null -eq $window) { continue }
            $used = Get-PropertyValue $window 'usedPercent'
            if ($null -eq $used) { continue }
            $usedNumber = [math]::Max(0, [math]::Min(100, [double]$used))
            $resetUnix = Get-PropertyValue $window 'resetsAt'
            $resetAt = $null
            if ($null -ne $resetUnix) {
                try { $resetAt = [DateTimeOffset]::FromUnixTimeSeconds([long]$resetUnix).LocalDateTime } catch { }
            }
            $minutes = Get-PropertyValue $window 'windowDurationMins'
            $null = $windows.Add([pscustomobject]@{
                LimitId = [string]$bucketEntry.Key
                LimitName = [string]$name
                Slot = $slot
                UsedPercent = [math]::Round($usedNumber, 1)
                RemainingPercent = [math]::Round(100 - $usedNumber, 1)
                WindowDurationMins = if ($null -eq $minutes) { $null } else { [int]$minutes }
                ResetsAt = $resetAt
            })
        }
    }

    if ($windows.Count -eq 0) { return $null }

    $codexWindows = @($windows | Where-Object { $_.LimitId -eq 'codex' })
    $displayPool = if ($codexWindows.Count -gt 0) { $codexWindows } else { @($windows) }
    $mostConstrained = $displayPool | Sort-Object RemainingPercent | Select-Object -First 1
    $accountBucketEntry = $buckets | Where-Object { $_.Key -eq 'codex' } | Select-Object -First 1
    if ($null -eq $accountBucketEntry) { $accountBucketEntry = $buckets | Select-Object -First 1 }
    $accountBucket = if ($null -eq $accountBucketEntry) { $null } else { $accountBucketEntry.Value }
    $credits = Get-PropertyValue $Payload 'credits'
    if ($null -eq $credits) { $credits = Get-PropertyValue $accountBucket 'credits' }
    $resetCredits = Get-PropertyValue $Payload 'rateLimitResetCredits'
    $planType = Get-PropertyValue $Payload 'planType'
    if ($null -eq $planType) { $planType = Get-PropertyValue $accountBucket 'planType' }

    [pscustomobject]@{
        RemainingPercent = [int][math]::Round($mostConstrained.RemainingPercent)
        UsedPercent = [int][math]::Round($mostConstrained.UsedPercent)
        ResetsAt = $mostConstrained.ResetsAt
        Windows = @($windows)
        PlanType = $planType
        Credits = $credits
        ResetCredits = $resetCredits
        UpdatedAt = (Get-Date).ToString('o')
        Source = 'Codex App Server'
        IsCached = $false
    }
}

function Format-WindowDuration {
    param($Minutes)
    if ($null -eq $Minutes) { return '额度窗口' }
    $value = [int]$Minutes
    if ($value -lt 60) { return ('{0} 分钟' -f $value) }
    if (($value % 1440) -eq 0) { return ('{0} 天' -f [int]($value / 1440)) }
    if (($value % 60) -eq 0) { return ('{0} 小时' -f [int]($value / 60)) }
    return ('{0} 分钟' -f $value)
}

function Get-DisplayQuotaWindows {
    param($Snapshot)
    if ($null -eq $Snapshot) { return @() }
    $allWindows = @($Snapshot.Windows)
    $codexWindows = @($allWindows | Where-Object { $_.LimitId -eq 'codex' })
    $displayWindows = if ($codexWindows.Count -gt 0) { $codexWindows } else { $allWindows }
    return @($displayWindows | Sort-Object @{ Expression = { if ($null -eq $_.WindowDurationMins) { [int]::MaxValue } else { [int]$_.WindowDurationMins } } })
}

function Get-ThemeIsLight {
    try {
        $value = Get-ItemPropertyValue -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize' -Name 'SystemUsesLightTheme' -ErrorAction Stop
        return ([int]$value -ne 0)
    } catch {
        return $false
    }
}

function New-QuotaIcon {
    param($Windows, [bool]$ThemeIsLight, [bool]$HasError)
    $bitmap = New-Object System.Drawing.Bitmap 32, 32, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
    $graphics.Clear([System.Drawing.Color]::Transparent)

    if ($ThemeIsLight) { $foreground = [System.Drawing.Color]::FromArgb(235, 0, 0, 0) }
    else { $foreground = [System.Drawing.Color]::FromArgb(245, 255, 255, 255) }
    $quotaWindows = @($Windows)
    if ($HasError -or $quotaWindows.Count -eq 0) {
        $font = New-Object System.Drawing.Font 'Segoe UI', 22, ([System.Drawing.FontStyle]::Bold), ([System.Drawing.GraphicsUnit]::Pixel)
        $brush = New-Object System.Drawing.SolidBrush $foreground
        $format = New-Object System.Drawing.StringFormat
        $format.Alignment = [System.Drawing.StringAlignment]::Center
        $format.LineAlignment = [System.Drawing.StringAlignment]::Center
        $graphics.DrawString('!', $font, $brush, (New-Object System.Drawing.RectangleF 0, -1, 32, 32), $format)
        $format.Dispose(); $brush.Dispose(); $font.Dispose()
    } else {
        $trackColor = if ($ThemeIsLight) { [System.Drawing.Color]::FromArgb(55, 17, 24, 39) } else { [System.Drawing.Color]::FromArgb(70, 255, 255, 255) }
        $outerColor = if ($ThemeIsLight) { [System.Drawing.Color]::FromArgb(255, 5, 150, 105) } else { [System.Drawing.Color]::FromArgb(255, 52, 211, 153) }
        $innerColor = if ($ThemeIsLight) { [System.Drawing.Color]::FromArgb(255, 37, 99, 235) } else { [System.Drawing.Color]::FromArgb(255, 96, 165, 250) }
        $trackPen = New-Object System.Drawing.Pen $trackColor, 3.2
        $trackPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
        $trackPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
        $outerPen = New-Object System.Drawing.Pen $outerColor, 3.2
        $outerPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
        $outerPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
        $innerPen = New-Object System.Drawing.Pen $innerColor, 3.2
        $innerPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
        $innerPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round

        $outerPercent = [math]::Max(0, [math]::Min(100, [double]$quotaWindows[0].RemainingPercent))
        $innerWindow = if ($quotaWindows.Count -gt 1) { $quotaWindows[1] } else { $quotaWindows[0] }
        $innerPercent = [math]::Max(0, [math]::Min(100, [double]$innerWindow.RemainingPercent))
        $outerRect = New-Object System.Drawing.RectangleF 2.7, 2.7, 26.6, 26.6
        $innerRect = New-Object System.Drawing.RectangleF 8.2, 8.2, 15.6, 15.6
        $graphics.DrawArc($trackPen, $outerRect, -90, 359.9)
        $graphics.DrawArc($trackPen, $innerRect, -90, 359.9)
        if ($outerPercent -gt 0) { $graphics.DrawArc($outerPen, $outerRect, -90, [single]($outerPercent * 3.599)) }
        if ($innerPercent -gt 0) { $graphics.DrawArc($innerPen, $innerRect, -90, [single]($innerPercent * 3.599)) }
        $innerPen.Dispose(); $outerPen.Dispose(); $trackPen.Dispose()
    }

    $graphics.Dispose()
    $handle = $bitmap.GetHicon()
    try { $icon = [System.Drawing.Icon]::FromHandle($handle).Clone() }
    finally { [NativeIcon]::DestroyIcon($handle) | Out-Null; $bitmap.Dispose() }
    return $icon
}

function Set-QuotaNotifyIcon {
    param($Windows, [bool]$ThemeIsLight, [bool]$HasError)
    $quotaWindows = @($Windows)
    $valueKey = if ($quotaWindows.Count -eq 0) { 'none' } else { @($quotaWindows | Select-Object -First 2 | ForEach-Object { '{0}:{1}' -f $_.WindowDurationMins, ([int][math]::Round($_.RemainingPercent)) }) -join ',' }
    $key = '{0}|{1}|{2}' -f $valueKey, $ThemeIsLight, $HasError
    if ($script:LastIconKey -eq $key) { return }

    $newIcon = New-QuotaIcon -Windows $quotaWindows -ThemeIsLight $ThemeIsLight -HasError $HasError
    $oldIcon = $script:NotifyIcon.Icon
    $script:NotifyIcon.Icon = $newIcon
    $script:LastIconKey = $key
    if ($null -ne $oldIcon) { $oldIcon.Dispose() }
}

function Resolve-CodexCommand {
    # Prefer the npm/CLI wrapper when present. Windows Store package executables can
    # be visible in PATH while direct child-process launch is denied by AppContainer.
    $cmd = Get-Command 'codex.cmd' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($cmd) {
        $arguments = '/d /s /c ""{0}" app-server"' -f $cmd.Source
        return [pscustomobject]@{ Executable = $env:ComSpec; Arguments = $arguments }
    }

    $exe = Get-Command 'codex.exe' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($exe) { return [pscustomobject]@{ Executable = $exe.Source; Arguments = 'app-server' } }
    throw '未找到 Codex CLI。请先安装或更新 Codex。'
}

function Send-AppServerMessage {
    param([hashtable]$Message)
    $json = $Message | ConvertTo-Json -Depth 12 -Compress
    $script:Transport.Send($json)
}

function Start-AppServer {
    try {
        if ($null -ne $script:Transport) { $script:Transport.Dispose() }
        $command = Resolve-CodexCommand
        $script:Transport = New-Object CodexAppServerTransport
        $script:Transport.Start($command.Executable, $command.Arguments)
        $script:Initialized = $false
        $script:LastRequestAt = Get-Date
        Send-AppServerMessage @{ method = 'initialize'; id = 1; params = @{ clientInfo = @{ name = 'codex_quota_tray'; title = 'Codex Quota Tray'; version = $script:Version } } }
        $script:ConnectionState = '已连接，正在读取额度…'
        $script:ReconnectAt = [datetime]::MinValue
        Write-AppLog ('Started app-server via {0}' -f $command.Executable)
    } catch {
        $script:ConnectionState = $_.Exception.Message
        $script:ReconnectAt = (Get-Date).AddSeconds(15)
        Write-AppLog ('App-server start failed: {0}' -f $_.Exception.Message)
    }
}

function Request-QuotaRefresh {
    if ($null -eq $script:Transport -or -not $script:Transport.IsRunning -or -not $script:Initialized) { return }
    $script:RequestId++
    Send-AppServerMessage @{ method = 'account/rateLimits/read'; id = $script:RequestId; params = @{} }
    $script:LastRequestAt = Get-Date
}

function Save-SnapshotCache {
    param($Snapshot)
    try { $Snapshot | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $script:CachePath -Encoding UTF8 } catch { }
}

function Load-SnapshotCache {
    try {
        if (-not (Test-Path -LiteralPath $script:CachePath)) { return $null }
        $cached = Get-Content -LiteralPath $script:CachePath -Raw -Encoding UTF8 | ConvertFrom-Json
        $cached.IsCached = $true
        $cached.Source = '上次成功读取'
        return $cached
    } catch { return $null }
}

function Restart-AppServerForRefresh {
    $script:ConnectionState = '正在同步当前账号…'
    Start-AppServer
    if ($null -eq $script:Snapshot) { Update-Interface }
}

function Get-AutoStartEnabled {
    try { return ($null -ne (Get-ItemPropertyValue -Path $script:StartupRegistryPath -Name $script:StartupValueName -ErrorAction Stop)) }
    catch { return $false }
}

function Set-AutoStartEnabled {
    param([bool]$Enabled)
    if ($Enabled) {
        $powershell = Join-Path $PSHOME 'powershell.exe'
        $command = '"{0}" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{1}"' -f $powershell, $PSCommandPath
        Set-ItemProperty -Path $script:StartupRegistryPath -Name $script:StartupValueName -Value $command -Type String
        Write-AppLog 'Auto-start enabled.'
    } else {
        Remove-ItemProperty -Path $script:StartupRegistryPath -Name $script:StartupValueName -ErrorAction SilentlyContinue
        Write-AppLog 'Auto-start disabled.'
    }
}

function Invoke-SelfTest {
    $fixture = '{"rateLimits":{"limitId":"codex","primary":{"usedPercent":25,"windowDurationMins":300,"resetsAt":1893456000},"secondary":{"usedPercent":40,"windowDurationMins":10080,"resetsAt":1893542400}},"rateLimitsByLimitId":{"codex":{"limitId":"codex","primary":{"usedPercent":25,"windowDurationMins":300,"resetsAt":1893456000},"secondary":{"usedPercent":40,"windowDurationMins":10080,"resetsAt":1893542400}}}}' | ConvertFrom-Json
    $snapshot = ConvertTo-QuotaSnapshot $fixture
    if ($snapshot.RemainingPercent -ne 60) { throw 'Self-test failed: most constrained quota was not selected.' }
    if ($snapshot.Windows.Count -ne 2) { throw 'Self-test failed: quota windows were not parsed.' }
    if ((Format-WindowDuration 300) -ne '5 小时') { throw 'Self-test failed: duration formatting.' }
    Write-Output 'PASS: quota parser, window selection, and duration formatting.'
}

if ($SelfTest) { Invoke-SelfTest; exit 0 }

if (-not $Probe) {
    $createdNew = $false
    $mutexName = if ($ShowOnStart -and $SmokeTestSeconds -gt 0) { 'Local\CodexQuotaTray.VisualPreview' } else { 'Local\CodexQuotaTray.SingleInstance' }
    $script:SingleInstanceMutex = New-Object System.Threading.Mutex($true, $mutexName, [ref]$createdNew)
    if (-not $createdNew) { exit 0 }
    Remove-Item -LiteralPath $script:StopRequestPath -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $script:ShowRequestPath -Force -ErrorAction SilentlyContinue
    @{
        version = 1
        pid = $PID
        startedAt = (Get-Date).ToString('o')
        scriptPath = $PSCommandPath
    } | ConvertTo-Json | Set-Content -LiteralPath $script:RuntimePath -Encoding UTF8
}

if ($Probe) {
    Start-AppServer
    $deadline = (Get-Date).AddSeconds(20)
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 100
        if ($null -eq $script:Transport) { continue }
        foreach ($errorLine in $script:Transport.DrainErrors()) { Write-Verbose ('app-server stderr: {0}' -f $errorLine) }
        foreach ($line in $script:Transport.DrainOutput()) {
            Write-Verbose ('app-server stdout: {0}' -f $line)
            try {
                $message = $line | ConvertFrom-Json
                $messageId = Get-PropertyValue $message 'id'
                $result = Get-PropertyValue $message 'result'
                if ($messageId -eq 1 -and $null -ne $result) {
                    Send-AppServerMessage @{ method = 'initialized'; params = @{} }
                    $script:Initialized = $true
                    Request-QuotaRefresh
                    continue
                }
                if ($null -ne $result -and $null -ne (Get-PropertyValue $result 'rateLimits')) {
                    $snapshot = ConvertTo-QuotaSnapshot $result
                    $snapshot | ConvertTo-Json -Depth 12
                    $script:Transport.Dispose()
                    exit 0
                }
                $errorObject = Get-PropertyValue $message 'error'
                if ($null -ne $errorObject) { throw (Get-PropertyValue $errorObject 'message') }
            } catch {
                if ($_.Exception.Message -notmatch 'JSON') {
                    Write-Error $_.Exception.Message
                    $script:Transport.Dispose()
                    exit 1
                }
            }
        }
    }
    if ($null -ne $script:Transport) { $script:Transport.Dispose() }
    Write-Error '20 秒内没有收到额度响应。请确认 Codex 已登录且 CLI 为较新版本。'
    exit 1
}

# ---- Tray user interface ----
$fontFamily = 'Microsoft YaHei UI'
$script:NotifyIcon = New-Object System.Windows.Forms.NotifyIcon
$script:NotifyIcon.Visible = $true
$script:NotifyIcon.Text = 'Codex 剩余额度：正在连接'

$script:DetailsForm = New-Object System.Windows.Forms.Form
$script:DetailsForm.Text = $script:AppTitle
$script:DetailsForm.ClientSize = New-Object System.Drawing.Size 404, 350
$script:DetailsForm.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
$script:DetailsForm.ShowInTaskbar = $false
$script:DetailsForm.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
$script:DetailsForm.TopMost = $true
$script:DetailsForm.Padding = New-Object System.Windows.Forms.Padding 1

$script:ContentPanel = New-Object System.Windows.Forms.Panel
$script:ContentPanel.Location = New-Object System.Drawing.Point 1, 1
$script:ContentPanel.Size = New-Object System.Drawing.Size 402, 348

$script:BrandBadge = New-Object System.Windows.Forms.Label
$script:BrandBadge.Text = 'C'
$script:BrandBadge.Font = New-Object System.Drawing.Font 'Segoe UI', 14, ([System.Drawing.FontStyle]::Bold)
$script:BrandBadge.TextAlign = [System.Drawing.ContentAlignment]::MiddleCenter
$script:BrandBadge.Location = New-Object System.Drawing.Point 20, 18
$script:BrandBadge.Size = New-Object System.Drawing.Size 38, 38

$script:TitleLabel = New-Object System.Windows.Forms.Label
$script:TitleLabel.Text = 'Codex'
$script:TitleLabel.Font = New-Object System.Drawing.Font $fontFamily, 12, ([System.Drawing.FontStyle]::Bold)
$script:TitleLabel.Location = New-Object System.Drawing.Point 70, 17
$script:TitleLabel.AutoSize = $true

$script:SubtitleLabel = New-Object System.Windows.Forms.Label
$script:SubtitleLabel.Text = '使用额度'
$script:SubtitleLabel.Font = New-Object System.Drawing.Font $fontFamily, 8.5
$script:SubtitleLabel.Location = New-Object System.Drawing.Point 70, 40
$script:SubtitleLabel.AutoSize = $true

$script:CloseButton = New-Object System.Windows.Forms.Button
$script:CloseButton.Text = '×'
$script:CloseButton.Font = New-Object System.Drawing.Font 'Segoe UI', 15
$script:CloseButton.Location = New-Object System.Drawing.Point 354, 14
$script:CloseButton.Size = New-Object System.Drawing.Size 32, 32
$script:CloseButton.FlatStyle = [System.Windows.Forms.FlatStyle]::Flat
$script:CloseButton.FlatAppearance.BorderSize = 0
$script:CloseButton.Cursor = [System.Windows.Forms.Cursors]::Hand

$script:StatusPill = New-Object System.Windows.Forms.Label
$script:StatusPill.Text = '●  正在连接'
$script:StatusPill.Font = New-Object System.Drawing.Font $fontFamily, 8.5
$script:StatusPill.TextAlign = [System.Drawing.ContentAlignment]::MiddleCenter
$script:StatusPill.Location = New-Object System.Drawing.Point 275, 21
$script:StatusPill.Size = New-Object System.Drawing.Size 73, 26

$script:StatusLabel = New-Object System.Windows.Forms.Label
$script:StatusLabel.Text = $script:ConnectionState
$script:StatusLabel.Font = New-Object System.Drawing.Font $fontFamily, 8.5
$script:StatusLabel.Location = New-Object System.Drawing.Point 177, 80
$script:StatusLabel.Size = New-Object System.Drawing.Size 204, 20
$script:StatusLabel.TextAlign = [System.Drawing.ContentAlignment]::MiddleRight

$script:WindowsHeading = New-Object System.Windows.Forms.Label
$script:WindowsHeading.Text = '额度窗口'
$script:WindowsHeading.Font = New-Object System.Drawing.Font $fontFamily, 9.5, ([System.Drawing.FontStyle]::Bold)
$script:WindowsHeading.Location = New-Object System.Drawing.Point 22, 79
$script:WindowsHeading.AutoSize = $true

$script:QuotaRowsPanel = New-Object System.Windows.Forms.Panel
$script:QuotaRowsPanel.Location = New-Object System.Drawing.Point 20, 106
$script:QuotaRowsPanel.Size = New-Object System.Drawing.Size 362, 174
$script:QuotaRowsPanel.AutoScroll = $false

$script:RefreshButton = New-Object System.Windows.Forms.Button
$script:RefreshButton.Text = '↻  刷新额度'
$script:RefreshButton.Font = New-Object System.Drawing.Font $fontFamily, 9, ([System.Drawing.FontStyle]::Bold)
$script:RefreshButton.Location = New-Object System.Drawing.Point 278, 298
$script:RefreshButton.Size = New-Object System.Drawing.Size 104, 34
$script:RefreshButton.FlatStyle = [System.Windows.Forms.FlatStyle]::Flat
$script:RefreshButton.FlatAppearance.BorderSize = 0
$script:RefreshButton.Cursor = [System.Windows.Forms.Cursors]::Hand

$script:SourceLabel = New-Object System.Windows.Forms.Label
$script:SourceLabel.Text = '官方接口 · 只读连接'
$script:SourceLabel.Font = New-Object System.Drawing.Font $fontFamily, 8.5
$script:SourceLabel.Location = New-Object System.Drawing.Point 22, 308
$script:SourceLabel.Size = New-Object System.Drawing.Size 245, 22

$script:ContentPanel.Controls.AddRange(@($script:BrandBadge, $script:TitleLabel, $script:SubtitleLabel, $script:CloseButton, $script:StatusPill, $script:StatusLabel, $script:WindowsHeading, $script:QuotaRowsPanel, $script:RefreshButton, $script:SourceLabel))
$script:DetailsForm.Controls.Add($script:ContentPanel)

$script:ContextMenu = New-Object System.Windows.Forms.ContextMenuStrip
$script:MenuRefresh = New-Object System.Windows.Forms.ToolStripMenuItem '刷新额度'
$script:MenuAutoStart = New-Object System.Windows.Forms.ToolStripMenuItem '开机自动运行'
$script:MenuAutoStart.CheckOnClick = $true
$script:MenuAutoStart.Checked = Get-AutoStartEnabled
$script:MenuLogs = New-Object System.Windows.Forms.ToolStripMenuItem '打开日志目录'
$script:MenuExit = New-Object System.Windows.Forms.ToolStripMenuItem '退出'
$null = $script:ContextMenu.Items.Add($script:MenuRefresh)
$null = $script:ContextMenu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
$null = $script:ContextMenu.Items.Add($script:MenuAutoStart)
$null = $script:ContextMenu.Items.Add($script:MenuLogs)
$null = $script:ContextMenu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
$null = $script:ContextMenu.Items.Add($script:MenuExit)
$script:NotifyIcon.ContextMenuStrip = $script:ContextMenu

function Set-RoundedRegion {
    param([System.Windows.Forms.Control]$Control, [int]$Radius)
    if ($null -eq $Control -or $Control.Width -le 1 -or $Control.Height -le 1) { return }
    $radiusValue = [math]::Max(1, [math]::Min($Radius, [int]([math]::Min($Control.Width, $Control.Height) / 2)))
    $diameter = $radiusValue * 2
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $path.AddArc(0, 0, $diameter, $diameter, 180, 90)
    $path.AddArc($Control.Width - $diameter, 0, $diameter, $diameter, 270, 90)
    $path.AddArc($Control.Width - $diameter, $Control.Height - $diameter, $diameter, $diameter, 0, 90)
    $path.AddArc(0, $Control.Height - $diameter, $diameter, $diameter, 90, 90)
    $path.CloseFigure()
    $oldRegion = $Control.Region
    $Control.Region = New-Object System.Drawing.Region $path
    if ($null -ne $oldRegion) { $oldRegion.Dispose() }
    $path.Dispose()
}

function Rebuild-QuotaRows {
    $snapshotKey = if ($null -eq $script:Snapshot) {
        'none:{0}' -f $script:ConnectionState
    } else {
        $windowKey = @($script:Snapshot.Windows | ForEach-Object { '{0}:{1}:{2}' -f $_.LimitId, $_.RemainingPercent, $_.ResetsAt }) -join ','
        '{0}:{1}:{2}' -f $script:Snapshot.RemainingPercent, $script:Snapshot.IsCached, $windowKey
    }
    $rowsKey = '{0}|theme:{1}' -f $snapshotKey, $script:LastThemeIsLight
    if ($script:LastRowsKey -eq $rowsKey) { return }
    $script:LastRowsKey = $rowsKey

    foreach ($oldControl in @($script:QuotaRowsPanel.Controls)) { $oldControl.Dispose() }
    $script:QuotaRowsPanel.Controls.Clear()
    $colors = $script:ThemeColors

    if ($null -eq $script:Snapshot) {
        $placeholder = New-Object System.Windows.Forms.Label
        $placeholder.Text = '正在获取额度窗口…'
        $placeholder.Font = New-Object System.Drawing.Font $fontFamily, 9
        $placeholder.ForeColor = $colors.Muted
        $placeholder.BackColor = $colors.Card
        $placeholder.Location = New-Object System.Drawing.Point 16, 38
        $placeholder.AutoSize = $true
        $script:QuotaRowsPanel.Controls.Add($placeholder)
        return
    }

    $windows = @(Get-DisplayQuotaWindows $script:Snapshot)
    $singleCard = ($windows.Count -eq 1)
    for ($index = 0; $index -lt $windows.Count; $index++) {
        $window = $windows[$index]
        if ($index -ge 2) { break }
        $card = New-Object System.Windows.Forms.Panel
        $cardWidth = if ($singleCard) { 350 } else { 171 }
        $cardX = if ($singleCard) { 6 } else { 4 + ($index * 179) }
        $card.Location = New-Object System.Drawing.Point $cardX, 7
        $card.Size = New-Object System.Drawing.Size $cardWidth, 158
        $card.BackColor = $colors.Card
        $accent = if ($index -eq 0) { $colors.Accent } else { $colors.AccentSecondary }

        $name = Format-WindowDuration $window.WindowDurationMins
        if ($window.LimitId -ne 'codex') { $name = '{0} · {1}' -f $window.LimitName, $name }
        $resetText = if ($null -eq $window.ResetsAt) { '重置时间未知' } else { '{0} 重置' -f ([datetime]$window.ResetsAt).ToString('M月d日 HH:mm') }

        $nameLabel = New-Object System.Windows.Forms.Label
        $nameLabel.Text = $name
        $nameLabel.Font = New-Object System.Drawing.Font $fontFamily, 10, ([System.Drawing.FontStyle]::Bold)
        $nameLabel.ForeColor = $colors.Foreground
        $nameLabel.BackColor = $colors.Card
        $nameLabel.Location = New-Object System.Drawing.Point 14, 12
        $nameLabel.AutoSize = $true

        $periodLabel = New-Object System.Windows.Forms.Label
        $periodLabel.Text = if ($index -eq 0 -and $windows.Count -gt 1) { '短周期' } elseif ($windows.Count -gt 1) { '长周期' } else { '额度周期' }
        $periodLabel.Font = New-Object System.Drawing.Font $fontFamily, 8
        $periodLabel.ForeColor = $accent
        $periodLabel.BackColor = $colors.Card
        $periodLabel.Location = New-Object System.Drawing.Point ($cardWidth - 61), 14
        $periodLabel.Size = New-Object System.Drawing.Size 47, 18
        $periodLabel.TextAlign = [System.Drawing.ContentAlignment]::MiddleRight

        $valueLabel = New-Object System.Windows.Forms.Label
        $valueLabel.Text = '{0}%' -f [int][math]::Round($window.RemainingPercent)
        $valueLabel.Font = New-Object System.Drawing.Font 'Segoe UI', 27, ([System.Drawing.FontStyle]::Bold)
        $valueLabel.ForeColor = $colors.Foreground
        $valueLabel.BackColor = $colors.Card
        $valueLabel.Location = New-Object System.Drawing.Point 12, 36
        $valueLabel.Size = New-Object System.Drawing.Size ($cardWidth - 24), 48
        $valueLabel.TextAlign = [System.Drawing.ContentAlignment]::TopLeft

        $remainingLabel = New-Object System.Windows.Forms.Label
        $remainingLabel.Text = '剩余'
        $remainingLabel.Font = New-Object System.Drawing.Font $fontFamily, 8.5
        $remainingLabel.ForeColor = $colors.Muted
        $remainingLabel.BackColor = $colors.Card
        $remainingLabel.Location = New-Object System.Drawing.Point ($cardWidth - 51), 59
        $remainingLabel.Size = New-Object System.Drawing.Size 37, 18
        $remainingLabel.TextAlign = [System.Drawing.ContentAlignment]::MiddleRight

        $track = New-Object System.Windows.Forms.Panel
        $track.Location = New-Object System.Drawing.Point 14, 96
        $track.Size = New-Object System.Drawing.Size ($cardWidth - 28), 7
        $track.BackColor = $colors.Track
        $fill = New-Object System.Windows.Forms.Panel
        $fill.Location = New-Object System.Drawing.Point 0, 0
        $fillWidth = [math]::Max(1, [int][math]::Round($track.Width * ([double]$window.RemainingPercent / 100)))
        $fill.Size = New-Object System.Drawing.Size $fillWidth, 7
        $fill.BackColor = $accent
        $track.Controls.Add($fill)

        $usedLabel = New-Object System.Windows.Forms.Label
        $usedLabel.Text = '已用 {0}%' -f [int][math]::Round($window.UsedPercent)
        $usedLabel.Font = New-Object System.Drawing.Font $fontFamily, 8
        $usedLabel.ForeColor = $colors.Muted
        $usedLabel.BackColor = $colors.Card
        $usedLabel.Location = New-Object System.Drawing.Point 14, 110
        $usedLabel.AutoSize = $true

        $resetLabel = New-Object System.Windows.Forms.Label
        $resetLabel.Text = $resetText
        $resetLabel.Font = New-Object System.Drawing.Font $fontFamily, 8
        $resetLabel.ForeColor = $colors.Muted
        $resetLabel.BackColor = $colors.Card
        $resetLabel.Location = New-Object System.Drawing.Point 14, 134
        $resetLabel.Size = New-Object System.Drawing.Size ($cardWidth - 28), 20

        $card.Controls.AddRange(@($nameLabel, $periodLabel, $valueLabel, $remainingLabel, $track, $usedLabel, $resetLabel))
        $script:QuotaRowsPanel.Controls.Add($card)
        Set-RoundedRegion $card 12
        Set-RoundedRegion $track 4
        Set-RoundedRegion $fill 4
    }
}

function Update-Theme {
    $isLight = Get-ThemeIsLight
    if ($null -ne $script:LastThemeIsLight -and $script:LastThemeIsLight -eq $isLight) { return }
    $script:LastThemeIsLight = $isLight

    if ($isLight) {
        $script:ThemeColors = [pscustomobject]@{
            Background = [System.Drawing.Color]::FromArgb(255, 255, 255)
            Border = [System.Drawing.Color]::FromArgb(218, 220, 224)
            Foreground = [System.Drawing.Color]::FromArgb(28, 29, 32)
            Muted = [System.Drawing.Color]::FromArgb(105, 108, 116)
            Card = [System.Drawing.Color]::FromArgb(245, 246, 248)
            Track = [System.Drawing.Color]::FromArgb(228, 230, 234)
            Divider = [System.Drawing.Color]::FromArgb(222, 224, 228)
            Accent = [System.Drawing.Color]::FromArgb(16, 163, 127)
            AccentSecondary = [System.Drawing.Color]::FromArgb(37, 99, 235)
            OnAccent = [System.Drawing.Color]::White
        }
    } else {
        $script:ThemeColors = [pscustomobject]@{
            Background = [System.Drawing.Color]::FromArgb(31, 32, 35)
            Border = [System.Drawing.Color]::FromArgb(64, 66, 72)
            Foreground = [System.Drawing.Color]::FromArgb(247, 247, 248)
            Muted = [System.Drawing.Color]::FromArgb(169, 172, 181)
            Card = [System.Drawing.Color]::FromArgb(43, 44, 49)
            Track = [System.Drawing.Color]::FromArgb(62, 64, 70)
            Divider = [System.Drawing.Color]::FromArgb(66, 68, 74)
            Accent = [System.Drawing.Color]::FromArgb(53, 201, 155)
            AccentSecondary = [System.Drawing.Color]::FromArgb(96, 165, 250)
            OnAccent = [System.Drawing.Color]::FromArgb(18, 52, 42)
        }
    }

    $colors = $script:ThemeColors
    $script:DetailsForm.BackColor = $colors.Border
    $script:ContentPanel.BackColor = $colors.Background
    foreach ($control in @($script:TitleLabel, $script:WindowsHeading)) { $control.ForeColor = $colors.Foreground; $control.BackColor = $colors.Background }
    foreach ($control in @($script:SubtitleLabel, $script:StatusLabel, $script:SourceLabel)) { $control.ForeColor = $colors.Muted; $control.BackColor = $colors.Background }
    $script:BrandBadge.BackColor = $colors.Foreground
    $script:BrandBadge.ForeColor = $colors.Background
    $script:CloseButton.BackColor = $colors.Background
    $script:CloseButton.ForeColor = $colors.Muted
    $script:StatusPill.BackColor = $colors.Card
    $script:StatusPill.ForeColor = $colors.Accent
    $script:QuotaRowsPanel.BackColor = $colors.Card
    $script:RefreshButton.BackColor = $colors.Accent
    $script:RefreshButton.ForeColor = $colors.OnAccent
    $script:RefreshButton.FlatAppearance.MouseOverBackColor = $colors.Accent
    $script:RefreshButton.FlatAppearance.MouseDownBackColor = $colors.Accent

    Set-RoundedRegion $script:DetailsForm 18
    Set-RoundedRegion $script:ContentPanel 17
    Set-RoundedRegion $script:BrandBadge 10
    Set-RoundedRegion $script:StatusPill 13
    Set-RoundedRegion $script:QuotaRowsPanel 14
    Set-RoundedRegion $script:RefreshButton 10
    Rebuild-QuotaRows

    $iconWindows = if ($null -ne $script:Snapshot) { @(Get-DisplayQuotaWindows $script:Snapshot) } else { @() }
    $hasError = ($script:ConnectionState -match '失败|未找到|错误|不支持')
    Set-QuotaNotifyIcon -Windows $iconWindows -ThemeIsLight $isLight -HasError $hasError
}

function Update-Interface {
    if ($null -eq $script:Snapshot) {
        $script:StatusLabel.Text = $script:ConnectionState
        $script:StatusPill.Text = '●  连接中'
        $script:SourceLabel.Text = '官方接口 · 只读连接'
        $script:NotifyIcon.Text = ('Codex 剩余额度：{0}' -f $script:ConnectionState).Substring(0, [math]::Min(63, ('Codex 剩余额度：{0}' -f $script:ConnectionState).Length))
        Update-Theme
        Rebuild-QuotaRows
        return
    }

    $snapshot = $script:Snapshot
    $age = [math]::Max(0, [int]((Get-Date) - [datetime]$snapshot.UpdatedAt).TotalSeconds)
    $ageText = if ($age -lt 10) { '刚刚更新' } elseif ($age -lt 60) { ('{0} 秒前更新' -f $age) } else { ('{0} 分钟前更新' -f [int]($age / 60)) }
    $cacheText = if ($snapshot.IsCached) { ' · 缓存数据' } else { '' }
    $script:StatusLabel.Text = ('{0}{1}' -f $ageText, $cacheText)
    $script:StatusPill.Text = if ($snapshot.IsCached) { '●  缓存' } else { '●  已连接' }
    $planSuffix = if ([string]::IsNullOrWhiteSpace([string]$snapshot.PlanType)) { '' } else { ' · {0}' -f $snapshot.PlanType }
    $script:SourceLabel.Text = if ($snapshot.IsCached) { '上次成功读取 · 等待重新连接' } else { '官方接口 · 只读连接{0}' -f $planSuffix }
    $displayWindows = @(Get-DisplayQuotaWindows $snapshot)
    $windowSummary = @($displayWindows | Select-Object -First 2 | ForEach-Object { '{0} {1}%' -f (Format-WindowDuration $_.WindowDurationMins), ([int][math]::Round($_.RemainingPercent)) }) -join ' · '
    $tooltip = if ([string]::IsNullOrWhiteSpace($windowSummary)) { 'Codex 额度已连接' } else { 'Codex · {0}' -f $windowSummary }
    $script:NotifyIcon.Text = $tooltip.Substring(0, [math]::Min(63, $tooltip.Length))
    Rebuild-QuotaRows
    Set-QuotaNotifyIcon -Windows $displayWindows -ThemeIsLight (Get-ThemeIsLight) -HasError $false
}

function Accept-Snapshot {
    param($Snapshot)
    if ($null -eq $Snapshot) { return }
    $script:Snapshot = $Snapshot
    $script:LastResponseAt = Get-Date
    $script:ConnectionState = '已连接'
    Save-SnapshotCache $Snapshot
    Update-Interface
}

function Process-AppServerOutput {
    if ($null -eq $script:Transport) { return }
    foreach ($errorLine in $script:Transport.DrainErrors()) {
        if ($errorLine -match 'Failed to deserialize JSONRPCMessage: expected value at line 1 column 1') { continue }
        Write-AppLog ('app-server: {0}' -f $errorLine)
    }
    foreach ($line in $script:Transport.DrainOutput()) {
        try {
            $message = $line | ConvertFrom-Json
            $method = Get-PropertyValue $message 'method'
            $messageId = Get-PropertyValue $message 'id'
            $result = Get-PropertyValue $message 'result'
            if ($messageId -eq 1 -and $null -ne $result) {
                Send-AppServerMessage @{ method = 'initialized'; params = @{} }
                $script:Initialized = $true
                Request-QuotaRefresh
                continue
            }
            if ($method -eq 'account/rateLimits/updated') {
                $params = Get-PropertyValue $message 'params'
                Accept-Snapshot (ConvertTo-QuotaSnapshot $params)
                continue
            }

            if ($null -ne $result -and $null -ne (Get-PropertyValue $result 'rateLimits')) {
                Accept-Snapshot (ConvertTo-QuotaSnapshot $result)
                continue
            }

            $errorObject = Get-PropertyValue $message 'error'
            if ($null -ne $errorObject) {
                $errorMessage = [string](Get-PropertyValue $errorObject 'message')
                if ([string]::IsNullOrWhiteSpace($errorMessage)) { $errorMessage = 'Codex 返回了未知错误。' }
                $script:ConnectionState = $errorMessage
                Write-AppLog ('RPC error: {0}' -f $errorMessage)
                Update-Interface
            }
        } catch {
            Write-AppLog ('Ignored malformed app-server line: {0}' -f $_.Exception.Message)
        }
    }
}

function Show-DetailsForm {
    $screen = [System.Windows.Forms.Screen]::FromPoint([System.Windows.Forms.Cursor]::Position)
    $area = $screen.WorkingArea
    Update-Interface
    $script:DetailsForm.Left = $area.Right - $script:DetailsForm.Width - 12
    $script:DetailsForm.Top = $area.Bottom - $script:DetailsForm.Height - 12
    $script:DetailsForm.Show()
    $script:DetailsForm.Activate()
}

$script:RefreshButton.Add_Click({ Restart-AppServerForRefresh })
$script:CloseButton.Add_Click({ $script:DetailsForm.Hide() })
$script:MenuRefresh.Add_Click({ Restart-AppServerForRefresh })
$script:MenuAutoStart.Add_Click({
    try { Set-AutoStartEnabled $script:MenuAutoStart.Checked }
    catch {
        $script:MenuAutoStart.Checked = -not $script:MenuAutoStart.Checked
        [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, $script:AppTitle, 'OK', 'Error') | Out-Null
    }
})
$script:MenuLogs.Add_Click({ Start-Process -FilePath 'explorer.exe' -ArgumentList ('"{0}"' -f $script:AppDataDirectory) })
$script:MenuExit.Add_Click({ $script:ExitRequested = $true; [System.Windows.Forms.Application]::Exit() })
$script:NotifyIcon.Add_MouseClick({
    param($sender, $eventArgs)
    if ($eventArgs.Button -eq [System.Windows.Forms.MouseButtons]::Left) {
        if ($script:DetailsForm.Visible) { $script:DetailsForm.Hide() } else { Show-DetailsForm }
    }
})
$script:DetailsForm.Add_FormClosing({
    param($sender, $eventArgs)
    if (-not $script:ExitRequested -and $eventArgs.CloseReason -eq [System.Windows.Forms.CloseReason]::UserClosing) {
        $eventArgs.Cancel = $true
        $script:DetailsForm.Hide()
    }
})
$script:DetailsForm.Add_Deactivate({
    if (-not $script:ExitRequested -and $script:DetailsForm.Visible) {
        $script:DetailsForm.Hide()
    }
})

$script:UiTimer = New-Object System.Windows.Forms.Timer
$script:UiTimer.Interval = 1000
$script:UiTimer.Add_Tick({
    if (Test-Path -LiteralPath $script:StopRequestPath) {
        Remove-Item -LiteralPath $script:StopRequestPath -Force -ErrorAction SilentlyContinue
        $script:ExitRequested = $true
        [System.Windows.Forms.Application]::Exit()
        return
    }
    if (Test-Path -LiteralPath $script:ShowRequestPath) {
        Remove-Item -LiteralPath $script:ShowRequestPath -Force -ErrorAction SilentlyContinue
        Show-DetailsForm
    }
    Process-AppServerOutput
    if ($null -eq $script:Transport -or -not $script:Transport.IsRunning) {
        if ((Get-Date) -ge $script:ReconnectAt) { Start-AppServer }
    } elseif (((Get-Date) - $script:LastRequestAt).TotalSeconds -ge 60) {
        Restart-AppServerForRefresh
    }
    if ((Get-Date).Second % 3 -eq 0) { Update-Theme }
    if ($script:DetailsForm.Visible -and (Get-Date).Second % 5 -eq 0) { Update-Interface }
})

$script:Snapshot = Load-SnapshotCache
Update-Theme
Update-Interface
Start-AppServer
$script:UiTimer.Start()
if ($ShowOnStart) { Show-DetailsForm }
$script:PreviewCaptureTimer = $null
if ($ShowOnStart -and (-not [string]::IsNullOrWhiteSpace($RenderPreviewPath) -or -not [string]::IsNullOrWhiteSpace($RenderIconPreviewPath))) {
    $script:PreviewCaptureTimer = New-Object System.Windows.Forms.Timer
    $script:PreviewCaptureTimer.Interval = 5000
    $script:PreviewCaptureTimer.Add_Tick({
        $script:PreviewCaptureTimer.Stop()
        try {
            Update-Interface
            if (-not [string]::IsNullOrWhiteSpace($RenderPreviewPath)) {
                $previewBitmap = New-Object System.Drawing.Bitmap $script:DetailsForm.Width, $script:DetailsForm.Height
                $previewRectangle = New-Object System.Drawing.Rectangle 0, 0, $script:DetailsForm.Width, $script:DetailsForm.Height
                $script:DetailsForm.DrawToBitmap($previewBitmap, $previewRectangle)
                $previewBitmap.Save($RenderPreviewPath, [System.Drawing.Imaging.ImageFormat]::Png)
                $previewBitmap.Dispose()
            }
            if (-not [string]::IsNullOrWhiteSpace($RenderIconPreviewPath) -and $null -ne $script:NotifyIcon.Icon) {
                $iconBitmap = $script:NotifyIcon.Icon.ToBitmap()
                $iconBitmap.Save($RenderIconPreviewPath, [System.Drawing.Imaging.ImageFormat]::Png)
                $iconBitmap.Dispose()
            }
        } catch {
            Write-AppLog ('Preview capture failed: {0}' -f $_.Exception.Message)
        }
    })
    $script:PreviewCaptureTimer.Start()
}
$script:SmokeTimer = $null
if ($SmokeTestSeconds -gt 0) {
    $script:SmokeTimer = New-Object System.Windows.Forms.Timer
    $script:SmokeTimer.Interval = [math]::Max(1000, $SmokeTestSeconds * 1000)
    $script:SmokeTimer.Add_Tick({ $script:SmokeTimer.Stop(); [System.Windows.Forms.Application]::Exit() })
    $script:SmokeTimer.Start()
}
Write-AppLog ('Codex Quota Tray {0} started.' -f $script:Version)

try {
    [System.Windows.Forms.Application]::Run()
} finally {
    $script:UiTimer.Stop()
    if ($null -ne $script:PreviewCaptureTimer) { $script:PreviewCaptureTimer.Stop(); $script:PreviewCaptureTimer.Dispose() }
    if ($null -ne $script:SmokeTimer) { $script:SmokeTimer.Stop(); $script:SmokeTimer.Dispose() }
    if ($null -ne $script:Transport) { $script:Transport.Dispose() }
    $script:NotifyIcon.Visible = $false
    if ($null -ne $script:NotifyIcon.Icon) { $script:NotifyIcon.Icon.Dispose() }
    $script:NotifyIcon.Dispose()
    $script:DetailsForm.Dispose()
    if ($null -ne $script:SingleInstanceMutex) { $script:SingleInstanceMutex.Dispose() }
    try {
        if (Test-Path -LiteralPath $script:RuntimePath) {
            $runtime = Get-Content -LiteralPath $script:RuntimePath -Raw -Encoding UTF8 | ConvertFrom-Json
            if ([int]$runtime.pid -eq $PID) { Remove-Item -LiteralPath $script:RuntimePath -Force }
        }
    } catch { }
    Write-AppLog 'Codex Quota Tray stopped.'
}
