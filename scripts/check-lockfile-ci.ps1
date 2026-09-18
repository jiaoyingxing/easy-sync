# Lockfile clean-install smoke gate (release preflight).
# Verifies package-lock.json reconstructs a complete dependency tree on the
# npm generations used by the Obsidian community scanners and older CI images
# (`npm ci --ignore-scripts`). A broken lockfile here is what produced mass
# no-unsafe-* false positives on the plugin scorecard twice (2026-08 and
# 2026-09, see docs/archive/2026-08/20260827-1357 and the 1.4.12 prep line).
# Wired as `npm run check:lockfile`; required after any package.json /
# package-lock.json change and in every release preflight.
# Usage: pwsh -NoProfile -File scripts/check-lockfile-ci.ps1 [-RepoPaths path1,path2] [-Versions v1,v2]
param(
    [string[]]$RepoPaths = @((Split-Path -Parent $PSScriptRoot)),
    [string[]]$Versions = @("7.24.2", "8.19.4", "9.9.3", "10.9.2"),
    [string]$ScratchRoot = (Join-Path ([System.IO.Path]::GetTempPath()) "easy-sync-lock-gate")
)

$ErrorActionPreference = "Stop"
$files = @("package.json", "package-lock.json")
$overallFailed = $false

foreach ($repo in $RepoPaths) {
    $repoFailed = $false
    foreach ($f in $files) {
        if (-not (Test-Path (Join-Path $repo $f))) {
            Write-Error "$repo missing $f"
            $repoFailed = $true
        }
    }
    if ($repoFailed) { $overallFailed = $true; continue }

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
        $log = Join-Path $dir ("npm-$v.log")
        Push-Location $dir
        try {
            & cmd /c "npx -y npm@$v ci --ignore-scripts" > $log 2>&1
            $exit = $LASTEXITCODE
        } finally {
            Pop-Location
        }
        $verdict = if ($exit -eq 0) { "PASS" } else { $repoFailed = $true; "FAIL" }
        Write-Host ("  npm {0,-8} ci --ignore-scripts -> exit {1} [{2}]" -f $v, $exit, $verdict)
        if ($exit -ne 0) {
            Write-Host "  --- npm error (first lines; full log kept in scratch below):"
            Get-Content $log -TotalCount 15 | ForEach-Object { Write-Host ("    " + $_) }
        }
    }
    if ($repoFailed) {
        $overallFailed = $true
        Write-Host "  scratch kept for forensics: $dir"
    } else {
        Remove-Item -Recurse -Force $dir
    }
}

if ($overallFailed) {
    Write-Host "LOCKFILE GATE: RED - regenerate package-lock.json with an npm generation all rows accept (e.g. 'npx -y npm@10.9.2 install --package-lock-only'); the local default npm may be newer than the scanner generations."
    exit 1
}
Write-Host "LOCKFILE GATE: GREEN - clean install succeeds on every checked npm generation."
