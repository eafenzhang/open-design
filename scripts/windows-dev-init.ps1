<#
.SYNOPSIS
    Open Design — Windows Development Environment Initialization
.DESCRIPTION
    One-click setup script for Open Design Windows development.
    Installs Node.js >=24, pnpm, Visual Studio Build Tools, Python.
    Configures PowerShell execution policy and runs pnpm install.
.PARAMETER SkipChoco
    Skip Chocolatey installation steps and use winget instead.
.PARAMETER NodeVersion
    Target Node.js major version. Default: 24.
.PARAMETER SkipBuildTools
    Skip Visual Studio Build Tools installation (if already installed).
.EXAMPLE
    .\windows-dev-init.ps1
.EXAMPLE
    .\windows-dev-init.ps1 -SkipChoco -NodeVersion 24
.NOTES
    Requires administrator privileges for some package installations.
    Run from an elevated PowerShell terminal.
#>

param(
    [Parameter(Mandatory = $false)]
    [switch]$SkipChoco,

    [Parameter(Mandatory = $false)]
    [int]$NodeVersion = 24,

    [Parameter(Mandatory = $false)]
    [switch]$SkipBuildTools
)

$Script:ErrorActionPreference = "Stop"
$Script:LogPrefix = "[OpenDesign:DevInit]"

function Write-Log {
    param([string]$Message, [string]$Level = "INFO")
    $timestamp = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
    Write-Host "$Script:LogPrefix [$timestamp] [$Level] $Message"
}

