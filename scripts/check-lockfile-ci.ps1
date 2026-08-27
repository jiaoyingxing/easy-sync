# Lockfile clean-install smoke gate (release preflight).
# Verifies package-lock.json reconstructs a complete dependency tree on the
# npm generations used by the Obsidian community scanners and older CI images
# (`npm ci --ignore-scripts`). A broken lockfile here is what produced 4000+
# no-unsafe-* false positives on the plugin scorecard (docs/temp/20260827-1357).
# Usage: pwsh scripts/check-lockfile-ci.ps1 [-RepoPaths path1,path2] [-Versions v1,v2]
param(
    [string[]]$RepoPaths = @((Split-Path -Parent $PSScriptRoot)),
    [string[]]$Versions = @("7.24.2", "8.19.4", "9.9.3", "10.9.2"),
    [string]$ScratchRoot = (Join-Path ([System.IO.Path]::GetTempPath()) "easy-sync-lock-gate")
)

$ErrorActionPreference = "Stop"
$files = @("package.json", "package-lock.json")
$overallFailed = $false

foreach ($repo in $RepoPaths) {
    foreach ($f in $files) {
        if (-not (Test-Path (Join-Path $repo $f))) {
            Write-Error "$repo missing $f"
            $overallFailed = $true
        }
    }
    if ($overallFailed) { continue }

    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $dir = Join-Path $ScratchRoot "$stamp-$(Split-Path -Leaf $repo)"
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    foreach ($f in $files) {
        Copy-Item (Join-Path $repo $f) (Join-Path $dir $f)
    }
    if (Test-Path (Join-Path $repo ".npmrc")) {
        Copy-Item (Join-Path $repo ".npmrc") (Join-Path $dir ".npmrc")
    }

    Write-Host "== $repo"
    foreach ($v in $Versions) {
        if (Test-Path (Join-Path $dir "node_modules")) {
            Remove-Item -Recurse -Force (Join-Path $dir "node_modules")
        }
        Push-Location $dir
        try {
            cmd /c "npx -y npm@$v ci --ignore-scripts >nul 2>&1"
            $exit = $LASTEXITCODE
        } finally {
            Pop-Location
        }
        $verdict = if ($exit -eq 0) { "PASS" } else { $overallFailed = $true; "FAIL" }
        Write-Host ("  npm {0,-8} ci --ignore-scripts -> exit {1} [{2}]" -f $v, $exit, $verdict)
    }
    Remove-Item -Recurse -Force $dir
}

if ($overallFailed) {
    Write-Host "LOCKFILE GATE: RED - regenerate package-lock.json (npm install --package-lock-only) until all rows PASS."
    exit 1
}
Write-Host "LOCKFILE GATE: GREEN - clean install succeeds on every checked npm generation."
