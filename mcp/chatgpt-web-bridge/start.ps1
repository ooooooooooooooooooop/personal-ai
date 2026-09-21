# ChatGPT-Web2API launcher — persistent-Chrome topology.
#
#   start.ps1  launches Chrome itself (standalone, --start-minimized) so the
#   REST/MCP daemons always ATTACH to CDP :9222 and never own the browser.
#   Restarting or crashing daemons leaves Chrome (and your login) untouched.
#
# Idempotent: skips whatever is already healthy. Safe to re-run anytime.

# Prefer the explicitly configured environment, then an existing local or
# user runtime. Refuse to launch with an unverified/missing interpreter.
$venv = if ($env:W2A_VENV) {
    Join-Path $env:W2A_VENV "Scripts"
} elseif (Test-Path -LiteralPath (Join-Path $PSScriptRoot ".venv\Scripts\python.exe")) {
    Join-Path $PSScriptRoot ".venv\Scripts"
} else {
    Join-Path $env:USERPROFILE ".chatgpt-web2api\venv\Scripts"
}
$python = Join-Path $venv "python.exe"
if (-not (Test-Path -LiteralPath $python)) { Write-Error "Bridge runtime not found; run install.ps1 or set W2A_VENV."; exit 1 }
$chrome = "C:\Program Files\Google\Chrome\Application\chrome.exe"
$profile = Join-Path $env:USERPROFILE ".chatgpt-web2api\chrome-profile"

# Destructive tools (delete_conversation / delete_memory / ...) are HARD-LOCKED:
# W2A_ENABLE_DESTRUCTIVE intentionally unset — agents get no delete path at all.
# For a one-off authorized deletion, set the env var on a manual daemon launch.

function Test-Cdp { try { (Invoke-WebRequest -Uri "http://127.0.0.1:9222/json/version" -TimeoutSec 2 -UseBasicParsing).StatusCode -eq 200 } catch { $false } }

# 1. Chrome — standalone, survives all daemon restarts
if (-not (Test-Cdp)) {
    Write-Host "Launching standalone Chrome (minimized)..."
    Start-Process -WindowStyle Hidden -FilePath $chrome -ArgumentList @(
        "--remote-debugging-port=9222",
        "--user-data-dir=$profile",
        "--no-first-run",
        "--no-default-browser-check",
        "--start-minimized",
        "https://chatgpt.com"
    )
    $ok = $false
    for ($i = 0; $i -lt 30; $i++) { Start-Sleep 1; if (Test-Cdp) { $ok = $true; break } }
    if (-not $ok) { Write-Error "Chrome CDP never came up on :9222"; exit 1 }
    Write-Host "Chrome CDP ready."
} else { Write-Host "Chrome CDP already up." }

# 2. Verify REST and the real MCP handshake. Recovery checks the listener's
# executable, arguments and creation identity; healthy services remain running.
& $python -m chatgpt_web2api ensure --rest-port 8080 --mcp-sse-port 8090 --cdp-port 9222
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-Host "Ready. REST: http://127.0.0.1:8080/v1   MCP SSE: http://127.0.0.1:8090/sse"
