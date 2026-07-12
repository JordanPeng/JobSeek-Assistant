<#
.SYNOPSIS
    Shared helpers for the JobSeek Assistant Windows install, uninstall,
    status, and release-audit scripts.

.DESCRIPTION
    This module intentionally contains only local, non-mutating helpers plus a
    small number of process-control helpers used by the installer. Pure
    functions (manifest/artifact policy checks and needle derivation) are kept
    side-effect free so they can be unit tested without a real install.

    No function in this module ever prints a secret value, an OAuth client
    secret, a token, or resume contents. Sensitive-string scanners return only
    offending artifact paths and stable violation codes.
#>

Set-StrictMode -Version Latest

# The stable, public MV3 signing key for the production extension. Only the
# public key is embedded here; it yields the stable extension id and is safe to
# ship. It is NOT a secret.
$script:PublicExtensionKey = 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAmraT2orcdm4ET91T8I1v4fgzaL0GMPZUtuoe5zMSI+d/WrraoyPcotBPF9C6UiaSAyYm3l/WjMAiYW98WxbQW2cxnaIIbAWQbOtoZdct2vSdX75QWyWT6qDOmJcbvDwdyS8RCz0x7b9vJr6bnBcaPMzHZ087IZALzgDIGrYDPuf4gxs+rPAng7NgOf1U2hSl8vRn8tZrOH6cHyFy+nOecsK66AEuY/UKmqNzYRsCtYWa6ZlDcFweq5B8wAqru3X+9f0WGeHBO4PwikQ325Mlr4zqRvCeCC/qIGgY1/JjOyIEaFq0op0xdlIyw4HT07ODrpB4qSddTaAIfUSInq0AZQIDAQAB'
$script:StableExtensionId = 'eblebceopnkaakmhgdcdbpdaampoildh'
$script:HostName = 'com.jobseek.assistant'
$script:TaskName = 'JobSeek Assistant Agent'

function Get-JobSeekConstant {
    <#.SYNOPSIS Returns stable identifiers used across the scripts.#>
    [CmdletBinding()]
    param()
    return [pscustomobject]@{
        PublicExtensionKey = $script:PublicExtensionKey
        ExtensionId        = $script:StableExtensionId
        HostName           = $script:HostName
        TaskName           = $script:TaskName
        RegistryPath       = "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$($script:HostName)"
    }
}

function Get-JobSeekPaths {
    <#.SYNOPSIS Resolves the on-disk runtime layout under %LOCALAPPDATA%.#>
    [CmdletBinding()]
    param(
        [string]$RuntimeRoot
    )

    if ([string]::IsNullOrWhiteSpace($RuntimeRoot)) {
        $RuntimeRoot = Join-Path $env:LOCALAPPDATA 'JobSeekAssistant'
    }

    $appRoot = Join-Path $RuntimeRoot 'app'
    $configDirectory = Join-Path $RuntimeRoot 'config'
    return [pscustomobject]@{
        Runtime            = $RuntimeRoot
        App                = $appRoot
        Agent              = Join-Path $appRoot 'agent'
        NativeHost         = Join-Path $appRoot 'nativehost'
        CopilotWorker      = Join-Path $appRoot 'copilot-worker'
        Config             = $configDirectory
        Data               = Join-Path $RuntimeRoot 'data'
        Vault              = Join-Path $RuntimeRoot 'vault'
        Logs               = Join-Path $RuntimeRoot 'logs'
        Exports            = Join-Path $RuntimeRoot 'exports'
        AgentExe           = Join-Path (Join-Path $appRoot 'agent') 'JobSeek.Agent.exe'
        NativeHostExe      = Join-Path (Join-Path $appRoot 'nativehost') 'JobSeek.NativeHost.exe'
        WorkerEntry        = Join-Path (Join-Path (Join-Path $appRoot 'copilot-worker') 'dist') 'index.js'
        AgentPointer       = Join-Path $configDirectory 'agent-path.txt'
        WorkerPointer      = Join-Path $configDirectory 'copilot-worker-path.txt'
        ManifestPath       = Join-Path $configDirectory 'com.jobseek.assistant.json'
        OAuthClient        = Join-Path $configDirectory 'google-oauth-client.json'
    }
}

