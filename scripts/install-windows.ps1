<#
.SYNOPSIS
    Idempotent, atomic install/update of the JobSeek Assistant Windows bridge.

.DESCRIPTION
    Everything is built and validated in a unique staging directory before the
    live install is touched. The live 'app' directory is then swapped in a
    single move, pointers/manifest/registry/task are refreshed, and the agent is
    health-checked. If the health check fails after the swap, the previous app
    is restored. Runtime data (data, vault, database, exports, and the config
    OAuth client/token) is never moved or deleted.

    The script is safe to run repeatedly, including while the Agent is running:
    only processes whose executable image lives under the app root are stopped,
    each by a specific process id.
#>
[CmdletBinding()]
param(
    [switch]$SelfContained
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Import-Module (Join-Path $PSScriptRoot 'JobSeek.Common.psm1') -Force

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$const = Get-JobSeekConstant
$paths = Get-JobSeekPaths
$agentProject = Join-Path $projectRoot 'companion\src\JobSeek.Agent\JobSeek.Agent.csproj'
$nativeHostProject = Join-Path $projectRoot 'companion\src\JobSeek.NativeHost\JobSeek.NativeHost.csproj'

function Import-InstalledOAuthClient {
    param(
        [Parameter(Mandatory)][string]$SourceRoot,
        [Parameter(Mandatory)][string]$DestinationDirectory
    )

    $clients = @(Get-ChildItem -Path $SourceRoot -Filter 'client_secret_*.json' -File -ErrorAction SilentlyContinue)
    if ($clients.Count -eq 0) { return $false }
    if ($clients.Count -ne 1) { throw 'Expected exactly one local client_secret_*.json OAuth client file.' }
    try {
        $client = Get-Content -Path $clients[0].FullName -Raw | ConvertFrom-Json
    }
    catch { throw 'The local OAuth client file is not valid JSON.' }
    $installedProperty = $client.PSObject.Properties['installed']
    $webProperty = $client.PSObject.Properties['web']
    if ($null -eq $installedProperty -or $null -ne $webProperty) {
        throw 'The OAuth client must be a Desktop app client with a top-level installed object.'
    }
    $installed = $installedProperty.Value
    if ([string]::IsNullOrWhiteSpace($installed.client_id) -or [string]::IsNullOrWhiteSpace($installed.client_secret)) {
        throw 'The Desktop OAuth client is invalid.'
    }

    $destination = Join-Path $DestinationDirectory 'google-oauth-client.json'
    Copy-Item -LiteralPath $clients[0].FullName -Destination $destination -Force
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    & icacls $destination /inheritance:r /grant:r "${identity}:(F)" *> $null
    if ($LASTEXITCODE -ne 0) {
        throw 'Failed to restrict the installed OAuth client to the current user.'
    }
    return $true
}

function Build-StagedApp {
    param([Parameter(Mandatory)][string]$StagingApp)

    $agentDirectory = Join-Path $StagingApp 'agent'
    $nativeHostDirectory = Join-Path $StagingApp 'nativehost'
    $copilotWorkerDirectory = Join-Path $StagingApp 'copilot-worker'
    foreach ($path in @($StagingApp, $agentDirectory, $nativeHostDirectory, $copilotWorkerDirectory)) {
        New-Item -ItemType Directory -Path $path -Force | Out-Null
    }

    $selfContainedValue = $SelfContained.ToString().ToLowerInvariant()
    & dotnet publish $agentProject -c Release -r win-x64 --self-contained $selfContainedValue -o $agentDirectory
    if ($LASTEXITCODE -ne 0) { throw 'Agent publish failed.' }
    & dotnet publish $nativeHostProject -c Release -r win-x64 --self-contained $selfContainedValue -o $nativeHostDirectory
    if ($LASTEXITCODE -ne 0) { throw 'Native host publish failed.' }

    # The optional worker is isolated from the extension and companion payloads.
    # Copy only compiled JS and its production package dependencies.
    & npm --prefix $projectRoot run build --workspace '@jobseek/copilot-worker'
    if ($LASTEXITCODE -ne 0) { throw 'Copilot worker build failed.' }
    New-Item -ItemType Directory -Path (Join-Path $copilotWorkerDirectory 'dist') -Force | Out-Null
    Copy-Item -Path (Join-Path $projectRoot 'apps\copilot-worker\dist\*') -Destination (Join-Path $copilotWorkerDirectory 'dist') -Force
    @{
        name = '@jobseek/copilot-worker-runtime'
        private = $true
        type = 'module'
        dependencies = @{
            '@github/copilot-sdk' = '1.0.6-preview.1'
            zod = '4.4.3'
        }
    } | ConvertTo-Json -Depth 4 | Set-Content -Path (Join-Path $copilotWorkerDirectory 'package.json') -Encoding utf8
    & npm --prefix $copilotWorkerDirectory install --omit=dev --ignore-scripts --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'Copilot worker production dependency installation failed.' }
    Get-ChildItem -Path $copilotWorkerDirectory -Recurse -Include '*.map', '*.test.*', '*.spec.*' | Remove-Item -Force -ErrorAction SilentlyContinue
}

