@echo off
REM Public link without a domain: the portal on this PC opens from https://akhil535.github.io/automation-portal
REM (the start page on GitHub Pages is updated with the current address). Keep this window open; Ctrl+C stops it.
cd /d "%~dp0"
node scripts\public-link.mjs
