# Installs uassist for Windows: builds standalone uassist.exe and
# uassist-server.exe (bun --compile -- no Bun runtime needed to run them
# afterward, only to build them) and puts them on your user PATH.
#
# Usage:  powershell -ExecutionPolicy Bypass -File scripts\install.ps1
# Override the install location with $env:UASSIST_INSTALL_DIR.

$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $PSScriptRoot
$InstallDir = if ($env:UASSIST_INSTALL_DIR) { $env:UASSIST_INSTALL_DIR } else { "$env:LOCALAPPDATA\uassist\bin" }

if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
    Write-Error "bun is required to build uassist (https://bun.sh)."
    exit 1
}

Write-Host "Building uassist from $RepoRoot..."
Set-Location $RepoRoot
bun install
bun run build:cli
bun run build:server

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

# bun --compile appends .exe on Windows; copy whichever the build produced.
function Copy-Built([string]$Name) {
    $withExt = Join-Path $RepoRoot "dist\$Name.exe"
    $noExt = Join-Path $RepoRoot "dist\$Name"
    $source = if (Test-Path $withExt) { $withExt } else { $noExt }
    if (-not (Test-Path $source)) {
        Write-Error "build output not found: $withExt (or $noExt)"
        exit 1
    }
    Copy-Item $source (Join-Path $InstallDir "$Name.exe") -Force
}

Copy-Built "uassist"
Copy-Built "uassist-server"
Write-Host "Installed to $InstallDir"

# The two binaries must stay siblings -- `uassist start` finds
# uassist-server.exe next to its own executable path, not on PATH.
$UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($UserPath -split ";" -contains $InstallDir) {
    Write-Host "$InstallDir is already on your user PATH."
} else {
    $NewPath = if ([string]::IsNullOrEmpty($UserPath)) { $InstallDir } else { "$UserPath;$InstallDir" }
    [Environment]::SetEnvironmentVariable("Path", $NewPath, "User")
    Write-Host "Added $InstallDir to your user PATH."
    Write-Host "Open a new terminal for it to take effect."
}

Write-Host ""
Write-Host "Done. Open a new terminal and try: uassist --help"
