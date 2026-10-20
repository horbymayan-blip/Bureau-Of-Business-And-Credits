@echo off
cd /d "%~dp0"
echo === git status before ===
git status --short --branch
echo.
echo === adding ===
git add .
if errorlevel 1 (
  echo ADD FAILED
  pause
  exit /b 1
)
echo.
echo === status after add ===
git status --short --branch
echo.
echo === committing ===
git commit -m "Initial commit"
if errorlevel 1 (
  echo COMMIT FAILED - maybe already committed or missing git identity
  echo Run: git config user.name "Your Name" ^&^& git config user.email "you@example.com"
  pause
  exit /b 1
)
echo.
echo === log ===
git log --oneline -5
echo.
echo === final status ===
git status
pause
