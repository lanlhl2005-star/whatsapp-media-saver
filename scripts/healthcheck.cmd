@echo off
REM 10-minute health probe for Task Scheduler.
setlocal
cd /d "%~dp0.."
node src\index.js health
exit /b %ERRORLEVEL%
