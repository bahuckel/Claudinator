@echo off
cd /d "%~dp0"
start "" http://localhost:8752
node server.js
pause