function Test-Admin {
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object System.Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Install-Chocolatey {
    if (Get-Command choco -ErrorAction SilentlyContinue) {
        Write-Log "Chocolatey is already installed."
        return $true
    }

    Write-Log "Installing Chocolatey..."
    try {
        Set-ExecutionPolicy Bypass -Scope Process -Force
        [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.ServicePointManager]::SecurityProtocol -bor 3072
        Invoke-Expression ((New-Object System.Net.WebClient).DownloadString('https://community.chocolatey.org/install.ps1'))
        Write-Log "Chocolatey installed successfully."
        return $true
    } catch {
        Write-Log "Failed to install Chocolatey: $_" "WARN"
        return $false
    }
}

function Install-NodeViaChoco {
    param([int]$Version)

    Write-Log "Installing Node.js >= $Version via Chocolatey..."
    choco install "nodejs-lts" --version="$Version.0.0" --yes --allow-downgrade
    if ($LASTEXITCODE -ne 0) {
        # Fallback: install any available LTS
        choco install nodejs-lts --yes
    }
    refreshenv
}

function Install-NodeViaWinget {
    param([int]$Version)

    Write-Log "Installing Node.js >= $Version via winget..."
    $result = winget install OpenJS.NodeJS.LTS --silent --accept-package-agreements
    if ($LASTEXITCODE -ne 0) {
        throw "winget install Node.js failed with code $LASTEXITCODE"
    }
}

function Install-Pnpm {
    Write-Log "Installing pnpm..."

    if (Get-Command pnpm -ErrorAction SilentlyContinue) {
        Write-Log "pnpm is already installed."
        return
    }

    try {
        Invoke-Expression "npm install -g pnpm@latest"
        Write-Log "pnpm installed successfully (version: $(pnpm --version))."
    } catch {
        # Fallback: install via PowerShell
        Invoke-WebRequest https://get.pnpm.io/install.ps1 -UseBasicParsing | Invoke-Expression
        Write-Log "pnpm installed via get.pnpm.io."
    }
}

function Install-VSBuildTools {
    if ($SkipBuildTools) {
        Write-Log "Skipping Visual Studio Build Tools installation."
        return
    }

    Write-Log "Installing Visual Studio Build Tools (required for better-sqlite3 native compilation)..."

    if (Get-Command choco -ErrorAction SilentlyContinue) {
        choco install visualstudio2022buildtools --yes `
            --package-parameters "--add Microsoft.VisualStudio.Workload.VCTools --includeRecommended --passive"
        if ($LASTEXITCODE -ne 0) {
            Write-Log "Chocolatey VS Build Tools install returned code $LASTEXITCODE" "WARN"
        }
    } elseif (Get-Command winget -ErrorAction SilentlyContinue) {
        winget install Microsoft.VisualStudio.2022.BuildTools --silent --accept-package-agreements `
            --override "--add Microsoft.VisualStudio.Workload.VCTools --includeRecommended --passive"
    } else {
        Write-Log "Cannot install VS Build Tools: neither choco nor winget found." "ERROR"
        Write-Log "Please manually install from: https://visualstudio.microsoft.com/downloads/#build-tools-for-visual-studio-2022" "ERROR"
    }
}

function Install-Python {
    Write-Log "Checking Python installation..."
    if (Get-Command python -ErrorAction SilentlyContinue) {
        Write-Log "Python is already installed: $(python --version)"
        return
    }

    if (Get-Command choco -ErrorAction SilentlyContinue) {
        choco install python --yes
    } elseif (Get-Command winget -ErrorAction SilentlyContinue) {
        winget install Python.Python.3.12 --silent --accept-package-agreements
    }
}

function Set-ExecutionPolicySafe {
    Write-Log "Configuring PowerShell execution policy..."
    $currentPolicy = Get-ExecutionPolicy -Scope CurrentUser -ErrorAction SilentlyContinue

    if ($currentPolicy -eq "Restricted" -or $currentPolicy -eq "Undefined") {
        if (Test-Admin) {
            Set-ExecutionPolicy RemoteSigned -Scope CurrentUser -Force
            Write-Log "Execution policy set to RemoteSigned for CurrentUser."
        } else {
            Write-Log "Cannot change execution policy without admin privileges." "WARN"
        }
    } else {
        Write-Log "Current execution policy ($currentPolicy) is acceptable."
    }
}

function Invoke-PnpmInstall {
    Write-Log "Running pnpm install..."
    $projectRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
    Push-Location $projectRoot
    try {
        pnpm install --frozen-lockfile
        if ($LASTEXITCODE -ne 0) {
            Write-Log "pnpm install --frozen-lockfile failed, trying without lockfile..." "WARN"
            pnpm install
        }
        Write-Log "pnpm install completed successfully."
    } finally {
        Pop-Location
    }
}

function Show-Status {
    Write-Host ""
    Write-Host "========================================" -ForegroundColor Cyan
    Write-Host "  Open Design Dev Environment Status" -ForegroundColor Cyan
    Write-Host "========================================" -ForegroundColor Cyan
    Write-Host ""

    $items = @(
        @{ Label = "Node.js"; Command = "node --version" },
        @{ Label = "npm"; Command = "npm --version" },
        @{ Label = "pnpm"; Command = "pnpm --version" },
        @{ Label = "Python"; Command = "python --version" },
        @{ Label = "PowerShell"; Command = "`$PSVersionTable.PSVersion.ToString()" },
        @{ Label = "Chocolatey"; Command = "choco --version" }
    )

    foreach ($item in $items) {
        try {
            $result = Invoke-Expression $item.Command 2>$null
            Write-Host "  [OK]  $($item.Label): $result" -ForegroundColor Green
        } catch {
            Write-Host "  [MISS] $($item.Label): Not found" -ForegroundColor Red
        }
    }
    Write-Host ""
}

# === Main Execution ===

Write-Log "============================================"
Write-Log "Open Design Windows Dev Environment Init"
Write-Log "============================================"

if (-not (Test-Admin)) {
    Write-Log "WARNING: Not running as administrator. Some features may fail." "WARN"
    Write-Log "Recommend re-running from an elevated PowerShell terminal." "WARN"
}

# Step 1: Configure execution policy
Set-ExecutionPolicySafe

# Step 2: Install package managers
$hasChoco = $false
if (-not $SkipChoco) {
    $hasChoco = Install-Chocolatey
}

# Step 3: Install Node.js
if ($hasChoco) {
    Install-NodeViaChoco -Version $NodeVersion
} else {
    Install-NodeViaWinget -Version $NodeVersion
}

# Step 4: Install pnpm
Install-Pnpm

# Step 5: Install VS Build Tools (for native modules like better-sqlite3)
Install-VSBuildTools

# Step 6: Install Python (required by node-gyp)
Install-Python

# Step 7: Install project dependencies
Invoke-PnpmInstall

# Step 8: Display status
Show-Status

Write-Log "============================================"
Write-Log "Dev environment initialization complete!"
Write-Log "Run 'pnpm run dev' to start development."
Write-Log "============================================"
