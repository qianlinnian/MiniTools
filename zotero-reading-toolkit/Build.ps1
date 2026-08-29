param(
    [string]$Version
)

$ErrorActionPreference = "Stop"
$toolRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$manifest = Get-Content -Raw (Join-Path $toolRoot "manifest.json") | ConvertFrom-Json
if (-not $Version) {
    $Version = $manifest.version
}
if ($Version -ne $manifest.version) {
    throw "Package version '$Version' does not match manifest version '$($manifest.version)'."
}
$releaseDir = Join-Path $toolRoot "releases"
$zipPath = Join-Path $releaseDir "zotero-reading-toolkit-v$Version.zip"
$xpiPath = Join-Path $releaseDir "zotero-reading-toolkit-v$Version.xpi"

New-Item -ItemType Directory -Force -Path $releaseDir | Out-Null
if (Test-Path -LiteralPath $zipPath) {
    Remove-Item -LiteralPath $zipPath
}
if (Test-Path -LiteralPath $xpiPath) {
    Remove-Item -LiteralPath $xpiPath
}

# PowerShell's Compress-Archive omits explicit directory entries. Zotero's
# jar: loader can then read root files but fails to open content/*.js from the
# installed XPI. bsdtar emits a standards-compatible ZIP with content/ present.
& tar.exe -a -c -f $zipPath -C $toolRoot manifest.json bootstrap.js prefs.js content
if ($LASTEXITCODE -ne 0) {
    throw "tar.exe failed with exit code $LASTEXITCODE."
}
Move-Item -LiteralPath $zipPath -Destination $xpiPath

$entries = @(& tar.exe -tf $xpiPath)
$requiredEntries = @(
    "manifest.json",
    "bootstrap.js",
    "prefs.js",
    "content/",
    "content/core.js",
    "content/preferences.xhtml",
    "content/readingToolkit.js"
)
foreach ($entry in $requiredEntries) {
    if ($entries -notcontains $entry) {
        throw "Package is missing required entry '$entry'."
    }
}

$hash = Get-FileHash -Algorithm SHA256 -LiteralPath $xpiPath
Write-Host "Built: $xpiPath"
Write-Host "SHA256: $($hash.Hash)"
