@echo off
REM Always-on daemon launcher for Task Scheduler (At startup / At log on).
setlocal
cd /d "%~dp0.."

if not exist "node_modules\" (
  echo [whatsapp-media-saver] node_modules missing — run npm install first.
  exit /b 1
)

where node >nul 2>&1
if errorlevel 1 (
  echo [whatsapp-media-saver] node not found on PATH.
  exit /b 1
)

REM Optional: uncomment / edit to override save root
REM set SAVE_ROOT=F:\Scan\whatsapp media

echo [whatsapp-media-saver] starting daemon...
node src\index.js run
set EXITCODE=%ERRORLEVEL%
echo [whatsapp-media-saver] exited with %EXITCODE%
exit /b %EXITCODE%
