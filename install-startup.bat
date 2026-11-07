@echo off
REM Start the portal automatically (hidden) every time you log on to Windows.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-startup.ps1
pause
