<#
.SYNOPSIS
    Non-mutating release gate for JobSeek Assistant. Reports a concise pass/fail
    across manifest, package, and privacy checks.

.DESCRIPTION
    Orchestrates read-only checks and never builds, installs, or mutates state:

      - Production manifest policy (permissions / CSP / host rules / stable key)
      - Git privacy: no resume/OAuth client/runtime state tracked; local OAuth
        client patterns are ignored
      - Artifact secret / PII / runtime-state / remote-code scan
        (delegated to audit-artifacts.ps1)

    Exits non-zero if any check fails. Prints only paths and codes, never secret
    contents.
#>
[CmdletBinding()]
param(
    [string]$ExtensionBuild
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Import-Module (Join-Path $PSScriptRoot 'JobSeek.Common.psm1') -Force

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$repoRoot = $projectRoot

$script:results = @()
function Add-Result {
    param([string]$Name, [bool]$Passed, [string]$Detail)
    $script:results += [pscustomobject]@{ Check = $Name; Result = $(if ($Passed) { 'PASS' } else { 'FAIL' }); Detail = $Detail }
}

# --- Manifest policy (read-only) -------------------------------------------
if ([string]::IsNullOrWhiteSpace($ExtensionBuild)) {
    $ExtensionBuild = Join-Path $projectRoot 'apps\extension\.output\edge-mv3'
}
$manifestFile = Join-Path $ExtensionBuild 'manifest.json'
if (Test-Path -LiteralPath $manifestFile) {
    $manifest = Get-Content -LiteralPath $manifestFile -Raw | ConvertFrom-Json
    $violations = @(Get-ManifestPolicyViolation -Manifest $manifest)
    Add-Result -Name 'Production manifest policy' -Passed ($violations.Count -eq 0) -Detail ($(if ($violations.Count -eq 0) { 'exact permissions/CSP/host/key' } else { $violations -join ', ' }))
}
else {
    Add-Result -Name 'Production manifest policy' -Passed $false -Detail "manifest not found at $ExtensionBuild (build the extension first)"
}

# --- Git privacy (read-only) ------------------------------------------------
function Test-Ignored {
    param([string]$RelativePath)
    & git -C $repoRoot check-ignore -q -- $RelativePath 2>$null
    return $LASTEXITCODE -eq 0
}
$oauthIgnored = Test-Ignored 'client_secret_probe.json'
Add-Result -Name 'OAuth client ignored' -Passed $oauthIgnored -Detail 'client_secret_*.json is git-ignored'

$privateTracked = @(& git -C $repoRoot ls-files 2>$null | Where-Object {
    $_ -match '(^|/)(resume\.md|client_secret_.*\.json|google-oauth-client\.json)$' -or $_ -match '\.pdf$'
})
Add-Result -Name 'No private source material tracked' -Passed ($privateTracked.Count -eq 0) -Detail ($(if ($privateTracked.Count -eq 0) { 'clean' } else { $privateTracked -join '; ' }))

# No runtime/secret files may be tracked anywhere in the project.
$tracked = @(& git -C $repoRoot ls-files 2>$null)
$leakPattern = '(client_secret_.*\.json$|google-oauth-client\.json$|oauth-token|gmail-token|/tokens/|\.db$|\.db-wal$|\.db-shm$|\.sqlite|/vault/|document-vault/|browser-profiles?/)'
$leaked = @($tracked | Where-Object { $_ -match $leakPattern })
Add-Result -Name 'No secrets/runtime files tracked' -Passed ($leaked.Count -eq 0) -Detail ($(if ($leaked.Count -eq 0) { 'clean' } else { ($leaked -join '; ') }))

# --- Artifact audit (delegated) --------------------------------------------
$auditScript = Join-Path $PSScriptRoot 'audit-artifacts.ps1'
& pwsh -NoProfile -File $auditScript -ExtensionBuild $ExtensionBuild
$auditPassed = $LASTEXITCODE -eq 0
Add-Result -Name 'Artifact secret/PII/remote-code audit' -Passed $auditPassed -Detail 'see audit-artifacts output above'

# --- Report -----------------------------------------------------------------
Write-Output ''
Write-Output 'check-release summary:'
$script:results | Format-Table -AutoSize | Out-String | Write-Output

$failed = @($script:results | Where-Object { $_.Result -eq 'FAIL' })
if ($failed.Count -eq 0) {
    Write-Output 'check-release: PASS'
    exit 0
}
Write-Output "check-release: FAIL ($($failed.Count) check(s) failed)"
exit 1
