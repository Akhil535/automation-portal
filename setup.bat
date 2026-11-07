@echo off
REM One-time setup: installs the Node.js packages and checks the register.
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js 20 or newer is required: https://nodejs.org & pause & exit /b 1)
if not exist config.json (copy config.example.json config.json >nul & echo Created config.json from config.example.json)
call npm install --omit=dev || (echo npm install failed & pause & exit /b 1)
node --use-system-ca cli.js register-info
echo.
echo Next: start-portal.bat  (or scripts\install-startup.ps1 to start it automatically at log-on)
pause
