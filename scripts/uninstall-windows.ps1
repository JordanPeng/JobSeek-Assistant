<#
.SYNOPSIS
    Removes the JobSeek Assistant Windows bridge. Preserves local data by
    default.

.DESCRIPTION
    Stops the scheduled task and only the processes whose executable image lives
    under the app install root (each stopped by a specific process id), then
    removes the app directory, native-messaging registry entry, native manifest,
    and config pointers. Runtime data (data, vault, database, exports) and the
    config OAuth client/token are preserved unless -DeleteData is supplied
    together with the exact confirmation phrase.

    The script is idempotent: running it again after a successful uninstall
    succeeds and changes nothing.

.PARAMETER DeleteData
    Also delete ALL local runtime data. Requires -Confirmation to exactly match
    the phrase 'DELETE ALL LOCAL DATA'. A bare -DeleteData switch never wipes
    data on its own.

.PARAMETER Confirmation
    The exact confirmation phrase required by -DeleteData.
#>
[CmdletBinding(PositionalBinding = $false)]
param(
    [switch]$DeleteData,
    [string]$Confirmation
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Import-Module (Join-Path $PSScriptRoot 'JobSeek.Common.psm1') -Force

$const = Get-JobSeekConstant
$paths = Get-JobSeekPaths
$deleteDataPhrase = 'DELETE ALL LOCAL DATA'

# Resolve the DeleteData intent up front, before removing anything, so an
# unconfirmed -DeleteData cannot accidentally wipe data.
$wipeData = $false
if ($DeleteData) {
    if ($Confirmation -ceq $deleteDataPhrase) {
        $wipeData = $true
    }
    elseif ([Environment]::UserInteractive -and -not [System.Console]::IsInputRedirected) {
        $typed = Read-Host "Type '$deleteDataPhrase' to permanently delete all local JobSeek data"
        if ($typed -ceq $deleteDataPhrase) {
            $wipeData = $true
        }
    }
    if (-not $wipeData) {
        Write-Warning "Data deletion was NOT confirmed. Pass -Confirmation '$deleteDataPhrase' to wipe data. Continuing with binaries-only uninstall; data preserved."
    }
}

# Stop the task idempotently, then terminate only app-root processes by PID.
if ($null -ne (Get-ScheduledTask -TaskName $const.TaskName -ErrorAction SilentlyContinue)) {
    Stop-ScheduledTask -TaskName $const.TaskName -ErrorAction SilentlyContinue
}
if (Test-Path -LiteralPath $paths.App) {
    [void](Stop-JobSeekAppProcess -AppRoot $paths.App -TimeoutSeconds 20)
}

Unregister-ScheduledTask -TaskName $const.TaskName -Confirm:$false -ErrorAction SilentlyContinue
Remove-Item -Path $const.RegistryPath -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $paths.App -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $paths.AgentPointer -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $paths.WorkerPointer -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $paths.ManifestPath -Force -ErrorAction SilentlyContinue

# Remove staging/backup remnants from an interrupted install (never data).
Get-ChildItem -LiteralPath $paths.Runtime -Directory -Force -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like '.staging-*' -or $_.Name -like '.backup-*' -or $_.Name -like '.failed-*' } |
    ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue }

if ($wipeData) {
    Remove-Item -LiteralPath $paths.Runtime -Recurse -Force -ErrorAction SilentlyContinue
    Write-Output 'Uninstalled JobSeek Assistant and deleted all local runtime data.'
}
else {
    Write-Output 'Uninstalled JobSeek Assistant binaries and registration. Runtime data, exports, OAuth client, and Gmail token were preserved.'
}
