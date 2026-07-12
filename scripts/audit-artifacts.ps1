<#
.SYNOPSIS
    Fails the build if any JobSeek release artifact contains secrets, PII,
    runtime state, source maps, tests, remote code, or a manifest that does not
    match the exact production policy.

.DESCRIPTION
    Scans three artifact classes and exits non-zero on any finding:

      1. The production extension build (default: apps/extension/.output/edge-mv3)
         - exact production permissions / CSP / host rules and stable key
         - no OAuth/client_secret, DB/WAL/SHM/sqlite, vault/token/browser-profile
         - no backup, resume source, or PDF
         - no source maps or test files
         - no remote code, telemetry, or unexpected network sinks

      2. The installed and/or staged Copilot worker
         - no source maps, tests, OAuth, resume, or project files
         - no Browserbase / Exa / Gmail / GitHub secret values

      3. Companion Release publishes (Agent + NativeHost)
         - no runtime DB / vault / tokens / OAuth / resume / browser profiles

    Sensitive-string needles are derived at runtime from the local ignored
    OAuth client when one is configured. Needle VALUES are never printed; only
    offending artifact paths and stable violation codes are reported. The
    public extension signing key is allowed.

.PARAMETER ExtensionBuild
    Path to the production extension build to audit.

.PARAMETER WorkerPaths
    One or more Copilot worker roots to audit (installed and/or staged).

.PARAMETER CompanionPublish
    One or more companion Release publish directories to audit.