function Test-StagedApp {
    param([Parameter(Mandatory)][string]$StagingApp)

    $agentExe = Join-Path (Join-Path $StagingApp 'agent') 'JobSeek.Agent.exe'
    $nativeHostExe = Join-Path (Join-Path $StagingApp 'nativehost') 'JobSeek.NativeHost.exe'
    $workerEntry = Join-Path (Join-Path (Join-Path $StagingApp 'copilot-worker') 'dist') 'index.js'
    $workerPackage = Join-Path (Join-Path $StagingApp 'copilot-worker') 'package.json'
    $workerModules = Join-Path (Join-Path $StagingApp 'copilot-worker') 'node_modules'

    foreach ($required in @($agentExe, $nativeHostExe, $workerEntry, $workerPackage)) {
        if (-not (Test-Path -LiteralPath $required)) {
            throw "Staging validation failed: expected artifact missing: $((Get-RelativeArtifactPath -BasePath $StagingApp -FullPath $required))"
        }
    }
    if (-not (Test-Path -LiteralPath $workerModules -PathType Container)) {
        throw 'Staging validation failed: worker production dependencies were not installed.'
    }

    $relativePaths = Get-ChildItem -LiteralPath $StagingApp -Recurse -File | ForEach-Object {
        Get-RelativeArtifactPath -BasePath $StagingApp -FullPath $_.FullName
    }
    # The DPAPI protected-data library ships in the companion payload; its file
    # name legitimately contains "ProtectedData" and is not a token artifact.
    $structure = @(Get-ArtifactStructureViolation -RelativePaths $relativePaths | Where-Object {
        -not ($_.Code -eq 'TOKEN' -and $_.Path -match 'ProtectedData')
    })
    if ($structure.Count -gt 0) {
        $summary = ($structure | ForEach-Object { "$($_.Code): $($_.Path)" }) -join '; '
        throw "Staging validation failed: forbidden artifacts present: $summary"
    }
}

function Write-InstallPointers {
    New-Item -ItemType Directory -Path $paths.Config -Force | Out-Null
    Set-Content -Path $paths.AgentPointer -Value $paths.AgentExe -NoNewline -Encoding utf8
    Set-Content -Path $paths.WorkerPointer -Value $paths.CopilotWorker -NoNewline -Encoding utf8
    @{
        name = $const.HostName
        description = 'JobSeek Assistant native bridge'
        path = $paths.NativeHostExe
        type = 'stdio'
        allowed_origins = @("chrome-extension://$($const.ExtensionId)/")
    } | ConvertTo-Json -Depth 3 | Set-Content -Path $paths.ManifestPath -Encoding utf8

    New-Item -Path $const.RegistryPath -Force | Out-Null
    Set-ItemProperty -Path $const.RegistryPath -Name '(default)' -Value $paths.ManifestPath
}

