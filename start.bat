@echo off
rem Launch the desktop pet.
rem ELECTRON_RUN_AS_NODE must be cleared, otherwise Electron degrades to plain Node.
cd /d "%~dp0"
set ELECTRON_RUN_AS_NODE=

if not exist "node_modules\electron\dist\electron.exe" (
    echo [x] electron not found, run "npm install" first.
    pause
    exit /b 1
)

start "" "node_modules\electron\dist\electron.exe" .