#>
[CmdletBinding()]
param(
    [string]$ExtensionBuild,
    [string[]]$WorkerPaths,
    [string[]]$CompanionPublish
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Import-Module (Join-Path $PSScriptRoot 'JobSeek.Common.psm1') -Force

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$repoRoot = $projectRoot
$const = Get-JobSeekConstant
$paths = Get-JobSeekPaths

$script:findings = @()
function Add-Finding {
    param(
        [Parameter(Mandatory)][string]$Scope,
        [Parameter(Mandatory)][string]$Code,
        [Parameter(Mandatory)][string]$Path
    )
    $script:findings += [pscustomobject]@{ Scope = $Scope; Code = $Code; Path = $Path }
}

# Derive sensitive needles once (values never printed).
$oauthClientLocal = @(Get-ChildItem -Path $projectRoot -Filter 'client_secret_*.json' -File -ErrorAction SilentlyContinue |
        Select-Object -First 1 | ForEach-Object { $_.FullName })
$oauthClientPath = if ($oauthClientLocal.Count -gt 0) { $oauthClientLocal[0] } elseif (Test-Path -LiteralPath $paths.OAuthClient) { $paths.OAuthClient } else { $null }
$needles = @(Get-SensitiveNeedle -OAuthClientPath $oauthClientPath -ResumePath $null)
$externalSecretNeedles = @(@(
    'BROWSERBASE_API_KEY', 'EXA_API_KEY', 'GH_TOKEN', 'GITHUB_TOKEN',
    'COPILOT_GITHUB_TOKEN', 'GOOGLE_APPLICATION_CREDENTIALS'
) | ForEach-Object {
    $value = [Environment]::GetEnvironmentVariable($_)
    if (-not [string]::IsNullOrWhiteSpace($value)) { [pscustomobject]@{ Code = "ENV_$_"; Value = $value } }
} | Where-Object { $null -ne $_ })

$textExtensions = @('.js', '.mjs', '.cjs', '.json', '.html', '.css', '.txt', '.map')

function Test-Structure {
    param([string]$Scope, [string]$Base, [switch]$AllowPdf)
    $files = @(Get-ChildItem -LiteralPath $Base -Recurse -File -ErrorAction SilentlyContinue)
    $relative = $files | ForEach-Object { Get-RelativeArtifactPath -BasePath $Base -FullPath $_.FullName }
    $violations = @(Get-ArtifactStructureViolation -RelativePaths $relative -AllowPdf:$AllowPdf | Where-Object {
        # The .NET DPAPI library file name contains "ProtectedData" but is not a token.
        -not ($_.Code -eq 'TOKEN' -and $_.Path -match 'ProtectedData')
    })
    foreach ($violation in $violations) { Add-Finding -Scope $Scope -Code $violation.Code -Path $violation.Path }
    return $files
}

function Test-Needles {
    param([string]$Scope, [string]$Base, [object[]]$Files)
    $textFiles = @($Files | Where-Object { $textExtensions -contains $_.Extension.ToLowerInvariant() } | ForEach-Object { $_.FullName })
    foreach ($hit in @(Find-SensitiveNeedleHit -Files $textFiles -Needles $needles -BasePath $Base)) {
        Add-Finding -Scope $Scope -Code $hit.Code -Path $hit.Path
    }
    if ($externalSecretNeedles.Count -gt 0) {
        foreach ($hit in @(Find-SensitiveNeedleHit -Files $textFiles -Needles $externalSecretNeedles -BasePath $Base)) {
            Add-Finding -Scope $Scope -Code $hit.Code -Path $hit.Path
        }
    }
}

# --- 1. Extension build -----------------------------------------------------
if ([string]::IsNullOrWhiteSpace($ExtensionBuild)) {
    $ExtensionBuild = Join-Path $projectRoot 'apps\extension\.output\edge-mv3'
}
if (Test-Path -LiteralPath $ExtensionBuild) {
    $manifestFile = Join-Path $ExtensionBuild 'manifest.json'
    if (-not (Test-Path -LiteralPath $manifestFile)) {
        Add-Finding -Scope 'extension' -Code 'MANIFEST_MISSING' -Path 'manifest.json'
    }
    else {
        $manifest = Get-Content -LiteralPath $manifestFile -Raw | ConvertFrom-Json
        foreach ($code in @(Get-ManifestPolicyViolation -Manifest $manifest)) {
            Add-Finding -Scope 'extension' -Code $code -Path 'manifest.json'
        }
    }

    $extFiles = Test-Structure -Scope 'extension' -Base $ExtensionBuild
    Test-Needles -Scope 'extension' -Base $ExtensionBuild -Files $extFiles

    foreach ($jsFile in @($extFiles | Where-Object { $_.Extension -in @('.js', '.mjs', '.cjs') })) {
        $content = Get-Content -LiteralPath $jsFile.FullName -Raw -ErrorAction SilentlyContinue
        if ([string]::IsNullOrEmpty($content)) { continue }
        $relative = Get-RelativeArtifactPath -BasePath $ExtensionBuild -FullPath $jsFile.FullName
        foreach ($violation in @(Get-RemoteCodeViolation -Content $content -Path $relative)) {
            Add-Finding -Scope 'extension' -Code $violation.Code -Path $violation.Path
        }
    }
}
else {
    Write-Warning "Extension build not found at $ExtensionBuild; skipping extension audit."
}

# --- 2. Copilot worker ------------------------------------------------------
if ($null -eq $WorkerPaths -or $WorkerPaths.Count -eq 0) {
    $WorkerPaths = @()
    # The installed worker (dist + production node_modules) is the real artifact.
    if (Test-Path -LiteralPath $paths.CopilotWorker) { $WorkerPaths += $paths.CopilotWorker }
    # Also audit the freshly built worker dist output, if present.
    $builtWorkerDist = Join-Path $projectRoot 'apps\copilot-worker\dist'
    if (Test-Path -LiteralPath $builtWorkerDist) { $WorkerPaths += $builtWorkerDist }
}
foreach ($workerRoot in ($WorkerPaths | Select-Object -Unique)) {
    if (-not (Test-Path -LiteralPath $workerRoot)) { continue }
    # Ignore worker dev-time sources/tests: only audit the shippable dist +
    # production node_modules when present; if a raw project dir is passed,
    # still flag test/map files under src.
    $scope = "worker:$([System.IO.Path]::GetFileName($workerRoot))"
    $workerFiles = Test-Structure -Scope $scope -Base $workerRoot
    Test-Needles -Scope $scope -Base $workerRoot -Files $workerFiles
}

# --- 3. Companion publishes -------------------------------------------------
if ($null -eq $CompanionPublish -or $CompanionPublish.Count -eq 0) {
    $CompanionPublish = @(
        (Join-Path $projectRoot 'companion\src\JobSeek.Agent\bin\Release\net10.0-windows\win-x64\publish'),
        (Join-Path $projectRoot 'companion\src\JobSeek.NativeHost\bin\Release\net10.0-windows\win-x64\publish')
    )
}
foreach ($publishRoot in ($CompanionPublish | Select-Object -Unique)) {
    if (-not (Test-Path -LiteralPath $publishRoot)) { continue }
    $scope = "companion:$([System.IO.Path]::GetFileName((Split-Path $publishRoot -Parent)))"
    # Managed DLL PDBs and .NET runtime files are expected; only forbid runtime
    # state and secrets. PDFs are not expected in a companion publish.
    $publishFiles = Test-Structure -Scope $scope -Base $publishRoot
    Test-Needles -Scope $scope -Base $publishRoot -Files $publishFiles
}

# --- Report -----------------------------------------------------------------
if ($needles.Count -eq 0) {
    Write-Warning 'No local OAuth secret needles were derived; content scan was structural plus environment-secret checks.'
}

if ($script:findings.Count -eq 0) {
    Write-Output 'audit-artifacts: PASS (no secrets, PII, runtime state, remote code, or manifest policy violations found).'
    exit 0
}

Write-Output 'audit-artifacts: FAIL'
$script:findings | Sort-Object Scope, Code, Path | Format-Table -AutoSize | Out-String | Write-Output
Write-Error "audit-artifacts found $($script:findings.Count) violation(s)."
exit 1
