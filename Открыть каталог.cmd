@echo off
cd /d "%~dp0"
node catalog-server.mjs --open
if errorlevel 1 pause
