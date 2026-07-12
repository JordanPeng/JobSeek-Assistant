<#
.SYNOPSIS
    Parser checks and pure-function unit tests for the JobSeek Windows scripts.

.DESCRIPTION
    Standalone (no Pester dependency). Verifies that every script parses without
    error and asserts the behaviour of the side-effect-free helpers in
    JobSeek.Common.psm1 using synthetic inputs only. No secrets or real data are
    used or printed.

    Exits 0 when all checks pass, 1 otherwise.
#>
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$scriptRoot = Split-Path -Parent $PSCommandPath
$scriptsDir = Split-Path -Parent $scriptRoot
Import-Module (Join-Path $scriptsDir 'JobSeek.Common.psm1') -Force

$script:failures = @()
function Assert-True {
    param([Parameter(Mandatory)][bool]$Condition, [Parameter(Mandatory)][string]$Message)
    if ($Condition) {
        Write-Host "  [PASS] $Message"
    }
    else {
        Write-Host "  [FAIL] $Message" -ForegroundColor Red
        $script:failures += $Message
    }
}
function Assert-Equal {
    param($Expected, $Actual, [Parameter(Mandatory)][string]$Message)
    Assert-True -Condition ($Expected -eq $Actual) -Message "$Message (expected '$Expected', got '$Actual')"
}

Write-Host 'Parser checks:'
$allScripts = Get-ChildItem -LiteralPath $scriptsDir -Filter '*.ps1' -Recurse
$allScripts += Get-ChildItem -LiteralPath $scriptsDir -Filter '*.psm1'
foreach ($file in $allScripts) {
    $tokens = $null
    $errors = $null
    [System.Management.Automation.Language.Parser]::ParseFile($file.FullName, [ref]$tokens, [ref]$errors) | Out-Null
    Assert-True -Condition ($errors.Count -eq 0) -Message "parses: $($file.Name)"
    if ($errors.Count -gt 0) { $errors | ForEach-Object { Write-Host "    $($_.Message)" -ForegroundColor Red } }
}

Write-Host ''
Write-Host 'Get-ManifestPolicyViolation:'
$key = (Get-JobSeekConstant).PublicExtensionKey
$cleanJson = @"
{"manifest_version":3,"key":"$key","permissions":["storage","alarms","activeTab","scripting","nativeMessaging"],"optional_host_permissions":["https://*/*"],"content_security_policy":{"extension_pages":"script-src 'self'; object-src 'self'"}}
"@
$clean = $cleanJson | ConvertFrom-Json
Assert-Equal 0 (@(Get-ManifestPolicyViolation -Manifest $clean).Count) 'compliant manifest yields no violations'

$dirty = $cleanJson | ConvertFrom-Json
$dirty.optional_host_permissions = @('https://*/*', 'http://*/*')
$dirty | Add-Member -NotePropertyName host_permissions -NotePropertyValue @('https://*/*') -Force
$dirty.key = 'not-the-public-key'
$dirtyCodes = @(Get-ManifestPolicyViolation -Manifest $dirty)
Assert-True -Condition ($dirtyCodes -contains 'OPTIONAL_HOST_MISMATCH') -Message 'http optional host flagged'
Assert-True -Condition ($dirtyCodes -contains 'HOST_PERMISSIONS_PRESENT') -Message 'required host permission flagged'
Assert-True -Condition ($dirtyCodes -contains 'KEY_MISMATCH') -Message 'wrong signing key flagged'

$badCsp = $cleanJson | ConvertFrom-Json
$badCsp.content_security_policy.extension_pages = "script-src 'self' https://cdn.example"
Assert-True -Condition (@(Get-ManifestPolicyViolation -Manifest $badCsp) -contains 'CSP_MISMATCH') -Message 'loosened CSP flagged'

$missingPerm = $cleanJson | ConvertFrom-Json
$missingPerm.permissions = @('storage', 'alarms', 'activeTab', 'scripting')
Assert-True -Condition (@(Get-ManifestPolicyViolation -Manifest $missingPerm) -contains 'PERMISSIONS_MISMATCH') -Message 'permission set mismatch flagged'

Write-Host ''
Write-Host 'Get-ArtifactStructureViolation:'
$structCodes = @(Get-ArtifactStructureViolation -RelativePaths @(
        'dist\index.js', 'dist\index.js.map', 'a\b.test.js', 'a\c.spec.ts',
        'data\jobseek.db', 'data\jobseek.db-wal', 'store.sqlite3',
        'vault\doc.bin', 'config\google-oauth-client.json',
        'client_secret_abc.json', 'oauth-tokens.json', 'gmail-token\creds',
        'browser-profiles\Default\Cookies', 'resume.md', 'candidate-resume.pdf'
    ) | ForEach-Object { $_.Code } | Sort-Object -Unique)
