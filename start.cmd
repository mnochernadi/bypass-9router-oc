@echo off
setlocal
cd /d "%~dp0"
if not exist "bin\xray.exe" ( node lib\setup.js || goto :fail )
start "" http://127.0.0.1:8791
node server.js
goto :eof:fail
pause