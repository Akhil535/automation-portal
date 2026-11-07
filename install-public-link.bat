@echo off
REM Start the public link automatically (hidden) every time you log on to Windows - and start it now.
REM The portal then opens from https://akhil535.github.io/automation-portal
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-public-link.ps1 -StartNow
pause
