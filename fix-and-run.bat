@echo off
REM Fix Bureau Portal - bypasses PowerShell execution policy by using npm.cmd directly
cd /d "%~dp0"
echo === Node version ===
node --version
echo.
echo === Installing dependencies (this restores node_modules) ===
"C:\Program Files\nodejs\npm.cmd" install --no-audit --no-fund
if errorlevel 1 (
  echo.
  echo INSTALL FAILED - try: "C:\Program Files\nodejs\npm.cmd" cache clean --force
  pause
  exit /b 1
)
echo.
echo === Checking server.js ===
node --check server.js && echo server.js OK
echo.
echo === Starting portal ===
echo Open http://localhost:3000/health in your browser
node server.js
pause
