#!/usr/bin/env pwsh
# One-shot setup script: installs deps, builds connectors, captures the
# master passphrase and (optionally) saves it to your PowerShell profile so
# OpenCode picks it up automatically on every launch.

$ErrorActionPreference = "Stop"

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "OK  $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "    $msg" -ForegroundColor Yellow }

# -- Node check --
Write-Step "Checking Node.js"
try {
    $nodeVersion = node --version
    Write-Ok "Node $nodeVersion"
    $major = [int]($nodeVersion -replace 'v(\d+).*', '$1')
    if ($major -lt 20) { throw "Node 20+ required, found $nodeVersion" }
} catch {
    Write-Host "Node.js 20+ is required. Install from https://nodejs.org" -ForegroundColor Red
    exit 1
}

# -- Install + build --
Write-Step "Installing dependencies"
npm install
if ($LASTEXITCODE -ne 0) { exit 1 }
Write-Ok "Dependencies installed"

Write-Step "Building connectors"
npm run build
if ($LASTEXITCODE -ne 0) { exit 1 }
Write-Ok "Build succeeded"

# -- Passphrase --
Write-Step "Master passphrase"
Write-Host ""
Write-Host "  opencode.json contains the GitHub token encrypted with a master"
Write-Host "  passphrase. The connector needs OPENCODE_PASSPHRASE in its"
Write-Host "  environment to decrypt the token at startup."
Write-Host ""
$secure = Read-Host "  Enter your master passphrase" -AsSecureString
$plain = [System.Net.NetworkCredential]::new("", $secure).Password
if ([string]::IsNullOrWhiteSpace($plain)) {
    Write-Host "Passphrase cannot be empty." -ForegroundColor Red
    exit 1
}

# -- Set for current session --
$env:OPENCODE_PASSPHRASE = $plain
Write-Ok "OPENCODE_PASSPHRASE set for the current PowerShell session"

# -- Offer to persist --
Write-Host ""
$ans = Read-Host "Save passphrase to your PowerShell profile so you don't have to enter it again? (y/N)"
if ($ans -match '^[Yy]') {
    if (-not (Test-Path $PROFILE)) {
        New-Item -ItemType File -Path $PROFILE -Force | Out-Null
    }
    $marker = "# --- opencode-connectors passphrase (auto-added by setup.ps1) ---"
    $line   = "`$env:OPENCODE_PASSPHRASE = '$plain'"
    $existing = Get-Content $PROFILE -Raw -ErrorAction SilentlyContinue
    if ($existing -and $existing -match [regex]::Escape($marker)) {
        $newContent = $existing -replace "(?ms)$([regex]::Escape($marker)).*?# --- end ---", "$marker`n$line`n# --- end ---"
        Set-Content -Path $PROFILE -Value $newContent
    } else {
        Add-Content -Path $PROFILE -Value "`n$marker`n$line`n# --- end ---"
    }
    Write-Ok "Saved to $PROFILE"
    Write-Warn "Warning: the passphrase is now stored in plaintext in your PowerShell profile."
} else {
    Write-Host ""
    Write-Host "Skipped. To set the passphrase manually in future sessions, run:"
    Write-Host "  `$env:OPENCODE_PASSPHRASE = '<your passphrase>'" -ForegroundColor Yellow
}

# -- Smoke check: try to spawn the connector and decrypt --
Write-Step "Verifying the connector can decrypt the token"
$verifyScript = @'
import { resolveToken } from "./connectors/github/dist/crypto.js";
import { readFileSync } from "node:fs";
const cfg = JSON.parse(readFileSync("opencode.json", "utf-8"));
const enc = cfg.mcp.github.environment.GITHUB_TOKEN_ENCRYPTED;
const t = resolveToken({ GITHUB_TOKEN_ENCRYPTED: enc, OPENCODE_PASSPHRASE: process.env.OPENCODE_PASSPHRASE });
if (!t.token.startsWith("gh")) throw new Error("decrypted value doesn't look like a GitHub token");
console.log("Decrypt OK, token starts with: " + t.token.slice(0, 7) + "...");
'@
$verifyScript | Out-File -FilePath .\.verify.mjs -Encoding UTF8
try {
    node ./.verify.mjs
    if ($LASTEXITCODE -ne 0) { throw "verification failed" }
    Write-Ok "Token decrypts correctly"
} catch {
    Write-Host "Decryption failed — wrong passphrase?" -ForegroundColor Red
    Remove-Item .\.verify.mjs -ErrorAction SilentlyContinue
    exit 1
}
Remove-Item .\.verify.mjs -ErrorAction SilentlyContinue

Write-Host ""
Write-Step "All set."
Write-Host ""
Write-Host "  Launch OpenCode in this folder ('opencode' command, or via your"
Write-Host "  installed app) and the 'github' MCP server will start automatically."
