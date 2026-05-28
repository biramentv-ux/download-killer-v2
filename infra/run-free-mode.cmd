@echo off
setlocal
cd /d "%~dp0\.."
powershell -ExecutionPolicy Bypass -File ".\infra\run-free-mode.ps1"
endlocal
