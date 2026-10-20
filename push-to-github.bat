@echo off
REM Deploy Bureau Portal to GitHub - safe, never pushes .env / data / node_modules
cd /d "%~dp0"
where git >nul 2>&1
if errorlevel 1 (
  echo Git is NOT installed.
  echo 1. Install from https://git-scm.com/download/win
  echo 2. Restart VS Code / cmd.exe
  echo 3. Run this file again
  pause
  exit /b 1
)
echo === Git version ===
git --version
if not exist .git (
  echo === Initializing git ===
  git init
  git branch -M main
)
echo.
echo === Checking what will be pushed (VERIFY .env is NOT listed) ===
git status --short
echo.
echo === Safe add - code and config templates only ===
git add .gitignore package.json package-lock.json server.js database.js auth.js payment-providers.js wifi-provider.js drive-provider.js public/ scripts/ test/ Dockerfile docker-compose.yml Caddyfile.example render.yaml .env.example .env.production.example DEPLOYMENT.md fix-and-run.bat push-to-github.bat 2>nul
echo.
echo === Files staged: ===
git status --short
echo.
echo WARNING: If you see .env, data/, *.sqlite, or node_modules/ above - STOP and tell me.
echo.
set /p REPO_URL="Paste your GitHub repo URL (e.g. https://github.com/YOU/bureau-portal.git): "
if "%REPO_URL%"=="" (
  echo No URL given - files are staged but not pushed.
  pause
  exit /b 0
)
git remote remove origin 2>nul
git remote add origin %REPO_URL%
git commit -m "Bureau Portal ready for Render deploy" 2>nul
if errorlevel 1 echo (nothing new to commit - continuing to push)
git push -u origin main
echo.
echo Done. Check your repo on github.com - verify .env is NOT there.
pause
