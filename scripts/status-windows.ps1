<#
.SYNOPSIS
    Reports the live JobSeek Assistant install status and health without
    printing any secret contents.

.DESCRIPTION
    Shows the agent/native-host/worker versions and paths, install presence,
    OAuth client type (Desktop app vs. invalid, never the secret), native
    manifest registration, scheduled-task state, app-root process ids, and the
    result of a single health.get exchange. No OAuth secret, token, or resume
    value is ever read or displayed.
#>
[CmdletBinding(PositionalBinding = $false)]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Import-Module (Join-Path $PSScriptRoot 'JobSeek.Common.psm1') -Force

$const = Get-JobSeekConstant
$paths = Get-JobSeekPaths

function Read-Pointer {
    param([Parameter(Mandatory)][string]$Path)
    if (Test-Path -LiteralPath $Path) { (Get-Content -LiteralPath $Path -Raw).Trim() } else { $null }
}

function Get-FileVersion {
    param([string]$Path)
    if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path -LiteralPath $Path)) { return $null }
    try { return (Get-Item -LiteralPath $Path).VersionInfo.ProductVersion } catch { return $null }
}

$task = Get-ScheduledTask -TaskName $const.TaskName -ErrorAction SilentlyContinue
$health = Get-JobSeekHealth
$appProcesses = @(Get-JobSeekAppProcess -AppRoot $paths.App)

# OAuth client TYPE only. The secret is never read.
$oauthType = if (Test-Path -LiteralPath $paths.OAuthClient) {
    try {
        $oauth = Get-Content -LiteralPath $paths.OAuthClient -Raw | ConvertFrom-Json
        if ($oauth.PSObject.Properties['installed'] -and -not $oauth.PSObject.Properties['web']) { 'Desktop app' } else { 'invalid' }
    }
    catch { 'invalid' }
}
else { 'not configured' }

$gmailTokenDirectory = Join-Path $paths.Config 'gmail-token'
$gmailTokenPresent = (Test-Path -LiteralPath $gmailTokenDirectory) -and
    @(Get-ChildItem -LiteralPath $gmailTokenDirectory -Filter '*.bin' -File -ErrorAction SilentlyContinue).Count -gt 0

$healthService = if ($null -ne $health -and $null -ne $health.result -and $health.result.PSObject.Properties['service']) { $health.result.service } else { $null }
$healthVersion = if ($null -ne $health -and $null -ne $health.result -and $health.result.PSObject.Properties['version']) { $health.result.version } else { $null }

[pscustomobject]@{
    RuntimeRoot          = $paths.Runtime
    InstalledAppExists   = Test-Path -LiteralPath $paths.App
    AgentPath            = Read-Pointer $paths.AgentPointer
    AgentExeVersion      = Get-FileVersion $paths.AgentExe
    NativeHostExeVersion = Get-FileVersion $paths.NativeHostExe
    CopilotWorkerPath    = Read-Pointer $paths.WorkerPointer
    CopilotWorkerPresent = Test-Path -LiteralPath $paths.WorkerEntry
    NativeManifest       = if (Test-Path -LiteralPath $const.RegistryPath) { Get-ItemPropertyValue -Path $const.RegistryPath -Name '(default)' } else { $null }
    NativeManifestExists = Test-Path -LiteralPath $paths.ManifestPath
    ExtensionId          = $const.ExtensionId
    TaskState            = if ($null -ne $task) { $task.State.ToString() } else { 'not registered' }
    TaskRunsOnBattery    = if ($null -ne $task) { -not $task.Settings.DisallowStartIfOnBatteries -and -not $task.Settings.StopIfGoingOnBatteries } else { $false }
    TaskRestartCount     = if ($null -ne $task) { $task.Settings.RestartCount } else { 0 }
    AppProcessIds        = ($appProcesses | ForEach-Object { $_.ProcessId }) -join ', '
    Health               = if ($null -ne $health -and $health.ok -eq $true) { "ok ($healthService $healthVersion)" } else { 'unavailable' }
    OAuthClientType      = $oauthType
    GmailTokenPresent    = $gmailTokenPresent
} | Format-List
