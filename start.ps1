# One-command demo start: build the frontend if needed, then serve everything on http://localhost:8000
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
if (-not (Test-Path frontend/dist/index.html)) {
    Push-Location frontend
    if (-not (Test-Path node_modules)) { npm install }
    npm run build
    Pop-Location
}
python backend/server.py
