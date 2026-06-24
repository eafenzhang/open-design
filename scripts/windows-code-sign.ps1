<#
.SYNOPSIS
    Open Design — Windows Code Signing Script
.DESCRIPTION
    Wraps signtool.exe to sign Windows executables with EV/OV code signing certificates.
    Supports dual signing (SHA-256 + SHA-1) with RFC 3161 timestamping.
.PARAMETER TargetPath
    Path to the executable (.exe) or installer to sign.
.PARAMETER CertificateFile
    Path to the .pfx or .p12 certificate file.
.PARAMETER CertificatePassword
    Password for the certificate file. Defaults to env:CODESIGN_CERT_PASSWORD.
.PARAMETER TimestampServerSha256
    RFC 3161 timestamp server URL for SHA-256. Defaults to DigiCert.
.PARAMETER TimestampServerSha1
    RFC 3161 timestamp server URL for SHA-1 legacy. Defaults to DigiCert.
.PARAMETER SkipSha1
    Skip legacy SHA-1 dual signing. SHA-256 only.
.PARAMETER SigntoolPath
    Path to signtool.exe. Defaults to auto-detect from Windows SDK.
.EXAMPLE
    .\windows-code-sign.ps1 -TargetPath ".\dist\Open Design Setup.exe" -CertificateFile ".\cert.pfx"
.EXAMPLE
    .\windows-code-sign.ps1 -TargetPath ".\dist\Open Design Setup.exe" -CertificateFile ".\cert.pfx" -SkipSha1
.NOTES
    Requires Windows SDK signtool.exe to be installed.
    Certificate password can also be set via CODESIGN_CERT_PASSWORD environment variable.
#>

[Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSAvoidUsingPlainTextForPassword', 'CertificatePassword')]
param(
    [Parameter(Mandatory = $true)]
    [ValidateScript({ Test-Path $_ -PathType Leaf })]
    [string]$TargetPath,

    [Parameter(Mandatory = $true)]
    [ValidateScript({ Test-Path $_ -PathType Leaf })]
    [string]$CertificateFile,

    [Parameter(Mandatory = $false)]
    [string]$CertificatePassword = $env:CODESIGN_CERT_PASSWORD,

    [Parameter(Mandatory = $false)]
    [string]$TimestampServerSha256 = "http://timestamp.digicert.com",

    [Parameter(Mandatory = $false)]
    [string]$TimestampServerSha1 = "http://timestamp.digicert.com",

    [Parameter(Mandatory = $false)]
    [switch]$SkipSha1,

    [Parameter(Mandatory = $false)]
    [string]$SigntoolPath = ""
)

$Script:ErrorActionPreference = "Stop"
$Script:LogPrefix = "[OpenDesign:CodeSign]"

function Write-Log {
    param([string]$Message, [string]$Level = "INFO")
    $timestamp = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
    Write-Host "$Script:LogPrefix [$timestamp] [$Level] $Message"
}

function Find-Signtool {
    <#
    .SYNOPSIS
        Auto-detect signtool.exe from Windows SDK installations.
    #>
    if ($SigntoolPath -and (Test-Path $SigntoolPath)) {
        Write-Log "Using provided signtool: $SigntoolPath"
        return $SigntoolPath
    }

    # Search common Windows SDK paths
    $sdkRoots = @(
        "${env:ProgramFiles(x86)}\Windows Kits\10\bin",
        "${env:ProgramFiles}\Windows Kits\10\bin"
    )

    $foundPaths = @()
    foreach ($root in $sdkRoots) {
        if (Test-Path $root) {
            $foundPaths += Get-ChildItem -Path $root -Recurse -Filter "signtool.exe" -ErrorAction SilentlyContinue |
                Where-Object { $_.FullName -match '\\x64\\' } |
                Select-Object -ExpandProperty FullName
        }
    }

    if ($foundPaths.Count -gt 0) {
        # Prefer the latest SDK version
        $selected = ($foundPaths | Sort-Object -Descending)[0]
        Write-Log "Auto-detected signtool at: $selected"
        return $selected
    }

    throw "signtool.exe not found. Install Windows SDK or provide -SigntoolPath."
}

function Invoke-Sign {
    param(
        [string]$SigntoolExe,
        [string]$Target,
        [string]$CertFile,
        [string]$CertPass,
        [string]$DigestAlgorithm,
        [string]$TimestampUrl
    )

    $args = @(
        "sign",
        "/fd", $DigestAlgorithm,
        "/td", $DigestAlgorithm,
        "/tr", $TimestampUrl,
        "/f", "`"$CertFile`""
    )

    if ($CertPass) {
        $args += "/p"
        $args += "`"$CertPass`""
    }

    $args += "/v"
    $args += "`"$Target`""

    $argString = $args -join " "
    Write-Log "Executing: $SigntoolExe $argString"

    $process = Start-Process -FilePath $SigntoolExe -ArgumentList $argString -NoNewWindow -Wait -PassThru

    if ($process.ExitCode -ne 0) {
        throw "[${DigestAlgorithm}] signtool exited with code $($process.ExitCode)"
    }

    Write-Log "[${DigestAlgorithm}] Signing completed successfully."
}

function Test-Signature {
    param(
        [string]$SigntoolExe,
        [string]$Target
    )

    Write-Log "Verifying signature on: $Target"
    $process = Start-Process -FilePath $SigntoolExe -ArgumentList "verify /pa /v `"$Target`"" -NoNewWindow -Wait -PassThru

    if ($process.ExitCode -ne 0) {
        throw "Signature verification failed with code $($process.ExitCode)"
    }

    Write-Log "Signature verified successfully."
}

# === Main Execution ===

Write-Log "Starting code signing process..."
Write-Log "Target: $TargetPath"
Write-Log "Certificate: $CertificateFile"

if (-not $CertificatePassword) {
    Write-Log "WARNING: No certificate password provided. Ensure certificate does not require one." "WARN"
}

$signtool = Find-Signtool

try {
    # SHA-256 signing (primary)
    Write-Log "--- SHA-256 Signing ---"
    Invoke-Sign -SigntoolExe $signtool `
        -Target $TargetPath `
        -CertFile $CertificateFile `
        -CertPass $CertificatePassword `
        -DigestAlgorithm "sha256" `
        -TimestampUrl $TimestampServerSha256

    # SHA-1 signing (legacy compatibility)
    if (-not $SkipSha1) {
        Write-Log "--- SHA-1 Signing (Dual Sign) ---"
        Invoke-Sign -SigntoolExe $signtool `
            -Target $TargetPath `
            -CertFile $CertificateFile `
            -CertPass $CertificatePassword `
            -DigestAlgorithm "sha1" `
            -TimestampUrl $TimestampServerSha1
    } else {
        Write-Log "Skipping SHA-1 dual signing (SkipSha1 flag set)."
    }

    # Verify final signature
    Test-Signature -SigntoolExe $signtool -Target $TargetPath

    Write-Log "Code signing completed successfully!"
} catch {
    Write-Log "Code signing FAILED: $_" "ERROR"
    exit 1
}
