@echo off
REM Starts the portal in this window. Open http://localhost:8080 in your browser.
cd /d "%~dp0"
start "" http://localhost:8080
node --use-system-ca server.js