function Get-JobSeekAppProcess {
    <#
    .SYNOPSIS
        Enumerates only processes whose executable image lives under the app
        install root. Never matches by process name.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$AppRoot
    )

    $normalizedRoot = [System.IO.Path]::GetFullPath($AppRoot).TrimEnd([char]'\')
    $normalized = $normalizedRoot + [char]'\'
    $result = @()
    try {
        $processes = Get-CimInstance -ClassName Win32_Process -ErrorAction Stop
    }
    catch {
        return $result
    }
    foreach ($process in $processes) {
        $imagePath = $process.ExecutablePath
        $full = $null
        if (-not [string]::IsNullOrWhiteSpace($imagePath)) {
            try {
                $full = [System.IO.Path]::GetFullPath($imagePath)
            }
            catch {
                $full = $null
            }
        }
        $imageUnderRoot = $null -ne $full -and
            $full.StartsWith($normalized, [System.StringComparison]::OrdinalIgnoreCase)
        $commandReferencesRoot = -not [string]::IsNullOrWhiteSpace($process.CommandLine) -and
            $process.CommandLine.IndexOf($normalizedRoot, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
        if ($imageUnderRoot -or $commandReferencesRoot) {
            $result += [pscustomobject]@{
                ProcessId  = [int]$process.ProcessId
                ImagePath  = $full
                Name       = $process.Name
            }
        }
    }
    return $result
}

function Stop-JobSeekAppProcess {
    <#
    .SYNOPSIS
        Terminates only processes running from under the app install root using
        a specific -Id per process, then waits (bounded) for them to exit.
    #>
    [CmdletBinding(SupportsShouldProcess)]
    param(
        [Parameter(Mandatory)][string]$AppRoot,
        [int]$TimeoutSeconds = 20
    )

    $targets = @(Get-JobSeekAppProcess -AppRoot $AppRoot)
    foreach ($target in $targets) {
        if ($PSCmdlet.ShouldProcess("PID $($target.ProcessId) ($($target.Name))", 'Stop-Process')) {
            Stop-Process -Id $target.ProcessId -Force -ErrorAction SilentlyContinue
        }
    }

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        $remaining = @(Get-JobSeekAppProcess -AppRoot $AppRoot)
        if ($remaining.Count -eq 0) { return $true }
        Start-Sleep -Milliseconds 250
    }
    return (@(Get-JobSeekAppProcess -AppRoot $AppRoot).Count -eq 0)
}

function Get-JobSeekHealth {
    <#
    .SYNOPSIS
        Performs one length-prefixed health.get exchange on the current-user
        named pipe. Returns the parsed response object, or $null if unavailable.
    #>
    [CmdletBinding()]
    param(
        [int]$ConnectTimeoutMs = 1500
    )

    $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $pipeName = 'JobSeekAssistant.' + $sid.Replace('-', '_')
    $request = @{
        protocolVersion = 1
        requestId       = [guid]::NewGuid().ToString()
        operation       = 'health.get'
        payload         = @{}
    } | ConvertTo-Json -Compress
    $payload = [System.Text.Encoding]::UTF8.GetBytes($request)
    $pipe = [System.IO.Pipes.NamedPipeClientStream]::new('.', $pipeName, [System.IO.Pipes.PipeDirection]::InOut)
    try {
        $pipe.Connect($ConnectTimeoutMs)
        $pipe.Write([BitConverter]::GetBytes([uint32]$payload.Length), 0, 4)
        $pipe.Write($payload, 0, $payload.Length)
        $pipe.Flush()
        $lengthBuffer = Read-JobSeekExact -Stream $pipe -Count 4
        $length = [BitConverter]::ToUInt32($lengthBuffer, 0)
        if ($length -eq 0 -or $length -gt 524288) { return $null }
        $body = Read-JobSeekExact -Stream $pipe -Count $length
        return [System.Text.Encoding]::UTF8.GetString($body) | ConvertFrom-Json
    }
    catch {
        return $null
    }
    finally {
        $pipe.Dispose()
    }
}