function Register-AgentTask {
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    $action = New-ScheduledTaskAction -Execute $paths.AgentExe -WorkingDirectory $paths.Agent
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity
    # Interactive + Limited: runs only in the signed-in session, never elevated.
    $principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet `
        -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries `
        -StartWhenAvailable `
        -ExecutionTimeLimit ([TimeSpan]::Zero) `
        -MultipleInstances IgnoreNew `
        -RestartCount 3 `
        -RestartInterval (New-TimeSpan -Minutes 1)
    Register-ScheduledTask -TaskName $const.TaskName -Action $action -Trigger $trigger -Principal $principal `
        -Settings $settings `
        -Description 'Runs JobSeek Assistant only in the signed-in user session.' -Force | Out-Null
}

function Stop-AgentTaskAndProcesses {
    if ($null -ne (Get-ScheduledTask -TaskName $const.TaskName -ErrorAction SilentlyContinue)) {
        Stop-ScheduledTask -TaskName $const.TaskName -ErrorAction SilentlyContinue
    }
    if (Test-Path -LiteralPath $paths.App) {
        [void](Stop-JobSeekAppProcess -AppRoot $paths.App -TimeoutSeconds 20)
    }
}

# --- Build and validate in staging before touching the live install ---------
foreach ($path in @($paths.Runtime, $paths.Config, $paths.Data, $paths.Vault, $paths.Logs, $paths.Exports)) {
    New-Item -ItemType Directory -Path $path -Force | Out-Null
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
$stagingRoot = Join-Path $paths.Runtime (".staging-$stamp")
$stagingApp = Join-Path $stagingRoot 'app'
$backupApp = Join-Path $paths.Runtime (".backup-$stamp")

try {
    Build-StagedApp -StagingApp $stagingApp
    Test-StagedApp -StagingApp $stagingApp
}
catch {
    Remove-Item -LiteralPath $stagingRoot -Recurse -Force -ErrorAction SilentlyContinue
    throw
}

# OAuth client import writes only the config client file; tokens are untouched.
$oauthImported = Import-InstalledOAuthClient -SourceRoot $projectRoot -DestinationDirectory $paths.Config

# --- Component swap ---------------------------------------------------------
# Agent and NativeHost directories are atomically replaced. The worker is
# updated inside its stable directory because an authenticated Copilot runtime
# may temporarily hold that directory as its working directory even after the
# JobSeek worker process exits; Windows permits file/subdirectory replacement
# but not renaming the held parent directory.
Stop-AgentTaskAndProcesses

$hadOldApp = Test-Path -LiteralPath $paths.App
$swapStarted = $false
$workerHadOld = Test-Path -LiteralPath $paths.CopilotWorker
try {
    New-Item -ItemType Directory -Path $paths.App, $backupApp -Force | Out-Null
    $swapStarted = $true

    foreach ($component in @('agent', 'nativehost')) {
        $liveComponent = Join-Path $paths.App $component
        $stagedComponent = Join-Path $stagingApp $component
        $backupComponent = Join-Path $backupApp $component
        if (Test-Path -LiteralPath $liveComponent) {
            Move-Item -LiteralPath $liveComponent -Destination $backupComponent
        }
        Move-Item -LiteralPath $stagedComponent -Destination $liveComponent
    }

    $stagedWorker = Join-Path $stagingApp 'copilot-worker'
    $backupWorker = Join-Path $backupApp 'copilot-worker'
    if ($workerHadOld) {
        New-Item -ItemType Directory -Path $backupWorker -Force | Out-Null
        foreach ($name in @('dist', 'package.json', 'package-lock.json')) {
            $liveItem = Join-Path $paths.CopilotWorker $name
            if (Test-Path -LiteralPath $liveItem) {
                Move-Item -LiteralPath $liveItem -Destination (Join-Path $backupWorker $name)
            }
        }
        New-Item -ItemType Directory -Path $paths.CopilotWorker -Force | Out-Null
        Move-Item -LiteralPath (Join-Path $stagedWorker 'dist') -Destination (Join-Path $paths.CopilotWorker 'dist')
        Copy-Item -LiteralPath (Join-Path $stagedWorker 'package.json') -Destination (Join-Path $paths.CopilotWorker 'package.json') -Force
        if (-not (Test-Path -LiteralPath (Join-Path $paths.CopilotWorker 'node_modules'))) {
            Move-Item -LiteralPath (Join-Path $stagedWorker 'node_modules') -Destination (Join-Path $paths.CopilotWorker 'node_modules')
        }
        & npm --prefix $paths.CopilotWorker install --omit=dev --ignore-scripts --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { throw 'Installed Copilot worker dependency refresh failed.' }
        Get-ChildItem -Path $paths.CopilotWorker -Recurse -File -Include '*.map', '*.test.*', '*.spec.*' |
            Remove-Item -Force -ErrorAction SilentlyContinue
        $invalidSystemDriveRoot = Join-Path $paths.CopilotWorker '%SystemDrive%'
        if (Test-Path -LiteralPath $invalidSystemDriveRoot) {
            Remove-Item -LiteralPath $invalidSystemDriveRoot -Recurse -Force
        }
    }
    else {
        Move-Item -LiteralPath $stagedWorker -Destination $paths.CopilotWorker
    }

    Write-InstallPointers
    Register-AgentTask
    Start-ScheduledTask -TaskName $const.TaskName

    $health = Wait-JobSeekHealth -TimeoutSeconds 30
    if ($null -eq $health -or $health.ok -ne $true) {
        throw 'The installed Agent did not report healthy after the swap.'
    }

    # Success: discard the previous app and any staging remnants.
    if (Test-Path -LiteralPath $backupApp) {
        Remove-Item -LiteralPath $backupApp -Recurse -Force -ErrorAction SilentlyContinue
    }
    Remove-Item -LiteralPath $stagingRoot -Recurse -Force -ErrorAction SilentlyContinue

    $service = if ($null -ne $health.result -and $health.result.PSObject.Properties['service']) { $health.result.service } else { 'unknown' }
    $version = if ($null -ne $health.result -and $health.result.PSObject.Properties['version']) { $health.result.version } else { 'unknown' }
    Write-Output "Installed JobSeek Assistant bridge under $($paths.App) (service: $service $version; OAuth client configured: $oauthImported)."
}
catch {
    Write-Warning "Install failed after swap; attempting rollback. $($_.Exception.Message)"
    if ($swapStarted) {
        Stop-AgentTaskAndProcesses
        foreach ($component in @('agent', 'nativehost')) {
            $liveComponent = Join-Path $paths.App $component
            $backupComponent = Join-Path $backupApp $component
            Remove-Item -LiteralPath $liveComponent -Recurse -Force -ErrorAction SilentlyContinue
            if (Test-Path -LiteralPath $backupComponent) {
                Move-Item -LiteralPath $backupComponent -Destination $liveComponent -ErrorAction SilentlyContinue
            }
        }

        $backupWorker = Join-Path $backupApp 'copilot-worker'
        if ($workerHadOld -and (Test-Path -LiteralPath $backupWorker)) {
            foreach ($name in @('dist', 'package.json', 'package-lock.json')) {
                $liveItem = Join-Path $paths.CopilotWorker $name
                $backupItem = Join-Path $backupWorker $name
                Remove-Item -LiteralPath $liveItem -Recurse -Force -ErrorAction SilentlyContinue
                if (Test-Path -LiteralPath $backupItem) {
                    Move-Item -LiteralPath $backupItem -Destination $liveItem -ErrorAction SilentlyContinue
                }
            }
        }

        # Pointers/manifest/registry paths are stable; re-assert and restart.
        try {
            Write-InstallPointers
            Register-AgentTask
            Start-ScheduledTask -TaskName $const.TaskName -ErrorAction SilentlyContinue
        }
        catch {
            Write-Warning "Rollback restart encountered an error: $($_.Exception.Message)"
        }
    }
    Remove-Item -LiteralPath $stagingRoot -Recurse -Force -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $backupApp) {
        Remove-Item -LiteralPath $backupApp -Recurse -Force -ErrorAction SilentlyContinue
    }
    throw
}
