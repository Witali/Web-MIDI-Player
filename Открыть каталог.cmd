@echo off
title Web-MIDI-Player
cd /d "%~dp0"
node catalog-server.mjs --open
if errorlevel 1 pause