function Read-JobSeekExact {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][System.IO.Stream]$Stream,
        [Parameter(Mandatory)][int]$Count
    )
    $buffer = New-Object byte[] $Count
    $offset = 0
    while ($offset -lt $Count) {
        $read = $Stream.Read($buffer, $offset, $Count - $offset)
        if ($read -eq 0) { throw 'Unexpected end of pipe stream.' }
        $offset += $read
    }
    return , $buffer
}

function Wait-JobSeekHealth {
    <#.SYNOPSIS Polls health.get until ok, or a bounded timeout elapses.#>
    [CmdletBinding()]
    param(
        [int]$TimeoutSeconds = 30
    )
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        $health = Get-JobSeekHealth
        if ($null -ne $health -and $health.ok -eq $true) { return $health }
        Start-Sleep -Milliseconds 500
    }
    return $null
}

# --------------------------------------------------------------------------
# Pure policy helpers (side-effect free; safe to unit test without an install)
# --------------------------------------------------------------------------

function Get-ManifestPolicyViolation {
    <#
    .SYNOPSIS
        Validates a production MV3 manifest object against the exact JobSeek
        release policy. Returns an array of stable violation codes (empty when
        the manifest complies).
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]$Manifest
    )

    $violations = @()
    $expectedPermissions = @('activeTab', 'alarms', 'nativeMessaging', 'scripting', 'storage')
    $expectedCsp = "script-src 'self'; object-src 'self'"

    if (($Manifest.PSObject.Properties['manifest_version']) -eq $null -or [int]$Manifest.manifest_version -ne 3) {
        $violations += 'MANIFEST_VERSION'
    }

    $permissions = @()
    if ($Manifest.PSObject.Properties['permissions']) { $permissions = @($Manifest.permissions) }
    $permissionsKey = ($permissions | Sort-Object) -join ','
    $expectedPermissionsKey = ($expectedPermissions | Sort-Object) -join ','
    if ($permissionsKey -ne $expectedPermissionsKey) {
        $violations += 'PERMISSIONS_MISMATCH'
    }

    if ($Manifest.PSObject.Properties['host_permissions'] -and @($Manifest.host_permissions).Count -gt 0) {
        $violations += 'HOST_PERMISSIONS_PRESENT'
    }

    $optional = @()
    if ($Manifest.PSObject.Properties['optional_host_permissions']) { $optional = @($Manifest.optional_host_permissions) }
    $optionalKey = ($optional | Sort-Object) -join ','
    if ($optionalKey -ne 'https://*/*') {
        $violations += 'OPTIONAL_HOST_MISMATCH'
    }

    $csp = $null
    if ($Manifest.PSObject.Properties['content_security_policy'] -and $Manifest.content_security_policy.PSObject.Properties['extension_pages']) {
        $csp = $Manifest.content_security_policy.extension_pages
    }
    if ($csp -ne $expectedCsp) {
        $violations += 'CSP_MISMATCH'
    }

    $key = $null
    if ($Manifest.PSObject.Properties['key']) { $key = $Manifest.key }
    if ($key -ne $script:PublicExtensionKey) {
        $violations += 'KEY_MISMATCH'
    }

    return @($violations)
}

