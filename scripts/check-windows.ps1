<#
.SYNOPSIS
    Reports Windows readiness for JobSeek Assistant without changing the machine.

.DESCRIPTION
    Prints tool versions, the Edge location, the local OAuth client TYPE (never
    the secret), install/registration/task presence, health, and the git
    privacy status of the ignored OAuth client. No secret contents are printed.
#>
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Import-Module (Join-Path $PSScriptRoot 'JobSeek.Common.psm1') -Force

$projectRoot = Split-Path -Parent $PSScriptRoot
$repoRoot = $projectRoot
$const = Get-JobSeekConstant
$paths = Get-JobSeekPaths

function Get-FirstLine {
    param([Parameter(Mandatory)][string]$Command)
    $resolved = Get-Command $Command -ErrorAction SilentlyContinue
    if ($null -eq $resolved) { return 'not found' }
    $version = & $resolved.Source --version 2>$null
    return (($version | Select-Object -First 1) -join '').Trim()
}

function Get-EdgePath {
    $candidates = @(
        'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe',
        'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe'
    )
    foreach ($candidate in $candidates) {
        if (Test-Path $candidate) {
            return (Get-ItemPropertyValue -Path $candidate -Name '(default)')
        }
    }

    $programFilesX86 = [System.Environment]::GetFolderPath([System.Environment+SpecialFolder]::ProgramFilesX86)
    $edgeCandidates = @(
        (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe'),
        (Join-Path $programFilesX86 'Microsoft\Edge\Application\msedge.exe')
    )
    foreach ($candidate in $edgeCandidates) {
        if (($null -ne $candidate) -and (Test-Path $candidate)) {
            return $candidate
        }
    }

    return 'not found'
}

function Get-OAuthClientTypes {
    $files = @(Get-ChildItem -Path $projectRoot -Filter 'client_secret_*.json' -File -ErrorAction SilentlyContinue)
    if ($files.Count -eq 0) {
        return 'none found'
    }

    $types = foreach ($file in $files) {
        try {
            $json = Get-Content -Path $file.FullName -Raw | ConvertFrom-Json
            if ($null -ne $json.PSObject.Properties['installed']) {
                'Desktop app'
            }
            elseif ($null -ne $json.PSObject.Properties['web']) {
                'Web application'
            }
            else {
                'unknown'
            }
        }
        catch {
            'unreadable'
        }
    }

    return ($types | Sort-Object -Unique) -join ', '
}

$task = Get-ScheduledTask -TaskName $const.TaskName -ErrorAction SilentlyContinue
$health = Get-JobSeekHealth
& git -C $repoRoot check-ignore -q 'client_secret_probe.json'
$oauthIgnored = $LASTEXITCODE -eq 0

[pscustomobject]@{
    PowerShell           = $PSVersionTable.PSVersion.ToString()
    DotNet               = Get-FirstLine 'dotnet'
    Node                 = Get-FirstLine 'node'
    Npm                  = Get-FirstLine 'npm'
    Git                  = Get-FirstLine 'git'
    EdgePath             = Get-EdgePath
    OAuthClientType      = Get-OAuthClientTypes
    OAuthIgnored         = $oauthIgnored
    RuntimeRootExists    = Test-Path $paths.Runtime
    InstalledAppExists   = Test-Path $paths.App
    NativeHostRegistered = Test-Path $const.RegistryPath
    LogonTaskRegistered  = $null -ne $task
    Health               = if ($null -ne $health -and $health.ok -eq $true) { 'ok' } else { 'unavailable' }
} | Format-List

Write-Output 'Git privacy checks (path status only):'
& git -C $repoRoot check-ignore -v 'client_secret_*.json' 2>$null
& git -C $repoRoot ls-files -- 'client_secret_*.json' 2>$null