foreach ($expected in @('SOURCE_MAP', 'TEST_FILE', 'DATABASE', 'VAULT', 'OAUTH_CLIENT', 'TOKEN', 'BROWSER_PROFILE', 'RESUME_SOURCE', 'PDF_DOCUMENT')) {
    Assert-True -Condition ($structCodes -contains $expected) -Message "structure flags $expected"
}
$cleanStruct = @(Get-ArtifactStructureViolation -RelativePaths @('dist\index.js', 'package.json', 'nativehost\JobSeek.NativeHost.exe'))
Assert-Equal 0 $cleanStruct.Count 'clean artifact list yields no structure violations'
$pdfAllowed = @(Get-ArtifactStructureViolation -RelativePaths @('doc.pdf') -AllowPdf)
Assert-Equal 0 $pdfAllowed.Count 'AllowPdf suppresses PDF flag'

Write-Host ''
Write-Host 'Get-SensitiveNeedle / Find-SensitiveNeedleHit:'
$fakeOAuth = Join-Path $env:TEMP ("jobseek-test-oauth-" + [guid]::NewGuid().ToString('N') + '.json')
$fakeResume = Join-Path $env:TEMP ("jobseek-test-resume-" + [guid]::NewGuid().ToString('N') + '.md')
$fakeArtifact = Join-Path $env:TEMP ("jobseek-test-artifact-" + [guid]::NewGuid().ToString('N') + '.js')
try {
    @{ installed = @{ client_id = 'FAKE-CLIENT-ID-123.apps.googleusercontent.com'; client_secret = 'FAKE-SECRET-XYZ' } } |
        ConvertTo-Json | Set-Content -LiteralPath $fakeOAuth -Encoding utf8
    "Contact: fake.person@example.com or +1 (555) 867-5309" | Set-Content -LiteralPath $fakeResume -Encoding utf8
    $needles = @(Get-SensitiveNeedle -OAuthClientPath $fakeOAuth -ResumePath $fakeResume)
    $codes = $needles | ForEach-Object { $_.Code } | Sort-Object -Unique
    Assert-True -Condition ($codes -contains 'OAUTH_CLIENT_SECRET') -Message 'derives OAuth secret needle'
    Assert-True -Condition ($codes -contains 'RESUME_EMAIL') -Message 'derives resume email needle'
    Assert-True -Condition ($codes -contains 'RESUME_PHONE') -Message 'derives resume phone needle'

    'var leaked = "FAKE-SECRET-XYZ"; var mail = "fake.person@example.com";' | Set-Content -LiteralPath $fakeArtifact -Encoding utf8
    $hits = @(Find-SensitiveNeedleHit -Files @($fakeArtifact) -Needles $needles -BasePath $env:TEMP)
    Assert-True -Condition ($hits.Count -ge 2) -Message 'needle scan detects planted secret and email'
    Assert-True -Condition (($hits | ForEach-Object { $_.PSObject.Properties.Name }) -notcontains 'Value') -Message 'needle hit objects do not expose Value'

    $cleanArtifact = Join-Path $env:TEMP ("jobseek-test-clean-" + [guid]::NewGuid().ToString('N') + '.js')
    'export const answer = 42;' | Set-Content -LiteralPath $cleanArtifact -Encoding utf8
    Assert-Equal 0 (@(Find-SensitiveNeedleHit -Files @($cleanArtifact) -Needles $needles -BasePath $env:TEMP).Count) 'clean artifact has no needle hits'
    Remove-Item -LiteralPath $cleanArtifact -Force -ErrorAction SilentlyContinue
}
finally {
    Remove-Item -LiteralPath $fakeOAuth, $fakeResume, $fakeArtifact -Force -ErrorAction SilentlyContinue
}

Write-Host ''
Write-Host 'Get-RemoteCodeViolation:'
$remote = @(Get-RemoteCodeViolation -Content 'fetch("https://evil.example/x"); navigator.sendBeacon("/t"); new WebSocket("wss://x")' -Path 'bg.js') | ForEach-Object { $_.Code }
Assert-True -Condition ($remote -contains 'REMOTE_FETCH') -Message 'remote fetch flagged'
Assert-True -Condition ($remote -contains 'SEND_BEACON') -Message 'sendBeacon flagged'
Assert-True -Condition ($remote -contains 'REMOTE_SOCKET') -Message 'WebSocket flagged'
$benign = @(Get-RemoteCodeViolation -Content 'const svg="http://www.w3.org/2000/svg"; const scope="https://www.googleapis.com/auth/gmail.readonly";' -Path 'ui.js')
Assert-Equal 0 $benign.Count 'benign namespace/scope URLs are not flagged'

Write-Host ''
if ($script:failures.Count -eq 0) {
    Write-Host "All script tests passed." -ForegroundColor Green
    exit 0
}
Write-Host "$($script:failures.Count) test(s) failed." -ForegroundColor Red
exit 1