function Get-ArtifactStructureViolation {
    <#
    .SYNOPSIS
        Given a list of relative artifact paths, returns objects describing any
        file whose name/type is forbidden in a release artifact (source maps,
        test files, databases, vaults, tokens, browser profiles, resume/PDF,
        OAuth client files). Returns [] when clean.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][AllowEmptyCollection()][string[]]$RelativePaths,
        [switch]$AllowPdf
    )

    $rules = [ordered]@{
        SOURCE_MAP        = '\.map$'
        TEST_FILE         = '\.(test|spec)\.[a-z0-9]+$'
        DATABASE          = '\.(db|sqlite|sqlite3)(-wal|-shm|-journal)?$'
        VAULT             = '(^|[\\/])(vault|document-vault)([\\/]|$)'
        TOKEN             = '(?i)((^|[\\/_.-])(oauth[-_]?tokens?|gmail[-_]?tokens?|refresh[-_]?tokens?|access[-_]?tokens?|token[-_]?store)([\\/_.-]|$)|[\\/]tokens?[\\/])'
        OAUTH_CLIENT      = '(client_secret_.*\.json$|google-oauth-client\.json$|oauth-client.*\.json$)'
        BROWSER_PROFILE   = '(^|[\\/])(browser-profiles?|user-data-dir)([\\/]|$)'
        RESUME_SOURCE     = '(^|[\\/])resume\.md$'
    }
    if (-not $AllowPdf) { $rules['PDF_DOCUMENT'] = '\.pdf$' }

    $violations = @()
    foreach ($path in $RelativePaths) {
        if ([string]::IsNullOrWhiteSpace($path)) { continue }
        foreach ($code in $rules.Keys) {
            if ($path -match $rules[$code]) {
                $violations += [pscustomobject]@{ Code = $code; Path = $path }
            }
        }
    }
    return @($violations)
}

function Get-SensitiveNeedle {
    <#
    .SYNOPSIS
        Derives sensitive string needles at runtime from the local (ignored)
        OAuth client and the tracked resume source. Returns objects with a
        stable Code and the secret Value. Callers MUST NOT print Value; it is
        only used to test artifact contents.
    #>
    [CmdletBinding()]
    param(
        [string]$OAuthClientPath,
        [string]$ResumePath
    )

    $needles = @()

    if (-not [string]::IsNullOrWhiteSpace($OAuthClientPath) -and (Test-Path -LiteralPath $OAuthClientPath)) {
        try {
            $client = Get-Content -LiteralPath $OAuthClientPath -Raw | ConvertFrom-Json
            $node = if ($client.PSObject.Properties['installed']) { $client.installed } elseif ($client.PSObject.Properties['web']) { $client.web } else { $null }
            if ($null -ne $node) {
                if ($node.PSObject.Properties['client_secret'] -and -not [string]::IsNullOrWhiteSpace($node.client_secret)) {
                    $needles += [pscustomobject]@{ Code = 'OAUTH_CLIENT_SECRET'; Value = [string]$node.client_secret }
                }
                if ($node.PSObject.Properties['client_id'] -and -not [string]::IsNullOrWhiteSpace($node.client_id)) {
                    $needles += [pscustomobject]@{ Code = 'OAUTH_CLIENT_ID'; Value = [string]$node.client_id }
                }
            }
        }
        catch {
            # A malformed local client is not a release-artifact problem; skip.
        }
    }

    if (-not [string]::IsNullOrWhiteSpace($ResumePath) -and (Test-Path -LiteralPath $ResumePath)) {
        try {
            $resume = Get-Content -LiteralPath $ResumePath -Raw
            foreach ($match in [regex]::Matches($resume, '[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}')) {
                $needles += [pscustomobject]@{ Code = 'RESUME_EMAIL'; Value = $match.Value }
            }
            foreach ($match in [regex]::Matches($resume, '\+?\d[\d\-\s().]{8,}\d')) {
                $digits = ($match.Value -replace '\D', '')
                if ($digits.Length -ge 10) {
                    $needles += [pscustomobject]@{ Code = 'RESUME_PHONE'; Value = $digits }
                }
            }
        }
        catch {
            # Resume unreadable; needle derivation is best-effort.
        }
    }

    return @($needles | Sort-Object -Property Code, Value -Unique)
}

