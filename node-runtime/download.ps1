# Downloads and extracts a project-local portable Node 26 into node-runtime/.
# The OpenTUI UI needs Node >= 26 (experimental `node:ffi`); `npm start` uses
# this runtime so your system Node version doesn't matter.
$ErrorActionPreference = 'Stop'

$version = 'v26.6.0'
$dir = Join-Path $PSScriptRoot "node-$version-win-x64"
$zip = Join-Path $PSScriptRoot "node-$version-win-x64.zip"
$url = "https://nodejs.org/dist/$version/node-$version-win-x64.zip"

if (Test-Path (Join-Path $dir 'node.exe')) {
    Write-Host "Portable Node $version already present at $dir" -ForegroundColor Green
    exit 0
}

Write-Host "Downloading $url ..."
Invoke-WebRequest -Uri $url -OutFile $zip -Headers @{ 'User-Agent' = 'gura' }

Write-Host "Extracting to $PSScriptRoot ..."
Expand-Archive -Path $zip -DestinationPath $PSScriptRoot -Force

& (Join-Path $dir 'node.exe') --version
Write-Host "Ready. Run 'npm start'." -ForegroundColor Green