function Find-SensitiveNeedleHit {
    <#
    .SYNOPSIS
        Scans the given files for any derived needle. Returns objects with the
        offending artifact Path and the needle Code only. The needle Value is
        never returned or printed.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][AllowEmptyCollection()][string[]]$Files,
        [Parameter(Mandatory)][AllowEmptyCollection()][object[]]$Needles,
        [string]$BasePath
    )

    $hits = @()
    if ($Needles.Count -eq 0) { return @($hits) }

    foreach ($file in $Files) {
        if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { continue }
        $content = $null
        try {
            $bytes = [System.IO.File]::ReadAllBytes($file)
            $content = [System.Text.Encoding]::UTF8.GetString($bytes)
        }
        catch {
            continue
        }
        if ([string]::IsNullOrEmpty($content)) { continue }
        $reported = if ([string]::IsNullOrWhiteSpace($BasePath)) { $file } else { Get-RelativeArtifactPath -BasePath $BasePath -FullPath $file }
        foreach ($needle in $Needles) {
            if ($content.IndexOf($needle.Value, [System.StringComparison]::Ordinal) -ge 0) {
                $hits += [pscustomobject]@{ Code = $needle.Code; Path = $reported }
            }
        }
    }
    return @($hits)
}

function Get-RelativeArtifactPath {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$BasePath,
        [Parameter(Mandatory)][string]$FullPath
    )
    $baseFull = [System.IO.Path]::GetFullPath($BasePath).TrimEnd([char]'\')
    $itemFull = [System.IO.Path]::GetFullPath($FullPath)
    if ($itemFull.StartsWith($baseFull, [System.StringComparison]::OrdinalIgnoreCase)) {
        return $itemFull.Substring($baseFull.Length).TrimStart([char]'\')
    }
    return $itemFull
}

function Get-RemoteCodeViolation {
    <#
    .SYNOPSIS
        Scans extension JavaScript text for network exfiltration / remote-code
        and telemetry indicators. Benign namespace URLs (w3.org, react.dev,
        json-schema.org) and the Gmail read-only scope label are ignored;
        only actual sinks and known analytics domains are flagged.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Content,
        [Parameter(Mandatory)][string]$Path
    )

    $violations = @()
    $telemetryDomains = @(
        'google-analytics.com', 'googletagmanager.com', 'analytics.google.com',
        'sentry.io', 'segment.io', 'segment.com', 'mixpanel.com', 'amplitude.com',
        'fullstory.com', 'datadoghq.com', 'bugsnag.com', 'browser-intake', 'hotjar.com',
        'sardine.ai', 'cloudflareinsights.com'
    )
    foreach ($domain in $telemetryDomains) {
        if ($Content.IndexOf($domain, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
            $violations += [pscustomobject]@{ Code = 'TELEMETRY_DOMAIN'; Path = $Path }
            break
        }
    }

    # Network sinks pointed at an absolute remote URL.
    if ($Content -match 'fetch\(\s*[`"'']https?://') {
        $violations += [pscustomobject]@{ Code = 'REMOTE_FETCH'; Path = $Path }
    }
    if ($Content -match 'sendBeacon\s*\(') {
        $violations += [pscustomobject]@{ Code = 'SEND_BEACON'; Path = $Path }
    }
    if ($Content -match 'new\s+WebSocket\s*\(' -or $Content -match 'new\s+EventSource\s*\(') {
        $violations += [pscustomobject]@{ Code = 'REMOTE_SOCKET'; Path = $Path }
    }
    # Dynamic import of a remote module or an injected remote script src.
    if ($Content -match 'import\(\s*[`"'']https?://') {
        $violations += [pscustomobject]@{ Code = 'REMOTE_IMPORT'; Path = $Path }
    }

    return @($violations)
}

Export-ModuleMember -Function `
    Get-JobSeekConstant, Get-JobSeekPaths, Get-JobSeekAppProcess, Stop-JobSeekAppProcess, `
    Get-JobSeekHealth, Wait-JobSeekHealth, Read-JobSeekExact, `
    Get-ManifestPolicyViolation, Get-ArtifactStructureViolation, `
    Get-SensitiveNeedle, Find-SensitiveNeedleHit, Get-RelativeArtifactPath, Get-RemoteCodeViolation
